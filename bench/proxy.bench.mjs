/**
 * 代理层基准：状态读路径（保护代理 vs 裸对象）与 action 写入路径。
 *
 * 读基准都用「返回值喂给 sink」的方式防止死码消除；写基准走真实 dispatch，
 * 包含通知调度与脏键记账（默认无订阅者时通知路径会提前返回）。
 *
 * 读/写用例用工厂收敛重复的 setup/teardown 样板：少一处手写，少一处漂移。
 */
import { loadLib } from './lib.mjs'

const { lib } = loadLib()

const smallState = () => ({
  a: 1,
  b: 2,
  nested: { x: 10, y: 20 },
  list: [1, 2, 3],
  map: new Map([['k', { v: 1 }]]),
})

const largeState = () => {
  const state = {}
  for (let i = 0; i < 100; i++) state['k' + i] = i
  state.nested = { x: 10, y: 20 }
  state.list = Array.from({ length: 10000 }, (_, i) => i)
  state.map = new Map([['k', { v: 1 }]])
  return state
}

const sink = { value: 0 }

function storeWith(options, state = smallState()) {
  return lib.createStore({ state, ...options })
}

/**
 * 读用例工厂：统一 setup/teardown。
 * @param {string} name
 * @param {(store: any) => unknown} read 读取表达式（结果写入 sink，防死码消除）
 * @param {{ options?: Record<string, unknown>, state?: () => Record<string, unknown> }} [config]
 */
function readCase(name, read, config = {}) {
  return {
    name,
    setup: () => ({ store: storeWith(config.options ?? {}, (config.state ?? smallState)()) }),
    fn(context) {
      sink.value = read(context.store)
    },
    teardown: (context) => context.store.destroy(),
  }
}

/**
 * 写用例工厂：每轮 dispatch 一个 action，参数是自增 counter。
 * @param {string} name
 * @param {string} actionName
 * @param {Function} actionImpl action 实现（this 为 action 上下文）
 */
function writeCase(name, actionName, actionImpl) {
  return {
    name,
    setup() {
      const store = storeWith({ actions: { [actionName]: actionImpl } })
      return { store, counter: 0 }
    },
    fn(context) {
      context.counter += 1
      context.store.dispatch(actionName, context.counter)
    },
    teardown: (context) => context.store.destroy(),
  }
}

export const cases = [
  {
    name: 'read: raw object property (baseline)',
    setup: () => ({ object: { a: 1 } }),
    // 亚纳秒级操作：一次 fn 内做 100 次读，按 100 归一，避免闭包调用/JIT 状态主导读数
    opts: { opsPerIteration: 100 },
    fn(context) {
      for (let i = 0; i < 100; i++) sink.value = context.object.a
    },
  },
  readCase('read: store.getState().a', (store) => store.getState().a),
  readCase('read: store.state.a (protection on)', (store) => store.state.a),
  readCase('read: store.state.nested.x (depth 3, protection on)', (store) => store.state.nested.x),
  readCase('read: store.state.list[1] (array index)', (store) => store.state.list[1]),
  readCase('read: store.state.map.get(k) (builtin passthrough)', (store) => store.state.map.get('k').v),
  readCase('read: store.state.a (protection off)', (store) => store.state.a, { options: { stateProtection: { enabled: false } } }),
  readCase('read: store.state.nested.x (depth 3, protection off)', (store) => store.state.nested.x, {
    options: { stateProtection: { enabled: false } },
  }),
  readCase('read: large state 100 keys -> k50', (store) => store.state.k50, { state: largeState }),
  readCase('read: large state 10000 array -> [5000]', (store) => store.state.list[5000], { state: largeState }),
  writeCase('write: action this.state.a = i', 'writeA', function writeA(value) {
    this.state.a = value
  }),
  writeCase('write: action nested this.state.nested.x = i', 'writeNested', function writeNested(value) {
    this.state.nested.x = value
  }),
  writeCase('write: action list.push(i)', 'pushOne', function pushOne(value) {
    // 该 case 在同一 store 上贯穿探针/校准/预热/采样，必须限制数组无界增长；
    // 达到上限后重置到初始形态，避免扩容与 GC 成本污染后续样本。
    if (this.state.list.length > 1024) this.setState('list', [1, 2, 3])
    this.state.list.push(value)
  }),
  writeCase('write: action map.set(k, i)', 'setEntry', function setEntry(value) {
    // case 名是 map.set(k, i)，传标量即可；此前每轮分配 { v: counter } 把对象分配/归属登记混进测量
    this.state.map.set('k', value)
  }),
  {
    // 每轮先重建再删除（ 修复后的真实路径），case 名必须反映 set + delete；
    // 旧 baseline 的纯 delete 数值不可比，重新锚定需参考机重跑 bench:save
    name: 'write: action set + delete this.state.temp',
    setup() {
      const store = storeWith(
        {
          actions: {
            dropTemp() {
              // measure() 会在计时前先探测调用一次 fn()，temp 在探测轮就被删掉；
              // 每轮先重建再删除，确保测到「删除已存在键」的路径
              this.state.temp = 1
              delete this.state.temp
            },
          },
        },
        () => ({ ...smallState(), temp: 1 }),
      )
      return { store }
    },
    fn(context) {
      context.store.dispatch('dropTemp')
    },
    teardown: (context) => context.store.destroy(),
  },
]
