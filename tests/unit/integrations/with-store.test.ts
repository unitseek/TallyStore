import { createStore, TallyStoreError } from '../../../src/index.js'
import { withPageStore, withComponentStore } from '../../../src/integrations/with-store.js'
import { createHost, trackSubscriptions } from '../../utils/host.js'

type CounterStore = ReturnType<typeof createCounterStore>

type PageHost = {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  [key: string]: unknown
}

type ComponentHost = {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  methods?: Record<string, unknown>
  [key: string]: unknown
}

type DecoratedPage = {
  onLoad: (this: PageHost, ...args: unknown[]) => void
  onUnload: (this: PageHost) => void
  data: Record<string, unknown>
}

type DecoratedComponent = {
  lifetimes: {
    attached: (this: ComponentHost) => void
    detached: (this: ComponentHost) => void
  }
  methods: Record<string, unknown>
  data: Record<string, unknown>
}

function createCounterStore() {
  return createStore({
    name: 'counter',
    state: () => ({ count: 0, label: 'a' }),
    actions: {
      inc(step = 1) {
        this.setState('count', this.getState().count + step)
      },
      rename(label: string) {
        this.setState('label', label)
      },
    },
    getters: {
      doubled: (state) => state.count * 2,
    },
  })
}

function decoratePage(store: CounterStore, options?: Record<string, unknown>, config: Record<string, unknown> = {}): DecoratedPage {
  const decorator = options === undefined ? withPageStore(store) : withPageStore(store, options as never)
  return (decorator as unknown as (c: Record<string, unknown>) => DecoratedPage)(config)
}

function decorateComponent(store: CounterStore, options?: Record<string, unknown>, config: Record<string, unknown> = {}): DecoratedComponent {
  const decorator = options === undefined ? withComponentStore(store) : withComponentStore(store, options as never)
  return (decorator as unknown as (c: Record<string, unknown>) => DecoratedComponent)(config)
}

/** mappers 的初始 setData 发生在 onLoad/attached 内，这里只清空记录便于断言后续增量 */
function clearCalls(calls: Array<Record<string, unknown>>): void {
  calls.splice(0, calls.length)
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('withPageStore：Page 集成', () => {
  it('onLoad 建立映射：初始值一次 setData，用户 onLoad 最后调用并收到参数与 this', () => {
    const store = createCounterStore()
    const { host, setDataCalls } = createHost()
    const onLoad = jest.fn()
    const page = decoratePage(store, { mapState: ['count'], mapGetters: ['doubled'] }, { data: { local: 1 }, onLoad })
    // 真实宿主会把配置里的 data 作为实例初始 data，这里模拟这一层
    host.data = { local: 1 }

    page.onLoad.call(host as PageHost, 'first', 2)

    expect(setDataCalls).toEqual([{ count: 0 }, { doubled: 0 }])
    expect(host.data).toMatchObject({ local: 1, count: 0, doubled: 0 })
    expect(onLoad).toHaveBeenCalledTimes(1)
    expect(onLoad.mock.instances[0]).toBe(host)
    expect(onLoad).toHaveBeenCalledWith('first', 2)
    // 集成不改写用户配置对象里的 data 字面量
    expect(page.data).toEqual({ local: 1 })
    store.destroy()
  })

  it('state/getters 共享一条只读订阅：状态变化只下发映射键，未映射键变化不产生 setData', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const page = decoratePage(store, { mapState: ['count'], mapGetters: ['doubled'] })
    const { host, setDataCalls } = createHost()
    page.onLoad.call(host as PageHost)
    expect(stats.registered).toBe(1)

    clearCalls(setDataCalls)
    store.setState('count', 2)
    // 同一通知内 state/getter 跨 mapper 合并为一次 setData（此前为两次）
    expect(setDataCalls).toEqual([{ count: 2, doubled: 4 }])

    clearCalls(setDataCalls)
    store.setState('label', 'b')
    expect(setDataCalls).toEqual([])
    store.destroy()
  })

  it('对象形态映射支持本地重命名，actions 对象/数组两种形态都能绑定并转发 dispatch', () => {
    const store = createCounterStore()
    const { host } = createHost()
    const page = decoratePage(store, { mapState: { localCount: 'count' }, mapActions: { bump: 'inc' } })
    page.onLoad.call(host as PageHost)
    expect((host.data as Record<string, unknown>).localCount).toBe(0)
    ;(host as PageHost & { bump: (step: number) => void }).bump(3)
    expect(store.getState().count).toBe(3)
    expect((host.data as Record<string, unknown>).localCount).toBe(3)

    const second = decoratePage(store, { mapActions: ['rename'] })
    const { host: host2 } = createHost()
    second.onLoad.call(host2 as PageHost)
    ;(host2 as PageHost & { rename: (label: string) => void }).rename('b')
    expect(store.getState().label).toBe('b')
    store.destroy()
  })

  it('重复 onLoad 先清理旧绑定再重建：订阅数保持 1，通知不重复下发', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const page = decoratePage(store, { mapState: ['count'], mapGetters: ['doubled'] })
    const { host, setDataCalls } = createHost()

    page.onLoad.call(host as PageHost)
    page.onLoad.call(host as PageHost)

    expect(stats.registered).toBe(2)
    expect(stats.active).toBe(1)
    clearCalls(setDataCalls)
    store.setState('count', 1)
    expect(setDataCalls).toEqual([{ count: 1, doubled: 2 }])
    store.destroy()
  })

  it('onUnload 退订并调用用户 onUnload：卸载后状态变化不再 setData', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const onUnload = jest.fn()
    const page = decoratePage(store, { mapState: ['count'] }, { onUnload })
    const { host, setDataCalls } = createHost()
    page.onLoad.call(host as PageHost)

    page.onUnload.call(host as PageHost)

    expect(onUnload).toHaveBeenCalledTimes(1)
    expect(onUnload.mock.instances[0]).toBe(host)
    expect(stats.active).toBe(0)
    clearCalls(setDataCalls)
    store.setState('count', 9)
    expect(setDataCalls).toEqual([])
    expect((host.data as Record<string, unknown>).count).toBe(0)
    store.destroy()
  })

  it('用户 onUnload 抛错时仍清理当前实例订阅', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const page = decoratePage(
      store,
      { mapState: ['count'] },
      {
        onUnload() {
          throw new Error('unload boom')
        },
      },
    )
    const { host, setDataCalls } = createHost()
    page.onLoad.call(host as PageHost)

    expect(() => page.onUnload.call(host as PageHost)).toThrow('unload boom')
    expect(stats.active).toBe(0)
    clearCalls(setDataCalls)
    store.setState('count', 1)
    expect(setDataCalls).toEqual([])
    store.destroy()
  })

  it('空映射（空数组/空对象）不建立订阅也不 setData', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const page = decoratePage(store, { mapState: [], mapGetters: {}, mapActions: [] })
    const { host, setDataCalls } = createHost()

    page.onLoad.call(host as PageHost)

    expect(stats.registered).toBe(0)
    expect(setDataCalls).toEqual([])
    store.setState('count', 1)
    expect(setDataCalls).toEqual([])
    store.destroy()
  })

  it('覆盖宿主已有方法：开发期告警，onUnload 后按原值恢复', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createCounterStore()
    const original = jest.fn(() => 'original')
    const page = decoratePage(store, { mapActions: ['inc'] })
    const { host } = createHost({ inc: original })
    page.onLoad.call(host as PageHost)

    expect(host.inc).not.toBe(original)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('将被 action "inc" 覆盖'))
    ;(host as PageHost & { inc: (step: number) => void }).inc(5)
    expect(store.getState().count).toBe(5)

    page.onUnload.call(host as PageHost)
    expect(host.inc).toBe(original)
    store.destroy()
  })

  it('首次 setData 抛错时回滚：onLoad 原样重抛、不建立订阅', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const page = decoratePage(store, { mapState: ['count'], mapActions: ['inc'] })
    const { host } = createHost()
    host.setData = () => {
      throw new Error('setData boom')
    }

    expect(() => page.onLoad.call(host as PageHost)).toThrow('setData boom')
    expect(stats.registered).toBe(0)
    expect(warn).toHaveBeenCalledWith('[withPageStore] 绑定映射失败，已回滚本次登记的订阅', expect.any(Error))
    store.destroy()
  })

  it('状态值变为 undefined 时向宿主导出 null 清除旧值', () => {
    const store = createStore({ name: 'u', state: () => ({ value: 1 as number | undefined }) })
    const { host, setDataCalls } = createHost()
    const page = decoratePage(store as never, { mapState: ['value'] })
    page.onLoad.call(host as PageHost)
    setDataCalls.length = 0

    store.setState('value', undefined)

    expect(setDataCalls).toEqual([{ value: null }])
    expect((host.data as Record<string, unknown>).value).toBe(null)
    store.destroy()
  })

  it('同一页面配置叠加两个 store 装饰器时互不清除对方绑定', () => {
    const first = createStore({ name: 'first', state: () => ({ a: 0 }) })
    const second = createStore({ name: 'second', state: () => ({ b: 0 }) })
    const { host, setDataCalls } = createHost()
    const base = decoratePage(first as never, { mapState: ['a'] }, {})
    const combined = (withPageStore(second, { mapState: ['b'] } as never) as unknown as (c: object) => DecoratedPage)(base)

    combined.onLoad.call(host as PageHost)
    setDataCalls.length = 0
    first.setState('a', 1)
    second.setState('b', 2)

    expect(setDataCalls).toContainEqual({ a: 1 })
    expect(setDataCalls).toContainEqual({ b: 2 })
    expect(host.data).toMatchObject({ a: 1, b: 2 })

    combined.onUnload.call(host as PageHost)
    setDataCalls.length = 0
    first.setState('a', 3)
    second.setState('b', 4)
    expect(setDataCalls).toEqual([])
    first.destroy()
    second.destroy()
  })

  it('action 本地名与宿主生命周期同名时跳过并上报 onError', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createCounterStore()
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const { host } = createHost()
    const lifecycle = jest.fn()
    host.onShow = lifecycle
    const page = decoratePage(store, { mapState: ['count'], mapActions: { onShow: 'inc' } })
    page.onLoad.call(host as PageHost)

    expect(host.onShow).toBe(lifecycle)
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'bindActions')
    store.destroy()
  })

  it('非法 options 抛 TypeError；非法 schedule 抛 TallyStoreError(INVALID_CONFIG)', () => {
    const store = createCounterStore()
    expect(() => decoratePage(store, null as never)).toThrow(TypeError)
    expect(() => decoratePage(store, { schedule: 'weird' } as never)).toThrow(TallyStoreError)
    expect(() => decoratePage(store, { schedule: 'weird' } as never)).toThrow(/INVALID_CONFIG|schedule/)
    expect(() => decorateComponent(store, null as never)).toThrow(TypeError)
    store.destroy()
  })

  it('未传 options 时按默认空映射处理，仅转发用户生命周期', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const onLoad = jest.fn()
    const page = decoratePage(store, undefined, { onLoad })
    const { host, setDataCalls } = createHost()

    page.onLoad.call(host as PageHost)

    expect(stats.registered).toBe(0)
    expect(setDataCalls).toEqual([])
    expect(onLoad).toHaveBeenCalledTimes(1)
    store.destroy()
  })

  it('未建立绑定直接调用 onUnload 不报错', () => {
    const store = createCounterStore()
    const page = decoratePage(store, { mapState: ['count'] })
    const { host } = createHost()
    expect(() => page.onUnload.call(host as PageHost)).not.toThrow()
    store.destroy()
  })
})

describe('withComponentStore：Component 集成', () => {
  it('attached 建立映射并把 action 合并进 methods，detached 移除方法并退订', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const attached = jest.fn()
    const detached = jest.fn()
    const component = decorateComponent(
      store,
      { mapState: ['count'], mapGetters: ['doubled'], mapActions: ['inc'] },
      { data: { local: 1 }, lifetimes: { attached, detached }, methods: { existing: () => 'x' } },
    )
    const { host, setDataCalls } = createHost({ methods: { existing: () => 'x' } })

    component.lifetimes.attached.call(host as ComponentHost)
    expect(setDataCalls).toEqual([{ count: 0 }, { doubled: 0 }])
    expect(attached).toHaveBeenCalledTimes(1)
    expect(typeof (host.methods as Record<string, unknown>).inc).toBe('function')
    expect(typeof (host.methods as Record<string, unknown>).existing).toBe('function')
    expect(stats.active).toBe(1)
    ;((host.methods as Record<string, unknown>).inc as (step: number) => void)(2)
    expect(store.getState().count).toBe(2)
    expect((host.data as Record<string, unknown>).doubled).toBe(4)

    component.lifetimes.detached.call(host as ComponentHost)
    expect(detached).toHaveBeenCalledTimes(1)
    expect('inc' in (host.methods as Record<string, unknown>)).toBe(false)
    expect(stats.active).toBe(0)
    store.destroy()
  })

  it('action 覆盖组件同名方法时告警，detached 恢复用户原方法', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createCounterStore()
    const userInc = jest.fn(() => 'user')
    const component = decorateComponent(store, { mapActions: ['inc'] }, { methods: { inc: userInc } })
    const { host } = createHost({ methods: { inc: userInc } })

    component.lifetimes.attached.call(host as ComponentHost)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('组件已有同名方法 "inc"'))
    expect((host.methods as Record<string, unknown>).inc).not.toBe(userInc)

    component.lifetimes.detached.call(host as ComponentHost)
    expect((host.methods as Record<string, unknown>).inc).toBe(userInc)
    store.destroy()
  })

  it('多实例共享同一配置时 methods 与订阅各自独立', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const component = decorateComponent(store, { mapState: ['count'], mapActions: ['inc'] }, { methods: {} })
    const first = createHost({ methods: {} })
    const second = createHost({ methods: {} })
    component.lifetimes.attached.call(first.host as ComponentHost)
    component.lifetimes.attached.call(second.host as ComponentHost)
    expect(stats.active).toBe(2)
    expect(first.host.methods).not.toBe(second.host.methods)

    component.lifetimes.detached.call(first.host as ComponentHost)
    expect('inc' in (first.host.methods as Record<string, unknown>)).toBe(false)
    expect(typeof (second.host.methods as Record<string, unknown>).inc).toBe('function')
    expect(stats.active).toBe(1)
    store.destroy()
  })

  it('实例没有 methods 时 attached/detached 不合并方法也不报错，订阅仍正常', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const component = decorateComponent(store, { mapState: ['count'] }, { methods: { inc: () => 'user' } })
    const { host, setDataCalls } = createHost()

    component.lifetimes.attached.call(host as ComponentHost)
    expect(setDataCalls).toEqual([{ count: 0 }])
    component.lifetimes.detached.call(host as ComponentHost)
    expect(stats.active).toBe(0)
    store.destroy()
  })

  it('配置未声明 lifetimes 时自动补齐 attached/detached 并可正常绑定', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const component = decorateComponent(store, { mapState: ['count'] })
    const { host, setDataCalls } = createHost()

    component.lifetimes.attached.call(host as ComponentHost)
    expect(setDataCalls).toEqual([{ count: 0 }])
    component.lifetimes.detached.call(host as ComponentHost)
    expect(stats.active).toBe(0)
    store.destroy()
  })

  it('用户 attached 抛错时绑定已建立，detached 仍可清理', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const component = decorateComponent(
      store,
      { mapState: ['count'] },
      {
        lifetimes: {
          attached() {
            throw new Error('attached boom')
          },
        },
      },
    )
    const { host } = createHost()

    expect(() => component.lifetimes.attached.call(host as ComponentHost)).toThrow('attached boom')
    expect(stats.active).toBe(1)
    component.lifetimes.detached.call(host as ComponentHost)
    expect(stats.active).toBe(0)
    store.destroy()
  })

  it('用户 detached 抛错时仍清理订阅', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const component = decorateComponent(
      store,
      { mapState: ['count'] },
      {
        lifetimes: {
          detached() {
            throw new Error('detached boom')
          },
        },
      },
    )
    const { host } = createHost()
    component.lifetimes.attached.call(host as ComponentHost)

    expect(() => component.lifetimes.detached.call(host as ComponentHost)).toThrow('detached boom')
    expect(stats.active).toBe(0)
    store.destroy()
  })

  it('首次 setData 抛错时回滚：attached 原样重抛、不建立订阅', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const component = decorateComponent(store, { mapState: ['count'] })
    const { host } = createHost()
    host.setData = () => {
      throw new Error('setData boom')
    }

    expect(() => component.lifetimes.attached.call(host as ComponentHost)).toThrow('setData boom')
    expect(stats.registered).toBe(0)
    expect(warn).toHaveBeenCalledWith('[withComponentStore] 绑定映射失败，已回滚本次登记的订阅', expect.any(Error))
    store.destroy()
  })

  it('未传 options 时按默认空映射处理', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const component = decorateComponent(store)
    const { host, setDataCalls } = createHost({ methods: {} })

    component.lifetimes.attached.call(host as ComponentHost)
    expect(stats.registered).toBe(0)
    expect(setDataCalls).toEqual([])
    component.lifetimes.detached.call(host as ComponentHost)
    store.destroy()
  })

  it('未建立绑定直接调用 detached 不报错', () => {
    const store = createCounterStore()
    const component = decorateComponent(store, { mapState: ['count'] })
    const { host } = createHost({ methods: {} })
    expect(() => component.lifetimes.detached.call(host as ComponentHost)).not.toThrow()
    store.destroy()
  })

  it('backgroundUpdates: false：不包装 pageLifetimes，组件层回退立即更新', () => {
    const store = createCounterStore()
    const component = decorateComponent(store, { mapState: ['count'], backgroundUpdates: false })
    expect((component as unknown as Record<string, unknown>).pageLifetimes).toBeUndefined()
    const { host, setDataCalls } = createHost({ methods: {} })
    component.lifetimes.attached.call(host as ComponentHost)
    clearCalls(setDataCalls)
    store.actions.inc()
    expect(setDataCalls).toEqual([{ count: 1 }])
    component.lifetimes.detached.call(host as ComponentHost)
    store.destroy()
  })

  it('同一宿主叠加两个 store：methods 按 store 维度登记，detached 逐个回放互不误删', () => {
    const storeA = createStore({
      name: 'multi-a',
      state: () => ({ a: 0 }),
      actions: {
        bumpA() {
          this.setState('a', this.getState().a + 1)
        },
      },
    })
    const storeB = createStore({
      name: 'multi-b',
      state: () => ({ b: 0 }),
      actions: {
        bumpB() {
          this.setState('b', this.getState().b + 1)
        },
      },
    })
    const decorateA = withComponentStore(storeA, { mapActions: ['bumpA'] } as never) as unknown as (config: object) => Record<string, unknown>
    const decorateB = withComponentStore(storeB, { mapActions: ['bumpB'] } as never) as unknown as (config: object) => DecoratedComponent
    const component = decorateB(decorateA({ methods: {} }))

    const { host } = createHost({ methods: {} })
    component.lifetimes.attached.call(host as ComponentHost)
    const methods = host.methods as Record<string, () => void>
    expect(typeof methods.bumpA).toBe('function')
    expect(typeof methods.bumpB).toBe('function')
    methods.bumpA()
    methods.bumpB()
    expect(storeA.getState().a).toBe(1)
    expect(storeB.getState().b).toBe(1)

    component.lifetimes.detached.call(host as ComponentHost)
    expect('bumpA' in (host.methods as Record<string, unknown>)).toBe(false)
    expect('bumpB' in (host.methods as Record<string, unknown>)).toBe(false)
    storeA.destroy()
    storeB.destroy()
  })
})

describe('生产模式：组件方法遮蔽告警静默', () => {
  it('production 下不打印 warn，覆盖与 detached 恢复仍生效', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const index = await import('../../../src/index.js')
      const mod = await import('../../../src/integrations/with-store.js')
      const store = index.createStore({
        name: 'prod-shadow',
        state: () => ({ count: 0 }),
        actions: {
          increment() {
            this.setState('count', this.getState().count + 1)
          },
        },
      })
      const config = (
        mod.withComponentStore(store, { mapActions: { inc: 'increment' } } as never) as unknown as (c: object) => {
          lifetimes: { attached: (this: Record<string, unknown>) => void; detached: (this: Record<string, unknown>) => void }
          methods: Record<string, unknown>
        }
      )({ methods: { inc: () => 'user' } })
      const { createHost } = await import('../../utils/host.js')
      const { host } = createHost({ methods: {} })
      config.lifetimes.attached.call(host)
      expect(warn).not.toHaveBeenCalled()
      expect((host.methods as Record<string, unknown>).inc).not.toBeUndefined()
      config.lifetimes.detached.call(host)
      expect((host.methods as Record<string, unknown>).inc).toEqual(expect.any(Function))
      store.destroy()
    } finally {
      warn.mockRestore()
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
      jest.resetModules()
    }
  })
})

describe('生产模式：Component action 映射以「有效映射」为准', () => {
  const restoreNodeEnv = (previous: string | undefined): void => {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }

  it('生产期非法 mapActions 不生成幽灵方法（配置级与实例级都只含有效映射）', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const index = await import('../../../src/index.js')
      const mod = await import('../../../src/integrations/with-store.js')
      const { createHost } = await import('../../utils/host.js')
      const store = index.createStore({
        name: 'prod-ghost',
        state: () => ({ count: 0 }),
        actions: {
          increment() {
            this.setState('count', this.getState().count + 1)
          },
        },
      })
      const onError = jest.fn()
      store.hooks.on('onError', onError)
      type Decorated = {
        lifetimes: { attached: (this: Record<string, unknown>) => void; detached: (this: Record<string, unknown>) => void }
        methods: Record<string, unknown>
      }
      const config = (
        mod.withComponentStore(store, { mapActions: { inc: 'increment', ghost: 'not-an-action' } } as never) as unknown as (c: object) => Decorated
      )({
        methods: {},
      })
      const { host } = createHost({ methods: {} })
      config.lifetimes.attached.call(host)

      // 装饰期的静默净化：配置级 methods 不含非法映射
      expect('ghost' in config.methods).toBe(false)
      // 绑定期 connectHost 返回的有效映射同样不含非法键：实例 methods 不生成幽灵方法
      expect(typeof (host.methods as Record<string, unknown>).inc).toBe('function')
      expect('ghost' in (host.methods as Record<string, unknown>)).toBe(false)
      // 非法映射在绑定期统一上报一次（不被装饰期静默净化吞掉，也不重复上报）
      expect(onError).toHaveBeenCalledTimes(1)
      expect((onError.mock.calls[0][0] as { code?: string }).code).toBe('INVALID_MAPPING')

      config.lifetimes.detached.call(host)
      expect('inc' in (host.methods as Record<string, unknown>)).toBe(false)
      store.destroy()
    } finally {
      restoreNodeEnv(previous)
      jest.resetModules()
    }
  })

  it('生产期本地键冲突：后绑定 store 不覆盖先绑定 store 的 action 方法，解绑也不误删', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const index = await import('../../../src/index.js')
      const mod = await import('../../../src/integrations/with-store.js')
      const { createHost } = await import('../../utils/host.js')
      const storeA = index.createStore({
        name: 'prod-conflict-a',
        state: () => ({ a: 0 }),
        actions: {
          bump() {
            this.setState('a', this.getState().a + 1)
          },
        },
      })
      const storeB = index.createStore({
        name: 'prod-conflict-b',
        state: () => ({ b: 0 }),
        actions: {
          bump() {
            this.setState('b', this.getState().b + 1)
          },
        },
      })
      const onErrorB = jest.fn()
      storeB.hooks.on('onError', onErrorB)
      type Decorated = {
        lifetimes: { attached: (this: Record<string, unknown>) => void; detached: (this: Record<string, unknown>) => void }
        methods: Record<string, unknown>
      }
      const decorate = (target: typeof storeA | typeof storeB): Decorated =>
        (mod.withComponentStore(target as typeof storeA, { mapActions: ['bump'] } as never) as unknown as (c: object) => Decorated)({
          methods: {},
        })
      const configA = decorate(storeA)
      const configB = decorate(storeB)
      const { host } = createHost({ methods: {} })

      configA.lifetimes.attached.call(host)
      configB.lifetimes.attached.call(host)

      // B 的本地键因冲突被剔除并上报；实例上保留的是 A 的方法（不被 B 的幽灵方法覆盖）
      expect(onErrorB).toHaveBeenCalledTimes(1)
      expect((onErrorB.mock.calls[0][0] as { code?: string }).code).toBe('INVALID_MAPPING')
      ;((host.methods as Record<string, unknown>).bump as () => void)()
      expect(storeA.getState().a).toBe(1)
      expect(storeB.getState().b).toBe(0)

      // B 解绑只回放自己注入的方法（本次为空），不误删 A 仍在用的方法
      configB.lifetimes.detached.call(host)
      expect(typeof (host.methods as Record<string, unknown>).bump).toBe('function')
      configA.lifetimes.detached.call(host)
      expect('bump' in (host.methods as Record<string, unknown>)).toBe(false)

      storeA.destroy()
      storeB.destroy()
    } finally {
      restoreNodeEnv(previous)
      jest.resetModules()
    }
  })
})

describe('withComponentStore：methods 合并边界', () => {
  it('配置级 methods 的 action 绑定可直接调用；原生实例（无 methods 命名空间）绑定实例顶层并在 detached 移除', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const component = decorateComponent(store, { mapState: ['count'], mapActions: ['inc'] }, { methods: {} })

    // 装饰期配置级 methods 已含 action 绑定（真实宿主由框架把 methods 提升为实例顶层方法）
    ;((component.methods as Record<string, unknown>).inc as (step: number) => void)(2)
    expect(store.getState().count).toBe(2)

    // 原生组件实例没有 this.methods：attached 把 action 绑定到实例顶层，detached 回放/移除
    const { host } = createHost()
    component.lifetimes.attached.call(host as ComponentHost)
    expect((host.data as Record<string, unknown>).count).toBe(2)
    expect(typeof (host as Record<string, unknown>).inc).toBe('function')
    ;((host as Record<string, unknown>).inc as (step: number) => void)(3)
    expect(store.getState().count).toBe(5)
    component.lifetimes.detached.call(host as ComponentHost)
    expect('inc' in (host as Record<string, unknown>)).toBe(false)
    expect(stats.active).toBe(0)
    store.destroy()
  })

  it('实例 methods 在 attached 后被移除：detached 安全清理，不重建 methods', () => {
    const store = createCounterStore()
    const component = decorateComponent(store, { mapState: ['count'], mapActions: ['inc'] }, { methods: {} })
    const { host } = createHost({ methods: {} })
    component.lifetimes.attached.call(host as ComponentHost)
    expect(typeof (host.methods as Record<string, unknown>).inc).toBe('function')

    // 外部（其他装饰器/宿主框架）把实例 methods 整个移除：detached 不得因此抛错或重建
    delete (host as Record<string, unknown>).methods
    expect(() => component.lifetimes.detached.call(host as ComponentHost)).not.toThrow()
    expect(host.methods).toBeUndefined()
    store.destroy()
  })
})

describe('withComponentStore：宿主保留成员与原生实例', () => {
  it('mapActions 本地名为 setData / 组件独有成员：跳过并上报 INVALID_MAPPING，不生成方法', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createCounterStore()
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    // setData 来自 Page/App 共享清单；triggerEvent 来自组件独有清单（ 拆分后仍须拦截）
    const component = decorateComponent(store, { mapActions: { setData: 'inc', triggerEvent: 'inc', inc: 'inc' } }, { methods: {} })
    const { host } = createHost({ methods: {} })

    component.lifetimes.attached.call(host as ComponentHost)

    // 配置级与实例级 methods 都不含保留名方法；合法映射照常绑定
    expect('setData' in (component.methods as Record<string, unknown>)).toBe(false)
    expect('setData' in (host.methods as Record<string, unknown>)).toBe(false)
    expect('triggerEvent' in (component.methods as Record<string, unknown>)).toBe(false)
    expect('triggerEvent' in (host.methods as Record<string, unknown>)).toBe(false)
    expect(typeof (host.methods as Record<string, unknown>).inc).toBe('function')
    expect(onError).toHaveBeenCalledTimes(2)
    for (const call of onError.mock.calls) {
      expect((call[0] as { code?: string }).code).toBe('INVALID_MAPPING')
      expect(call[1]).toBe('bindActions')
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('保留成员'))

    component.lifetimes.detached.call(host as ComponentHost)
    store.destroy()
  })

  it('原生实例：被遮蔽的配置级用户方法在 detached 后恢复', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createCounterStore()
    const userInc = jest.fn(() => 'user')
    const component = decorateComponent(store, { mapActions: ['inc'] }, { methods: { inc: userInc } })
    const { host } = createHost()
    // 模拟原生框架：config.methods 已提升为实例顶层方法（此时是 action 绑定，非用户原方法）
    ;(host as Record<string, unknown>).inc = (component.methods as Record<string, unknown>).inc

    component.lifetimes.attached.call(host as ComponentHost)
    expect(typeof (host as Record<string, unknown>).inc).toBe('function')
    expect((host as Record<string, unknown>).inc).not.toBe(userInc)
    ;((host as Record<string, unknown>).inc as (step: number) => void)(2)
    expect(store.getState().count).toBe(2)

    // detached 按装饰期登记的配置级原方法回放用户方法，而不是把 action 当成原值
    component.lifetimes.detached.call(host as ComponentHost)
    expect((host as Record<string, unknown>).inc).toBe(userInc)
    store.destroy()
  })
})

describe('withComponentStore：原生实例成员边界', () => {
  it('原生实例已有同名成员（非配置级遮蔽）：detached 按原描述符回放', () => {
    const store = createCounterStore()
    const original = jest.fn(() => 'framework')
    const component = decorateComponent(store, { mapActions: ['inc'] }, { methods: {} })
    const { host } = createHost()
    ;(host as Record<string, unknown>).inc = original

    component.lifetimes.attached.call(host as ComponentHost)
    expect((host as Record<string, unknown>).inc).not.toBe(original)
    ;((host as Record<string, unknown>).inc as () => void)()
    expect(store.getState().count).toBe(1)

    component.lifetimes.detached.call(host as ComponentHost)
    expect((host as Record<string, unknown>).inc).toBe(original)
    store.destroy()
  })

  it('原生实例成员不可重定义：跳过该 action 并上报，detached 不抛错', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createCounterStore()
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const component = decorateComponent(store, { mapActions: ['inc'] }, { methods: {} })
    const { host } = createHost()
    Object.defineProperty(host, 'inc', { value: 'locked', writable: false, configurable: false })

    component.lifetimes.attached.call(host as ComponentHost)
    expect((host as Record<string, unknown>).inc).toBe('locked')
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as { code?: string }).code).toBe('INVALID_MAPPING')
    expect(onError.mock.calls[0][1]).toBe('bindActions')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('不可重定义'))

    expect(() => component.lifetimes.detached.call(host as ComponentHost)).not.toThrow()
    expect((host as Record<string, unknown>).inc).toBe('locked')
    store.destroy()
  })

  it('实例 methods 显式为 null：按原生实例形态在顶层绑定，detached 移除', () => {
    const store = createCounterStore()
    const component = decorateComponent(store, { mapActions: ['inc'] }, { methods: {} })
    const { host } = createHost({ methods: null })

    component.lifetimes.attached.call(host as ComponentHost)
    expect(typeof (host as Record<string, unknown>).inc).toBe('function')
    expect(host.methods).toBeNull()
    component.lifetimes.detached.call(host as ComponentHost)
    expect('inc' in (host as Record<string, unknown>)).toBe(false)
    store.destroy()
  })
})

describe('withComponentStore：原生实例非可配置成员', () => {
  it('成员不可配置但可写：绑定保留 enumerable/configurable，detached 按描述符回放', () => {
    const store = createCounterStore()
    const component = decorateComponent(store, { mapActions: ['inc'] }, { methods: {} })
    const { host } = createHost()
    const original = jest.fn(() => 'writable-frozen')
    Object.defineProperty(host, 'inc', { value: original, writable: true, configurable: false, enumerable: false })

    component.lifetimes.attached.call(host as ComponentHost)
    const bound = Object.getOwnPropertyDescriptor(host, 'inc')
    expect(bound?.configurable).toBe(false)
    expect(bound?.enumerable).toBe(false)
    expect((host as Record<string, unknown>).inc).not.toBe(original)
    ;((host as Record<string, unknown>).inc as () => void)()
    expect(store.getState().count).toBe(1)

    component.lifetimes.detached.call(host as ComponentHost)
    const restored = Object.getOwnPropertyDescriptor(host, 'inc')
    expect(restored?.value).toBe(original)
    expect(restored?.configurable).toBe(false)
    expect(restored?.enumerable).toBe(false)
    store.destroy()
  })
})

describe('生命周期清理隔离', () => {
  it('用户 detached 抛错 + 清理步骤抛错：原始 detached 异常优先，清理错误上报且方法回放仍执行', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createCounterStore()
    const component = decorateComponent(
      store,
      { mapActions: ['inc'] },
      {
        methods: {},
        lifetimes: {
          detached() {
            throw new Error('detached boom')
          },
        },
      },
    )
    const { host } = createHost({ methods: {} })
    component.lifetimes.attached.call(host as ComponentHost)
    const onError = jest.fn()
    store.hooks.on('onError', onError)

    // 注入清理步骤失败：disconnectHost 读取订阅计数时抛错（真实实现不会，属极端防御场景）
    const originalCount = store.getSubscriptionCount.bind(store)
    let failOnce = true
    ;(store as unknown as { getSubscriptionCount: () => number }).getSubscriptionCount = () => {
      if (failOnce) {
        failOnce = false
        throw new Error('cleanup boom')
      }
      return originalCount()
    }

    expect(() => component.lifetimes.detached.call(host as ComponentHost)).toThrow('detached boom')
    expect(onError.mock.calls.some(([error, source]) => (error as Error).message === 'cleanup boom' && source === 'unbind')).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('生命周期清理失败'), expect.any(Error))
    // 第二步清理（方法回放）仍执行：清理失败不阻断后续步骤
    expect('inc' in (host.methods as Record<string, unknown>)).toBe(false)
    store.destroy()
  })

  it('用户 onUnload 抛错 + 清理步骤抛错：原始 onUnload 异常优先，清理错误上报', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createCounterStore()
    const page = decoratePage(
      store,
      { mapState: ['count'] },
      {
        onUnload() {
          throw new Error('unload boom')
        },
      },
    )
    const { host } = createHost()
    page.onLoad.call(host as PageHost)
    const onError = jest.fn()
    store.hooks.on('onError', onError)

    const originalCount = store.getSubscriptionCount.bind(store)
    let failOnce = true
    ;(store as unknown as { getSubscriptionCount: () => number }).getSubscriptionCount = () => {
      if (failOnce) {
        failOnce = false
        throw new Error('cleanup boom')
      }
      return originalCount()
    }

    expect(() => page.onUnload.call(host as PageHost)).toThrow('unload boom')
    expect(onError.mock.calls.some(([error, source]) => (error as Error).message === 'cleanup boom' && source === 'unbind')).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('清理失败'), expect.any(Error))
    store.destroy()
  })
})

describe('withComponentStore：框架提升的注入闭包不得被当成用户原成员', () => {
  it('原生实例：promote 到实例顶层的注入闭包不登记为原成员，detached 删除而非回放', () => {
    const store = createCounterStore()
    const component = decorateComponent(store, { mapActions: ['inc'] }, { methods: {} })
    const { host } = createHost()
    // 模拟原生框架：config.methods（含装饰期注入的 dispatch 闭包）被提升为实例顶层方法
    ;(host as Record<string, unknown>).inc = (component.methods as Record<string, unknown>).inc

    component.lifetimes.attached.call(host as ComponentHost)
    expect(typeof (host as Record<string, unknown>).inc).toBe('function')
    ;((host as Record<string, unknown>).inc as (step: number) => void)(2)
    expect(store.getState().count).toBe(2)

    component.lifetimes.detached.call(host as ComponentHost)
    // 修复前：把注入闭包当「用户原方法」回放 → detached 后仍调用 store.dispatch（幽灵方法）
    expect('inc' in (host as Record<string, unknown>)).toBe(false)
    store.destroy()
  })

  it('实例 methods 被框架用 config.methods 预填充：detached 恢复配置级用户方法，不回放注入闭包', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = createCounterStore()
    const userInc = jest.fn(() => 'user')
    const component = decorateComponent(store, { mapActions: ['inc'] }, { methods: { inc: userInc } })
    const injected = (component.methods as Record<string, unknown>).inc
    // wrapper/测试宿主会把 config.methods 预填充到实例 methods（即注入闭包）
    const { host } = createHost({ methods: { ...(component.methods as Record<string, unknown>) } })

    component.lifetimes.attached.call(host as ComponentHost)
    expect(typeof (host.methods as Record<string, unknown>).inc).toBe('function')
    ;((host.methods as Record<string, unknown>).inc as (step: number) => void)(1)
    expect(store.getState().count).toBe(1)

    component.lifetimes.detached.call(host as ComponentHost)
    // 修复前：hasOwnProperty 优先于 configShadowed → 记录注入闭包 → 解绑后回放注入闭包而非用户方法
    expect((host.methods as Record<string, unknown>).inc).toBe(userInc)
    expect((host.methods as Record<string, unknown>).inc).not.toBe(injected)
    store.destroy()
  })

  it('生产期 claim 剔除的 action：框架提升的注入闭包在 attached 即被清理（原生实例顶层）', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const index = await import('../../../src/index.js')
      const mod = await import('../../../src/integrations/with-store.js')
      const { createHost } = await import('../../utils/host.js')
      const store = index.createStore({
        name: 'ocr2-ghost-instance',
        state: () => ({ count: 0 }),
        actions: {
          increment() {
            this.setState('count', this.getState().count + 1)
          },
        },
      })
      const onError = jest.fn()
      store.hooks.on('onError', onError)
      type Decorated = {
        lifetimes: { attached: (this: Record<string, unknown>) => void; detached: (this: Record<string, unknown>) => void }
        methods: Record<string, unknown>
      }
      const config = (mod.withComponentStore(store, { mapActions: { inc: 'increment' } } as never) as unknown as (c: object) => Decorated)({ methods: {} })
      // 宿主自有 data 已有 inc：claimLocalKeys 在生产期剔除该 action（上报后继续）
      const { host } = createHost({ data: { inc: 0 } })
      ;(host as Record<string, unknown>).inc = config.methods.inc

      config.lifetimes.attached.call(host as Record<string, unknown>)
      // 修复前：被剔除的本地名不在有效映射里 → 提升上来的注入闭包残留成幽灵方法
      expect('inc' in (host as Record<string, unknown>)).toBe(false)
      expect(onError).toHaveBeenCalledTimes(1)
      expect((onError.mock.calls[0][0] as { code?: string }).code).toBe('INVALID_MAPPING')

      config.lifetimes.detached.call(host as Record<string, unknown>)
      store.destroy()
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
      jest.resetModules()
    }
  })

  it('生产期 claim 剔除的 action：instance methods 上预填充的注入闭包被清理，配置级用户方法恢复', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const index = await import('../../../src/index.js')
      const mod = await import('../../../src/integrations/with-store.js')
      const { createHost } = await import('../../utils/host.js')
      const store = index.createStore({
        name: 'ocr2-ghost-methods',
        state: () => ({ count: 0 }),
        actions: {
          increment() {
            this.setState('count', this.getState().count + 1)
          },
        },
      })
      const userInc = jest.fn(() => 'user')
      type Decorated = {
        lifetimes: { attached: (this: Record<string, unknown>) => void; detached: (this: Record<string, unknown>) => void }
        methods: Record<string, unknown>
      }
      const config = (mod.withComponentStore(store, { mapActions: { inc: 'increment' } } as never) as unknown as (c: object) => Decorated)({
        methods: { inc: userInc },
      })
      // 宿主 data 已有 inc → claim 剔除；同时 wrapper 已把 config.methods（注入闭包）预填充到实例 methods
      const { host } = createHost({ data: { inc: 0 }, methods: { ...config.methods } })

      config.lifetimes.attached.call(host as Record<string, unknown>)
      expect((host.methods as Record<string, unknown>).inc).toBe(userInc)

      config.lifetimes.detached.call(host as Record<string, unknown>)
      store.destroy()
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
      jest.resetModules()
    }
  })

  it('生产期 claim 剔除的 action：instance methods 上的注入闭包被删除（无配置级原方法时不留幽灵）', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const index = await import('../../../src/index.js')
      const mod = await import('../../../src/integrations/with-store.js')
      const { createHost } = await import('../../utils/host.js')
      const store = index.createStore({
        name: 'ocr2-ghost-methods-del',
        state: () => ({ count: 0 }),
        actions: {
          increment() {
            this.setState('count', this.getState().count + 1)
          },
        },
      })
      type Decorated = {
        lifetimes: { attached: (this: Record<string, unknown>) => void; detached: (this: Record<string, unknown>) => void }
        methods: Record<string, unknown>
      }
      const config = (mod.withComponentStore(store, { mapActions: { inc: 'increment' } } as never) as unknown as (c: object) => Decorated)({ methods: {} })
      // 宿主 data 占用 inc → claim 剔除；wrapper 已把 config.methods 预填充到实例 methods
      const { host } = createHost({ data: { inc: 0 }, methods: { ...config.methods } })

      config.lifetimes.attached.call(host as Record<string, unknown>)
      expect('inc' in (host.methods as Record<string, unknown>)).toBe(false)

      config.lifetimes.detached.call(host as Record<string, unknown>)
      store.destroy()
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
      jest.resetModules()
    }
  })

  it('生产期 claim 剔除的 action：原生实例顶层清理覆盖「守卫跳过」与「配置级用户方法回放」两条路径', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const index = await import('../../../src/index.js')
      const mod = await import('../../../src/integrations/with-store.js')
      const { createHost } = await import('../../utils/host.js')
      const store = index.createStore({
        name: 'ocr2-native-replay',
        state: () => ({ count: 0 }),
        actions: {
          increment() {
            this.setState('count', this.getState().count + 1)
          },
          decrement() {
            this.setState('count', this.getState().count - 1)
          },
        },
      })
      const onError = jest.fn()
      store.hooks.on('onError', onError)
      const userInc = jest.fn(() => 'user-inc')
      const userDec = jest.fn(() => 'user-dec')
      type Decorated = {
        lifetimes: { attached: (this: Record<string, unknown>) => void; detached: (this: Record<string, unknown>) => void }
        methods: Record<string, unknown>
      }
      const config = (mod.withComponentStore(store, { mapActions: { inc: 'increment', dec: 'decrement' } } as never) as unknown as (c: object) => Decorated)({
        methods: { inc: userInc, dec: userDec },
      })
      // 原生实例（实例没有 methods 命名空间）：宿主自有 data 占用 inc/dec → 生产期 claim 全部剔除
      const { host } = createHost({ data: { inc: 0, dec: 0 } })
      // 框架把 config.methods 提升到实例顶层：inc 是本装饰器注入的闭包（走 configShadowed 回放），
      // dec 已被用户方法替换（isInjectedActionMethod 守卫命中 → 跳过、不覆盖用户方法）
      ;(host as Record<string, unknown>).inc = config.methods.inc
      ;(host as Record<string, unknown>).dec = userDec

      config.lifetimes.attached.call(host as Record<string, unknown>)
      // configShadowed.has('inc') → defineOwnValue 回放配置级用户方法；dec 被守卫跳过保持用户方法
      expect((host as Record<string, unknown>).inc).toBe(userInc)
      expect((host as Record<string, unknown>).dec).toBe(userDec)
      expect(userInc).not.toHaveBeenCalled()
      expect(userDec).not.toHaveBeenCalled()
      expect(store.getState().count).toBe(0)
      // 两个本地名都因宿主 data 冲突被剔除并上报
      const invalidMappingErrors = onError.mock.calls.filter((call) => (call[0] as { code?: string }).code === 'INVALID_MAPPING')
      expect(invalidMappingErrors).toHaveLength(2)

      config.lifetimes.detached.call(host as Record<string, unknown>)
      expect((host as Record<string, unknown>).inc).toBe(userInc)
      expect((host as Record<string, unknown>).dec).toBe(userDec)
      store.destroy()
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
      jest.resetModules()
    }
  })
})

describe('配置对象原型保留与原型污染防护', () => {
  it('Page：Object.create 组织的配置，原型上的 onLoad 不丢失', () => {
    const store = createCounterStore()
    const onLoad = jest.fn()
    const config = Object.create({ onLoad }) as Record<string, unknown>
    config.data = {}
    const page = (withPageStore(store, { mapState: ['count'] } as never) as unknown as (c: object) => DecoratedPage)(config)
    const { host } = createHost()

    page.onLoad.call(host as PageHost)
    expect(onLoad).toHaveBeenCalledTimes(1)
    expect((host.data as Record<string, unknown>).count).toBe(0)
    page.onUnload.call(host as PageHost)
    store.destroy()
  })

  it('Component：原型上的 lifetimes.attached 不丢失', () => {
    const store = createCounterStore()
    const attached = jest.fn()
    const config = Object.create({ lifetimes: { attached } }) as Record<string, unknown>
    config.data = {}
    const component = decorateComponent(store, { mapState: ['count'] }, config)
    const { host } = createHost({ methods: {} })

    component.lifetimes.attached.call(host as ComponentHost)
    expect(attached).toHaveBeenCalledTimes(1)
    expect((host.data as Record<string, unknown>).count).toBe(0)
    component.lifetimes.detached.call(host as ComponentHost)
    store.destroy()
  })

  it('配置自带可枚举 __proto__ 键：返回配置原型不被污染', () => {
    const store = createCounterStore()
    const config = JSON.parse('{"__proto__":{"polluted":true},"data":{}}') as Record<string, unknown>
    const page = (withPageStore(store, { mapState: ['count'] } as never) as unknown as (c: object) => DecoratedPage)(config)

    expect(Object.getPrototypeOf(page)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(page, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()

    const { host } = createHost()
    page.onLoad.call(host as PageHost)
    expect((host.data as Record<string, unknown>).count).toBe(0)
    page.onUnload.call(host as PageHost)
    store.destroy()
  })
})
