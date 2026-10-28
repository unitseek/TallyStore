/**
 * 插件基准：持久化的安装/写入/恢复/卸载补写与 logger 的写入开销。
 *
 * 用内存 StorageBackend 隔离宿主差异；logger 用 noop sink，只测「日志插件的接线成本」。
 *
 * 约定（bench/README.md）：断言放 setup/teardown（失败让该 case 标红），清理写 finally。
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

/** 持久化 key 常量：store.name 与插件 key 必须是同一个字面量，避免只改一处导致恢复/补写静默失效 */
const NOOP_KEY = 'bench-persist-noop'
const RESTORE_SMALL_KEY = 'bench-persist-restore-small'
const RESTORE_LARGE_KEY = 'bench-persist-restore-large'
const FLUSH_KEY = 'bench-persist-flush'
const BOTH_KEY = 'bench-both'

const SMALL_KEY = 'bench-persist-small'
const LARGE_KEY = 'bench-persist-large'
/** 恢复用例的种子必须与默认 state 可区分：否则无法判断恢复真的发生，还是被跳过 */
const smallSeed = JSON.stringify({ ...smallState(), count: 1 })
const largeSeed = JSON.stringify({ ...largeState(), count: 1 })

export const cases = [
  {
    name: 'baseline: setState single key (no plugins)',
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
    // 与 persistence no-op 用例同路径的「无插件」对照，否则两者差值混入 baseline 的额外工作
    name: 'baseline: setState equal value (no plugins)',
    setup() {
      return { store: lib.createStore({ state: () => smallState() }) }
    },
    fn(context) {
      // 与当前值相等：setState 在相等性检查处短路，不通知、不落盘
      context.store.setState('count', 0)
    },
    teardown: (context) => context.store.destroy(),
  },
  {
    name: 'persistence: setState no-op (installed, no notify)',
    setup() {
      const store = lib.createStore({ name: NOOP_KEY, state: () => smallState() })
      store.use(plugins.persistencePlugin({ key: NOOP_KEY, storage: memoryBackend(), filter: (state) => state, debounce: 0, restore: false }))
      return { store }
    },
    fn(context) {
      // 与当前值相等：setState 短路，不通知、不落盘，只测插件接线后的固定开销
      context.store.setState('count', 0)
    },
    teardown: (context) => context.store.destroy(),
  },
  {
    name: 'persistence: write small state (debounce 0)',
    setup() {
      const backend = memoryBackend()
      const store = lib.createStore({ name: 'bench-persist-write-small', state: () => smallState() })
      store.use(plugins.persistencePlugin({ key: SMALL_KEY, storage: backend, filter: (state) => state, debounce: 0, restore: false }))
      return { store, backend, counter: 0 }
    },
    fn(context) {
      context.counter += 1
      context.store.setState('count', context.counter)
    },
    teardown(context) {
      try {
        // 证明写用例真的落盘；debounce/通知语义变化导致空跑时直接标红
        if (!context.backend.map.has(SMALL_KEY)) {
          throw new Error('write small 未真正落盘（backend 中找不到 ' + SMALL_KEY + '）')
        }
      } finally {
        context.store.destroy()
      }
    },
  },
  {
    name: 'persistence: write large state (debounce 0)',
    setup() {
      const backend = memoryBackend()
      const store = lib.createStore({ name: 'bench-persist-write-large', state: () => largeState() })
      store.use(plugins.persistencePlugin({ key: LARGE_KEY, storage: backend, filter: (state) => state, debounce: 0, restore: false }))
      return { store, backend, counter: 0 }
    },
    fn(context) {
      context.counter += 1
      context.store.setState('count', context.counter)
    },
    teardown(context) {
      try {
        if (!context.backend.map.has(LARGE_KEY)) {
          throw new Error('write large 未真正落盘（backend 中找不到 ' + LARGE_KEY + '）')
        }
      } finally {
        context.store.destroy()
      }
    },
  },
  {
    name: 'persistence: restore small from JSON (install + destroy)',
    setup() {
      // backend/断言状态在 setup 准备，fn 只留被测的 use + destroy（断言移到 teardown）
      return { backend: memoryBackend({ [RESTORE_SMALL_KEY]: smallSeed }), restored: false }
    },
    fn(context) {
      const store = lib.createStore({ name: RESTORE_SMALL_KEY, state: () => smallState() })
      try {
        store.use(plugins.persistencePlugin({ key: RESTORE_SMALL_KEY, storage: context.backend, filter: (state) => state, debounce: 0 }))
        // 种子写的是 count:1，恢复被跳过时这里是 0；只记录一次廉价读取，判定放 teardown
        context.restored = store.getState().count === 1
      } finally {
        store.destroy()
      }
    },
    teardown(context) {
      if (!context.restored) {
        throw new Error('restore small 未恢复 count=1（恢复可能被跳过）')
      }
    },
  },
  {
    name: 'persistence: restore large from JSON (install + destroy)',
    // 口径：destroy() 的卸载补写会对整棵状态再做一次 JSON.stringify 与 lastSaved 比较
    //（persistence.ts 的 saveState/卸载分支），因此 large 的实测值 = JSON.parse + $patch + 一次全量序列化。
    setup() {
      return { backend: memoryBackend({ [RESTORE_LARGE_KEY]: largeSeed }), restored: false }
    },
    fn(context) {
      const store = lib.createStore({ name: RESTORE_LARGE_KEY, state: () => largeState() })
      try {
        store.use(plugins.persistencePlugin({ key: RESTORE_LARGE_KEY, storage: context.backend, filter: (state) => state, debounce: 0 }))
        context.restored = store.getState().count === 1
      } finally {
        store.destroy()
      }
    },
    teardown(context) {
      if (!context.restored) {
        throw new Error('restore large 未恢复 count=1（恢复可能被跳过）')
      }
    },
  },
  {
    name: 'persistence: uninstall flush (pending debounce 1000ms)',
    fn() {
      const backend = memoryBackend()
      const store = lib.createStore({ name: FLUSH_KEY, state: () => smallState() })
      // try/finally 保证任何路径都执行 destroy——否则 1000ms 防抖定时器会活到后续 case
      try {
        store.use(plugins.persistencePlugin({ key: FLUSH_KEY, storage: backend, filter: (state) => state, debounce: 1000, restore: false }))
        store.setState('count', 1)
      } finally {
        // destroy -> 卸载：清定时器 + 同步补写 pendingState（含末次状态）
        store.destroy()
      }
    },
  },
  {
    name: 'logger: setState with noop sink (write overhead)',
    setup() {
      const store = lib.createStore({ name: 'bench-logger', state: () => smallState() })
      store.use(plugins.loggerPlugin({ sink: noopSink }))
      return { store, counter: 0 }
    },
    fn(context) {
      context.counter += 1
      context.store.setState('count', context.counter)
    },
    teardown: (context) => context.store.destroy(),
  },
  {
    name: 'persistence + logger: setState small state',
    setup() {
      const backend = memoryBackend()
      const store = lib.createStore({ name: BOTH_KEY, state: () => smallState() })
      store.use(plugins.persistencePlugin({ key: BOTH_KEY, storage: backend, filter: (state) => state, debounce: 0, restore: false }))
      store.use(plugins.loggerPlugin({ sink: noopSink }))
      return { store, counter: 0 }
    },
    fn(context) {
      context.counter += 1
      context.store.setState('count', context.counter)
    },
    teardown: (context) => context.store.destroy(),
  },
]
