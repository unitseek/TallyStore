/**
 * 映射更新调度：默认同步；schedule: 'auto' 在 Skyline 宿主合并同一 tick 的 setData。
 */
import { createStore, TallyStoreError } from '../../../src/index.js'
import { withPageStore, withComponentStore } from '../../../src/integrations/with-store.js'
import { withAppStore } from '../../../src/integrations/with-app-store.js'
import { createHost } from '../../utils/host.js'

type CounterStore = ReturnType<typeof createCounterStore>

function createCounterStore() {
  return createStore({
    name: 'counter',
    state: () => ({ count: 0, label: 'a' }),
    actions: {
      inc(step = 1) {
        this.setState('count', this.getState().count + step)
      },
    },
    getters: { doubled: (state) => state.count * 2 },
  })
}

type PageOptions = { onLoad: (this: Record<string, unknown>) => void; onUnload: (this: Record<string, unknown>) => void }
type ComponentOptions = { lifetimes: { attached: (this: Record<string, unknown>) => void; detached: (this: Record<string, unknown>) => void } }

function decoratePage(store: CounterStore, options: Record<string, unknown>): PageOptions {
  return (withPageStore(store, options as never) as unknown as (config: object) => PageOptions)({})
}

function decorateComponent(store: CounterStore, options: Record<string, unknown>): ComponentOptions {
  return (withComponentStore(store, options as never) as unknown as (config: object) => ComponentOptions)({})
}

const flushMicrotask = async (): Promise<void> => {
  await Promise.resolve()
}

/** 推进多个微任务：异步写入失败会自动重试（最多 3 次），需连续推进才能到达成功/耗尽 */
const flushMicrotasks = async (times = 8): Promise<void> => {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve()
  }
}

/** 清空记录便于断言增量（schedule 测试专用） */
function clearSetData(calls: Array<Record<string, unknown>>): void {
  calls.splice(0, calls.length)
}

function restoreNodeEnv(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.NODE_ENV
  } else {
    process.env.NODE_ENV = previous
  }
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('集成映射调度', () => {
  it('默认在 WebView 宿主逐次同步 setData，初始映射同步可用', () => {
    const store = createCounterStore()
    const { host, setDataCalls } = createHost()
    const page = decoratePage(store, { mapState: ['count'] })
    page.onLoad.call(host)

    expect((host.data as Record<string, unknown>).count).toBe(0)
    setDataCalls.length = 0
    store.setState('count', 1)
    store.setState('count', 2)
    expect(setDataCalls).toEqual([{ count: 1 }, { count: 2 }])
    store.destroy()
  })

  it("schedule: 'auto' 在 Skyline 宿主把同一 tick 的多次写入合并为一次 setData", async () => {
    const store = createCounterStore()
    const { host, setDataCalls } = createHost({ renderer: 'skyline' })
    const page = decoratePage(store, { mapState: ['count'], mapGetters: ['doubled'] })
    page.onLoad.call(host)

    // 初始映射仍同步交付
    expect(host.data).toMatchObject({ count: 0, doubled: 0 })
    setDataCalls.length = 0

    store.setState('count', 1)
    store.setState('count', 2)
    expect(setDataCalls).toEqual([])

    await flushMicrotask()
    expect(setDataCalls).toEqual([{ count: 2, doubled: 4 }])
    store.destroy()
  })

  it("schedule: 'sync' 覆盖 Skyline 自动合并", () => {
    const store = createCounterStore()
    const { host, setDataCalls } = createHost({ renderer: 'skyline' })
    const page = decoratePage(store, { mapState: ['count'], schedule: 'sync' })
    page.onLoad.call(host)
    setDataCalls.length = 0

    store.setState('count', 1)
    store.setState('count', 2)
    expect(setDataCalls).toEqual([{ count: 1 }, { count: 2 }])
    store.destroy()
  })

  it("schedule: 'microtask' 在 WebView 宿主也可合并", async () => {
    const store = createCounterStore()
    const { host, setDataCalls } = createHost()
    const page = decoratePage(store, { mapState: ['count'], schedule: 'microtask' })
    page.onLoad.call(host)
    setDataCalls.length = 0

    store.setState('count', 3)
    await flushMicrotask()
    expect(setDataCalls).toEqual([{ count: 3 }])
    store.destroy()
  })

  it('卸载时丢弃尚未交付的合并写入', async () => {
    const store = createCounterStore()
    const { host, setDataCalls } = createHost({ renderer: 'skyline' })
    const page = decoratePage(store, { mapState: ['count'] })
    page.onLoad.call(host)
    setDataCalls.length = 0

    store.setState('count', 9)
    page.onUnload.call(host)
    await flushMicrotask()
    expect(setDataCalls).toEqual([])
    store.destroy()
  })

  it('组件 detached 同样丢弃挂起写入，attached 重新绑定后恢复同步初始值', async () => {
    const store = createCounterStore()
    const { host, setDataCalls } = createHost({ renderer: 'skyline' })
    const component = decorateComponent(store, { mapState: ['count'] })
    component.lifetimes.attached.call(host)
    expect((host.data as Record<string, unknown>).count).toBe(0)
    setDataCalls.length = 0

    store.setState('count', 5)
    component.lifetimes.detached.call(host)
    await flushMicrotask()
    expect(setDataCalls).toEqual([])

    component.lifetimes.attached.call(host)
    expect(setDataCalls).toEqual([{ count: 5 }])
    store.destroy()
  })

  it('异步写入失败经 onError 上报，走入口名作为 source', async () => {
    const store = createCounterStore()
    const error = new Error('setData boom')
    const { host, setDataCalls } = createHost({
      renderer: 'skyline',
      setData(patch: Record<string, unknown>) {
        setDataCalls.push(patch)
        if ((patch as { count?: number }).count === 1) {
          throw error
        }
        Object.assign(host.data as Record<string, unknown>, patch)
      },
    })
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    const page = decoratePage(store, { mapState: ['count'] })
    page.onLoad.call(host)
    setDataCalls.length = 0

    store.setState('count', 1)
    // setData 对 count=1 持续失败：自动重试耗尽后才上报（ 有界重试）
    await flushMicrotasks()

    // 宿主写入失败包装为 TallyStoreError(HOST_WRITE_ERROR)，cause 保留原始错误
    expect(onError).toHaveBeenCalledTimes(1)
    const [reported, source] = onError.mock.calls[0]
    expect(source).toBe('withPageStore')
    expect(reported).toBeInstanceOf(TallyStoreError)
    expect((reported as TallyStoreError).code).toBe('HOST_WRITE_ERROR')
    expect((reported as TallyStoreError).cause).toBe(error)
    expect((reported as TallyStoreError).message).toContain('setData boom')
    expect(consoleError).toHaveBeenCalled()
    store.destroy()
  })

  it('：WebView（默认逐次）下同一通知内 state+getter 也合并为 1 次 setData', () => {
    const store = createCounterStore()
    // 不带 renderer：WebView 宿主，schedule 'auto' 走同步逐次路径
    const { host, setDataCalls } = createHost()
    const page = decoratePage(store, { mapState: ['count'], mapGetters: ['doubled'] })
    page.onLoad.call(host as never)
    clearSetData(setDataCalls)

    store.setState('count', 5)
    expect(setDataCalls).toEqual([{ count: 5, doubled: 10 }])

    page.onUnload.call(host as never)
    store.destroy()
  })

  it('flushNow 交付后的僵尸微任务不提前冲掉新写入：失败批次只按有界重试交付、只上报一次', async () => {
    // 回归：初始映射 flushNow 后，已排队的微任务未作废——同 tick 的新写入被它提前
    // flush，失败重试批次又被下一个合法微任务再次 flush，同一次逻辑写入产生额外的
    // setData 交付与 onError（此前被 toHaveBeenCalledWith 宽松断言掩盖）
    const store = createCounterStore()
    const setDataCalls: Array<Record<string, unknown>> = []
    const { host } = createHost({
      renderer: 'skyline',
      setData(patch: Record<string, unknown>) {
        setDataCalls.push(patch)
        if ((patch as { count?: number }).count === 1) {
          throw new Error('zombie boom')
        }
        Object.assign(host.data as Record<string, unknown>, patch)
      },
    })
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const page = decoratePage(store, { mapState: ['count'] })
    page.onLoad.call(host)
    setDataCalls.length = 0

    store.setState('count', 1)
    await flushMicrotasks()

    // 失败批次自动重试 3 次后耗尽：count=1 共尝试 4 次（首次 + 3 次重试），onError 只上报一次；
    // 僵尸微任务不作废的话会多出一次交付
    expect(setDataCalls.filter((patch) => patch.count === 1)).toHaveLength(4)
    expect(onError).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
    store.destroy()
  })

  it('production 下异步写入失败不打印 console.error，但 onError 仍上报', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const index = await import('../../../src/index.js')
      const storeModule = await import('../../../src/integrations/with-store.js')
      const store = index.createStore({ name: 'prod', state: () => ({ count: 0 }) })
      const onError = jest.fn()
      store.hooks.on('onError', onError)
      const setDataCalls: Array<Record<string, unknown>> = []
      const host: Record<string, unknown> = {
        data: {},
        renderer: 'skyline',
        setData(patch: Record<string, unknown>) {
          setDataCalls.push(patch)
          if ((patch as { count?: number }).count === 1) {
            throw new Error('prod setData boom')
          }
          Object.assign(host.data as Record<string, unknown>, patch)
        },
      }
      const page = (
        storeModule.withPageStore(store, { mapState: ['count'] }) as unknown as (config: object) => {
          onLoad: (this: Record<string, unknown>) => void
        }
      )({})
      page.onLoad.call(host)
      setDataCalls.length = 0
      store.setState('count', 1)
      await flushMicrotasks()

      expect(onError).toHaveBeenCalledWith(expect.any(Error), 'withPageStore')
      expect(consoleError).not.toHaveBeenCalled()
      store.destroy()
    } finally {
      consoleError.mockRestore()
      restoreNodeEnv(previous)
      jest.resetModules()
    }
  })

  it('合并窗口按 tick 重置：不同 tick 的写入各自合并一次', async () => {
    const store = createCounterStore()
    const { host, setDataCalls } = createHost({ renderer: 'skyline' })
    const page = decoratePage(store, { mapState: ['count'] })
    page.onLoad.call(host)
    setDataCalls.length = 0

    store.setState('count', 1)
    await flushMicrotask()
    store.setState('count', 2)
    await flushMicrotask()

    expect(setDataCalls).toEqual([{ count: 1 }, { count: 2 }])
    store.destroy()
  })

  it('App 映射同样支持合并调度', async () => {
    const store = createCounterStore()
    const host: Record<string, unknown> = { globalData: { existing: 1 } }
    const app = withAppStore(store, { mapState: ['count'], schedule: 'microtask' })({})
    ;(app.onLaunch as (this: Record<string, unknown>) => void).call(host)
    expect((host.globalData as Record<string, unknown>).count).toBe(0)

    store.setState('count', 1)
    store.setState('count', 2)
    expect((host.globalData as Record<string, unknown>).count).toBe(0)
    await flushMicrotask()
    expect((host.globalData as Record<string, unknown>).count).toBe(2)
    store.destroy()
  })
})

describe('通知期错误优先级', () => {
  it('同步模式：mapper 抛错且宿主写入也失败时，原始 mapper 错误优先，写入失败降级为次级 onError', () => {
    let fragile = false
    const store = createStore({
      name: 'priority-a',
      state: () => ({ count: 0 }),
      getters: {
        fragile: () => {
          if (fragile) {
            throw new Error('fragile getter boom')
          }
          return 0
        },
      },
    })
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const host: Record<string, unknown> = {
      data: {},
      setData(patch: Record<string, unknown>) {
        Object.assign(host.data as Record<string, unknown>, patch)
        if ((patch as { count?: number }).count === 1) {
          throw new Error('setData boom')
        }
      },
    }
    const page = (
      withPageStore(store, { mapState: ['count'], mapGetters: ['fragile'] } as never) as unknown as (config: object) => {
        onLoad: (this: Record<string, unknown>) => void
        onUnload: (this: Record<string, unknown>) => void
      }
    )({ data: {} })
    page.onLoad.call(host)
    fragile = true

    store.setState('count', 1)

    // 先次级上报写入失败（来源 'notify'），再经监听器异常通道上报原始 mapper 错误
    expect(onError).toHaveBeenCalledTimes(2)
    const [writeError, writeSource] = onError.mock.calls[0]
    expect((writeError as TallyStoreError).code).toBe('HOST_WRITE_ERROR')
    expect(writeSource).toBe('notify')
    const [primaryError, primarySource] = onError.mock.calls[1]
    expect((primaryError as TallyStoreError).code).toBe('GETTER_EXECUTION_ERROR')
    expect(primarySource).toBeUndefined()
    expect((primaryError as Error).message).toContain('fragile')

    page.onUnload.call(host)
    consoleError.mockRestore()
    store.destroy()
  })

  it('同步模式：仅宿主写入失败时保持原行为（监听器异常通道上报 HOST_WRITE_ERROR）', () => {
    const store = createCounterStore()
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const host: Record<string, unknown> = {
      data: {},
      setData(patch: Record<string, unknown>) {
        if ((patch as { count?: number }).count === 1) {
          throw new Error('only setData boom')
        }
        Object.assign(host.data as Record<string, unknown>, patch)
      },
    }
    const page = (
      withPageStore(store, { mapState: ['count'] } as never) as unknown as (config: object) => {
        onLoad: (this: Record<string, unknown>) => void
        onUnload: (this: Record<string, unknown>) => void
      }
    )({ data: {} })
    page.onLoad.call(host)

    store.setState('count', 1)

    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as TallyStoreError).code).toBe('HOST_WRITE_ERROR')
    page.onUnload.call(host)
    consoleError.mockRestore()
    store.destroy()
  })
})
