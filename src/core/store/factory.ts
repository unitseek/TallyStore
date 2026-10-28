import { Store } from './Store.js'
import type { StoreConfig, State, Actions, Getters } from '../../types/store.js'

/*
 * 类型设计：S/A/G 由字面量各自推断；state 用重载区分「工厂函数 / 对象字面量 / 省略」三种形态
 * （工厂重载必须在前）。重载配置先 Omit<StoreConfig, 'state'> 再固定 state 类型，避免交集推断歧义。
 * 显式泛型只给一个类型参数时其余落到默认值（TypeScript 语义），需要精确类型请写全三个。
 */

type StoreConfigWithoutState<S, A, G> = Omit<StoreConfig<S, A, G>, 'state'>

type FactoryStoreConfig<S extends State, A extends Actions = Actions, G extends Getters<S> = Getters<S>> = StoreConfigWithoutState<S, A, G> & {
  state: () => S
}

type LiteralStoreConfig<S extends State, A extends Actions = Actions, G extends Getters<S> = Getters<S>> = StoreConfigWithoutState<S, A, G> & { state: S }

/** 创建 Store 实例（state 工厂函数形式） */
export function createStore<S extends State, A extends Actions = Actions, G extends Getters<S> = Getters<S>>(
  options: FactoryStoreConfig<S, A, G>,
): Store<S, A, G>

/**
 * 创建 Store 实例（state 对象字面量形式）。
 * 函数形态的 state 由重载声明顺序（工厂重载在前）与运行期 state 归一化保证走工厂语义；
 * 这里不再写无意义的 Exclude<State, ...>（State 是非联合别名 object，Exclude 恒等）。
 */
export function createStore<S extends State, A extends Actions = Actions, G extends Getters<S> = Getters<S>>(
  options: LiteralStoreConfig<S, A, G>,
): Store<S, A, G>

/**
 * 创建 Store 实例（省略 state）。
 * 运行时初始状态是空对象，状态键由 setState / $patch / $replaceState 在之后添加。
 */
export function createStore<S extends State = Record<string, unknown>, A extends Actions = Actions, G extends Getters<S> = Getters<S>>(
  options?: StoreConfigWithoutState<S, A, G> & { state?: undefined },
): Store<S, A, G>

// 实现签名（对外不可见，仅需兼容上述重载）
export function createStore<S extends State = Record<string, unknown>, A extends Actions = Actions, G extends Getters<S> = Getters<S>>(
  options: (StoreConfigWithoutState<S | (() => S), A, G> & { state?: S | (() => S) }) | undefined = {},
): Store<S, A, G> {
  // 数组配置会静默建出一个空 store，故与 null/非对象同口径就地拒绝
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('[TallyStore] createStore: options must be a valid object')
  }
  // 本工厂是未类型化 JS 调用的文档边界，state 必须在构造期 fail-fast。
  // null / 原始值此前会让 Store 静默变成空仓或坏状态，错误被推迟到首次 setState/$patch 才暴露
  const state = (options as { state?: unknown }).state
  if (state !== undefined && (state === null || (typeof state !== 'function' && typeof state !== 'object'))) {
    throw new TypeError('[TallyStore] createStore: state must be a function or a non-null object')
  }
  return new Store(options)
}
