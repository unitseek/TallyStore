/** TallyStore - 插件与集成契约 */

// ==================== plugin ====================

import type { Actions, Getters, InferActionArgs, InferActionReturn, State, Store } from './store.js'

/**
 * 重置审计信息：beforeReset / afterReset 钩子实参。
 * 只含标识与时间，不含任何状态值；afterReset 额外带 ok（失败时先发 ok=false 再 rethrow）。
 */
export interface ResetInfo {
  /** 被重置的 Store 名（日志前缀 / 持久化默认键来源） */
  storeName: string
  /** 触发方式：直接调用 Store.$reset 为 'direct'，defineStores.resetAll 为 'resetAll' */
  reason: 'direct' | 'resetAll'
  /** 事件时间戳（毫秒）；beforeReset 与 afterReset 共用同一时间 */
  timestamp: number
  /** 仅 afterReset 提供：重置是否成功（失败时 beforeReset 后紧跟 ok=false） */
  ok?: boolean
}

/**
 * 钩子名 → 处理器实参元组。
 * HookName 由本表键集派生（见下），新增钩子只需在这里加一行，不再两处手写同步。
 */
export interface HookArgsMap {
  beforeSetState: [key: string | number | symbol, value: unknown]
  afterSetState: [key: string | number | symbol, value: unknown]
  beforePatch: [partialState: Record<string, unknown>]
  afterPatch: [partialState: Record<string, unknown>]
  beforeDispatch: [actionName: string, args: readonly unknown[]]
  afterDispatch: [actionName: string, args: readonly unknown[], result: unknown]
  beforeReplaceState: [newState: object]
  afterReplaceState: [newState: object]
  /** 重置前（可观测性）：info 只含 storeName / reason / timestamp，不含状态值 */
  beforeReset: [info: ResetInfo]
  /** 重置后：info.ok 表示是否成功；失败时先发 ok=false 再 rethrow */
  afterReset: [info: ResetInfo]
  onError: [error: unknown, source?: string]
  /** 一轮通知分发完成（指标：不含任何状态值） */
  onNotify: [meta: { listeners: number }]
  /** 一次映射写入宿主完成（指标：载荷字节为估算值，不含字段值） */
  onHostWrite: [meta: { bytes: number; host: string }]
}

/** 钩子名称（= HookArgsMap 的键集，避免两处手写漂移） */
export type HookName = keyof HookArgsMap

/** `T` 是否为联合类型（`T` 分发到自身各成员时才会出现 `[B] extends [T]` 为 false） */
type IsUnion<T, B = T> = T extends B ? ([B] extends [T] ? false : true) : never

/** 指定钩子的处理器签名 */
export type HookHandlerFor<K extends HookName> = IsUnion<K> extends true ? HookHandler : (...args: HookArgsMap[K]) => void

/** 钩子处理函数 */
export type HookHandler<TArgs extends unknown[] = unknown[]> = (...args: TArgs) => void

/** 钩子系统契约接口 */
export interface IHookSystem {
  /** 注册钩子处理器，返回取消注册函数 */
  on<K extends HookName>(hookName: K, handler: HookHandlerFor<K>): () => void
  /** 触发钩子：实参元组由 HookArgsMap 按钩子名约束 */
  emit<K extends HookName>(hookName: K, ...args: HookArgsMap[K]): void
  /** 清除钩子（指定名称或全部） */
  clear(hookName?: HookName): void
  /** 计数，量纲随入参变化：传 `hookName` 返回该钩子的 handler 数，不传返回已注册的钩子名称数 */
  size(hookName?: HookName): number
  /** 指定钩子当前的处理器数量（未注册返回 0） */
  listenerCount(hookName: HookName): number
}

/** 插件安装钩子 - 返回可选的卸载函数 */
export type PluginHook<S extends State = State> = (store: Store<S, Actions, Getters<S>>) => void | (() => void)

/** 插件接口 */
export interface Plugin<S extends State = State> {
  name: string
  install: PluginHook<S>
}

// ==================== integration ====================

/** 连接选项：映射只有 state / getters / actions 三类 */
export interface ConnectOptions<S extends State = State, A extends Actions = Actions, G extends Getters<S> = Getters<S>> {
  /** 映射 state */
  mapState?: readonly (keyof S)[] | Record<string, keyof S>
  /** 映射 getters */
  mapGetters?: readonly (keyof G)[] | Record<string, keyof G>
  /** 映射 actions（数组形式按 action 名映射；对象形式支持本地名重命名，值须为 action 名） */
  mapActions?: readonly (keyof A)[] | Record<string, keyof A>
  /**
   * 映射写入宿主的单次载荷预算（字节，估算口径）。
   * - 默认 1048576（微信 `setData` 单次数据上限，发布前按官方口径复核）
   * - 超过预算时经 `onError(error, 'payload')` 告警，消息含最大字段、估算字节数与拆分建议；数据仍照常下发（告警不阻断）
   * - `0` 表示关闭守卫
   */
  maxPayloadBytes?: number
  /**
   * 前后台更新策略（默认启用）：页面进入后台（`onHide` / `pageLifetimes.hide`）后
   * 映射写入不下发（合并缓存），回前台按**最新状态**一次性对齐（不重放中间态）。
   * - 可见性信号缺失（宿主未走生命周期）时自动回退为立即更新，不丢更新
   * - `false` 关闭策略：后台也立即更新，供需要后台实时数据的页面
   */
  backgroundUpdates?: boolean
  /**
   * 映射写入宿主的时机。
   * - `'auto'`（默认）：Skyline 宿主合并同一 tick 的多次写入为一次 setData，其余宿主同步写入
   * - `'sync'`：每次通知立即写入
   * - `'microtask'`：同一 tick 的多次写入合并为一次（初始映射仍同步交付）
   */
  schedule?: 'auto' | 'sync' | 'microtask'
}

/**
 * 映射配置归一化为「本地键 → 源键」条目表：
 * - 数组形态：本地名 = 源名（仍需存在于源类型上，未知键被键集交叉过滤掉）；
 * - record 形态：本地名可重命名到任意源键；
 * - 未映射 / 非法配置：never（由下游 `Mapped*Of` 统一映射为 object）。
 * 三种 extractor 共用本表，只各自决定「源键 → 值类型」的映射，不再各自复制四层条件链。
 */
type MappingEntries<MK, K extends PropertyKey> = undefined extends MK
  ? never
  : MK extends readonly unknown[]
    ? { [P in MK[number] & K]: P }
    : MK extends Record<string, PropertyKey>
      ? { [P in keyof MK & string]: MK[P] }
      : never

/** 条目表 → state 映射类型（源键不在 S 上时值为 never，与 record 形态原口径一致） */
type MappedStateOf<E, S extends State> = [E] extends [never] ? object : { [P in keyof E]: S[E[P] & keyof S] }

/** 条目表 → getters 映射类型（数组 / record 两分支按同一套相交规则产出） */
type MappedGettersOf<E, G extends { [K: string]: (state: never) => unknown }> = [E] extends [never]
  ? object
  : { [P in keyof E]: ReturnType<G[E[P] & keyof G]> }

/** 条目表 → actions 映射类型（保留精确签名） */
type MappedActionsOf<E, A extends Actions> = [E] extends [never]
  ? object
  : { [P in keyof E]: (...args: InferActionArgs<A, E[P] & keyof A>) => InferActionReturn<A, E[P] & keyof A> }

/** 从映射配置提取状态类型 */
type ExtractMappedState<
  S extends State = State,
  M extends { mapState?: readonly (keyof S)[] | Record<string, keyof S> } = { mapState?: readonly (keyof S)[] | Record<string, keyof S> },
> = MappedStateOf<MappingEntries<M['mapState'], keyof S>, S>

/** 从映射配置提取计算属性类型 */
type ExtractMappedGetters<
  M extends { mapGetters?: readonly PropertyKey[] | Record<string, PropertyKey> } = { mapGetters?: readonly PropertyKey[] | Record<string, PropertyKey> },
  G extends { [K: string]: (state: never) => unknown } = { [K: string]: (state: never) => unknown },
> = MappedGettersOf<MappingEntries<M['mapGetters'], keyof G>, G>

/** 从映射配置提取 actions 类型（精确签名） */
export type ExtractMappedActions<
  A extends Actions = Actions,
  M extends { mapActions?: readonly (keyof A)[] | Record<string, keyof A> } = { mapActions?: readonly (keyof A)[] | Record<string, keyof A> },
> = MappedActionsOf<MappingEntries<M['mapActions'], keyof A>, A>

/**
 * 从 ConnectOptions 提取完整的页面 data 类型。
 *
 * 口径：
 * - **未映射的 state 键也是合法的可选属性**：第一项 Omit<Partial<S>, ...> 让页面可以自带与
 *   未映射 state 同名的字段（集成层不会注入它们，取值以页面自身 data 为准）；这是设计口径，
 *   与 tests/types/api-types.test-d.ts 的断言一致，不要按「只含映射字段」去"修正"；
 * - **getter 与映射 state 同名时 getter 胜出**：两处 Omit（含 keyof ExtractMappedGetters）
 *   先把同名 state 键剔除，再合并 getter 返回类型——优先级是显式契约而非 Omit 顺序的巧合。
 */
export type ExtractPageData<
  S extends State,
  M extends { mapState?: readonly (keyof S)[] | Record<string, keyof S>; mapGetters?: readonly PropertyKey[] | Record<string, PropertyKey> },
  G extends Getters<S> = Getters<S>,
> = Omit<Partial<S>, keyof ExtractMappedGetters<M, G>> & Omit<ExtractMappedState<S, M>, keyof ExtractMappedGetters<M, G>> & ExtractMappedGetters<M, G>

/** 页面/组件实例上由集成层注入的框架成员基类型 */
type InjectedDataShape<
  S extends State,
  M extends { mapState?: readonly (keyof S)[] | Record<string, keyof S>; mapGetters?: readonly PropertyKey[] | Record<string, PropertyKey> },
  G extends Getters<S> = Getters<S>,
> = {
  /** 注入/合并后的 data：映射的 state + getters（口径见 {@link ExtractPageData}） */
  data: ExtractPageData<S, M, G>
  /** 框架的 setData：实例上恒可用（本库不改其语义，全库只经 `this.setData` 写视图） */
  setData: (data: Record<string, unknown>, callback?: () => void) => void
}

/** 配置对象视角的 `data`（与实例视角 InjectedDataShape 形状不同） */
type InjectedConfigDataShape<
  S extends State,
  M extends { mapState?: readonly (keyof S)[] | Record<string, keyof S>; mapGetters?: readonly PropertyKey[] | Record<string, PropertyKey> },
  G extends Getters<S> = Getters<S>,
> = {
  data: ExtractPageData<S, M, G>
}

/** 组件 `methods` 命名空间的形状 */
type ComponentMethodsShape<ExtraMethods extends object, A extends Actions, M extends { mapActions?: readonly (keyof A)[] | Record<string, keyof A> }> = {
  /** 配置对象上的 methods 命名空间（微信 Component 写法）；组件实例上这些条目会被提升为顶层方法 */
  methods: ExtraMethods & ExtractMappedActions<A, M>
}

/** 方法 this 重写映射类型 */
export type WithPageThis<C, T> = {
  [K in keyof C]: C[K] extends (...args: infer P) => infer R ? (this: T, ...args: P) => R : C[K]
}

/** Page 保留键（框架生命周期 + 页面事件处理函数 + 内部字段），不参与自定义方法提取 */
export type PageReservedKeys =
  | 'data'
  | 'setData'
  | 'onLoad'
  | 'onShow'
  | 'onHide'
  | 'onUnload'
  | 'onReady'
  | 'onPullDownRefresh'
  | 'onReachBottom'
  | 'onPageScroll'
  | 'onShareAppMessage'
  | 'onResize'
  | 'onTabItemTap'
  | 'onShareTimeline'
  | 'onAddToFavorites'
  | 'onSaveExitState'
  | 'onRouteDone'
  | 'options'
  | '__tallyUnbinds'

/** 从 Page 配置提取用户自定义方法（排除保留键；方法 this 不检查以避免循环兼容性） */
export type PageOwnMethods<C> = {
  [K in keyof Omit<C, PageReservedKeys>]: C[K] extends (...args: infer P) => infer R ? (...args: P) => R : C[K]
}

/** 从 Component 配置提取用户自定义方法对象（C.methods） */
export type ComponentOwnMethods<C> = C extends { methods: infer M } ? (M extends Record<string, unknown> ? M : object) : object

/** 宿主 TabBar 句柄的最小形态（框架实例提供 getTabBar() 时才会注入） */
type TabBarHandle = { syncSelectedTab?: () => void }

/** 页面方法 this 类型 */
export type PageThis<
  S extends State,
  A extends Actions,
  G extends Getters<S> = Getters<S>,
  M extends ConnectOptions<S, A, G> = ConnectOptions<S, A, G>,
  ExtraMethods extends object = object,
> = InjectedDataShape<S, M, G> &
  ExtraMethods &
  ExtractMappedActions<A, M> & {
    getTabBar?: () => TabBarHandle | undefined
  }

/** 页面增强配置的形状（`withPageStore` 的返回类型） */
export type PageConfig<
  S extends State,
  M extends { mapState?: readonly (keyof S)[] | Record<string, keyof S>; mapGetters?: readonly PropertyKey[] | Record<string, PropertyKey> } = ConnectOptions<
    S,
    Actions,
    Getters<S>
  >,
  G extends Getters<S> = Getters<S>,
> = InjectedConfigDataShape<S, M, G> & {
  getTabBar?: () => TabBarHandle | undefined
}

/** 组件方法 this 类型 */
export type ComponentThis<
  S extends State,
  A extends Actions,
  G extends Getters<S> = Getters<S>,
  M extends ConnectOptions<S, A, G> = ConnectOptions<S, A, G>,
  ExtraMethods extends object = object,
> = InjectedDataShape<S, M, G> & ExtraMethods & ExtractMappedActions<A, M> & ComponentMethodsShape<ExtraMethods, A, M>

/** 组件增强配置的形状（`withComponentStore` 的返回类型） */
export type ComponentConfig<
  S extends State,
  A extends Actions,
  G extends Getters<S> = Getters<S>,
  M extends ConnectOptions<S, A, G> = ConnectOptions<S, A, G>,
  ExtraMethods extends object = object,
> = InjectedConfigDataShape<S, M, G> & ComponentMethodsShape<ExtraMethods, A, M>

/** Component 配置的 this 注入类型 */
export type WithComponentThis<C, T> = C & {
  methods?: ThisType<T>
  lifetimes?: ThisType<T>
  pageLifetimes?: ThisType<T>
}

/** 用户 App 配置里声明的 globalData 成员类型（无声明时为空对象） */
type DeclaredGlobalDataOf<Extra> = Extra extends { globalData?: infer Declared } ? (Declared extends object ? Declared : object) : object

/**
 * App globalData 中真正由 store 映射写入的键类型（state + getters）。
 * 与 ExtractPageData 同口径——getter 与映射 state 同名时 **getter 胜出**
 *（先 Omit 掉同名 state 键再合并 getters）。直接交叉会让同名异类型塌成 never，
 * 导致 App 侧 `this.globalData.count` 不可用，而 Page/Component 同一映射是 getter 类型。
 */
type MappedAppGlobalData<
  S extends State,
  M extends { mapState?: readonly (keyof S)[] | Record<string, keyof S>; mapGetters?: readonly PropertyKey[] | Record<string, PropertyKey> },
  G extends Getters<S>,
> = Omit<ExtractMappedState<S, M>, keyof ExtractMappedGetters<M, G>> & ExtractMappedGetters<M, G>

/**
 * App 实例 `globalData` 的合并类型：
 * - 与 store 映射键同名的成员以**映射类型**为准——运行时 store 是唯一事实来源
 *   （见 withAppStore 的同名覆盖告警）；Omit 只用「映射键」而不是 ExtractPageData 的
 *   全部 state 键（后者含未映射键，会把用户声明类型错误地替换成可选 state 类型）；
 * - 用户声明的其它 globalData 成员保留（例如初始化时写入的 `userInfo`），即使其名字
 *   与某个**未被映射**的 state 键相同——运行时不会覆盖它，类型也不应被覆盖；
 * - 未声明的未映射 state 键仍以 Partial<S> 可选字段出现（与 Page data 同口径）。
 */
type MergedAppGlobalData<
  S extends State,
  M extends { mapState?: readonly (keyof S)[] | Record<string, keyof S>; mapGetters?: readonly PropertyKey[] | Record<string, PropertyKey> },
  G extends Getters<S>,
  Extra extends object,
> = MappedAppGlobalData<S, M, G> &
  Omit<DeclaredGlobalDataOf<Extra>, keyof MappedAppGlobalData<S, M, G>> &
  Omit<ExtractPageData<S, M, G>, keyof DeclaredGlobalDataOf<Extra> | keyof MappedAppGlobalData<S, M, G>>

/** App 方法 this 类型：只保留 globalData 映射与 action 方法，不再有 Store 调试 API */
export type AppThis<
  S extends State,
  A extends Actions,
  G extends Getters<S> = Getters<S>,
  M extends ConnectOptions<S, A, G> = ConnectOptions<S, A, G>,
  Extra extends object = object,
> = Omit<Extra, 'globalData'> & {
  globalData: MergedAppGlobalData<S, M, G, Extra>
} & Omit<ExtractMappedActions<A, M>, 'globalData'>
