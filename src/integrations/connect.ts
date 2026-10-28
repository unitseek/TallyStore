/** 小程序宿主通用的「绑定 / 解绑」骨架：Page、Component、App 共用 */

import type { Store, State, Actions, Getters } from '../types/store.js'
import type { ConnectOptions } from '../types/plugin.js'
import {
  validateMappingDeclarations,
  createStoreSubscriber,
  bindMapperPair,
  subscribeMappers,
  bindActions,
  cleanupBindings,
  bindWithRollback,
  createUpdatesWriter,
  createPayloadGuard,
  DEFAULT_MAX_PAYLOAD_BYTES,
  type Mappings,
} from './utils.js'
import { isProduction } from '../core/store/utils.js'
import { TallyStoreError, ErrorCode } from '../core/errors/TallyStoreError.js'
import { createBackgroundGate } from './visibility.js'
import { estimateJsonBytes } from '../core/utils/helpers.js'

/** 宿主差异点：不同入口只提供这一组取值/写入函数 */
export interface HostSpec<H> {
  /** 出错信息里的入口名，如 withPageStore */
  label: string
  /** 把一轮映射写入宿主（Page/Component 是 setData，App 是 globalData） */
  write(host: H, updates: Record<string, unknown>): void
  /** action 绑定目标；返回 undefined 表示该入口的 action 在别处绑定（Component 并入 methods） */
  actionTarget?(host: H): Record<string, unknown> | undefined
  /** 宿主实例的渲染器（Skyline 实例上有 renderer 属性），用于 schedule: 'auto' */
  readRenderer?(host: H): 'skyline' | undefined
}

/** 宿主实例 → store → 该 store 的绑定列表；按 store 分槽，同一配置叠加多个装饰器互不覆盖 */
const hostBindings = new WeakMap<object, Map<object, Array<() => void>>>()

/** 映射类别：同一本地键跨类别会写入不同命名空间或同一份 data/globalData 载荷 */
type MappingKind = 'mapState' | 'mapGetters' | 'mapActions'

/** 宿主实例 → 本地键 → 占用该键的 store 与映射类别（多 Store 冲突 + 同 Store 跨类别冲突检测） */
interface LocalKeyOwner {
  store: object
  kind: MappingKind
}
const hostLocalKeyOwners = new WeakMap<object, Map<string, LocalKeyOwner>>()

/**
 * 宿主实例 → 宿主「自有」data 键快照。只在首次绑定时采集：之后映射写入会把键写进
 * host.data，重入绑定（重复 onLoad）时不能把映射自己写的键误判为宿主自有键。
 */
const hostOwnDataKeys = new WeakMap<object, Set<string>>()

function bindingListFor(host: object, store: object): Array<() => void> {
  let byStore = hostBindings.get(host)
  if (byStore === undefined) {
    byStore = new Map()
    hostBindings.set(host, byStore)
  }
  let list = byStore.get(store)
  if (list === undefined) {
    list = []
    byStore.set(store, list)
  }
  return list
}

/**
 *  绑定期冲突检测：同一本地键被多个 Store 映射、或与宿主自有 data 键同名。
 * 开发期抛 INVALID_MAPPING；生产期剔除该键（跳过映射）并经 onError 上报，不阻塞渲染。
 * 返回实际可用的映射（冲突键已剔除）；同 store 重入（重复 onLoad）不视为冲突。
 */
function claimLocalKeys<S extends State>(host: object, store: Store<S>, mappings: Mappings, label: string): Mappings {
  let owners = hostLocalKeyOwners.get(host)
  if (owners === undefined) {
    owners = new Map()
    hostLocalKeyOwners.set(host, owners)
  }
  // 宿主自有 data 键：首次绑定快照一次；重入时复用快照（映射写入的键不算宿主自有）
  let dataKeys = hostOwnDataKeys.get(host)
  if (dataKeys === undefined) {
    const hostData = (host as { data?: unknown }).data
    dataKeys = hostData !== null && typeof hostData === 'object' ? new Set(Object.keys(hostData as Record<string, unknown>)) : new Set<string>()
    hostOwnDataKeys.set(host, dataKeys)
  }

  const skip = (localKey: string, kind: MappingKind, reason: string): void => {
    const error = new TallyStoreError(ErrorCode.INVALID_MAPPING, reason, { host: label, localKey, mapping: kind })
    if (isProduction()) {
      store.hooks.emit('onError', error, 'mapping')
      delete (kind === 'mapState' ? mappings.stateMapping : kind === 'mapGetters' ? mappings.gettersMapping : mappings.actionsMapping)[localKey]
    } else {
      throw error
    }
  }

  for (const kind of ['mapState', 'mapGetters', 'mapActions'] as const) {
    const mapping = kind === 'mapState' ? mappings.stateMapping : kind === 'mapGetters' ? mappings.gettersMapping : mappings.actionsMapping
    for (const localKey of Object.keys(mapping)) {
      const owner = owners.get(localKey)
      if (owner !== undefined) {
        if (owner.store !== store) {
          skip(
            localKey,
            kind,
            '[' +
              label +
              '] 本地键 "' +
              localKey +
              '" 已被另一个 store 的映射占用，同一宿主上多 Store 不能映射同一本地键（后写者会覆盖先写者的下发，先解绑方还会恢复掉后绑定方的成员）',
          )
          continue
        }
        // 同一 store 的同一本地键跨类别：只有 mapState 与 mapGetters 会写入同一份
        // data/globalData 载荷，运行期后写者（getter）会静默覆盖先写者，必须按映射冲突处理；
        // mapActions 绑定的是实例成员（页面/App 顶层属性、组件 methods），与 data 载荷不同命名空间，
        // 允许与 data 映射共用本地名。重入绑定不会走到这里（connectHost 已先 release 旧占用）
        const sharesDataPayload = owner.kind !== 'mapActions' && kind !== 'mapActions'
        if (sharesDataPayload && owner.kind !== kind) {
          skip(
            localKey,
            kind,
            '[' +
              label +
              '] 本地键 "' +
              localKey +
              '" 已作为 ' +
              owner.kind +
              ' 映射，不能再作为 ' +
              kind +
              ' 映射：两者写入同一份 data/globalData 载荷，后写者会静默覆盖先写者（请用对象形态映射重命名）',
          )
          continue
        }
        // actions 与 data 同名合法共存：保留先登记的 owner（数据类别），供后续 mapGetters 冲突判定
      }
      if (dataKeys.has(localKey)) {
        skip(localKey, kind, '[' + label + '] 本地键 "' + localKey + '" 与宿主自有 data 同名，映射会覆盖宿主初始值；请改用其它本地名（对象形态映射可重命名）')
        continue
      }
      if (owner === undefined) {
        owners.set(localKey, { store, kind })
      }
    }
  }
  return mappings
}

/** 释放该 store 在宿主实例上占用的全部本地键（disconnectHost 调用） */
function releaseLocalKeys(host: object, store: object): void {
  const owners = hostLocalKeyOwners.get(host)
  if (owners === undefined) return
  for (const [localKey, owner] of owners) {
    if (owner.store === store) owners.delete(localKey)
  }
  if (owners.size === 0) {
    hostLocalKeyOwners.delete(host)
  }
}

/**
 *  实例级订阅计数：每个 (host, store) 绑定自己建立了多少条映射订阅（0 或 1；
 * 同一绑定的 state/getters 两个 mapper 共用一条订阅）。解绑时据此判断「本实例的订阅该退掉几条」，
 * 用于同步兜底与延迟复核（验收 4：计数 >0 且持续超过一个 tick 才告警）。
 */
interface BindingSubscriptionState {
  /** 本绑定创建的映射订阅数（空映射/仅 actions 时为 0） */
  count: number
  /** 泄漏告警已发出：同步兜底或延迟复核只报一次（重复 disconnect 也不会重复告警） */
  reported: boolean
}

/** (host, store) → 本绑定建立的实例级订阅计数与告警状态 */
const hostBindingSubscriptions = new WeakMap<object, Map<object, BindingSubscriptionState>>()

/** 集成层累计创建的映射订阅数：延迟复核时扣减复核窗口内新建的合法订阅，避免把新页面误判为泄漏 */
let integrationSubscriptionsCreated = 0

/** 默认的泄漏复核调度：微任务（queueMicrotask，缺失时回退 Promise.then） */
const defaultLeakRecheckScheduler = (callback: () => void): void => {
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(callback)
    return
  }
  Promise.resolve().then(callback)
}

/** 泄漏复核调度器（测试可注入同步/手动调度；默认微任务） */
let scheduleLeakRecheck: (callback: () => void) => void = defaultLeakRecheckScheduler

/** 仅供测试：注入泄漏复核调度器（传 undefined 还原默认微任务；不进入包入口 API） */
export function __setLeakRecheckSchedulerForTests(scheduler?: (callback: () => void) => void): void {
  scheduleLeakRecheck = scheduler ?? defaultLeakRecheckScheduler
}

/** 仅供测试：读取某 (host, store) 绑定的实例级订阅计数（未绑定返回 0） */
export function __getBindingSubscriptionCountForTests(host: object, store: object): number {
  return hostBindingSubscriptions.get(host)?.get(store)?.count ?? 0
}

function setBindingSubscriptionState(host: object, store: object, state: BindingSubscriptionState): void {
  let byStore = hostBindingSubscriptions.get(host)
  if (byStore === undefined) {
    byStore = new Map()
    hostBindingSubscriptions.set(host, byStore)
  }
  byStore.set(store, state)
}

function deleteBindingSubscriptionState(host: object, store: object): void {
  const byStore = hostBindingSubscriptions.get(host)
  if (byStore === undefined) return
  byStore.delete(store)
  if (byStore.size === 0) hostBindingSubscriptions.delete(host)
}

/** 清理失败绑定的空槽与旧订阅标记（本地键由 releaseLocalKeys 单独释放） */
function clearFailedBinding(host: object, store: object): void {
  deleteBindingSubscriptionState(host, store)
  const byStore = hostBindings.get(host)
  if (byStore !== undefined) {
    byStore.delete(store)
    if (byStore.size === 0) hostBindings.delete(host)
  }
}

/** 订阅计数只读视图：泄漏检测只依赖这两个成员，避免把 Store 泛型带进解绑路径 */
interface SubscriptionCountStore {
  getSubscriptionCount?: () => number
  hooks?: { emit?: (event: 'onError', error: unknown, source?: string) => void }
  name?: string
}

/** 读取订阅计数：无 API / 抛错统一返回 -1（不可判定，不做泄漏告警） */
function readSubscriptionCount(store: SubscriptionCountStore): number {
  if (typeof store.getSubscriptionCount !== 'function') return -1
  try {
    return store.getSubscriptionCount()
  } catch {
    return -1
  }
}

/** 发出一条泄漏告警：开发期 console.warn + onError('unbind')，生产期仅 onError（只报一次由调用方保证） */
function emitSubscriptionLeak(store: SubscriptionCountStore, message: string): void {
  if (!isProduction()) {
    console.warn(message)
  }
  try {
    store.hooks?.emit?.('onError', new Error(message), 'unbind')
  } catch {
    // 上报通道异常不外溢：泄漏告警自身不能制造崩溃
  }
}

/** 组装泄漏告警文案：保留「订阅计数未下降」短语，同步兜底与延迟复核共用 */
function buildSubscriptionLeakMessage(store: SubscriptionCountStore, countBefore: number, countAfter: string, detail: string): string {
  return '[TallyStore] 宿主解绑后订阅计数未下降（解绑前 ' + countBefore + '，' + countAfter + '，store "' + String(store.name ?? '(unknown)') + '"）：' + detail
}

/**
 * 解绑某个 store 在宿主实例上的全部绑定（Page onUnload / Component detached / 手动 unbindStore）。
 *
 *  泄漏检测分两层：
 * ① 同步快速兜底：解绑前后全局订阅计数未按本实例订阅数下降 → 立即告警（既有行为，避免破坏测试）；
 * ② 实例级延迟复核：微任务后若「本绑定订阅数」仍 >0（全局计数未降到预期剩余）才告警，
 *    覆盖退订延迟生效/异步清理的失效率场景；两层共用 reported 标记，每次解绑最多上报一次。
 * 重复 disconnect 幂等：绑定列表已删除，第二次直接返回，不会重复调度复核。
 */
export function disconnectHost(host: object, store: object): void {
  const byStore = hostBindings.get(host)
  const list = byStore?.get(store)
  if (byStore === undefined || list === undefined) {
    return
  }
  const countStore = store as SubscriptionCountStore
  const subscriptionState = hostBindingSubscriptions.get(host)?.get(store)
  const hadSubscription = subscriptionState !== undefined && subscriptionState.count > 0
  // 同步路径的计数读取保持「异常向上抛」：生命周期清理隔离依赖该异常经 runLifecycleCleanup 上报，
  // 不能在解绑路径里吞掉；延迟复核（另一个 tick 后）才用安全读取（不可判定就不告警）
  const countBefore = typeof countStore.getSubscriptionCount === 'function' ? countStore.getSubscriptionCount() : -1
  cleanupBindings(list)
  byStore.delete(store)
  if (byStore.size === 0) {
    hostBindings.delete(host)
  }
  releaseLocalKeys(host, store)
  deleteBindingSubscriptionState(host, store)
  if (!hadSubscription || subscriptionState === undefined || countBefore <= 0) {
    return
  }

  // ① 同步快速兜底：解绑后计数未下降 → 退订失效，立即告警（读取异常同样向上抛，交给清理隔离通道）
  const countAfter = typeof countStore.getSubscriptionCount === 'function' ? countStore.getSubscriptionCount() : -1
  if (countAfter >= countBefore) {
    subscriptionState.reported = true
    emitSubscriptionLeak(
      countStore,
      buildSubscriptionLeakMessage(
        countStore,
        countBefore,
        '解绑后 ' + (countAfter < 0 ? '不可读' : countAfter),
        '退订可能失效，存在幽灵更新与内存泄漏风险；请检查绕过集成层建立的订阅',
      ),
    )
    return
  }

  // ② 实例级延迟复核：一个 tick 后本绑定的订阅仍未退掉（计数高于「解绑前 - 本实例订阅数」）才告警
  const expectedRemaining = countBefore - subscriptionState.count
  const seqAtSchedule = integrationSubscriptionsCreated
  scheduleLeakRecheck(() => {
    if (subscriptionState.reported) return
    const countDelayed = readSubscriptionCount(countStore)
    if (countDelayed < 0) return
    // 复核窗口内新建的集成订阅是合法增长，从计数差里扣掉
    const newlyCreated = integrationSubscriptionsCreated - seqAtSchedule
    const stillOwned = countDelayed - expectedRemaining - newlyCreated
    if (stillOwned <= 0) return
    subscriptionState.reported = true
    emitSubscriptionLeak(
      countStore,
      buildSubscriptionLeakMessage(
        countStore,
        countBefore,
        '下一个 tick 后 ' + countDelayed,
        '本实例的映射订阅在解绑一个 tick 后仍未退掉，存在幽灵更新与内存泄漏风险；请检查退订函数是否失效',
      ),
    )
  })
}

/**
 * 手动解绑某个 store 在宿主实例上的全部绑定。
 *
 * 用于生命周期解绑（onUnload / detached）之外提前解绑的场景：页面内条件性退出某
 * Store 的映射、长驻页面释放不再使用的切片。幂等：未绑定时调用无副作用。
 */
export function unbindStore(host: object, store: object): void {
  disconnectHost(host, store)
}

/**
 * 建立一次宿主绑定。
 *
 * 不变量（与逐个入口手写时完全一致）：
 * - 重入进入时先清理上一轮绑定，否则订阅会叠加到卸载阶段。
 * - 先建订阅、再绑 action；任一步抛错时回滚本次已登记的绑定并原样重抛。
 */
export function connectHost<H, S extends State, A extends Actions, G extends Getters<S>>(
  store: Store<S, A, G>,
  options: ConnectOptions<S, A, G>,
  host: H,
  spec: HostSpec<H>,
): Mappings {
  const list = bindingListFor(host as unknown as object, store)
  // 同一 store 重新进入（重复 onLoad/attached）先清旧绑定，避免订阅叠加；
  // 同时释放旧本地键占用，再由 claimLocalKeys 按本次映射重新登记
  cleanupBindings(list)
  releaseLocalKeys(host as unknown as object, store as unknown as object)

  //  绑定期统一校验：声明存在性（开发期抛错/生产剔除上报）→ 宿主本地键占用与 data 冲突
  const { stateMapping, gettersMapping, actionsMapping } = claimLocalKeys(
    host as unknown as object,
    store,
    validateMappingDeclarations(store, options, spec.label),
    spec.label,
  )

  // Skyline 的渲染在独立线程：把同一 tick 的多轮映射合并为一次 setData，减少跨线程传递。
  // 'auto' 只对 Skyline 实例生效，WebView 保持逐次写入；初始映射由 flushNow 同步交付。
  const schedule = options.schedule ?? 'auto'
  const renderer = spec.readRenderer?.(host)
  const microtask = schedule === 'microtask' || (schedule === 'auto' && renderer === 'skyline')
  //  载荷守卫：包在 writer 之下、spec.write 之上，估算的是合并后真正下发的那份载荷。
  // 指标：守卫本来就要估算字节数，把结果顺手上报（超阈值关闭守卫时不计）
  const guardPayload = createPayloadGuard(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, spec.label, (error) => {
    store.hooks.emit('onError', error, 'payload')
  })
  let hostWriteMetrics: ((bytes: number) => void) | undefined
  if (options.maxPayloadBytes !== 0) {
    hostWriteMetrics = (bytes) => store.hooks.emit('onHostWrite', { bytes, host: spec.label })
  }
  //  宿主写入失败统一包装为 HOST_WRITE_ERROR 后原样重抛：
  // - 同步模式：包装错误经 mapper → StoreNotifier 的监听器异常通道上报（source 'notify'），单次不重复
  // - 微任务模式：包装错误被 writer 的 flush 捕获后经 onError 回调上报（source 入口名），单次不重复
  // - 初始映射（flushNow）：包装错误抛给宿主框架归因（bindWithRollback 回滚绑定后重抛）
  // message 保留原始错误文本，cause 保留原始错误对象
  const writeHost = (updates: Record<string, unknown>): void => {
    // 字节只估算一次，载荷守卫与指标共用（大载荷避免二次 stringify）。
    // 钩子（onHostWrite / onError）由 HookSystem 逐 handler 隔离，处理器异常不会中断本次写入。
    // maxPayloadBytes=0 时载荷守卫关闭且指标不建（上方 hostWriteMetrics 为空），
    // 两个消费者都不活跃——跳过整树 JSON 估算，避免显式关闭守卫的用户反而承担热路径序列化成本。
    const bytes = options.maxPayloadBytes === 0 ? -1 : estimateJsonBytes(updates)
    guardPayload(updates, bytes)
    try {
      spec.write(host, updates)
    } catch (error) {
      throw new TallyStoreError(
        ErrorCode.HOST_WRITE_ERROR,
        '[' + spec.label + '] 映射写入宿主失败：' + (error instanceof Error ? error.message : String(error)),
        { host: spec.label, fields: Object.keys(updates) },
        error,
      )
    }
    // 写入成功后才计指标——onHostWrite 的口径是「一次映射写入宿主完成」，
    // 写入失败/被守卫拦截的载荷不应被算作已下发字节
    if (hostWriteMetrics !== undefined && bytes >= 0) {
      hostWriteMetrics(bytes)
    }
  }

  const writer = createUpdatesWriter(writeHost, microtask, (error) => {
    if (!isProduction()) {
      console.error('[' + spec.label + '] 映射更新写入失败：', error)
    }
    store.hooks.emit('onError', error, spec.label)
  })

  //  前后台策略：默认启用——后台期间映射写入不下发（合并缓存），onShow 按最新状态
  // 一次性对齐；backgroundUpdates: false 关闭（立即更新，供需要后台实时数据的页面）。
  // 可见性信号由入口包装 onHide/onShow 驱动（见 with-store / with-component）；
  // 宿主未走生命周期时标志恒为可见，自动回退立即更新（正确性优先）。
  const backgroundGateEnabled = options.backgroundUpdates !== false
  const backgroundGate = backgroundGateEnabled
    ? createBackgroundGate(host as unknown as object, writer.write, (error) => {
        // 回前台对齐的缓存写入失败：按入口名上报（此前异常被 markHostHidden 的空 catch 吞掉）
        store.hooks.emit('onError', error, spec.label)
      })
    : undefined
  const deliver = backgroundGate !== undefined ? backgroundGate.gatedWrite : writer.write

  //  跨 mapper 合并：同一轮通知内 state / getter 两个 mapper 的写入合并为一次下发
  // （WebView 此前各 1 次共 2 次；Skyline 依赖微任务合并，现在通知内即合并）。
  // 初始映射（构造期 setter）不经过通知监听，不受影响（flushNow 已合并）
  let notifying = false
  let notificationBatch: Record<string, unknown> | undefined
  const batchedDeliver = (updates: Record<string, unknown>): void => {
    if (!notifying) {
      deliver(updates)
      return
    }
    const merged = notificationBatch ?? {}
    notificationBatch = merged
    for (const key of Object.keys(updates)) {
      Object.defineProperty(merged, key, { value: updates[key], writable: true, enumerable: true, configurable: true })
    }
  }
  /**
   * 监听器外壳：进入通知段收集、退出时一次性下发（mapper 抛错也照常下发已收集部分）。
   * run() 抛错时若 finally 里的下发也失败，必须保留原始 mapper 错误优先——
   * 下发失败降级为 onError 次级上报（source 'notify'，与监听器异常通道同口径），
   * 否则调用方只能看到 HOST_WRITE_ERROR，看不到真正的根因（getter/state 访问异常）。
   */
  const withBatching = (run: () => void): (() => void) => {
    return () => {
      notifying = true
      let runError: unknown
      let hasRunError = false
      try {
        run()
      } catch (error) {
        runError = error
        hasRunError = true
      }
      notifying = false
      const batch = notificationBatch
      notificationBatch = undefined
      if (batch !== undefined) {
        try {
          deliver(batch)
        } catch (writeError) {
          if (!hasRunError) {
            throw writeError
          }
          try {
            store.hooks.emit('onError', writeError, 'notify')
          } catch {
            // 次级上报通道自身失败时放弃，原始 mapper 错误仍向上传播
          }
        }
      }
      if (hasRunError) {
        throw runError
      }
    }
  }

  try {
    bindWithRollback(spec.label, list, () => {
      // 取消先登记：即使后续绑定抛错，也不能让挂起的微任务在已回滚的实例上写数据
      list.push(() => writer.cancel())
      if (backgroundGate !== undefined) {
        list.push(() => backgroundGate.dispose())
      }
      const hasMappers = Object.keys(stateMapping).length > 0 || Object.keys(gettersMapping).length > 0
      const { unsubscribe, runMappers } = subscribeMappers(
        createStoreSubscriber(store),
        bindMapperPair(store, stateMapping, gettersMapping, batchedDeliver),
        withBatching,
      )
      // 先登记退订再注册对齐回调——registerRealign 若抛错，回滚列表必须已包含 unsubscribe，
      // 否则刚建立的订阅会永久泄漏（宿主已解绑、store 仍在回调已失效实例）
      list.push(unsubscribe)
      // 对齐 = 以最新状态重跑全部 mapper（一次合并下发，不重放中间态）
      if (backgroundGate !== undefined && hasMappers) {
        backgroundGate.registerRealign(withBatching(runMappers))
      }
      // 记录本绑定建立的实例级订阅计数（state/getters 共用一条；空映射无订阅）。
      // 重绑定时按本次实际形态覆盖，避免上一轮的旧标记误判；延迟复核依赖该计数推导「预期剩余」。
      setBindingSubscriptionState(host as unknown as object, store as unknown as object, {
        count: hasMappers ? 1 : 0,
        reported: false,
      })
      if (hasMappers) {
        integrationSubscriptionsCreated += 1
      }
      const actionTarget = spec.actionTarget?.(host)
      if (actionTarget !== undefined) {
        list.push(...bindActions(actionTarget, actionsMapping, store))
      }
      // 初始映射同步交付：onLoad/attached 内的用户代码仍能立刻读到映射后的 data
      writer.flushNow()
    })
  } catch (error) {
    // 失败的绑定不得留下本地键占用与旧登记——否则同一宿主上另一 store 之后映射同名键
    // 会被误判冲突（开发期直接抛 INVALID_MAPPING），直到宿主解绑才恢复。清理后原样重抛。
    releaseLocalKeys(host as unknown as object, store as unknown as object)
    clearFailedBinding(host as unknown as object, store as unknown as object)
    throw error
  }
  // 返回本次绑定实际生效的映射（声明校验 + 本地键占用校验后的结果）：Component 集成
  // 据此合并 action methods，生产期被剔除的非法/冲突键不会留下幽灵方法
  return { stateMapping, gettersMapping, actionsMapping }
}
