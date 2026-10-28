/**  / AS-05：生命周期解绑与泄漏防护——实例级订阅计数、同步兜底 + 延迟复核、手动解绑、100 次进出压测 */
import { createStore, unbindStore } from '../../../src/index.js'
import { withPageStore, withComponentStore } from '../../../src/integrations/with-store.js'
import { withAppStore } from '../../../src/integrations/with-app-store.js'
import { createHost } from '../../utils/host.js'
import { connectHost, disconnectHost, __getBindingSubscriptionCountForTests, __setLeakRecheckSchedulerForTests } from '../../../src/integrations/connect.js'

type PageHost = {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  [key: string]: unknown
}

type DecoratedPage = {
  onLoad: (this: PageHost) => void
  onUnload: (this: PageHost) => void
}

type DecoratedComponent = {
  lifetimes: {
    attached: (this: Record<string, unknown>) => void
    detached: (this: Record<string, unknown>) => void
  }
}

type DecoratedApp = { onLaunch: (this: Record<string, unknown>) => void }

function makeStore(name: string) {
  return createStore({
    name,
    state: () => ({ count: 0 }),
    actions: {
      inc() {
        this.setState('count', this.getState().count + 1)
      },
    },
  })
}

function decorate(store: ReturnType<typeof makeStore>): DecoratedPage {
  return (withPageStore(store, { mapState: ['count'], mapActions: ['inc'] }) as unknown as (c: object) => DecoratedPage)({ data: {} })
}

function decorateComponent(store: ReturnType<typeof makeStore>): DecoratedComponent {
  return (withComponentStore(store, { mapState: ['count'] } as never) as unknown as (c: object) => DecoratedComponent)({ data: {}, lifetimes: {} })
}

function decorateApp(store: ReturnType<typeof makeStore>): DecoratedApp {
  return (withAppStore(store, { mapState: ['count'] } as never) as unknown as (c: object) => DecoratedApp)({})
}

/** 泄漏复核调度器改为手动队列：测试显式 flush 才执行「一个 tick 后」的复核，断言确定 */
let recheckQueue: Array<() => void> = []

beforeEach(() => {
  recheckQueue = []
  __setLeakRecheckSchedulerForTests((callback) => {
    recheckQueue.push(callback)
  })
})

afterEach(() => {
  __setLeakRecheckSchedulerForTests()
  jest.restoreAllMocks()
})

function flushLeakRechecks(): void {
  const queue = recheckQueue
  recheckQueue = []
  for (const callback of queue) callback()
}

/** 退订失效的 store 替身：subscribe 返回 no-op，getSubscriptionCount 走可控序列（数字或抛错） */
function makeLeakyStore(name: string, countSequence: Array<number | 'throw'>) {
  const listeners: Array<() => void> = []
  const onError = jest.fn()
  const counts = [...countSequence]
  const fakeStore = {
    name,
    subscribe: jest.fn(() => {
      listeners.push(() => {})
      return () => {}
    }),
    dispatch: jest.fn(),
    state: { count: 1 },
    getState: () => ({ count: 1 }),
    getterNames: () => [],
    actions: {},
    getter: jest.fn(),
    isStateKeyDirty: () => true,
    getSubscriptionCount: () => {
      const next = counts.length > 0 ? (counts.shift() as number | 'throw') : 0
      if (next === 'throw') throw new Error('count boom')
      return next
    },
    hooks: { emit: onError },
  } as never
  return { fakeStore, listeners, onError }
}

describe(' 订阅计数', () => {
  it('getSubscriptionCount 反映注册/退订，同一监听器多份注册计多份', () => {
    const store = makeStore('fr09-count')
    expect(store.getSubscriptionCount()).toBe(0)
    const listener = () => {}
    const off1 = store.subscribe(listener)
    const off2 = store.subscribe(listener, { readOnly: true })
    expect(store.getSubscriptionCount()).toBe(2)
    off1()
    expect(store.getSubscriptionCount()).toBe(1)
    off2()
    expect(store.getSubscriptionCount()).toBe(0)
    store.destroy()
  })

  it('实例级订阅计数：映射绑定为 1，解绑归 0；仅 actions 绑定为 0（无订阅）', () => {
    const store = makeStore('fr09-instance')
    const page = decorate(store)
    const { host } = createHost()
    page.onLoad.call(host as unknown as PageHost)
    expect(__getBindingSubscriptionCountForTests(host as unknown as object, store as unknown as object)).toBe(1)
    page.onUnload.call(host as unknown as PageHost)
    expect(__getBindingSubscriptionCountForTests(host as unknown as object, store as unknown as object)).toBe(0)

    const actionOnlyPage = (withPageStore(store, { mapActions: ['inc'] } as never) as unknown as (c: object) => DecoratedPage)({ data: {} })
    const { host: actionHost } = createHost()
    const queueBeforeActionOnly = recheckQueue.length
    actionOnlyPage.onLoad.call(actionHost as unknown as PageHost)
    expect(__getBindingSubscriptionCountForTests(actionHost as unknown as object, store as unknown as object)).toBe(0)
    actionOnlyPage.onUnload.call(actionHost as unknown as PageHost)
    // 无映射订阅的 actions-only 绑定不调度延迟复核
    expect(recheckQueue).toHaveLength(queueBeforeActionOnly)
    store.destroy()
  })
})

describe(' 手动解绑', () => {
  it('unbindStore 提前解绑：状态变更不再触发该实例 setData，action 绑定移除；幂等', () => {
    const store = makeStore('fr09-manual')
    const page = decorate(store)
    const { host, setDataCalls } = createHost()
    page.onLoad.call(host as unknown as PageHost)
    setDataCalls.splice(0, setDataCalls.length)

    unbindStore(host as unknown as object, store as unknown as object)
    store.actions.inc()
    expect(setDataCalls.length).toBe(0)
    expect(host.inc as (() => void) | undefined).toBeUndefined()
    // 幂等：重复解绑无副作用，也不会重复调度延迟复核
    expect(() => unbindStore(host as unknown as object, store as unknown as object)).not.toThrow()
    expect(recheckQueue).toHaveLength(1)
    store.destroy()
  })
})

describe(' 泄漏告警', () => {
  it('同步兜底：no-op 退订（计数不降）→ 立即 console.warn + onError(unbind)，延迟复核不重复上报', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { fakeStore, listeners, onError } = makeLeakyStore('leaky', [1, 1])
    const { host } = createHost()
    connectHost(fakeStore, { mapState: ['count'] } as never, host as never, { label: 'leakTest', write: () => {} } as never)
    expect(listeners.length).toBe(1)

    disconnectHost(host as unknown as object, fakeStore as unknown as object)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('订阅计数未下降'))
    const errorCalls = onError.mock.calls.filter(([event]) => event === 'onError')
    expect(errorCalls).toHaveLength(1)
    expect(errorCalls[0][2]).toBe('unbind')
    // 同步兜底已上报 → 不再调度延迟复核
    expect(recheckQueue).toHaveLength(0)
    expect(listeners.length).toBe(1)
  })

  it('实例级延迟复核：同步看似已退订、一个 tick 后计数回弹 → 只上报一次', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    // 解绑前 2（含其它订阅）、同步解绑后 1（看似退订成功）、一个 tick 后 2（本实例订阅回弹/退订延迟生效）
    const { fakeStore, listeners, onError } = makeLeakyStore('leaky-delayed', [2, 1, 2])
    const { host } = createHost()
    connectHost(fakeStore, { mapState: ['count'] } as never, host as never, { label: 'leakDelay', write: () => {} } as never)
    expect(listeners.length).toBe(1)

    disconnectHost(host as unknown as object, fakeStore as unknown as object)
    // 同步兜底不触发（解绑后计数已下降），等待延迟复核
    expect(warn).not.toHaveBeenCalled()
    expect(recheckQueue).toHaveLength(1)

    flushLeakRechecks()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('订阅计数未下降'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('下一个 tick 后'))
    const errorCalls = onError.mock.calls.filter(([event]) => event === 'onError')
    expect(errorCalls).toHaveLength(1)
    expect(errorCalls[0][2]).toBe('unbind')

    // 再次 flush 不重复上报（reported 标记）
    flushLeakRechecks()
    expect(onError.mock.calls.filter(([event]) => event === 'onError')).toHaveLength(1)
  })

  it('延迟复核读取计数抛错：不可判定时不告警（fail-open）', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    // 解绑前 2、同步后 1 看似正常；延迟复核读取计数时抛错 → 不可判定，不告警
    const { fakeStore, onError } = makeLeakyStore('leaky-read-throw', [2, 1, 'throw'])
    const { host } = createHost()
    connectHost(fakeStore, { mapState: ['count'] } as never, host as never, { label: 'leakReadThrow', write: () => {} } as never)

    disconnectHost(host as unknown as object, fakeStore as unknown as object)
    expect(recheckQueue).toHaveLength(1)
    expect(() => flushLeakRechecks()).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
    expect(onError.mock.calls.filter(([event]) => event === 'onError')).toHaveLength(0)
  })

  it('正常解绑（计数下降）同步不告警，延迟复核也不误报', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = makeStore('fr09-healthy')
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const page = decorate(store)
    const { host } = createHost()
    page.onLoad.call(host as unknown as PageHost)
    page.onUnload.call(host as unknown as PageHost)
    expect(warn).not.toHaveBeenCalled()
    expect(store.getSubscriptionCount()).toBe(0)
    expect(recheckQueue).toHaveLength(1)

    flushLeakRechecks()
    expect(warn).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    store.destroy()
  })

  it('默认调度（微任务）：一个 tick 后正常解绑仍不误报', async () => {
    __setLeakRecheckSchedulerForTests()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = makeStore('fr09-microtask')
    const page = decorate(store)
    const { host } = createHost()
    page.onLoad.call(host as unknown as PageHost)
    page.onUnload.call(host as unknown as PageHost)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('订阅计数未下降'))
    expect(store.getSubscriptionCount()).toBe(0)
    store.destroy()
  })

  it('宿主缺少 queueMicrotask 时回退 Promise 微任务，仍不误报', async () => {
    const globalWithQueue = globalThis as { queueMicrotask?: unknown }
    const originalQueueMicrotask = globalWithQueue.queueMicrotask
    globalWithQueue.queueMicrotask = undefined
    __setLeakRecheckSchedulerForTests()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = makeStore('fr09-no-queue-microtask')
    try {
      const page = decorate(store)
      const { host } = createHost()
      page.onLoad.call(host as unknown as PageHost)
      page.onUnload.call(host as unknown as PageHost)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('订阅计数未下降'))
      expect(store.getSubscriptionCount()).toBe(0)
    } finally {
      globalWithQueue.queueMicrotask = originalQueueMicrotask
      store.destroy()
    }
  })

  it('withComponentStore detached：实例级计数 1→0，延迟复核不误报', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = makeStore('fr09-component')
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const component = decorateComponent(store)
    const { host } = createHost({ methods: {} })

    component.lifetimes.attached.call(host)
    expect(__getBindingSubscriptionCountForTests(host as unknown as object, store as unknown as object)).toBe(1)
    component.lifetimes.detached.call(host)
    expect(__getBindingSubscriptionCountForTests(host as unknown as object, store as unknown as object)).toBe(0)
    expect(store.getSubscriptionCount()).toBe(0)

    flushLeakRechecks()
    expect(warn).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    store.destroy()
  })

  it('withAppStore + unbindStore：手动解绑实例级计数归 0，延迟复核不误报', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = makeStore('fr09-app')
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const app = decorateApp(store)
    const host: Record<string, unknown> = {}

    app.onLaunch.call(host)
    expect(__getBindingSubscriptionCountForTests(host, store as unknown as object)).toBe(1)
    unbindStore(host, store as unknown as object)
    expect(__getBindingSubscriptionCountForTests(host, store as unknown as object)).toBe(0)
    expect(store.getSubscriptionCount()).toBe(0)

    flushLeakRechecks()
    expect(warn).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    store.destroy()
  })
})

describe(' 压力：反复进出 100 次（AS-05）', () => {
  it('订阅数不增长；实例级计数随进出归零；延迟复核不产生泄漏告警；无 setData 作用于已卸载实例', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = makeStore('fr09-stress')
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const page = decorate(store)
    expect(store.getSubscriptionCount()).toBe(0)

    const deadHosts: Array<{ host: Record<string, unknown>; calls: Array<Record<string, unknown>> }> = []
    for (let i = 0; i < 100; i++) {
      const { host, setDataCalls } = createHost()
      page.onLoad.call(host as unknown as PageHost)
      // 清掉初始映射下发，只统计卸载后的残留调用
      setDataCalls.splice(0, setDataCalls.length)
      if (i % 10 === 0) {
        // 每十次抽查一次中途订阅数：恒为 1（本实例的映射订阅）
        expect(store.getSubscriptionCount()).toBe(1)
        expect(__getBindingSubscriptionCountForTests(host as unknown as object, store as unknown as object)).toBe(1)
      }
      page.onUnload.call(host as unknown as PageHost)
      expect(__getBindingSubscriptionCountForTests(host as unknown as object, store as unknown as object)).toBe(0)
      deadHosts.push({ host, calls: setDataCalls })
    }

    // 全部退出后：订阅归零
    expect(store.getSubscriptionCount()).toBe(0)
    // 100 次解绑各调度一次延迟复核；一次性 flush 后不应产生任何泄漏告警
    expect(recheckQueue).toHaveLength(100)
    flushLeakRechecks()
    expect(warn).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()

    // 状态变更不再命中任何已卸载实例
    store.actions.inc()
    for (const dead of deadHosts) {
      expect(dead.calls.length).toBe(0)
    }
    expect(store.getState().count).toBe(1)
    store.destroy()
  })
})
