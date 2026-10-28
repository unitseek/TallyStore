/** TallyStore - 状态与 Action 契约 */

import type { Plugin, IHookSystem } from './plugin.js'

/**
 * 状态类型：宽松对象约束，既兼容 Record<string, unknown> 的索引签名写法，
 * 也允许未声明索引签名的业务 interface 直接作为 State 类型自动推断。
 */
export type State = object

/** 解析 State 类型：() => S 工厂形式解析为返回的对象类型 S，普通对象原样返回 */
export type ResolveState<T> = T extends (...args: any[]) => infer R ? R : T

/** 解析后的状态类型（ResolveState + 归一化） */
export type ResolvedState<S> = ResolveState<S> extends State ? ResolveState<S> : State

/**
 * StoreConfig.getters 的 state 形参形状。
 * 与 ResolvedState 同口径归一化：非法 S 统一落回 State，避免 actions 与 getters
 * 两条配置分支对同一份错误配置给出不一致的 state 类型、从而掩盖配置错误。
 */
export type ConfigState<S> = ResolvedState<S>

/** Action 上下文运行时基础结构 - 包含 Store 核心方法，不含 actions 以避免循环依赖 */
export interface ActionContextBase<S extends State = State> {
  readonly name: string
  readonly state: S
  setState<K extends keyof S>(key: K, value: S[K]): void
  $patch(partialState: Partial<S>): void
  $replaceState(newState: S | (() => S)): void
  getState(): S
  dispatch(actionName: string, ...args: unknown[]): unknown
}

type ActionCollisionKeys<A extends Actions> = string extends keyof A ? never : keyof A

/**
 * Action 上下文里的 dispatch 成员：
 * - A 是开放索引签名（无法区分是否显式声明 dispatch）或未声明 dispatch → 内置 dispatcher：
 *   typed 重载 + 动态字符串重载，与 Store.dispatch 同形；
 * - A 显式声明了 dispatch → 不再交叉内置 dispatcher：运行时 action 上下文的 Proxy 先命中
 *   boundActions（ActionManager.initialize），用户 action 会真实遮蔽内置 dispatch，类型按用户
 *   签名呈现才与运行时一致（此形态下不能用 this.dispatch 调其它 action，请改 this.<action>()）。
 */
type ActionContextDispatch<A extends Actions> = string extends keyof A
  ? {
      dispatch<K extends keyof A>(actionName: K, ...args: InferActionArgs<A, K>): InferActionReturn<A, K>
      dispatch(actionName: string, ...args: unknown[]): unknown
    }
  : 'dispatch' extends keyof A
    ? unknown
    : {
        dispatch<K extends keyof A>(actionName: K, ...args: InferActionArgs<A, K>): InferActionReturn<A, K>
        dispatch(actionName: string, ...args: unknown[]): unknown
      }

/** Action 上下文类型 - action 方法中 this 的类型，合并 A 以支持直接访问其他 action */
export type ActionContext<S extends State = State, A extends Actions = Actions> = Omit<ActionContextBase<S>, 'dispatch' | ActionCollisionKeys<A>> &
  A &
  ActionContextDispatch<A>

/** Actions 类型约束 */
export type Actions = Record<string, (...args: any[]) => any>

/** Actions + ThisType 注入：靠 ThisType 把 ActionContext 注入 action 的 this，避免 Store ↔ actions 循环依赖 */
export type ActionsWithThis<S extends State, A extends Actions> = A & ThisType<ActionContext<S, A>>

/** Getters 类型 - 支持类型推断 */
export type Getters<S extends State = State> = {
  [K: string]: (state: S) => unknown
}

// ==================== 类型推断工具 ====================

/** 推断 Action 参数类型 */
export type InferActionArgs<A extends Actions, K extends keyof A> = A[K] extends (...args: infer Args) => unknown ? Args : never

/** 推断 Action 返回类型 */
export type InferActionReturn<A extends Actions, K extends keyof A> = A[K] extends (...args: never[]) => infer R ? R : never

/** 推断 Getter 返回类型 */
export type InferGetterReturn<G extends Record<string, (state: any) => any>, K extends keyof G> = G[K] extends (...args: never[]) => infer R ? R : never

/** 从 Actions 类型提取所有 action 名称 */
export type ActionNames<A extends Actions> = keyof A & string

// ==================== Store 配置 ====================

/** 状态监听器 */
export type StateListener<S extends State = State> = (state: S) => void

export interface StateProtectionOptions {
  /** 是否启用状态保护（默认 true） */
  enabled?: boolean
  /** 是否启用深层保护（递归保护嵌套对象，默认 true） */
  deep?: boolean
  /** 生产模式下非法修改的处理方式（默认 'warn'） */
  productionHandler?: 'error' | 'warn' | 'silent'
}

export type SubscriberLimitPolicy = 'evict-oldest' | 'throw'

export interface SubscriptionOptions {
  /** 最大订阅者数量（默认 50） */
  maxSubscribers?: number
  /** 订阅者达到上限时的策略（默认 'evict-oldest'） */
  onLimit?: SubscriberLimitPolicy
}

export interface NotifyOptions {
  /** 通知监听器前是否深拷贝状态 */
  clone?: boolean
  /** 仅在状态实际变化时才通知（默认 false），action 期间的写入由脏跟踪代理检测 */
  onlyOnChange?: boolean
  /** 启用通知的微任务合并（默认 false），同一 tick 内多次写入合并为一次通知 */
  async?: boolean
}

/** Store 配置的共享部分（不含 state，供工厂重载分别固定其类型） */
export interface StoreOptionsBase<S> {
  name?: string
  /** 初始状态：对象字面量或工厂函数（工厂形式避免共享引用 / 支持惰性初始化） */
  state?: S | (() => S)
  stateProtection?: StateProtectionOptions
  subscription?: SubscriptionOptions
  notify?: NotifyOptions
  /** 快照配置：体积上限，默认 min(1MB, 状态序列化体积×2)，超限 $snapshot 拒绝 */
  snapshot?: SnapshotOptions
}

/** $snapshot 配置 */
export interface SnapshotOptions {
  /** 单次快照的体积上限（字节，JSON 估算口径）；默认 1MB，且生效值不超过状态序列化体积的 2 倍 */
  maxBytes?: number
}

/** Store 自动推导配置类型（免泛型推导专用） */
export interface StoreConfig<S = Record<string, unknown>, A = unknown, G = unknown> extends StoreOptionsBase<S> {
  actions?: A & ThisType<ActionContext<ResolvedState<S>, A extends Actions ? A : Actions>>
  getters?: G & Record<string, (state: ConfigState<S>, ...args: unknown[]) => unknown>
}

/** Store 构造配置（显式泛型场景） */
export interface StoreOptions<S extends State = State, A extends Actions = Actions, G extends Getters<S> = Getters<S>> extends StoreOptionsBase<S> {
  actions?: ActionsWithThis<S, A>
  getters?: G
}

/**
 * Store 契约。S 默认 State（= object）：省略类型参数时 keyof S 退化为 never，
 * 默认实例基本不可用（已知限制，但改成 Record<string, unknown> 会改变裸 `Store`
 * 的类型含义、并与 Plugin<S=State>/PluginHook 的参数逆变冲突，属破坏性类型变更，
 * 需全库统一默认泛型后单独处理）。
 */
export interface Store<S extends State = State, A extends Actions = Actions, G extends Getters<S> = Getters<S>> {
  readonly name: string
  readonly state: S
  readonly actions: A
  /** 实例级钩子系统（每个 Store 独立） */
  readonly hooks: IHookSystem

  getState(): S
  setState<K extends keyof S>(key: K, value: S[K]): void
  $patch(partialState: Partial<S>): void
  $replaceState(newState: S | (() => S)): void
  $snapshot(): Readonly<S>
  $restore(snapshot: Readonly<S>): void
  /** 重置为初始状态：订阅保持有效，持久化草稿随通知清理 */
  $reset(): void

  /** 执行 action - 类型安全版本 */
  dispatch<K extends keyof A>(actionName: K, ...args: InferActionArgs<A, K>): InferActionReturn<A, K>
  /** 执行 action - 字符串名称调用（动态场景） */
  dispatch(actionName: string, ...args: unknown[]): unknown

  /** 使用 getter - 类型安全版本 */
  getter<K extends keyof G>(getterName: K): InferGetterReturn<G, K>
  /** 使用 getter - 字符串名称调用（动态场景） */
  getter(getterName: string): unknown
  /** 已声明的 getter 名列表（装饰期映射校验用） */
  getterNames(): string[]

  subscribe(listener: StateListener<S>, options?: { readOnly?: boolean }): () => void
  /** 当前在册订阅数（含同一监听器的多份注册； 压测与诊断用） */
  getSubscriptionCount(): number
  use(plugin: Plugin<NoInfer<S>> | Plugin<State>): () => void

  batch<T>(fn: () => T): T
  startBatch(): void
  endBatch(): void

  destroy(): void
  readonly destroyed: boolean

  /** 判断指定状态键自上次通知以来是否发生变更（供集成层精确跳过未变化的映射） */
  isStateKeyDirty(key: string | symbol): boolean
  isStateProtectionEnabled(): boolean
  setStateProtection(enabled: boolean): void
  getStateProtectionConfig(): Readonly<StateProtectionOptions>
}

// ==================== global ====================

declare global {
  /** 构建时定义的开发模式标志 */
  const __DEV__: boolean | undefined
}

export {}
