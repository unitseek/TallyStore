/**
 * 小程序集成基准：Page / Component / App 的绑定、mapState 规模、setData 触发与脏键跳过。
 *
 * 宿主一律用最小对象字面量 + setData 记录器模拟，不依赖微信开发者工具：
 * 被测的是「store 通知 → 映射器 → 宿主写入」这条真实链路的开销。
 *
 * 约定（bench/README.md）：断言放 setup/teardown，失败让该 case 标红；teardown 里的清理
 * 必须写在 finally 里——断言失败时也要释放订阅/定时器，否则会污染后续 case。
 */
import { loadLib } from './lib.mjs'

const { lib } = loadLib()

/** 生成 n 个顶层键的状态（外带一个未映射键用于脏键跳过用例） */
function stateWithKeys(count) {
  const state = { unmapped: 0 }
  for (let i = 0; i < count; i++) state['k' + i] = i
  return state
}

/** Page 实例壳：记录每轮 setData 载荷；extra 可带宿主字段（如 renderer: 'skyline'） */
function createPageInstance(extra = {}) {
  const setDataCalls = []
  const instance = {
    data: {},
    ...extra,
    setData(patch) {
      setDataCalls.push(patch)
      Object.assign(instance.data, patch)
    },
  }
  return { instance, setDataCalls }
}

/** 生成 Page 配置：n 个 state 映射 + 一个 getter 映射 + 一个 action 映射 */
function pageConfig(store, count) {
  const mapState = []
  for (let i = 0; i < count; i++) mapState.push('k' + i)
  return lib.withPageStore(store, {
    mapState,
    mapGetters: { doubled: 'doubled' },
    mapActions: { bump: 'increment' },
  })({ data: {}, onLoad() {}, onUnload() {} })
}

function componentConfig(store) {
  return lib.withComponentStore(store, {
    mapState: { localK0: 'k0', localK1: 'k1' },
    mapGetters: { localDoubled: 'doubled' },
    mapActions: { bump: 'increment' },
  })({ data: {}, methods: {}, lifetimes: {} })
}

function createComponentInstance() {
  const setDataCalls = []
  const instance = {
    data: {},
    methods: {},
    setData(patch) {
      setDataCalls.push(patch)
      Object.assign(instance.data, patch)
    },
  }
  return { instance, setDataCalls }
}

function createStore(count = 50) {
  return lib.createStore({
    name: 'bench-integration',
    state: () => stateWithKeys(count),
    actions: {
      increment() {
        this.setState('k0', this.getState().k0 + 1)
      },
    },
    getters: {
      doubled: (state) => state.k0 * 2,
    },
  })
}

/** Page 用例的公共 setup：store + 配置 + 实例 + setData 记录器 */
function pageCaseContext(count) {
  const store = createStore(50)
  const { instance, setDataCalls } = createPageInstance()
  const config = pageConfig(store, count)
  return { store, config, instance, setDataCalls }
}

/** 不读取 setDataCalls 的用例只返回必要字段，避免出现「看起来在测、实际没人读」的字段 */
function pageCaseContextWithoutCalls(count) {
  const { store, config, instance } = pageCaseContext(count)
  return { store, config, instance }
}

export const cases = [
  {
    name: 'page: onLoad map 5 state keys',
    setup: () => pageCaseContextWithoutCalls(5),
    fn(context) {
      context.config.onLoad.call(context.instance)
    },
    teardown(context) {
      context.config.onUnload.call(context.instance)
      context.store.destroy()
    },
  },
  {
    name: 'page: onLoad map 50 state keys',
    setup: () => pageCaseContextWithoutCalls(50),
    fn(context) {
      context.config.onLoad.call(context.instance)
    },
    teardown(context) {
      context.config.onUnload.call(context.instance)
      context.store.destroy()
    },
  },
  {
    name: 'page: setState -> one setData (5 mapped keys)',
    setup() {
      const context = pageCaseContext(5)
      context.config.onLoad.call(context.instance)
      return { ...context, counter: 0, badWrites: 0 }
    },
    fn(context) {
      context.counter += 1
      const before = context.setDataCalls.length
      context.store.setState('k0', context.counter)
      // 每次迭代都校验「恰好 1 次」；teardown 只在整轮结束后汇总，不能按总次数断言
      if (context.setDataCalls.length - before !== 1) context.badWrites += 1
    },
    teardown(context) {
      try {
        if (context.badWrites !== 0) {
          throw new Error('page 映射写入应每次恰好触发 1 次 setData，违规 ' + context.badWrites + ' 次（共 ' + context.counter + ' 次写入）')
        }
      } finally {
        context.config.onUnload.call(context.instance)
        context.store.destroy()
      }
    },
  },
  {
    //  覆盖约束：Skyline 合并（宿主 renderer='skyline' + 集成默认 schedule:'auto'）。
    // 对照：WebView 宿主（renderer 不是 'skyline'）下同一 tick 的两次映射写入会各写一次 setData（共 2 次），
    // Skyline 用微任务把同一 tick 的多次写入合并成 1 次；本 case 测合并后的路径（含微任务交付成本）。
    name: 'page: skyline same-tick setState x2 -> 1 setData (state+getter merged)',
    setup() {
      const context = pageCaseContext(5)
      context.instance.renderer = 'skyline'
      context.config.onLoad.call(context.instance)
      return { ...context, counter: 0, badWrites: 0 }
    },
    async fn(context) {
      context.counter += 1
      const before = context.setDataCalls.length
      // 同一 tick 写两个被映射的 state 键；getter 映射随同一轮通知重算
      context.store.setState('k0', context.counter)
      context.store.setState('k1', context.counter * 2)
      // 合并写入在同一 tick 的微任务里交付：等两跳让本轮 flush 计入本次迭代
      await Promise.resolve()
      await Promise.resolve()
      if (context.setDataCalls.length - before !== 1) {
        context.badWrites += 1
        return
      }
      const payload = context.setDataCalls[context.setDataCalls.length - 1]
      if (!payload || !('k0' in payload) || !('k1' in payload) || !('doubled' in payload)) {
        context.badWrites += 1
      }
    },
    teardown(context) {
      try {
        if (context.badWrites !== 0) {
          throw new Error(
            'Skyline 同 tick 两次映射写入应合并为 1 次 setData 且载荷含合并后的 k0/k1/doubled，违规 ' +
              context.badWrites +
              ' 次（共 ' +
              context.counter +
              ' 轮）',
          )
        }
      } finally {
        context.config.onUnload.call(context.instance)
        context.store.destroy()
      }
    },
  },
  {
    name: 'page: unmapped key write -> dirty-key skip (no setData)',
    setup() {
      const context = pageCaseContext(5)
      context.config.onLoad.call(context.instance)
      return { ...context, afterLoad: context.setDataCalls.length, counter: 0 }
    },
    fn(context) {
      context.counter += 1
      context.store.setState('unmapped', context.counter)
    },
    teardown(context) {
      try {
        if (context.afterLoad < 1) {
          throw new Error('onLoad 初始映射未产生 setData，脏键跳过用例失去前提')
        }
        const extra = context.setDataCalls.length - context.afterLoad
        if (extra !== 0) {
          throw new Error('未映射键的写入不应触发 setData，实际增加了 ' + extra + ' 次')
        }
      } finally {
        context.config.onUnload.call(context.instance)
        context.store.destroy()
      }
    },
  },
  {
    name: 'page: bind + onUnload pair (5 mapped keys)',
    setup: () => pageCaseContext(5),
    fn(context) {
      context.config.onLoad.call(context.instance)
      context.config.onUnload.call(context.instance)
    },
    teardown(context) {
      try {
        // 验证 onUnload 真的退订（漏掉 disconnectHost 时这里才会失败）
        const before = context.setDataCalls.length
        context.store.setState('k0', -1)
        if (context.setDataCalls.length !== before) {
          throw new Error('onUnload 后仍收到 store 通知，绑定未解绑')
        }
      } finally {
        context.store.destroy()
      }
    },
  },
  {
    name: 'page: mapped action call (bump)',
    setup() {
      const context = pageCaseContext(5)
      context.config.onLoad.call(context.instance)
      return { ...context, badWrites: 0, calls: 0 }
    },
    fn(context) {
      context.calls += 1
      const before = context.setDataCalls.length
      context.instance.bump()
      if (context.setDataCalls.length - before !== 1) context.badWrites += 1
    },
    teardown(context) {
      try {
        if (context.badWrites !== 0) {
          throw new Error('映射 action 应每次恰好触发 1 次 setData，违规 ' + context.badWrites + ' 次（共 ' + context.calls + ' 次调用）')
        }
      } finally {
        context.config.onUnload.call(context.instance)
        context.store.destroy()
      }
    },
  },
  {
    name: 'component: attached + detached pair',
    setup() {
      const store = createStore(50)
      const { instance } = createComponentInstance()
      const config = componentConfig(store)
      return { store, config, instance }
    },
    fn(context) {
      context.config.lifetimes.attached.call(context.instance)
      context.config.lifetimes.detached.call(context.instance)
    },
    teardown(context) {
      context.store.destroy()
    },
  },
  {
    name: 'component: attached maps data + methods',
    setup() {
      const store = createStore(50)
      const { instance } = createComponentInstance()
      const config = componentConfig(store)
      return { store, config, instance }
    },
    fn(context) {
      context.config.lifetimes.attached.call(context.instance)
    },
    teardown(context) {
      try {
        if (context.instance.data.localK0 !== 0 || typeof context.instance.methods.bump !== 'function') {
          throw new Error('component attached 未完成映射')
        }
      } finally {
        context.config.lifetimes.detached.call(context.instance)
        context.store.destroy()
      }
    },
  },
  {
    name: 'app: onLaunch map 5 keys',
    setup() {
      const store = createStore(50)
      const config = lib.withAppStore(store, {
        mapState: ['k0', 'k1', 'k2', 'k3', 'k4'],
        mapGetters: { doubled: 'doubled' },
        mapActions: { bump: 'increment' },
      })({ globalData: {}, onLaunch() {} })
      const instance = { globalData: {} }
      return { store, config, instance }
    },
    fn(context) {
      context.config.onLaunch.call(context.instance)
    },
    teardown(context) {
      try {
        if (context.instance.globalData.k0 !== 0 || typeof context.instance.bump !== 'function') {
          throw new Error('app onLaunch 未完成映射')
        }
      } finally {
        context.store.destroy()
      }
    },
  },
]
