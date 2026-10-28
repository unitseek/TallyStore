/**
 * Store 核心基准：构造/销毁、状态写入、批量、dispatch、快照、订阅通知与异步合并。
 * 所有 case 都在 setup 里建新 store，teardown 里 destroy，避免跨 case 状态与定时器泄漏。
 */
import { loadLib, memoryBackend } from './lib.mjs'

const { lib, plugins } = loadLib()

const noopSink = { log() {}, error() {} }

const smallState = () => ({ count: 0 })
const largeState = () => {
  const state = { count: 0 }
  for (let i = 0; i < 100; i++) state['k' + i] = i
  state.list = Array.from({ length: 10000 }, (_, i) => i)
  return state
}

const noopListener = () => {}

export const cases = [
  {
    name: 'createStore + destroy: small state',
    fn() {
      const store = lib.createStore({ state: () => smallState() })
      // 该 case 无插件、构造后也没有可能抛错的步骤：空 try/finally 是假保护；
      // 需要 finally 的是下面含插件安装的用例。
      store.destroy()
    },
  },
  {
    name: 'createStore + destroy: 2 plugins (persistence + logger)',
    setup() {
      return { backend: memoryBackend() }
    },
    fn(context) {
      const store = lib.createStore({ name: 'bench-create-destroy', state: () => smallState() })
      // 插件安装可能抛错（storage 形状/重复安装等），必须 finally 里销毁，避免定时器/订阅泄漏
      try {
        store.use(
          plugins.persistencePlugin({
            key: 'bench-create-destroy',
            storage: context.backend,
            filter: (state) => state,
            restore: false,
            clearOnUninstall: true,
          }),
        )
        store.use(plugins.loggerPlugin({ sink: noopSink }))
      } finally {
        store.destroy()
      }
    },
  },
  {
    name: 'setState: single key',
    setup() {
      return { store: lib.createStore({ state: () => smallState() }), counter: 0 }
    },
    fn(context) {
      context.counter += 1
      context.store.setState('count', context.counter)
    },
    teardown: (context) => context.store.destroy(),
  },
  {
    name: '$patch: shallow',
    setup() {
      return { store: lib.createStore({ state: () => smallState() }), counter: 0 }
    },
    fn(context) {
      context.counter += 1
      context.store.$patch({ count: context.counter })
    },
    teardown: (context) => context.store.destroy(),
  },
  {
    name: '$patch: deep nested',
    setup() {
      return { store: lib.createStore({ state: () => ({ nested: { x: 0, y: 0 } }) }), counter: 0 }
    },
    fn(context) {
      context.counter += 1
      context.store.$patch({ nested: { x: context.counter } })
    },
    teardown: (context) => context.store.destroy(),
  },
  {
    name: '$replaceState: small state',
    setup() {
      return { store: lib.createStore({ state: () => smallState() }), counter: 0 }
    },
    fn(context) {
      context.counter += 1
      context.store.$replaceState({ count: context.counter })
    },
    teardown: (context) => context.store.destroy(),
  },
  {
    // body 只有 a/b 两次 setState，嵌套 batch 不是一次写；case 名是 baseline 比较键，必须准确
    name: 'batch: nested 2 levels (2 writes)',
    setup() {
      return { store: lib.createStore({ state: () => ({ a: 0, b: 0 }) }), counter: 0 }
    },
    fn(context) {
      context.counter += 1
      context.store.batch(() => {
        context.store.setState('a', context.counter)
        context.store.batch(() => {
          context.store.setState('b', context.counter)
        })
      })
    },
    teardown: (context) => context.store.destroy(),
  },
  {
    name: 'dispatch: sync action',
    setup() {
      const store = lib.createStore({
        state: () => smallState(),
        actions: {
          increment() {
            this.setState('count', this.getState().count + 1)
          },
        },
      })
      return { store }
    },
    fn(context) {
      context.store.dispatch('increment')
    },
    teardown: (context) => context.store.destroy(),
  },
  {
    name: 'dispatch: async action (await settle)',
    setup() {
      const store = lib.createStore({
        state: () => smallState(),
        actions: {
          async incrementAsync() {
            await Promise.resolve()
            this.setState('count', this.getState().count + 1)
          },
        },
      })
      return { store }
    },
    async fn(context) {
      await context.store.dispatch('incrementAsync')
    },
    teardown: (context) => context.store.destroy(),
  },
  {
    name: 'getter: computed value',
    setup() {
      const store = lib.createStore({
        state: () => ({ count: 2 }),
        getters: { doubled: (state) => state.count * 2 },
      })
      return { store }
    },
    fn(context) {
      context.store.getter('doubled')
    },
    teardown: (context) => context.store.destroy(),
  },
  {
    name: '$snapshot: small state',
    setup() {
      const store = lib.createStore({ state: () => ({ count: 0, nested: { x: 1 }, list: [1, 2, 3] }) })
      return { store }
    },
    fn(context) {
      context.store.$snapshot()
    },
    teardown: (context) => context.store.destroy(),
  },
  {
    name: '$snapshot: large state (100 keys + 10000 list)',
    setup() {
      const store = lib.createStore({ state: () => largeState() })
      return { store }
    },
    fn(context) {
      context.store.$snapshot()
    },
    teardown: (context) => context.store.destroy(),
  },
  {
    name: '$restore: small snapshot',
    setup() {
      const store = lib.createStore({ state: () => smallState() })
      return { store, snapshot: store.$snapshot() }
    },
    fn(context) {
      context.store.$restore(context.snapshot)
    },
    teardown: (context) => context.store.destroy(),
  },
  {
    name: 'notify: 1 readOnly listener',
    setup() {
      const store = lib.createStore({ state: () => smallState() })
      store.subscribe(noopListener, { readOnly: true })
      return { store }
    },
    fn(context) {
      context.store.setState('count', context.store.getState().count + 1)
    },
    teardown: (context) => context.store.destroy(),
  },
  {
    name: 'notify: 50 readOnly listeners',
    setup() {
      // 默认订阅上限恰好 50（StoreNotifier.DEFAULT_MAX_SUBSCRIBERS），
      // 显式提高上限给本 case 留 headroom，避免未来多出的内置/插件订阅被静默驱逐
      const store = lib.createStore({ state: () => smallState(), subscription: { maxSubscribers: 100 } })
      for (let i = 0; i < 50; i++) store.subscribe(noopListener, { readOnly: true })
      return { store }
    },
    fn(context) {
      context.store.setState('count', context.store.getState().count + 1)
    },
    teardown: (context) => context.store.destroy(),
  },
  {
    name: 'notify: 1 writable listener (payload clone) small state',
    setup() {
      const store = lib.createStore({ state: () => smallState() })
      store.subscribe(noopListener)
      return { store }
    },
    fn(context) {
      context.store.setState('count', context.store.getState().count + 1)
    },
    teardown: (context) => context.store.destroy(),
  },
  {
    name: 'notify: 1 writable listener (payload clone) large state',
    setup() {
      const store = lib.createStore({ state: () => largeState() })
      store.subscribe(noopListener)
      return { store }
    },
    fn(context) {
      context.store.setState('count', context.store.getState().count + 1)
    },
    teardown: (context) => context.store.destroy(),
  },
  {
    name: 'notify.async: 100 writes coalesced into 1 notification',
    setup() {
      const store = lib.createStore({ state: () => smallState(), notify: { async: true } })
      const stats = { calls: 0, notifications: 0 }
      store.subscribe(
        () => {
          stats.notifications += 1
        },
        { readOnly: true },
      )
      return { store, counter: 0, stats }
    },
    async fn(context) {
      for (let i = 0; i < 100; i++) {
        context.counter += 1
        context.store.setState('count', context.counter)
      }
      context.stats.calls += 1
      // 合并通知在微任务里派发：等两跳让本轮 flush 计入本次迭代（多等一跳是防御性余量）
      await Promise.resolve()
      await Promise.resolve()
    },
    teardown(context) {
      try {
        // 证明合并通知真的派发且确实合并了（100 次写入/轮 → 不应是每写一次通知一次）
        if (context.stats.calls === 0) throw new Error('notify.async 用例未执行任何一轮')
        if (context.stats.notifications === 0) throw new Error('notify.async 合并通知未派发')
        if (context.stats.notifications > context.stats.calls) {
          throw new Error('notify.async 未合并通知：' + context.stats.notifications + ' 次通知 / ' + context.stats.calls + ' 轮')
        }
      } finally {
        context.store.destroy()
      }
    },
  },
  {
    name: 'subscribe + unsubscribe churn',
    setup() {
      return { store: lib.createStore({ state: () => smallState() }) }
    },
    fn(context) {
      const off = context.store.subscribe(noopListener, { readOnly: true })
      off()
    },
    teardown: (context) => context.store.destroy(),
  },
]
