/** TallyStore - 微信小程序集成原语 */

import type { Store, State } from '../types/store.js'
import { isProduction } from '../core/store/utils.js'
import { TallyStoreError, ErrorCode } from '../core/errors/TallyStoreError.js'
import { isMapLike, isSetLike } from '../core/store/proxyCore.js'
import { estimateJsonBytes } from '../core/utils/helpers.js'
import { findUnserializablePaths } from '../core/utils/serializable.js'
export { estimateJsonBytes }

/** 映射本地键禁止携带 setData 路径语法；原型敏感键一律拒绝 */
const RESERVED_MAPPING_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function assertMappingKey(key: PropertyKey, source: 'local' | 'store'): string {
  if (typeof key === 'symbol') {
    // symbol 键会被 String() 归一成 'Symbol(x)'，永远命不中真实状态键，静默失效比拒绝更糟
    throw new TypeError('[TallyStore] mapping does not support symbol keys (got ' + String(key) + '); use a string/number key instead')
  }
  const normalized = String(key)
  if (source === 'local' && (RESERVED_MAPPING_KEYS.has(normalized) || /[.[\]]/.test(normalized))) {
    // setData 支持 'a.b' / 'list[0]' 路径写法，本地键必须只有字段名语义
    throw new TypeError(
      '[TallyStore] mapping local key "' +
        normalized +
        '" is not allowed: use a plain field name without "." / "[" / "]" and without prototype-sensitive names',
    )
  }
  return normalized
}

/** 解析映射配置，返回统一的新键值对映射（与入参不共享引用） */
export function parseMapping(mapping: ReadonlyArray<PropertyKey> | Record<string, PropertyKey>): Record<string, string> {
  // 两个分支统一走一次归一化后返回新对象：对象分支直接返回入参会让调用方对解析结果的
  // 写入回灌用户配置，且数字/符号值未经 String 归一无法按 storeKey 查表
  const result: Record<string, string> = {}
  if (Array.isArray(mapping)) {
    for (const key of mapping) {
      const normalized = assertMappingKey(key, 'local')
      setOwnEntry(result, normalized, normalized)
    }
    return result
  }
  // Object.entries 只返回字符串键，symbol 本地键会被静默丢弃；显式拒绝，
  // 与「symbol 静默失效比直接报错更糟」的数组分支口径一致
  for (const symbolKey of Object.getOwnPropertySymbols(mapping)) {
    assertMappingKey(symbolKey, 'local')
  }
  for (const [key, value] of Object.entries(mapping)) {
    const local = assertMappingKey(key, 'local')
    setOwnEntry(result, local, assertMappingKey(value, 'store'))
  }
  return result
}

/** 以自有数据属性写入映射项：`'__proto__'` 用普通赋值会命中 Object.prototype 的 setter */
function setOwnEntry<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
}

/**
 * 某键能否被写成（或被改写成）target 的自有属性。
 * 导出供 Component 集成复用：组件绑定路径与 bindActions 必须是同一套可写判定。
 */
export function canOwnKey(target: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  if (!descriptor) {
    return Object.isExtensible(target)
  }
  return descriptor.configurable || descriptor.writable === true
}

/**
 * 以指定值覆写宿主键，并沿用原成员的 enumerable / configurable。
 * 导出供 Component 集成复用：两条绑定路径共用同一写入语义，避免各自复制后漂移。
 */
export function defineOwnValue(target: Record<string, unknown>, key: string, value: unknown, original: PropertyDescriptor | undefined): void {
  const locked = original !== undefined && !original.configurable
  Object.defineProperty(target, key, {
    value,
    writable: true,
    // 保留原 enumerable：硬编 true 会在绑定期间把宿主的非枚举属性翻成枚举，解绑才复原
    enumerable: original ? original.enumerable : true,
    configurable: locked ? false : true,
  })
}

/** 参与解析的三类映射字段（结构类型，避免耦合具体泛型） */
interface MappableOptions {
  mapState?: ReadonlyArray<PropertyKey> | Record<string, PropertyKey>
  mapGetters?: ReadonlyArray<PropertyKey> | Record<string, PropertyKey>
  mapActions?: ReadonlyArray<PropertyKey> | Record<string, PropertyKey>
}

/** 装饰期校验连接选项：早失败优于 onLoad/attached 里才抛 */
export function assertConnectOptions(options: unknown): void {
  // 结构性误用（非对象/数组）保持 TypeError；语义性取值非法用 INVALID_CONFIG 码
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('[TallyStore] connect options must be a plain object')
  }
  const schedule = (options as { schedule?: unknown }).schedule
  if (schedule !== undefined && schedule !== 'auto' && schedule !== 'sync' && schedule !== 'microtask') {
    throw new TallyStoreError(
      ErrorCode.INVALID_CONFIG,
      '[TallyStore] connect options.schedule must be "auto" | "sync" | "microtask", got ' + String(schedule),
      { option: 'schedule', value: String(schedule) },
    )
  }
  const maxPayloadBytes = (options as { maxPayloadBytes?: unknown }).maxPayloadBytes
  if (maxPayloadBytes !== undefined && (typeof maxPayloadBytes !== 'number' || !Number.isFinite(maxPayloadBytes) || maxPayloadBytes < 0)) {
    throw new TallyStoreError(
      ErrorCode.INVALID_CONFIG,
      '[TallyStore] connect options.maxPayloadBytes must be a non-negative finite number (0 disables the guard), got ' + String(maxPayloadBytes),
      { option: 'maxPayloadBytes', value: String(maxPayloadBytes) },
    )
  }
}

/** 三类映射表的统一形态（本地名 → store 键） */
export interface Mappings {
  stateMapping: Record<string, string>
  gettersMapping: Record<string, string>
  actionsMapping: Record<string, string>
}

/** 解析 ConnectOptions 的三类映射（未提供则为空对象） */
export function resolveMappings(options: MappableOptions): Mappings {
  return {
    stateMapping: options.mapState ? parseMapping(options.mapState) : {},
    gettersMapping: options.mapGetters ? parseMapping(options.mapGetters) : {},
    actionsMapping: options.mapActions ? parseMapping(options.mapActions) : {},
  }
}

// ==================== 映射校验 ====================

/**
 * 只依赖错误上报通道的最小 Store 结构：多个集成 helper 需要向 store.hooks 转投
 * onError；集中一处声明，避免各文件内联结构类型与真实 HookSystem.emit 契约漂移。
 */
export interface ErrorReportingStore {
  hooks: { emit(event: 'onError', error: unknown, source?: string): void }
}

/** 映射声明校验所需的 Store 能力（结构类型，避免泛型耦合） */
interface MappableStore extends ErrorReportingStore {
  name: string
  getState(): object
  getterNames(): string[]
  actions: Record<string, unknown>
}

/**
 * 装饰期校验映射声明：mapState / mapGetters / mapActions 的 storeKey 必须存在于 Store 声明。
 *
 *  口径：开发期抛 TallyStoreError(INVALID_MAPPING) 并指出 Store 与字段名；
 * 生产期剔除非法键（跳过该映射）并经 onError 上报，不阻塞页面渲染。
 * 返回净化后的三类映射（与 resolveMappings 同形态，非法键已移除）。
 *
 * mode='silent'：只做剔除、不抛错也不上报，供装饰期「静默预净化」使用（如
 * withComponentStore 构建配置级 methods）：绑定期 connectHost 会再校验一次并统一上报，
 * 静默模式避免同一非法键被上报两次；生产期之外不使用。
 */
export function validateMappingDeclarations(store: MappableStore, options: MappableOptions, label: string, mode: 'strict' | 'silent' = 'strict'): Mappings {
  const { stateMapping, gettersMapping, actionsMapping } = resolveMappings(options)
  const stateKeys = Object.keys(store.getState() as Record<string, unknown>)
  const getterKeys = store.getterNames()
  const actionKeys = Object.keys(store.actions)

  const check = (mapping: Record<string, string>, kind: 'mapState' | 'mapGetters' | 'mapActions', available: string[]): void => {
    for (const localKey of Object.keys(mapping)) {
      const storeKey = mapping[localKey]
      if (available.includes(storeKey)) continue
      const message =
        '[' +
        label +
        '] ' +
        kind +
        ' 映射的字段 "' +
        storeKey +
        '"（本地名 "' +
        localKey +
        '"）在 store "' +
        store.name +
        '" 中不存在。' +
        '可用字段：' +
        (available.length > 0 ? available.join(', ') : '(无)')
      if (mode === 'silent') {
        // 静默预净化：只剔除，不抛出也不上报（上报由绑定期校验统一负责）
        delete mapping[localKey]
        continue
      }
      const error = new TallyStoreError(ErrorCode.INVALID_MAPPING, message, {
        storeName: store.name,
        mapping: kind,
        localKey,
        storeKey,
        available,
      })
      if (isProduction()) {
        // 生产降级：跳过该键（从映射表剔除），上报后继续
        store.hooks.emit('onError', error, 'mapping')
        delete mapping[localKey]
      } else {
        throw error
      }
    }
  }

  check(stateMapping, 'mapState', stateKeys)
  check(gettersMapping, 'mapGetters', getterKeys)
  check(actionsMapping, 'mapActions', actionKeys)
  return { stateMapping, gettersMapping, actionsMapping }
}

/** 判断初始映射值是否「直接映射不可序列化」，是则返回种类标签，否则 null（同一口径） */
export function unserializableKind(value: unknown): string | null {
  if (typeof value === 'function') return '函数'
  // bigint/symbol 不是 JSON 可序列化值（BigInt 抛错、symbol 被静默丢弃），
  // 必须在开发期 fail-fast 指出字段，而不是退化成难定位的 HOST_WRITE_ERROR
  if (typeof value === 'bigint') return 'BigInt'
  if (typeof value === 'symbol') return 'Symbol'
  if (value === null || typeof value !== 'object') return null
  if (isMapLike(value)) return 'Map'
  if (isSetLike(value)) return 'Set'
  if (Array.isArray(value)) return cycleOrNull(value)
  const proto = Object.getPrototypeOf(value)
  // 纯对象（含 Object.create(null)）可序列化；Date/RegExp 由 setData 序列化支持，放行；其余为类实例
  if (proto === Object.prototype || proto === null) return cycleOrNull(value)
  if (value instanceof Date || value instanceof RegExp) return null
  return '类实例'
}

/** 纯对象/数组的循环引用探测：estimateJsonBytes 返回 -1 即不可序列化（含子字段 BigInt） */
function cycleOrNull(value: object): string | null {
  // 循环引用探测需要一次完整 JSON.stringify + 逐码点计数。生产期不做这次整树估算，
  // 由载荷守卫与 HOST_WRITE_ERROR 兜底真正的下发失败（与 assertMappedValueSerializable
  // 文档口径一致）；开发期保留早失败收益。bigint/symbol/Map/Set 等廉价判定两期都保留。
  if (isProduction()) return null
  return estimateJsonBytes(value) === -1 ? '循环引用（或子字段含 BigInt）' : null
}

/**
 * 绑定期校验单个映射值的可序列化性（初始映射时逐键检查）。
 * 开发期抛 INVALID_MAPPING 并指出字段；生产期上报并放行（交付链路自身的
 * HOST_WRITE_ERROR / 载荷守卫会兜底真正的下发失败）。
 */
export function assertMappedValueSerializable(
  storeName: string,
  localKey: string,
  kind: string,
  value: unknown,
  report: (error: TallyStoreError) => void,
): void {
  const kindLabel = unserializableKind(value)
  if (kindLabel === null) return
  const message =
    '[TallyStore] ' +
    kind +
    ' 映射字段 "' +
    localKey +
    '"（store "' +
    storeName +
    '"）的值不可直接映射：' +
    kindLabel +
    '。请在 action 内派生普通数据后再映射（setData 不接受函数；Map/Set 需派生数组/对象）'
  const error = new TallyStoreError(ErrorCode.INVALID_MAPPING, message, { storeName, localKey, mapping: kind })
  if (isProduction()) {
    report(error)
  } else {
    throw error
  }
}

/** 把 source 的自有可枚举键逐个写进 target（等价于 Object.assign，但按自有属性写入） */
export function copyOwnEntries(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    setOwnEntry(target, key, value)
  }
}

/**
 * 浅拷贝宿主配置并保留原型，Page/Component/App 三入口共用：
 * - 类实例 / Object.create 组织的配置，其原型上的生命周期/方法不能丢（展开只复制自有属性）；
 * - 用展开（CreateDataProperty 语义）复制自有属性，再单独恢复原型——Object.assign 的 [[Set]]
 *   在配置自带可枚举 "__proto__" 键时会命中原型 setter，替换返回对象的原型（原型污染）。
 */
export function copyConfigPreservingPrototype<T extends object>(config: T): T {
  const copy = { ...(config as Record<string, unknown>) } as T
  Object.setPrototypeOf(copy, Object.getPrototypeOf(config))
  return copy
}

/** 生成绑定到 store 的订阅函数（readOnly 透传），供 Page/Component/App 集成共用 */
export function createStoreSubscriber<S extends State>(store: Store<S>): (callback: () => void, subscribeOptions?: { readOnly?: boolean }) => () => void {
  return (callback: () => void, subscribeOptions?: { readOnly?: boolean }) => store.subscribe(callback, subscribeOptions)
}

/**
 * 创建映射更新器：把 mappings 指定的 store 值合并为一次 setter 调用。
 * changedKeys 只对 state 映射可用；缺失时对象值按「宁多勿漏」始终发送。
 * validateInitial（可选）在初始映射时逐键校验值（可序列化校验）。
 * reportInvalidRuntime（可选）在运行期组装载荷后递归校验不可序列化值：
 * 命中时该本地键从本次 setData 载荷剔除、绝不传给宿主，且不推进 prevValues（下次通知可重试）。
 */
export function createMapper(
  mappings: Record<string, string>,
  getValue: (storeKey: string) => unknown,
  setter: (updates: Record<string, unknown>) => void,
  changedKeys?: (storeKey: string) => boolean,
  validateInitial?: (localKey: string, value: unknown) => void,
  reportInvalidRuntime?: (localKey: string, paths: readonly string[]) => void,
): { update: () => void } {
  const entries = Object.entries(mappings)

  if (entries.length === 0) {
    return { update: () => {} }
  }

  // 记录上次各映射键的值用于跳过无变化的 setData；小程序 setData 开销大，
  // 与本地映射无关的 store 变化不应触发视图更新
  const prevValues: Record<string, unknown> = {}
  for (const [localKey, storeKey] of entries) {
    setOwnEntry(prevValues, localKey, getValue(storeKey))
  }

  const updateAll = () => {
    const updates: Record<string, unknown> = {}
    // 通过脏键过滤的候选键：[localKey, 状态原始值, 实际下发值]（undefined 已按既有口径转 null）。
    // prevValues 仍记录「状态原始值」以保持既有 undefined→null「只清一次」的基线语义
    const candidates: Array<[string, unknown, unknown]> = []
    // 单键取值失败延迟抛出：坏键先跳过，其余键照常合并进本轮 setData，
    // 批次结束后把第一个错误抛给订阅通道（StoreNotifier 经 onListenerError 上报到 onError）
    let deferredError: unknown
    let hasDeferredError = false
    // setter 成功前不推进 prevValues：setData 抛错/载荷校验剔除时这些键从未成功下发，
    // 先记成新值会让下一次无关通知把它们当「无变化」永久跳过
    const pendingPrevValues: Array<[string, unknown]> = []
    for (const [localKey, storeKey] of entries) {
      let next: unknown
      try {
        next = getValue(storeKey)
      } catch (error) {
        // 不更新 prevValues：状态恢复后的下次通知会重新交付，自愈不需要额外机制
        if (!hasDeferredError) {
          deferredError = error
          hasDeferredError = true
        }
        continue
      }
      const isObjectValue = next !== null && typeof next === 'object'
      let include: boolean
      if (isObjectValue) {
        // 对象值：引用未变且本批次该键未被标脏则跳过，避免大体量对象在无关变更时反复整包下发
        const dirty = changedKeys ? changedKeys(storeKey) : true
        include = !(next === prevValues[localKey] && !dirty)
      } else {
        include = !safeEqual(next, prevValues[localKey])
      }
      if (include) {
        // 微信 setData 不接受 undefined（报错且字段不生效）：状态值变成 undefined 时
        // 显式下发 null 才能清掉宿主旧值，否则页面/globalData 会永久停留在上一个值
        candidates.push([localKey, next, next === undefined ? null : next])
      }
    }

    //  /：setter 前对整批载荷做递归校验——命中函数 / BigInt / Symbol / Map / Set / 类实例 /
    // 循环引用的本地键剔除并上报（开发期 console.error + onError，生产期仅 onError），
    // 绝不把非法值传给宿主 setData。被剔除的键不推进 prevValues：下一次通知仍会重新尝试（可自愈）
    const invalidLocalKeys = new Set<string>()
    if (candidates.length > 0 && reportInvalidRuntime !== undefined) {
      for (const [localKey, , delivered] of candidates) {
        let paths: string[]
        try {
          paths = findUnserializablePaths(delivered, 'mapping')
        } catch {
          // 校验自身抛错（极端 Proxy / throwing getter）：按不可序列化 fail-closed 处理，路径不可判定
          paths = ['<unverifiable>']
        }
        if (paths.length === 0) continue
        invalidLocalKeys.add(localKey)
        reportInvalidRuntime(localKey, paths)
      }
    }

    const deliveredCandidates = candidates.filter(([localKey]) => !invalidLocalKeys.has(localKey))
    const changed = deliveredCandidates.length > 0
    if (changed) {
      for (const [localKey, rawNext, delivered] of deliveredCandidates) {
        setOwnEntry(updates, localKey, delivered)
        // 基线记状态原始值（undefined 仍记 undefined）：保持「undefined→null 只清一次」既有语义
        pendingPrevValues.push([localKey, rawNext])
      }
      setter(updates)
    }
    for (const [localKey, next] of pendingPrevValues) {
      setOwnEntry(prevValues, localKey, next)
    }
    if (hasDeferredError) {
      throw deferredError
    }
  }

  // 初始值：全空则不调用 setter，避免 setData({}) 走一次无意义的视图更新往返。
  // （有意取舍，不改行为）：初始 undefined 的映射键不下发 null——宿主自有 data 键已由
  // claimLocalKeys 拦截，此处下发 null 只会在挂载瞬间清掉宿主默认值；运行期 undefined→null 的
  // 清值语义针对「已有下发基线」的键，两者口径不同，故保留并在类型/文档层说明
  const initialValues: Record<string, unknown> = {}
  for (const [localKey] of entries) {
    if (prevValues[localKey] !== undefined) {
      // 初始映射逐键校验可序列化性（开发期抛错指出字段；生产期上报放行）
      validateInitial?.(localKey, prevValues[localKey])
      setOwnEntry(initialValues, localKey, prevValues[localKey])
    }
  }
  if (Object.keys(initialValues).length > 0) {
    setter(initialValues)
  }

  return { update: updateAll }
}

/**
 * 为同一宿主创建 state + getters 两个 mapper。
 * 两者共享调用方随后建立的一条订阅，避免同时配两类映射时占两份订阅额度。
 * 初始映射时逐键做可序列化校验。
 */
export function bindMapperPair<S extends State>(
  store: Store<S>,
  stateMapping: Record<string, string>,
  gettersMapping: Record<string, string>,
  setter: (updates: Record<string, unknown>) => void,
): Array<{ update: () => void }> {
  const mappers: Array<{ update: () => void }> = []
  const report = (error: TallyStoreError): void => {
    store.hooks.emit('onError', error, 'mapping')
  }
  //  /  运行期载荷校验的报告出口：错误码 INVALID_MAPPING + source 'mapping'，
  // 开发期额外 console.error；context 只带标识类字段（localKey / paths），不带状态明文
  const reportRuntimeInvalid = (localKey: string, paths: readonly string[], kind: string): void => {
    const error = new TallyStoreError(
      ErrorCode.INVALID_MAPPING,
      '[TallyStore] ' +
        kind +
        ' 映射字段 "' +
        localKey +
        '"（store "' +
        store.name +
        '"）的运行期值不可序列化（' +
        paths.join(', ') +
        '）：已从本次 setData 载荷剔除，绝不写入宿主；请在 action 内派生可序列化普通数据（Date/RegExp 允许）',
      { storeName: store.name, localKey, mapping: kind, paths: [...paths] },
    )
    if (!isProduction()) {
      console.error(error.message)
    }
    report(error)
  }
  // 按解析后的映射大小判定，不看选项真值：mapState: [] / {} 为真值，
  // push 一个 no-op mapper 会绕过 subscribeMappers 的空数组短路、白占一条订阅额度
  if (Object.keys(stateMapping).length > 0) {
    mappers.push(
      createMapper(
        stateMapping,
        (key) => store.state[key as keyof S],
        setter,
        (key) => store.isStateKeyDirty(key),
        (localKey, value) => assertMappedValueSerializable(store.name, localKey, 'mapState', value, report),
        (localKey, paths) => reportRuntimeInvalid(localKey, paths, 'mapState'),
      ),
    )
  }
  if (Object.keys(gettersMapping).length > 0) {
    mappers.push(
      createMapper(
        gettersMapping,
        (key) => store.getter(key),
        setter,
        undefined,
        (localKey, value) => assertMappedValueSerializable(store.name, localKey, 'mapGetters', value, report),
        (localKey, paths) => reportRuntimeInvalid(localKey, paths, 'mapGetters'),
      ),
    )
  }
  return mappers
}

/** subscribeMappers 的返回：退订句柄 + 手动重跑全部 mapper（回前台对齐用） */
export interface MapperSubscription {
  unsubscribe: () => void
  /** 以当前状态重跑全部 mapper（不经过通知链；错误按订阅回调同口径延迟抛出） */
  runMappers: () => void
}

/** 把多个映射更新器合并进同一条只读订阅（每个宿主实例一条）；wrapListener 可包通知外壳（ 跨 mapper 合并） */
export function subscribeMappers(
  subscribeStore: (callback: () => void, options?: { readOnly?: boolean }) => () => void,
  mappers: ReadonlyArray<{ update: () => void }>,
  wrapListener?: (run: () => void) => () => void,
): MapperSubscription {
  if (mappers.length === 0) {
    return { unsubscribe: () => {}, runMappers: () => {} }
  }
  const runMappers = (): void => {
    // 单更新器失败不得拖垮同批其余映射：先跑完全部更新器，再抛本轮第一个错误，
    // 由 StoreNotifier 的 onListenerError → onError 上报
    let deferredError: unknown
    let hasDeferredError = false
    for (const mapper of mappers) {
      try {
        mapper.update()
      } catch (error) {
        if (!hasDeferredError) {
          deferredError = error
          hasDeferredError = true
        }
      }
    }
    if (hasDeferredError) {
      throw deferredError
    }
  }
  const listener = wrapListener !== undefined ? wrapListener(runMappers) : runMappers
  return {
    unsubscribe: subscribeStore(listener, { readOnly: true }),
    runMappers,
  }
}

/**
 * 执行一次宿主绑定；中途抛错时回滚已登记的绑定并原样重抛。
 * 错误抛回框架归因，且调用方不得在失败后继续跑用户生命周期（映射尚未就绪）。
 */
export function bindWithRollback(label: string, unbinds: Array<() => void>, bind: () => void): void {
  try {
    bind()
  } catch (error) {
    cleanupBindings(unbinds)
    if (!isProduction()) {
      console.warn(`[${label}] 绑定映射失败，已回滚本次登记的订阅`, error)
    }
    throw error
  }
}

/**
 * 映射写入的调度器：
 * - 同步模式直接写宿主（保持既有语义）
 * - 合并模式把同一 tick 的多次写入合并为一次 `setData`，减少 Skyline 跨线程数据传递；
 *   初始映射由 `flushNow()` 同步交付，避免 onLoad/attached 里读到空 data
 * - 合并模式的异步写入失败做**有界自动重试**（最多 `WRITER_MAX_RETRIES` 次微任务，成功即停）：
 *   瞬时失败自动恢复视图，不需要业务侧再触发一次变更；重试耗尽后保留 pending、等下一次
 *   外部写入合并重试，并**只上报一次** onError（不随重试逐次刷屏，也不无限自动重排）
 */
export interface UpdatesWriter {
  write(updates: Record<string, unknown>): void
  /** 立即交付已挂起的写入（同步）；无挂起时为空操作 */
  flushNow(): void
  /** 取消挂起写入并关闭写入器（卸载/重入时调用） */
  cancel(): void
}

/** 合并模式写入失败后的自动重试上限（成功即停；耗尽后保留 pending，等下一次外部写入） */
const WRITER_MAX_RETRIES = 3

export function createUpdatesWriter(write: (updates: Record<string, unknown>) => void, microtask: boolean, onError: (error: unknown) => void): UpdatesWriter {
  if (!microtask) {
    return { write, flushNow: () => {}, cancel: () => {} }
  }

  let pending: Record<string, unknown> | undefined
  let scheduled = false
  let cancelled = false
  /** 当前失败批次的连续自动重试次数：交付成功或重试耗尽后归零 */
  let retries = 0
  /**
   * 调度代际：flushNow 交付后自增，使此前已排队的微任务作废。
   * 不作废的后果（存量 bug， 收紧断言时暴露）：僵尸微任务会把 flushNow 之后
   * 合并进 pending 的新写入提前冲掉并复位 scheduled；若该批写入失败，重试批次又被
   * 下一个合法微任务再次 flush——同一次逻辑写入产生两次 setData 重试与两次 onError。
   */
  let generation = 0

  const flush = (token: number): (() => void) => {
    return () => {
      if (cancelled) {
        return
      }
      // 僵尸微任务：本次调度已被 flushNow 交付取代，不能复位 scheduled、不能动 pending
      if (token !== generation) {
        return
      }
      scheduled = false
      const batch = pending
      pending = undefined
      if (batch === undefined) {
        return
      }
      try {
        write(batch)
        // 交付成功：复位重试额度，下一次独立失败重新享有完整的自动重试次数
        retries = 0
      } catch (error) {
        // 失败批次以最新值为准保留：失败期间合并进 pending 的新写入会覆盖旧值
        const retry = batch
        if (pending !== undefined) {
          copyOwnEntries(retry, pending)
        }
        pending = retry
        if (retries < WRITER_MAX_RETRIES) {
          retries += 1
          // 有界自动重试：下一个微任务再交付本批（期间新写入继续合并），成功即停
          schedule()
          return
        }
        // 重试耗尽：保留 pending 等下一次外部写入合并重试；onError 只在此处上报一次，
        // 避免持续失败时每个重试都刷屏
        retries = 0
        // onError 是宿主上报通道：它自身抛错不得变成未处理拒绝
        try {
          onError(error)
        } catch {
          // 上报通道失败时只能放弃本次异常，不能吞掉后续写入
        }
      }
    }
  }

  const schedule = (): void => {
    if (scheduled) {
      return
    }
    scheduled = true
    const token = generation
    // 与通知中枢一致：用 Promise 微任务而不是 queueMicrotask，少一个运行时能力判断
    Promise.resolve().then(flush(token))
  }

  return {
    write(updates) {
      if (cancelled) {
        return
      }
      const merged = pending ?? {}
      pending = merged
      copyOwnEntries(merged, updates)
      schedule()
    },
    flushNow() {
      if (cancelled || pending === undefined) {
        return
      }
      const batch = pending
      pending = undefined
      // 作废已排队的微任务：它稍后执行时 token 不匹配，属于空操作（不再能提前冲掉新写入）
      generation += 1
      scheduled = false
      // 初始映射失败与同步模式一致：抛给 connectHost 触发绑定回滚
      write(batch)
      // 同步交付成功同样复位重试额度：此后新的异步失败从完整额度开始
      retries = 0
    },
    cancel() {
      cancelled = true
      pending = undefined
    },
  }
}

/** 原始值比较：处理 NaN 与引用相等 */
function safeEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  return typeof a === 'number' && typeof b === 'number' && isNaN(a) && isNaN(b)
}

// ==================== 载荷守卫 ====================

/** 微信 setData 单次数据上限（1024KB，官方口径；发布前按平台事实清单复核） */
export const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024

/** 告警消息里列出的最大字段个数 */
const PAYLOAD_WARN_TOP_FIELDS = 3

/**
 * 创建载荷守卫：映射写入前估算载荷字节，超过 maxPayloadBytes 时经 report 告警。
 * 数据仍照常下发——告警的职责是让超限可观测并给出拆分建议，不是替宿主决定丢不丢更新。
 * @param knownBytes 调用方已算好的字节数（connectHost 与指标共用一次估算，避免二次 stringify）
 */
export function createPayloadGuard(
  maxPayloadBytes: number,
  label: string,
  report: (error: Error) => void,
): (updates: Record<string, unknown>, knownBytes?: number) => void {
  if (!(maxPayloadBytes > 0)) {
    return () => {}
  }
  return (updates, knownBytes) => {
    const total = knownBytes ?? estimateJsonBytes(updates)
    if (total < 0) {
      // JSON.stringify 失败（循环引用 / BigInt）时旧实现与「未超限」一并静默跳过，
      // 真正必然失败的载荷反而没有告警；这里单独上报一次，便于定位不可序列化映射值
      report(new Error('[' + label + '] 映射写入载荷无法序列化（循环引用 / BigInt 等）：setData 可能失败，请先在 action 内派生可序列化数据'))
      return
    }
    if (total <= maxPayloadBytes) {
      return
    }
    // 逐字段拆解：定位载荷大头，给出可执行的拆分建议
    const fields: Array<{ key: string; bytes: number }> = []
    for (const key of Object.keys(updates)) {
      const bytes = estimateJsonBytes(updates[key])
      if (bytes > 0) {
        fields.push({ key, bytes })
      }
    }
    fields.sort((a, b) => b.bytes - a.bytes)
    const top = fields
      .slice(0, PAYLOAD_WARN_TOP_FIELDS)
      .map((field) => field.key + '(约 ' + field.bytes + 'B)')
      .join('、')
    const message =
      '[' +
      label +
      '] 映射写入载荷约 ' +
      total +
      'B，超过 maxPayloadBytes=' +
      maxPayloadBytes +
      'B（setData 单次数据上限 ' +
      DEFAULT_MAX_PAYLOAD_BYTES / 1024 +
      'KB），可能造成 setData 失败或卡顿。' +
      '较大字段：' +
      (top || '(逐字段估算失败)') +
      '。建议：把大对象/长列表字段拆分为更细粒度的映射（组件级 mapState、分页下发），或先在 action 内派生最小可渲染切片'
    report(new Error(message))
  }
}

/**
 * Page / App 的宿主保留成员：action 本地名不得遮蔽（否则页面生命周期/框架方法被顶掉且没有提示）。
 * bindActions 对 Page / App 共用（含 App 的 globalData 绑定）。
 *
 * 本清单**只放 Page/App 上真实存在的成员**——组件实例独有的 API / 只读字段
 * （triggerEvent、getRelationNodes、id、dataset、is…）在 Page/App 上是合法可绑定的本地名，
 * 混进本清单会把原本正常的 mapActions 变成 INVALID_MAPPING 并让方法消失。
 * 组件独有部分见 COMPONENT_RESERVED_ACTIONS。
 * 补齐 Page 与自定义组件实例共有的基础库方法（媒体查询/ Skyline 动画等）。
 */
export const HOST_RESERVED_ACTIONS = new Set([
  // 三者通用 + Page 生命周期
  'data',
  'setData',
  'globalData',
  'options',
  'onLoad',
  'onShow',
  'onHide',
  'onUnload',
  'onReady',
  'onPullDownRefresh',
  'onReachBottom',
  'onPageScroll',
  'onShareAppMessage',
  'onShareTimeline',
  'onResize',
  'onTabItemTap',
  'onAddToFavorites',
  'onSaveExitState',
  'onRouteDone',
  // Page 实例的框架成员（也是 Page/Component 共有的实例方法）
  'route',
  'selectComponent',
  'selectAllComponents',
  'createSelectorQuery',
  'createIntersectionObserver',
  'createMediaQueryObserver',
  'animate',
  'clearAnimation',
  'applyAnimatedStyle',
  'clearAnimatedStyle',
  'getTabBar',
  'getOpenerEventChannel',
  'setUpdatePerformanceListener',
  // App 生命周期
  'onLaunch',
  'onError',
  'onPageNotFound',
  'onUnhandledRejection',
  'onThemeChange',
  'onNetworkStatusChange',
  'onMemoryWarning',
])

/**
 * 自定义组件实例独有的框架 API / 只读字段 / 配置命名空间（HOST_RESERVED_ACTIONS + COMPONENT_RESERVED_ACTIONS）：
 * - config.methods 会被框架提升为实例顶层方法，同名 action 会静默顶掉框架 API；
 * - 这些名字不属于 Page/App，不能并入 HOST_RESERVED_ACTIONS，否则会误伤 Page/App 的合法映射；
 * - 由 withComponentStore 的 filterReservedActions 在装饰期与 attached 二次过滤时消费。
 */
export const COMPONENT_RESERVED_ACTIONS = new Set([
  'triggerEvent',
  'getRelationNodes',
  'selectOwnerComponent',
  'hasBehavior',
  'groupSetData',
  'getPageId',
  'dataset',
  'id',
  'is',
  // 组件配置命名空间（非 Page/App 实例成员，仅 Component 路径使用）
  'observers',
  'properties',
  'methods',
  'lifetimes',
  'pageLifetimes',
])

/** 绑定 Actions 到目标实例，返回取消绑定函数数组 */
export function bindActions<S extends State = State>(target: Record<string, unknown>, mappings: Record<string, string>, store: Store<S>): Array<() => void> {
  const unbinds: Array<() => void> = []

  Object.entries(mappings).forEach(([localName, actionName]) => {
    if (HOST_RESERVED_ACTIONS.has(localName)) {
      const message = `[bindActions] 本地名 "${localName}" 是宿主保留成员，已跳过 action "${actionName}" 的绑定；请改用其他本地名`
      store.hooks.emit('onError', new TallyStoreError(ErrorCode.INVALID_MAPPING, message, { localName, actionName }), 'bindActions')
      if (!isProduction()) {
        console.warn(message)
      }
      return
    }
    // 按自有属性写入而非 `target[localName] = ...`：后者遇到 '__proto__'/'constructor'
    // 会沿原型链写入（污染宿主构造器），也无法在解绑时恢复被覆盖的原成员
    const original = Object.getOwnPropertyDescriptor(target, localName)
    if (!canOwnKey(target, localName)) {
      // 「少了一个 action」是静默功能降级：除开发期告警外一律转投 onError，
      // 否则生产环境只剩很远处的 `undefined is not a function`
      store.hooks.emit(
        'onError',
        new TallyStoreError(
          ErrorCode.INVALID_MAPPING,
          `[bindActions] 宿主成员 "${localName}" 不可重定义（非 configurable 且非 writable），已跳过 action "${actionName}" 的绑定`,
          { localName, actionName },
        ),
        'bindActions',
      )
      if (!isProduction()) {
        console.warn(`[bindActions] 宿主成员 "${localName}" 不可重定义（非 configurable 且非 writable），已跳过 action "${actionName}" 的绑定`)
      }
      return
    }
    // 覆盖是设计行为（解绑时恢复原值），按生产门控只做开发期告警
    if (original && !isProduction()) {
      console.warn(`[bindActions] 宿主已有成员 "${localName}"，将被 action "${actionName}" 覆盖，解绑时恢复原值`)
    }

    defineOwnValue(target, localName, (...args: unknown[]) => store.dispatch(actionName, ...args), original)

    // 按原描述符整体回放：只存值会把宿主的访问器成员（get/set）降级成数据属性
    unbinds.push(() => {
      if (original) {
        Object.defineProperty(target, localName, original)
      } else {
        delete target[localName]
      }
    })
  })

  return unbinds
}

/** 清理所有绑定 */
export function cleanupBindings(unbinds: Array<() => void>): void {
  unbinds.forEach((unbind) => {
    try {
      unbind()
    } catch (error) {
      if (!isProduction()) {
        console.warn('[TallyStore] Error during cleanup:', error)
      }
    }
  })
  unbinds.length = 0
}
