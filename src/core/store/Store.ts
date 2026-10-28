/** TallyStore - Store 核心实现 */

import type {
  Store as StoreInterface,
  StoreOptions,
  State,
  Actions,
  Getters,
  StateListener,
  StateProtectionOptions,
  InferActionArgs,
  InferActionReturn,
  InferGetterReturn,
  ActionContextBase,
} from '../../types/store.js'
import type { Plugin as PluginType } from '../../types/plugin.js'
import { HookSystem } from '../hooks/index.js'
import { deepMerge, isObject, isPlainObject, PROTO_SENSITIVE_KEYS, defineOwnProperty } from '../utils/helpers.js'
import { ownEnumerableKeys } from '../utils/clone.js'
import { findUnserializablePaths } from '../utils/serializable.js'

import { StateProxyManager } from './StateProxy.js'
import { createProxyCache } from './proxyCore.js'
import { StoreNotifier } from './StoreNotifier.js'
import { ActionManager, GetterManager } from './ActionManager.js'
import { BatchManager } from './BatchManager.js'
import type { InternalStateProtectionConfig } from './types.js'
import { deepCloneState, deepFreezeState, isProduction } from './utils.js'
import { estimateJsonBytes } from '../utils/helpers.js'
import { TallyStoreError, ErrorCode } from '../errors/TallyStoreError.js'
import { createDirtyTrackingProxy, createDirtyTrackingCache, type DirtyTrackingCache } from './dirtyTracking.js'
import { createPluginUninstaller } from './pluginSupport.js'
import { registerStoreInstance } from './registry.js'

/** 自动生成 Store 名称时使用的前缀 */
const STORE_NAME_PREFIX = 'store-'

/** destroy() 排空插件卸载函数的最大轮数，防止清理过程中不断重入 use() 时无限循环 */
const MAX_PLUGIN_UNINSTALL_ROUNDS = 10

/** 快照默认体积上限（字节）：微信单 key 上限同量级；生效值另受「状态序列化体积 × 2」约束 */
const SNAPSHOT_DEFAULT_MAX_BYTES = 1024 * 1024

/** 快照来源标记：Symbol.for 跨库副本共享；值为标记版本 */
const SNAPSHOT_MARK = Symbol.for('tallystore.snapshotMark')
const SNAPSHOT_MARK_VERSION = 1

/** 读取「一次按键写入将要写入/比对的那个值」，原型链敏感键按自有属性描述符取。 */
function readOwnValue(target: object, key: string | symbol): unknown {
  if (typeof key !== 'string' || !PROTO_SENSITIVE_KEYS.has(key)) {
    return (target as Record<PropertyKey, unknown>)[key]
  }
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  return descriptor ? descriptor.value : undefined
}

/**
 * 整树替换收尾所需的实例内部面（$replaceState 与 $reset 的非纯对象根路径共用）。
 *
 * 为什么不抽成 Store 的私有方法：TypeScript 的 private 只是编译期约束，方法在运行时仍挂在
 * Store.prototype 上，新增名字会进入 API 表面快照并触发 scripts/api-report.mjs --check 门禁。
 */
interface StateReplacementInternals<S extends State> {
  _state: S
  _dirtyProxyCache: DirtyTrackingCache
  _notifier: StoreNotifier<S>
  _dispatching: boolean
  _batchManager: BatchManager
  _rebuildStateProxyManager(): void
  _scheduleNotify(): void
  _withInternalAccess<T>(fn: () => T): T
}

/** 整树替换的公共收尾：深拷贝、重建代理缓存、旧/新键标脏并调度通知。 */
function commitStateReplacement<S extends State>(store: StateReplacementInternals<S>, nextState: S): void {
  // 旧键集必须在替换前取：被这次替换删掉的键也要标脏，否则集成层跳过 setData，视图残留旧值
  const previousKeys = ownEnumerableKeys(store._state) as Array<keyof S>

  store._withInternalAccess(() => {
    store._state = deepCloneState(nextState)
  })

  // 清除所有 Proxy 缓存（状态保护 + 脏跟踪均需重建）
  store._rebuildStateProxyManager()
  store._dirtyProxyCache = createDirtyTrackingCache()
  store._notifier.bumpMutation()
  // 整树替换：新键与被替换掉的旧键都视为已变更（后者是消失型变更）
  store._notifier.markDirty([...previousKeys, ...(ownEnumerableKeys(store._state) as Array<keyof S>)])

  if (!store._dispatching && !store._batchManager.isInBatch) {
    store._scheduleNotify()
  }
}

/**
 * Store 实现类。
 *
 * 不变量：
 * - 状态只能经 setState / $patch / $replaceState / action 写入；state getter 返回只读保护代理。
 * - dispatch 与 batch 期间的写入不通知，由收尾统一通知一次。
 * - 通知后清空脏键；通知期间重入写入的脏键留给下一轮。
 */
export class Store<S extends State = State, A extends Actions = Actions, G extends Getters<S> = Getters<S>> implements StoreInterface<S, A, G> {
  // ==================== 核心属性 ====================

  readonly name: string

  private _state!: S

  /** 构造时解析的初始状态源（$reset 重新克隆用） */
  private _initialStateSource: S | undefined

  private _isInternalAccess = false

  private _stateProtection: InternalStateProtectionConfig

  /** 快照体积上限（未配置时用 min(1MB, 状态序列化体积×2)） */
  private _snapshotMaxBytes: number | undefined

  /** 状态保护启用标志（内联缓存） */
  private _stateProtectionEnabled: boolean

  /** Action 脏跟踪代理缓存（代理与原对象双向映射；$replaceState 时重建） */
  private _dirtyProxyCache: DirtyTrackingCache = createDirtyTrackingCache()

  public actions!: A

  private _plugins: PluginType<S>[] = []

  private _pluginUninstallFns: Map<PluginType<S>, (() => void) | undefined> = new Map()

  /** 插件当前安装的代际令牌：旧句柄据此识别自己是否仍对应最新一次安装 */
  private _pluginInstallations: Map<PluginType<S>, object> = new Map()

  private _dispatching = false

  private _destroyed = false

  /** 全局注册表注销句柄（显式命名的 Store 才登记） */
  private _unregisterFromRegistry: (() => void) | undefined

  // ==================== 子模块实例 ====================

  private _stateProxyManager!: StateProxyManager<S>

  private _notifier: StoreNotifier<S>

  private _actionManager: ActionManager<S, A>

  private _getterManager: GetterManager<S, G>

  private _batchManager: BatchManager

  private _hooks: HookSystem

  /** 公开的钩子系统访问器，供插件使用 */
  public readonly hooks: HookSystem

  private static _storeCounter = 0

  // ==================== 构造函数 ====================

  constructor(options: StoreOptions<S, A, G> = {}) {
    this.name = options.name || STORE_NAME_PREFIX + Store._storeCounter++

    this._stateProtection = {
      enabled: options.stateProtection?.enabled ?? true,
      deep: options.stateProtection?.deep ?? true,
      productionHandler: options.stateProtection?.productionHandler ?? 'warn',
    }
    // /NaN 会让 Math.min(...)=NaN、体积上限静默失效；<=0/Infinity 会让所有快照直接失败；
    // (0,1) 的小数会让 effectiveMax < 1B，同样使所有非空快照被拒，故要求向下取整后至少 1 字节
    const snapshotMaxBytes = options.snapshot?.maxBytes
    if (snapshotMaxBytes !== undefined && (!Number.isFinite(snapshotMaxBytes) || Math.floor(snapshotMaxBytes) < 1)) {
      throw new TypeError('[TallyStore] snapshot.maxBytes must be a positive finite number (>= 1 byte)')
    }
    this._snapshotMaxBytes = snapshotMaxBytes
    this._stateProtectionEnabled = this._stateProtection.enabled

    this._rebuildStateProxyManager()

    // 实例级钩子系统（每个 Store 独立，避免全局单例跨 Store 干扰）
    this._hooks = new HookSystem()
    this.hooks = this._hooks

    //  全局唯一名登记：只登记显式命名的 Store（自动名跨 bundle 副本会误报冲突）。
    // 开发期重名在此抛出（阻断启动）；生产期经 onError 上报后放行（降级口径）
    if (options.name !== undefined) {
      this._unregisterFromRegistry = registerStoreInstance(options.name, this, (error) => {
        // 构造中 onError 尚无监听者，console 是生产期唯一可靠通道；两者都走
        console.error(error.message)
        this._hooks.emit('onError', error, 'register')
      })
    }

    // 通知中枢：订阅注册、脏键记账、通知调度与载荷策略都在这里
    this._notifier = new StoreNotifier<S>({
      storeName: this.name,
      maxSubscribers: options.subscription?.maxSubscribers,
      onLimit: options.subscription?.onLimit,
      notifyClone: options.notify?.clone ?? false,
      notifyAsync: options.notify?.async ?? false,
      notifyOnlyOnChange: options.notify?.onlyOnChange ?? false,
      buildPayload: (needsClone) => (needsClone || !this._stateProtectionEnabled ? this._state : this._stateProxyManager.createStateProxy(this._state, '')),
      // 监听器异常与驱逐事件都挂到 onError 钩子：生产控制台静默，没有这条通道就彻底丢失
      onListenerError: (error) => this._hooks.emit('onError', error),
      onAsyncNotifyError: (error) => this._hooks.emit('onError', error, 'notify'),
      onNotified: (listeners) => this._hooks.emit('onNotify', { listeners }),
      onSubscriberEvicted: (info) =>
        this._hooks.emit(
          'onError',
          new Error(
            '[TallyStore][' +
              this.name +
              '] 订阅者达到上限(' +
              info.maxSubscribers +
              ')，evict-oldest 驱逐了一份注册' +
              '（监听器：' +
              (info.listener.name || '(匿名函数)') +
              '，驱逐后在册注册数：' +
              info.size +
              '，不含本次新注册）',
          ),
          'subscribe',
        ),
    })

    // 收尾失败经 onError('notify') 上报（插件/logger/metrics 可见），不再只落 console
    this._batchManager = new BatchManager(
      () => this._onBatchEnd(),
      (error) => this._hooks.emit('onError', error, 'notify'),
    )

    this._actionManager = new ActionManager<S, A>({
      storeName: this.name,
      withInternalAccess: (fn) => this._withInternalAccess(fn),
      setDispatching: (value) => {
        this._dispatching = value
      },
      notifyListeners: () => this._scheduleNotify(),
      hooks: this._hooks,
      notifyOnlyOnChange: options.notify?.onlyOnChange ?? false,
      getMutationCount: () => this._notifier.mutationCount,
      getLastNotifiedMutationCount: () => this._notifier.lastNotifiedMutationCount,
      isInBatch: () => this._batchManager.isInBatch,
    })

    // getter 拿到的是只读保护代理：getter 内部意外写入必须被拦截而不是静默生效
    this._getterManager = new GetterManager<S, G>(this.name, () => this.state)

    try {
      this._initializeState(options.state)
      this._initializeActionsAndGetters(options.actions, options.getters)
    } catch (error) {
      // 构造失败时实例不可达，而全局注册表持有强引用：不注销会永久泄漏并占住 name
      this._unregisterFromRegistry?.()
      this._unregisterFromRegistry = undefined
      throw error
    }
  }

  // ==================== 状态访问器 ====================

  /** 状态访问器——返回只读保护 Proxy；写入请走 setState() / $patch() / $replaceState()。 */
  public get state(): S {
    // 只受保护开关影响：action 写入走 ActionManager 自己的可写脏跟踪代理，不依赖这个 getter
    if (!this._stateProtectionEnabled) {
      return this._state
    }
    return this._stateProxyManager.createStateProxy(this._state, '')
  }

  // ==================== 状态管理方法 ====================

  /** 获取当前状态的原始引用（内部使用）。 */
  getState(): S {
    return this._state
  }

  /** 设置单个状态值 */
  setState<K extends keyof S>(key: K, value: S[K]): void {
    if (this._destroyed) {
      throw new Error('[TallyStore] Cannot call setState on a destroyed Store')
    }
    if (key === null || key === undefined) {
      throw new TypeError('[TallyStore] setState: key must not be null or undefined')
    }

    this._hooks.emit('beforeSetState', key, value)

    // 原型链敏感键与 deepMerge 同口径：裸 [[Set]] 会改写状态对象原型，defineProperty 只定义自有数据属性
    const protoSensitive = typeof key === 'string' && PROTO_SENSITIVE_KEYS.has(key)

    // 相等性检查：值未变化时跳过写入和通知；敏感键经 readOwnValue 读自有描述符
    const oldValue = readOwnValue(this._state as unknown as Record<string, unknown>, key as string)
    if (Object.is(oldValue, value)) {
      this._hooks.emit('afterSetState', key, value)
      return
    }

    this._withInternalAccess(() => {
      if (protoSensitive) {
        defineOwnProperty(this._state as unknown as Record<string, unknown>, key as string, value)
      } else {
        this._state[key] = value
      }
    })

    this._notifier.bumpMutation()
    this._notifier.markDirty([key])

    if (!this._dispatching && !this._batchManager.isInBatch) {
      this._scheduleNotify()
    }
    this._hooks.emit('afterSetState', key, value)
  }

  /** 批量更新状态（深合并） */
  $patch(partialState: Partial<S>): void {
    if (this._destroyed) {
      throw new Error('[TallyStore] Cannot call $patch on a destroyed Store')
    }
    if (!partialState || typeof partialState !== 'object') {
      throw new TypeError('[TallyStore] $patch: partialState must be a valid object')
    }
    // deepMerge 只对纯对象做合并：数组 / Map / Set / 类实例根在这里就地响亮失败。
    // 此前用 isObject 放过了类实例，deepMerge 整体跳过（生产静默）+ 标脏通知 = patch 无效果却通知
    if (!isPlainObject(this._state)) {
      throw new TypeError('[TallyStore] $patch: state root must be a plain object (arrays/Map/Set/class-instance roots are not supported)')
    }

    this._hooks.emit('beforePatch', partialState)

    // 两侧都经 readOwnValue：原型链敏感键按 [[Get]] 拿到的是原型而不是写入值，等值比对会得出相反结论。
    // 键集用 ownEnumerableKeys 而非 Object.keys：符号键也是 setState 的一等写入键
    const stateRecord = this._state as unknown as Record<PropertyKey, unknown>
    const patchRecord = partialState as unknown as Record<PropertyKey, unknown>
    const effective: Record<PropertyKey, unknown> = {}
    const effectiveKeys: Array<string | symbol> = []
    for (const key of ownEnumerableKeys(patchRecord)) {
      const patchValue = readOwnValue(patchRecord, key)
      if (Object.is(readOwnValue(stateRecord, key), patchValue)) {
        continue
      }
      const protoSensitive = typeof key === 'string' && PROTO_SENSITIVE_KEYS.has(key)
      // 敏感键以 defineProperty 承载：effective['__proto__'] = value 走 [[Set]]，会丢掉该键
      if (protoSensitive) {
        defineOwnProperty(effective, key, patchValue)
      } else {
        effective[key] = patchValue
      }
      effectiveKeys.push(key)
    }

    if (effectiveKeys.length === 0) {
      this._hooks.emit('afterPatch', partialState)
      return
    }

    try {
      this._withInternalAccess(() => {
        deepMerge(stateRecord, effective)
      })
    } catch (error) {
      // deepMerge 边写边合并：中途抛错时前面的键已落进 state，异常路径同样要记账再原样上抛
      this._commitPatchEffects(effectiveKeys as Array<keyof S>)
      throw error
    }

    this._commitPatchEffects(effectiveKeys as Array<keyof S>)
    this._hooks.emit('afterPatch', partialState)
  }

  /** $patch 合并后的统一记账：正常路径与 deepMerge 中途抛错后的兜底共用。 */
  private _commitPatchEffects(changedKeys: Array<keyof S>): void {
    this._notifier.bumpMutation()

    // 走 effectiveKeys 而非 Object.keys(effective)：后者只给字符串键，符号键会漏掉脏键标记。
    // deepMerge 可能就地改写该键下的嵌套对象，故整键标记为已变更（保守超集）
    this._notifier.markDirty(changedKeys)

    if (!this._dispatching && !this._batchManager.isInBatch) {
      this._scheduleNotify()
    }
  }

  /** 替换整个状态 */
  $replaceState(newState: S | (() => S)): void {
    if (this._destroyed) {
      throw new Error('[TallyStore] Cannot call $replaceState on a destroyed Store')
    }
    const resolvedState = typeof newState === 'function' ? (newState as () => S)() : newState
    if (resolvedState === undefined || resolvedState === null) {
      throw new TypeError('[TallyStore] $replaceState: newState must be a valid state object')
    }
    // 与 $patch 同口径：数组 / Map / Set 根不支持（createStore 仅为向后兼容仍允许构造它们）
    if (!isObject(resolvedState)) {
      throw new TypeError('[TallyStore] $replaceState: newState must be a plain object')
    }

    this._hooks.emit('beforeReplaceState', resolvedState)
    commitStateReplacement(this as unknown as StateReplacementInternals<S>, resolvedState)
    this._hooks.emit('afterReplaceState', resolvedState)
  }

  /** 判断指定状态键自上次通知以来是否发生变更 */
  isStateKeyDirty(key: string | symbol): boolean {
    return this._notifier.isDirty(key)
  }

  /**
   * 创建状态快照（带体积上限与来源标记）。
   *
   * 返回深克隆后部分冻结的副本：纯对象与数组链上深度只读，但经 Date/RegExp/Map/Set
   * 或非纯对象触达的节点仍是活的可变对象（Readonly<S> 只到类型层面）。
   * 体积上限：min(配置 maxBytes ?? 1MB, 状态序列化体积 × 2)，超限抛 INVALID_CONFIG
   * 并附估算大小与收缩建议（快照是撤销/草稿原语，不是持久化——跨进程恢复走
   * persistencePlugin 的 schemaVersion 迁移）。
   */
  $snapshot(): Readonly<S> {
    if (this._destroyed) {
      throw new Error('[TallyStore] Cannot call $snapshot on a destroyed Store')
    }
    return this._withInternalAccess(() => {
      const cloned = deepCloneState(this._state)
      // 体积上限：不可序列化状态（估算 -1）不设限，保持既有行为
      const snapshotBytes = estimateJsonBytes(cloned)
      if (snapshotBytes >= 0) {
        const stateBytes = estimateJsonBytes(this._state)
        const effectiveMax =
          stateBytes >= 0
            ? Math.min(this._snapshotMaxBytes ?? SNAPSHOT_DEFAULT_MAX_BYTES, Math.max(stateBytes * 2, 1))
            : (this._snapshotMaxBytes ?? SNAPSHOT_DEFAULT_MAX_BYTES)
        if (snapshotBytes > effectiveMax) {
          throw new TallyStoreError(
            ErrorCode.INVALID_CONFIG,
            '[TallyStore] $snapshot 拒绝：快照约 ' +
              snapshotBytes +
              'B 超过上限 ' +
              effectiveMax +
              'B（key: ' +
              this.name +
              '）。快照用于撤销/草稿检查点，请缩小状态或调大 snapshot.maxBytes；跨进程恢复请走持久化（schemaVersion 迁移）',
            { storeName: this.name, snapshotBytes, maxBytes: effectiveMax },
          )
        }
      }
      // 来源标记：可枚举符号键，随快照对象存活（deepClone 复制可枚举符号），JSON 序列化忽略
      const marked = cloned as Record<symbol, unknown>
      marked[SNAPSHOT_MARK] = SNAPSHOT_MARK_VERSION
      return deepFreezeState(cloned) as Readonly<S>
    })
  }

  /** 从快照恢复状态（形态校验失败丢弃并上报；来源未标记告警但不阻断） */
  $restore(snapshot: Readonly<S>): void {
    if (this._destroyed) {
      throw new Error('[TallyStore] Cannot call $restore on a destroyed Store')
    }
    // 形态校验：非纯对象（null/数组/原始值/类实例）丢弃并上报后按 $replaceState 口径抛错，
    // 当前状态不受污染。原型接受 Object.prototype 或 null——$snapshot 克隆保留源原型，
    // Object.create(null) 状态的快照必须能恢复自己（全量审查发现项）
    const snapshotProto = snapshot === null || typeof snapshot !== 'object' ? undefined : Object.getPrototypeOf(snapshot)
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot) || (snapshotProto !== Object.prototype && snapshotProto !== null)) {
      const message =
        '[TallyStore] $restore 拒绝：快照必须是纯对象（收到 ' +
        (snapshot === null ? 'null' : Array.isArray(snapshot) ? 'array' : typeof snapshot) +
        '），状态保持不变'
      this._hooks.emit('onError', new TallyStoreError(ErrorCode.INVALID_CONFIG, message, { storeName: this.name }), 'restore')
      throw new TypeError('[TallyStore] $restore: snapshot must be a plain object')
    }
    // 来源标记：外部构造或跨版本快照——可观测但不阻断（形态合法即可恢复）
    const mark = (snapshot as Record<symbol, unknown>)[SNAPSHOT_MARK]
    if (mark !== SNAPSHOT_MARK_VERSION) {
      const message =
        '[TallyStore] $restore 收到' +
        (mark === undefined ? '无来源标记的快照（外部构造或跨版本导出）' : '不同版本标记的快照（v' + String(mark) + '）') +
        '：形态校验通过则照常恢复；跨版本数据请优先走持久化迁移（schemaVersion）'
      if (!isProduction()) {
        console.warn(message)
      }
      this._hooks.emit('onError', new TallyStoreError(ErrorCode.INVALID_CONFIG, message, { storeName: this.name }), 'restore')
    }
    // 来源标记不得进入活状态：$replaceState 内部的 deepCloneState 会复制可枚举符号键。
    // 先克隆再剥离，快照对象本身保持原样（仍带标记、仍冻结）。
    const sanitized = deepCloneState(snapshot) as Record<PropertyKey, unknown>
    delete sanitized[SNAPSHOT_MARK]
    // 克隆职责收敛到 $replaceState（其内部会再深拷贝一次，隔离副本换隔离副本）
    this.$replaceState(sanitized as S)
  }

  // ==================== Action 和 Getter ====================

  /** 执行 action */
  dispatch<K extends keyof A>(actionName: K, ...args: InferActionArgs<A, K>): InferActionReturn<A, K>
  dispatch(actionName: string, ...args: unknown[]): unknown
  dispatch(actionName: string | keyof A, ...args: unknown[]): unknown {
    if (this._destroyed) {
      throw new Error('[TallyStore] Cannot call dispatch on a destroyed Store')
    }
    return this._actionManager.execute(actionName as string, ...args)
  }

  /** 使用 getter */
  getter<K extends keyof G>(getterName: K): InferGetterReturn<G, K>
  getter(getterName: string): unknown
  getter(getterName: string | keyof G): unknown {
    if (this._destroyed) {
      throw new Error('[TallyStore] Cannot call getter on a destroyed Store')
    }
    return this._getterManager.execute(getterName as string)
  }

  /** 已声明的 getter 名列表（装饰期映射校验用） */
  getterNames(): string[] {
    return this._getterManager.names()
  }

  // ==================== 订阅 ====================

  /**
   * 订阅状态变化。
   *
   * readOnly 标记为只读订阅（仅读取状态、不修改）：当 Store 仅有只读订阅者时，
   * 通知路径跳过整棵状态树的深拷贝，显著降低大状态下的通知开销。
   */
  subscribe(listener: StateListener<S>, options?: { readOnly?: boolean }): () => void {
    if (this._destroyed) {
      throw new Error('[TallyStore] Cannot call subscribe on a destroyed Store')
    }
    return this._notifier.subscribe(listener, options)
  }

  /** 当前在册订阅数（含多份注册； 压测与线上诊断用） */
  getSubscriptionCount(): number {
    return this._notifier.size
  }

  // ==================== 插件管理 ====================

  /**
   * 安装插件，返回卸载函数。
   *
   * 同一插件实例重复安装会覆盖首条卸载映射、残留的注册永不卸载，故幂等返回既有卸载函数。
   */
  use(plugin: PluginType<NoInfer<S>> | PluginType<State>): () => void {
    if (this._destroyed) {
      throw new Error('[TallyStore] Cannot call use on a destroyed Store')
    }

    // 收窄为 PluginType<S>：状态无关插件（Plugin<State>）结构上满足「可安装到本 Store」
    const target = plugin as PluginType<S>
    if (this._plugins.indexOf(target) !== -1) {
      const message =
        '[TallyStore][' +
        this.name +
        '] 插件 "' +
        target.name +
        '" 已安装，忽略重复的 use() 调用。' +
        '同一实例重复安装会丢失卸载函数；如需多份独立副作用，请用插件工厂产生不同实例'
      if (!isProduction()) {
        console.warn(message)
      } else {
        // 生产期控制台静默，但重复安装不能完全不可观测（降级口径）：经 onError(..., 'plugin') 上报
        this._hooks.emit('onError', new TallyStoreError(ErrorCode.INVALID_CONFIG, message, { storeName: this.name, plugin: target.name }), 'plugin')
      }
      return this._createPluginUninstaller(target)
    }

    this._plugins.push(target)
    const installation = {}
    this._pluginInstallations.set(target, installation)

    let uninstall: unknown
    try {
      uninstall = this._withInternalAccess(() => target.install?.(this))
    } catch (error) {
      // 安装失败回滚入列：否则半安装插件常驻列表，重试 use() 会累积重复条目
      const index = this._plugins.indexOf(target)
      if (index !== -1) {
        this._plugins.splice(index, 1)
      }
      this._pluginInstallations.delete(target)
      throw error
    }

    this._pluginUninstallFns.set(target, uninstall as (() => void) | undefined)

    return this._createPluginUninstaller(target, installation)
  }

  /** 创建插件卸载句柄（实现已拆至 ./pluginSupport.js） */
  private _createPluginUninstaller(plugin: PluginType<S>, installation: object | undefined = this._pluginInstallations.get(plugin)): () => void {
    return createPluginUninstaller(plugin, this._plugins, this._pluginUninstallFns, this._pluginInstallations, installation)
  }

  // ==================== 生命周期 ====================

  /** 销毁 Store - 释放所有资源 */
  destroy(): void {
    if (this._destroyed) {
      return // 幂等：重复销毁不报错
    }

    try {
      // 反向卸载插件（后安装的先卸载），含清理过程中重入 use() 新装的那批
      this._drainPluginUninstalls()
      this._notifier.destroy()
      this._hooks.clear()
      this._batchManager.reset()
      this._destroyed = true
    } catch (error) {
      console.error('[TallyStore] Error during Store destruction:', error)
      // 即使出错也标记为销毁，防止半销毁状态
      this._destroyed = true
    } finally {
      // 闸门放在 finally：中途任一步抛错仍要排空重入注册的插件并清空容器；
      // 2~6 步（订阅/钩子清理）也可能重入 use()，故此处再排空一次
      this._drainPluginUninstalls()
      this._plugins = []
      this._pluginUninstallFns.clear()
      this._pluginInstallations.clear()
      // 注销全局注册表条目，释放 name 供后续同名的 Store 使用
      this._unregisterFromRegistry?.()
      this._unregisterFromRegistry = undefined
      // 走重建而非直接换缓存：StateProxyManager 构造时捕获了缓存引用，重建才能放掉旧状态树
      this._rebuildStateProxyManager()
    }
  }

  /** 排空全部在册插件的卸载函数（后装先卸），并接住清理过程中的重入注册 */
  private _drainPluginUninstalls(): void {
    for (let round = 0; this._pluginUninstallFns.size > 0; round++) {
      if (round >= MAX_PLUGIN_UNINSTALL_ROUNDS) {
        if (!isProduction()) {
          console.warn(
            '[TallyStore][' +
              this.name +
              '] 插件清理在 ' +
              MAX_PLUGIN_UNINSTALL_ROUNDS +
              ' 轮内未收敛，' +
              '剩余 ' +
              this._pluginUninstallFns.size +
              ' 个卸载函数被丢弃；请在 install() 的返回函数里做幂等清理，不要在清理中重新 use()',
          )
        }
        return
      }
      for (const plugin of [...this._pluginUninstallFns.keys()].reverse()) {
        const uninstallFn = this._pluginUninstallFns.get(plugin)
        this._pluginUninstallFns.delete(plugin)
        this._pluginInstallations.delete(plugin)
        if (typeof uninstallFn === 'function') {
          try {
            uninstallFn()
          } catch (error) {
            console.error('[TallyStore] Error uninstalling plugin:', error)
          }
        }
      }
    }
  }

  /** Store 是否已被销毁 */
  get destroyed(): boolean {
    return this._destroyed
  }

  // ==================== 状态保护 ====================

  /** 检查状态保护是否启用 */
  isStateProtectionEnabled(): boolean {
    return this._stateProtection.enabled
  }

  /** 动态启用/禁用状态保护 */
  setStateProtection(enabled: boolean): void {
    if (this._destroyed) {
      throw new Error('[TallyStore] Cannot call setStateProtection on a destroyed Store')
    }
    this._stateProtection.enabled = enabled
    this._stateProtectionEnabled = enabled
    if (!enabled) {
      this._rebuildStateProxyManager()
    }
  }

  /** 获取状态保护配置 */
  getStateProtectionConfig(): Readonly<StateProtectionOptions> {
    return { ...this._stateProtection }
  }

  // ==================== 批量更新 ====================

  /** 开始批量更新 */
  startBatch(): void {
    if (this._destroyed) {
      throw new Error('[TallyStore] Cannot call startBatch on a destroyed Store')
    }
    if (!this._batchManager.isInBatch) {
      this._notifier.noteBatchBaseline()
    }
    this._batchManager.start()
  }

  /** 结束批量更新 */
  endBatch(): void {
    if (this._destroyed) {
      throw new Error('[TallyStore] Cannot call endBatch on a destroyed Store')
    }
    this._batchManager.end()
  }

  /** 在批量更新上下文中执行操作 */
  batch<T>(fn: () => T): T {
    if (this._destroyed) {
      throw new Error('[TallyStore] Cannot call batch on a destroyed Store')
    }
    // 走 startBatch/endBatch 而非直接操作 BatchManager：只有 startBatch 记录变更计数基线
    this.startBatch()
    try {
      const result = fn()
      // 异步回调的批语义无法维持：endBatch 在返回 Promise 时立即执行，开发期显式告警
      if (!isProduction() && result instanceof Promise) {
        console.warn(
          '[TallyStore][' +
            this.name +
            '] batch() 收到异步回调：批保护仅覆盖同步段，' +
            'await 之后的变更将逐条通知。请在异步完成后再调用 endBatch()，或把异步段移出 batch',
        )
      }
      return result
    } finally {
      // 回调把 Store 销毁掉了：endBatch 会抛错并顶掉回调返回值/原始错误；销毁已把批语义作废
      if (!this._destroyed) {
        this.endBatch()
      }
    }
  }

  // ==================== 私有方法 ====================

  /** 初始化状态 */
  private _initializeState(state?: S | (() => S)): void {
    const resolvedState = typeof state === 'function' ? (state as () => S)() : state
    // 工厂返回值同样在构造期校验——null/原始值/函数无法作为状态根，
    // 否则会静默建出坏 Store（错误被推迟到首次 setState/$patch 才以无关形式暴露）
    if (resolvedState !== undefined && (resolvedState === null || typeof resolvedState !== 'object')) {
      throw new TypeError('[TallyStore] Store: state factory must return an object, got ' + (resolvedState === null ? 'null' : typeof resolvedState))
    }
    // /：开发期用 state 口径校验整棵初始状态——函数/BigInt/Symbol/循环引用/DOM 是硬不可序列化，
    // 提前指出路径；生产期不因构造校验抛错。Map/Set/Date/类实例根允许存在，不得误杀。
    if (!isProduction()) {
      const paths = findUnserializablePaths(resolvedState, 'state')
      if (paths.length > 0) {
        throw new TallyStoreError(
          ErrorCode.INVALID_CONFIG,
          '[TallyStore] Store "' + this.name + '" 初始状态含不可序列化值（函数/BigInt/Symbol/循环/DOM）：' + paths.join(', '),
          { storeName: this.name, paths },
        )
      }
    }
    // 保留已解析初始状态源的**克隆**（工厂结果 / 对象字面量），$reset 时重新深克隆。
    // 直接保存外部引用会让构造后对 options.state 的修改改变 $reset 的恢复目标，
    // 极端情况下把另一租户/用户的数据带进重置结果
    this._initialStateSource = resolvedState ? deepCloneState(resolvedState) : resolvedState
    // 深拷贝初始状态，防止外部修改 options.state 引用污染 Store 内部状态
    this._state = resolvedState ? deepCloneState(resolvedState) : ({} as S)
  }

  /**
   * 重置为初始状态：身份/租户切换时清理用户切片。
   * - 只影响本模块；订阅关系保持有效（不要求重新绑定）；
   * - 语义 = 以初始状态执行 $replaceState（旧键消失型变更也标脏、通知一次）；
   * - 持久化插件经订阅收到通知后自动把默认值写回存储（敏感草稿随之清理，与持久化联动）；
   * - 可观测性：重置前后 emit beforeReset / afterReset（info 只含 storeName / reason / timestamp / ok），
   *   失败时先发 afterReset(ok=false) 再 rethrow，便于日志/上报定位「状态被谁清空」（关键约束）。
   * @param reason 触发方式：直接调用为 'direct'（默认）；defineStores.resetAll 传 'resetAll'
   */
  $reset(reason: 'direct' | 'resetAll' = 'direct'): void {
    if (this._destroyed) {
      throw new Error('[TallyStore] Cannot call $reset on a destroyed Store')
    }
    const info = { storeName: this.name, reason, timestamp: Date.now() } as const
    this._hooks.emit('beforeReset', info)
    try {
      const initial = this._initialStateSource ? deepCloneState(this._initialStateSource) : ({} as S)
      if (isObject(initial)) {
        this.$replaceState(initial as S)
      } else {
        // 数组 / Map / Set 根：构造期为向后兼容仍然允许（见 $replaceState 注释与既有测试），
        // 但 $replaceState 只接受纯对象入参。reset 的语义是「以初始状态整树替换」，
        // 因此走同一收尾流程，使此类 Store 也能重置
        this._hooks.emit('beforeReplaceState', initial)
        commitStateReplacement(this as unknown as StateReplacementInternals<S>, initial)
        this._hooks.emit('afterReplaceState', initial)
      }
    } catch (error) {
      // 失败也要留下审计事件（ok=false）；hook 处理器内部异常由 HookSystem 隔离，不会覆盖原错误
      this._hooks.emit('afterReset', { ...info, ok: false })
      throw error
    }
    this._hooks.emit('afterReset', { ...info, ok: true })
  }

  /** 初始化 Actions 和 Getters */
  private _initializeActionsAndGetters(actions?: A, getters?: G): void {
    const self = this

    const contextBase: ActionContextBase<S> = {
      name: this.name,
      get state() {
        return self._getActionState()
      },
      setState: this.setState.bind(this),
      $patch: this.$patch.bind(this),
      $replaceState: this.$replaceState.bind(this),
      getState: this.getState.bind(this),
      dispatch: (actionName: string, ...args: unknown[]) => this.dispatch(actionName, ...args),
    }

    this._actionManager.initialize(actions, contextBase)
    this.actions = this._actionManager.actions

    this._getterManager.initialize(getters)
  }

  /** 在内部访问模式下执行操作（内部写入不触发状态保护） */
  private _withInternalAccess<T>(fn: () => T): T {
    const prev = this._isInternalAccess
    this._isInternalAccess = true
    try {
      return fn()
    } finally {
      this._isInternalAccess = prev
    }
  }

  /** Action 写入始终跟踪脏键；onlyOnChange 额外使用变更计数决定是否通知。 */
  private _getActionState(): S {
    return this._createDirtyTrackingProxy(this._state) as S
  }

  /** 重建状态保护 Proxy 管理器（构造、$replaceState、setStateProtection 共用） */
  private _rebuildStateProxyManager(): void {
    this._stateProxyManager = new StateProxyManager<S>({
      protection: this._stateProtection,
      proxyCache: createProxyCache(),
      isInternalAccess: () => this._isInternalAccess,
      // 生产期非法直写无论降级档位都经 onError 上报（silent 只关 console）
      onIllegalMutation: (error) => this._hooks.emit('onError', error, 'stateProtection'),
    })
  }

  /** 创建允许写入的脏跟踪代理（实现已拆至 ./dirtyTracking.js） */
  private _createDirtyTrackingProxy(target: object): object {
    return createDirtyTrackingProxy(target, this._dirtyProxyCache, (rootKeys) => {
      this._notifier.bumpMutation()
      this._notifier.markDirty(rootKeys)
    })
  }

  /** 批量结束通知：onlyOnChange 模式下批量期间无任何变更则跳过 */
  private _onBatchEnd(): void {
    // dispatch 进行中（action 体内使用 store.batch）：批收尾不提前通知，由 dispatch 收尾统一补发
    if (this._actionManager.dispatchDepth > 0) {
      return
    }
    if (!this._notifier.shouldNotifyAfterBatch()) {
      return
    }
    this._scheduleNotify()
  }

  /** 调度一次状态通知（同步 / 异步合并由 StoreNotifier 决定） */
  private _scheduleNotify(): void {
    this._notifier.requestNotify()
  }
}
