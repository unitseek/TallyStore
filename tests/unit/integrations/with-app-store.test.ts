import { createStore } from '../../../src/index.js'
import { withAppStore } from '../../../src/integrations/with-app-store.js'
import { trackSubscriptions } from '../../utils/host.js'

type AppHost = {
  globalData?: Record<string, unknown> | null
  [key: string]: unknown
}

type DecoratedApp = {
  onLaunch: (this: AppHost, ...args: unknown[]) => void
  onShow?: (...args: unknown[]) => void
  onHide?: (...args: unknown[]) => void
}

function createCounterStore() {
  return createStore({
    name: 'counter',
    state: () => ({ count: 0 }),
    actions: {
      inc(step = 1) {
        this.setState('count', this.getState().count + step)
      },
    },
    getters: {
      doubled: (state) => state.count * 2,
    },
  })
}

function decorateApp(store: unknown, options?: Record<string, unknown>, config: Record<string, unknown> = {}): DecoratedApp {
  // 用例需要覆盖不同 store 形状（含无 actions 的 store），这里按运行时契约传入
  const target = store as never
  const decorator = options === undefined ? withAppStore(target) : withAppStore(target, options as never)
  return (decorator as unknown as (c: Record<string, unknown>) => DecoratedApp)(config)
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('withAppStore：App 集成', () => {
  it('onLaunch 创建 globalData、写入 state/getters、绑定 actions，用户 onLaunch 最后调用', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const onLaunch = jest.fn(function (this: AppHost) {
      expect(this.globalData?.count).toBe(0)
    })
    const app = decorateApp(store, { mapState: ['count'], mapGetters: ['doubled'], mapActions: ['inc'] }, { onLaunch })
    const host: AppHost = {}

    app.onLaunch.call(host, 'arg')

    expect(host.globalData).toEqual({ count: 0, doubled: 0 })
    expect(stats.registered).toBe(1)
    expect(onLaunch).toHaveBeenCalledTimes(1)
    expect(onLaunch).toHaveBeenCalledWith('arg')
    ;(host as AppHost & { inc: (step: number) => void }).inc(2)
    expect(store.getState().count).toBe(2)
    expect(host.globalData?.count).toBe(2)
    expect(host.globalData?.doubled).toBe(4)
    store.destroy()
  })

  it('保留 globalData 其它成员；冲突告警只报一次', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createStore({
      name: 'counter',
      state: () => ({ count: 0 }),
      getters: { doubled: (state) => state.count * 2 },
    })
    const app = decorateApp(store, { mapState: { shared: 'count', other: 'count' }, mapGetters: { localDouble: 'doubled' } })
    const host: AppHost = { globalData: { shared: 'old', keep: 'me' } }
    const onError = jest.fn()
    store.hooks.on('onError', onError)

    app.onLaunch.call(host)
    expect(host.globalData).toMatchObject({ shared: 0, other: 0, localDouble: 0, keep: 'me' })
    expect(warn).toHaveBeenCalledTimes(1)
    // 冲突两期均经 onError(INVALID_MAPPING) 上报，只报一次
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as { code?: string }).code).toBe('INVALID_MAPPING')
    expect(onError.mock.calls[0][1]).toBe('mapping')
    const message = warn.mock.calls[0]?.[0] as string
    expect(message).toContain('globalData 已有成员 "shared"')

    app.onLaunch.call(host)
    expect(warn).toHaveBeenCalledTimes(1)
    store.destroy()
  })

  it('同一本地键跨 state/getters：开发期在绑定期抛 INVALID_MAPPING；此前 globalData 冲突告警已去重', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createStore({
      name: 'kind-conflict',
      state: () => ({ count: 0 }),
      getters: { doubled: (state) => state.count * 2 },
    })
    const app = decorateApp(store, { mapState: { shared: 'count' }, mapGetters: { shared: 'doubled' } })
    const host: AppHost = { globalData: { shared: 'old', keep: 'me' } }

    // 同一本地键在两类映射里各出现一次：装饰期不抛（两类字段都存在），绑定期按冲突拒绝
    expect(() => app.onLaunch.call(host)).toThrow(/本地键|INVALID_MAPPING|映射/)
    expect(warn).toHaveBeenCalledTimes(1)
    const message = warn.mock.calls[0]?.[0] as string
    expect((message.match(/"shared"/g) ?? []).length).toBe(1)
    store.destroy()
  })

  it('重复 onLaunch 重绑不叠加订阅，action 仍可调用且新值继续写入 globalData', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const app = decorateApp(store, { mapState: ['count'], mapActions: ['inc'] })
    const host: AppHost = {}

    app.onLaunch.call(host)
    app.onLaunch.call(host)

    expect(stats.registered).toBe(2)
    expect(stats.active).toBe(1)
    ;(host as AppHost & { inc: (step: number) => void }).inc(3)
    expect(host.globalData?.count).toBe(3)
    store.destroy()
  })

  it('对象形态映射支持本地重命名（state 与 getters）', () => {
    const store = createCounterStore()
    const app = decorateApp(store, { mapState: { localCount: 'count' }, mapGetters: { localDouble: 'doubled' } })
    const host: AppHost = {}

    app.onLaunch.call(host)
    expect(host.globalData).toEqual({ localCount: 0, localDouble: 0 })
    store.setState('count', 2)
    expect(host.globalData).toEqual({ localCount: 2, localDouble: 4 })
    store.destroy()
  })

  it('原型敏感本地键在装饰期直接拒绝（不进入 setData/globalData）', () => {
    const store = createCounterStore()
    expect(() => decorateApp(store, { mapState: { ['__proto__']: 'count' } })).toThrow(TypeError)
    expect(() => decorateApp(store, { mapActions: { ['__proto__']: 'inc' } })).toThrow(TypeError)
    store.destroy()
  })

  it('globalData 为 null 时同样补建对象', () => {
    const store = createCounterStore()
    const app = decorateApp(store, { mapState: ['count'] })
    const host: AppHost = { globalData: null }

    app.onLaunch.call(host)
    expect(host.globalData).toEqual({ count: 0 })
    store.destroy()
  })

  it('未传 options 时只保证 globalData 存在并转发用户生命周期', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const onLaunch = jest.fn()
    const app = decorateApp(store, undefined, { onLaunch })
    const host: AppHost = {}

    app.onLaunch.call(host)

    expect(host.globalData).toEqual({})
    expect(stats.registered).toBe(0)
    expect(onLaunch).toHaveBeenCalledTimes(1)
    store.destroy()
  })

  it('用户 onLaunch 抛错时绑定已建立、异常原样透出', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const app = decorateApp(
      store,
      { mapState: ['count'] },
      {
        onLaunch() {
          throw new Error('launch boom')
        },
      },
    )
    const host: AppHost = {}

    expect(() => app.onLaunch.call(host)).toThrow('launch boom')
    expect(stats.registered).toBe(1)
    expect(host.globalData?.count).toBe(0)
    store.destroy()
  })

  it('onShow/onHide 被包装以驱动可见性门控，但用户回调照常执行且不清理订阅', () => {
    const store = createCounterStore()
    const stats = trackSubscriptions(store)
    const onShow = jest.fn()
    const onHide = jest.fn()
    const app = decorateApp(store, { mapState: ['count'] }, { onShow, onHide })
    const host: AppHost = {}
    app.onLaunch.call(host)

    // 包装后不再是原函数引用，但用户回调在切换可见性标志后仍被调用
    expect(app.onShow).not.toBe(onShow)
    expect(app.onHide).not.toBe(onHide)
    app.onHide?.call(host)
    expect(onHide).toHaveBeenCalledTimes(1)
    app.onShow?.call(host)
    expect(onShow).toHaveBeenCalledTimes(1)
    // onHide 只切可见性，不清理订阅（运行期反复切换仍能同步）
    expect(stats.active).toBe(1)
    store.destroy()
  })

  it('backgroundUpdates 对 App 生效：后台不写 globalData，回前台对齐最新值', () => {
    const store = createCounterStore()
    const app = decorateApp(store, { mapState: ['count'] })
    const host: AppHost = {}
    app.onLaunch.call(host)
    expect(host.globalData?.count).toBe(0)

    app.onHide?.call(host)
    store.setState('count', 3)
    // 后台期间不下发，只缓存
    expect(host.globalData?.count).toBe(0)

    app.onShow?.call(host)
    expect(host.globalData?.count).toBe(3)
    store.destroy()
  })

  it('backgroundUpdates: false 时保持原函数引用（关闭门控）', () => {
    const store = createCounterStore()
    const onShow = jest.fn()
    const onHide = jest.fn()
    const app = decorateApp(store, { mapState: ['count'], backgroundUpdates: false }, { onShow, onHide })
    expect(app.onShow).toBe(onShow)
    expect(app.onHide).toBe(onHide)
    const host: AppHost = {}
    app.onLaunch.call(host)
    store.setState('count', 2)
    expect(host.globalData?.count).toBe(2)
    store.destroy()
  })

  it('globalData 被宿主替换后重新检查同名冲突', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createStore({ name: 'collision-ref', state: () => ({ count: 0 }) })
    const app = decorateApp(store, { mapState: ['count'] })
    const host: AppHost = { globalData: { count: 1 } }
    const onError = jest.fn()
    store.hooks.on('onError', onError)

    app.onLaunch.call(host)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)

    // 同一 globalData 重复 onLaunch：不重复告警
    app.onLaunch.call(host)
    expect(warn).toHaveBeenCalledTimes(1)

    // 宿主替换 globalData 对象：新对象上的同名冲突应重新检查并告警
    host.globalData = { count: 2 }
    app.onLaunch.call(host)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(2)
    store.destroy()
  })

  it('原型方式组织的 App 配置：原型上的 onLaunch 不丢失', () => {
    const store = createCounterStore()
    const onLaunch = jest.fn()
    const proto = { onLaunch }
    const config = Object.create(proto) as Record<string, unknown>
    const app = decorateApp(store, { mapState: ['count'] }, config)
    const host: AppHost = {}

    app.onLaunch.call(host)
    expect(onLaunch).toHaveBeenCalledTimes(1)
    expect(host.globalData?.count).toBe(0)
    store.destroy()
  })

  it('globalData 不是对象时 onLaunch 抛 TypeError', () => {
    const store = createCounterStore()
    const app = decorateApp(store, { mapState: ['count'] })
    const host = { globalData: 'not-object' as unknown as Record<string, unknown> }
    expect(() => app.onLaunch.call(host)).toThrow(TypeError)
    store.destroy()
  })
})

describe('生产模式：globalData 冲突告警静默', () => {
  const restoreNodeEnv = (previous: string | undefined): void => {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }

  it('production 下已有同名键不告警，但覆盖写入仍发生', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { createStore: createProdStore } = await import('../../../src/index.js')
      const { withAppStore: withProdAppStore } = await import('../../../src/integrations/with-app-store.js')
      const store = createProdStore({ name: 'prod-counter', state: () => ({ count: 0 }) })
      const decorate = (config: Record<string, unknown>): DecoratedApp =>
        (withProdAppStore(store, { mapState: ['count'] } as never) as unknown as (c: Record<string, unknown>) => DecoratedApp)(config)
      const host: AppHost = { globalData: { count: 5 } }

      const onError = jest.fn()
      store.hooks.on('onError', onError)
      decorate({}).onLaunch.call(host)

      expect(warn).not.toHaveBeenCalled()
      expect(host.globalData?.count).toBe(0)
      // 生产不刷控制台，但经 onError 上报（降级不静默）
      expect(onError).toHaveBeenCalledTimes(1)
      expect((onError.mock.calls[0][0] as { code?: string }).code).toBe('INVALID_MAPPING')
      store.destroy()
    } finally {
      warn.mockRestore()
      restoreNodeEnv(previous)
      jest.resetModules()
    }
  })

  it('生产期 globalData 非对象：不中断启动，onError 上报后以空对象兜底并继续执行用户 onLaunch', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { createStore: createProdStore } = await import('../../../src/index.js')
      const { withAppStore: withProdAppStore } = await import('../../../src/integrations/with-app-store.js')
      for (const badGlobalData of ['not-object', [] as unknown[]]) {
        const store = createProdStore({ name: 'prod-global-shape', state: () => ({ count: 0 }) })
        const onError = jest.fn()
        store.hooks.on('onError', onError)
        const onLaunch = jest.fn()
        const app = (withProdAppStore(store, { mapState: ['count'] } as never) as unknown as (c: Record<string, unknown>) => DecoratedApp)({
          onLaunch,
        })
        const host = { globalData: badGlobalData as unknown as Record<string, unknown> }

        // 生产期：不抛错（避免中断 App 启动），上报后降级为空对象，映射与用户 onLaunch 照常
        expect(() => app.onLaunch.call(host)).not.toThrow()
        expect(host.globalData).toEqual({ count: 0 })
        expect(onLaunch).toHaveBeenCalledTimes(1)
        expect(warn).not.toHaveBeenCalled()
        expect(onError).toHaveBeenCalledTimes(1)
        expect((onError.mock.calls[0][0] as { code?: string }).code).toBe('INVALID_CONFIG')
        expect(onError.mock.calls[0][1]).toBe('mapping')
        store.destroy()
      }
    } finally {
      warn.mockRestore()
      restoreNodeEnv(previous)
      jest.resetModules()
    }
  })
})

describe('配置对象原型保留与原型污染防护', () => {
  it('配置自带可枚举 __proto__ 键：保留原型且不污染 Object.prototype', () => {
    const store = createCounterStore()
    const config = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
    const app = decorateApp(store, { mapState: ['count'] }, config)

    expect(Object.getPrototypeOf(app)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(app, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()

    const host: AppHost = {}
    app.onLaunch.call(host)
    expect(host.globalData?.count).toBe(0)
    store.destroy()
  })
})
