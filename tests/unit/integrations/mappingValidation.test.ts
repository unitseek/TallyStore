/**  / AS-09：映射语义与命名冲突——不存在字段、多 Store 同名、宿主 data 同名、不可序列化值 */
import { createStore, TallyStoreError } from '../../../src/index.js'
import { withPageStore } from '../../../src/integrations/with-store.js'
import { visibilityOf } from '../../../src/integrations/visibility.js'
import { createHost } from '../../utils/host.js'

type PageHost = {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  [key: string]: unknown
}

type DecoratedPage = {
  onLoad: (this: PageHost) => void
  onUnload: (this: PageHost) => void
}

function makeStore(name: string) {
  return createStore({
    name,
    state: () => ({ count: 0, label: 'a', bag: new Map<string, number>() }),
    actions: {
      inc() {
        this.setState('count', this.getState().count + 1)
      },
    },
    getters: { doubled: (state) => state.count * 2 },
  })
}

function decorate(store: ReturnType<typeof makeStore>, options: Record<string, unknown>): DecoratedPage {
  return (withPageStore(store, options as never) as unknown as (c: object) => DecoratedPage)({ data: {} })
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe(' 映射校验（开发期）', () => {
  it('mapState 映射不存在的字段抛 INVALID_MAPPING，指出 Store 与字段名（AS-09）', () => {
    const store = makeStore('fr08-a')
    try {
      decorate(store, { mapState: ['cont'] })
      throw new Error('should throw')
    } catch (error) {
      expect(error).toBeInstanceOf(TallyStoreError)
      const e = error as TallyStoreError
      expect(e.code).toBe('INVALID_MAPPING')
      expect(e.message).toContain('cont')
      expect(e.message).toContain('fr08-a')
      expect(e.message).toContain('可用字段')
      expect(e.message).toContain('count')
    }
    store.destroy()
  })

  it('mapGetters / mapActions 映射不存在的字段同样报错', () => {
    const store = makeStore('fr08-b')
    expect(() => decorate(store, { mapGetters: ['tripled'] })).toThrow(/tripled.*fr08-b|fr08-b.*tripled/)
    expect(() => decorate(store, { mapActions: ['dec'] })).toThrow(/dec.*fr08-b|fr08-b.*dec/)
    store.destroy()
  })

  it('两个 Store 映射同一本地键：第二个绑定抛 INVALID_MAPPING；第一个不受影响', () => {
    const storeA = makeStore('fr08-c-a')
    const storeB = makeStore('fr08-c-b')
    const { host } = createHost()
    const pageA = decorate(storeA, { mapState: ['count'] })
    pageA.onLoad.call(host as never)

    const pageB = decorate(storeB, { mapState: ['count'] })
    expect(() => pageB.onLoad.call(host as never)).toThrow(/count.*已被另一个 store|占用/)
    // A 的绑定仍有效
    storeA.actions.inc()
    expect((host.data as { count: number }).count).toBe(1)

    pageA.onUnload.call(host as never)
    storeA.destroy()
    storeB.destroy()
  })

  it('映射本地键与宿主自有 data 同名：开发期抛 INVALID_MAPPING，不静默覆盖（AS-09）', () => {
    const store = makeStore('fr08-d')
    const page = decorate(store, { mapState: ['count'] })
    const { host } = createHost()
    // 宿主初始 data 自有 count 键（页面配置里的初始值）
    ;(host.data as Record<string, unknown>).count = 99
    expect(() => page.onLoad.call(host as never)).toThrow(/count.*宿主自有 data|宿主自有 data/)
    store.destroy()
  })

  it('宿主自有键快照只在首次绑定采集：重复 onLoad 不把映射写入的键误判为宿主自有', () => {
    const store = makeStore('fr08-e')
    const page = decorate(store, { mapState: ['count'] })
    const { host } = createHost()
    page.onLoad.call(host as never)
    expect(() => page.onLoad.call(host as never)).not.toThrow()
    page.onUnload.call(host as never)
    store.destroy()
  })

  it('卸载后本地键占用释放：另一 Store 可映射同一本地键', () => {
    const storeA = makeStore('fr08-f-a')
    const storeB = makeStore('fr08-f-b')
    const { host } = createHost()
    const pageA = decorate(storeA, { mapState: ['count'] })
    const pageB = decorate(storeB, { mapState: ['count'] })
    pageA.onLoad.call(host as never)
    pageA.onUnload.call(host as never)
    expect(() => pageB.onLoad.call(host as never)).not.toThrow()
    pageB.onUnload.call(host as never)
    storeA.destroy()
    storeB.destroy()
  })

  it('Map 直接映射：开发期抛 INVALID_MAPPING 并指出字段（ 验收 4）', () => {
    const store = makeStore('fr08-g')
    const page = decorate(store, { mapState: ['bag'] })
    const { host } = createHost()
    expect(() => page.onLoad.call(host as never)).toThrow(/bag.*Map|Map.*bag/)
    store.destroy()
  })

  it('函数值映射（getter 返回函数）：开发期报错', () => {
    const store = createStore({
      name: 'fr08-h',
      state: () => ({ count: 0 }),
      getters: { handler: () => () => 1 },
    })
    const page = decorate(store as never, { mapGetters: ['handler'] })
    const { host } = createHost()
    expect(() => page.onLoad.call(host as never)).toThrow(/handler.*函数|函数.*handler/)
    store.destroy()
  })

  it('Set 直接映射：开发期抛 INVALID_MAPPING 并指出字段', () => {
    const store = createStore({ name: 'fr08-set', state: () => ({ bag: new Set([1]) }) })
    const page = decorate(store as never, { mapState: ['bag'] })
    const { host } = createHost()
    expect(() => page.onLoad.call(host as never)).toThrow(/bag.*Set|Set.*bag/)
    store.destroy()
  })

  it('类实例直接映射：开发期抛 INVALID_MAPPING 并标注「类实例」', () => {
    class Service {}
    const store = createStore({ name: 'fr08-instance', state: () => ({ service: new Service() }) })
    const page = decorate(store as never, { mapState: ['service'] })
    const { host } = createHost()
    expect(() => page.onLoad.call(host as never)).toThrow(/service.*类实例|类实例.*service/)
    store.destroy()
  })

  it('可序列化的映射值（数组 / Date / RegExp / null 原型对象）照常下发', () => {
    const dict = Object.assign(Object.create(null) as Record<string, unknown>, { v: 1 })
    const store = createStore({
      name: 'fr08-serializable',
      state: () => ({ list: [1, 2], when: new Date(0), pattern: /x/, dict }),
    })
    const page = decorate(store as never, { mapState: ['list', 'when', 'pattern', 'dict'] })
    const { host } = createHost()
    expect(() => page.onLoad.call(host as never)).not.toThrow()
    const data = host.data as Record<string, unknown>
    expect(data.list).toEqual([1, 2])
    expect(data.when).toEqual(new Date(0))
    expect(data.pattern).toEqual(/x/)
    expect(data.dict).toEqual({ v: 1 })
    page.onUnload.call(host as never)
    store.destroy()
  })

  it('映射不存在的 getter 且 store 无 getters：错误文案给出「可用字段：(无)」', () => {
    const store = createStore({ name: 'fr08-no-getters', state: () => ({ count: 0 }) })
    try {
      decorate(store as never, { mapGetters: ['ghost'] })
      throw new Error('should throw')
    } catch (error) {
      expect((error as TallyStoreError).message).toContain('(无)')
    }
    store.destroy()
  })

  it('同一 store 的 mapState 与 mapGetters 使用同一本地键：开发期抛 INVALID_MAPPING', () => {
    const store = makeStore('fr08-kind-dev')
    // 两类映射的 storeKey 都存在（count / doubled），冲突只来自本地键 'doubled' 重复
    const page = decorate(store, { mapState: { doubled: 'count' }, mapGetters: { doubled: 'doubled' } })
    const { host } = createHost()
    expect(() => page.onLoad.call(host as never)).toThrow(/doubled.*已作为 mapState|已作为 mapState.*doubled/)
    store.destroy()
  })

  it('mapActions 与 data 映射共用本地名（不同命名空间）允许：data 与实例方法各自生效（ 口径）', () => {
    const store = makeStore('fr08-kind-ok')
    const page = decorate(store, { mapState: { inc: 'count' }, mapActions: { inc: 'inc' } })
    const { host } = createHost()
    page.onLoad.call(host as never)

    expect((host.data as Record<string, unknown>).inc).toBe(0)
    expect(typeof (host as Record<string, unknown>).inc).toBe('function')
    ;((host as Record<string, unknown>).inc as () => void)()
    expect(store.getState().count).toBe(1)
    expect((host.data as Record<string, unknown>).inc).toBe(1)
    page.onUnload.call(host as never)
    store.destroy()
  })

  it('绑定失败回滚：退订并释放本地键，另一 store 可复用同名本地键', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const storeA = makeStore('fr08-fail-a')
    const pageA = decorate(storeA, { mapState: ['count'] })
    const { host } = createHost()
    // 冻结 revealCallbacks：registerRealign 在订阅建立之后抛错，触发真正的回滚路径
    Object.freeze(visibilityOf(host).revealCallbacks)

    expect(() => pageA.onLoad.call(host as never)).toThrow(TypeError)
    // 订阅已建立的退订先登记，回滚后订阅计数归零（不泄漏）
    expect(storeA.getSubscriptionCount()).toBe(0)
    // 失败绑定登记的本地键已释放——另一 store 用同名本地键不再被误判冲突
    const storeB = makeStore('fr08-fail-b')
    const pageB = decorate(storeB, { mapState: ['count'], backgroundUpdates: false })
    expect(() => pageB.onLoad.call(host as never)).not.toThrow()
    expect((host.data as Record<string, unknown>).count).toBe(0)

    pageB.onUnload.call(host as never)
    storeA.destroy()
    storeB.destroy()
    expect(warn).toHaveBeenCalled()
  })
})

describe(' 生产降级', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production'
    jest.resetModules()
  })

  afterEach(() => {
    delete process.env.NODE_ENV
    jest.resetModules()
  })

  it('映射不存在字段：跳过该键 + onError(INVALID_MAPPING) 上报，页面不阻断', async () => {
    const { createStore: createProd, withPageStore: withPage } = await import('../../../src/index.js')
    const { createHost: host } = await import('../../utils/host.js')
    const store = createProd({ name: 'fr08-prod', state: () => ({ count: 0 }) })
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const { host: h } = host()
    const page = (
      withPage(store, { mapState: ['count', 'ghost'] } as never) as unknown as (c: object) => {
        onLoad: (this: typeof h) => void
        onUnload: (this: typeof h) => void
      }
    )({ data: {} })

    expect(() => page.onLoad.call(h)).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    const [error, source] = onError.mock.calls[0]
    expect((error as TallyStoreError).code).toBe('INVALID_MAPPING')
    expect(source).toBe('mapping')
    // 合法键照常映射，非法键被跳过
    expect((h.data as Record<string, unknown>).count).toBe(0)
    expect(Object.keys(h.data as Record<string, unknown>)).not.toContain('ghost')
    page.onUnload.call(h)
    store.destroy()
  })

  it('多 Store 同一本地键：生产期跳过后者该键并上报，前者继续生效', async () => {
    const { createStore: createProd, withPageStore: withPage } = await import('../../../src/index.js')
    const { createHost: host } = await import('../../utils/host.js')
    const storeA = createProd({ name: 'fr08-pa', state: () => ({ count: 0 }) })
    const storeB = createProd({ name: 'fr08-pb', state: () => ({ count: 100 }) })
    const onError = jest.fn()
    storeB.hooks.on('onError', onError)
    const { host: h } = host()
    const pageA = (withPage(storeA, { mapState: ['count'] }) as unknown as (c: object) => { onLoad: (this: typeof h) => void })({ data: {} })
    const pageB = (withPage(storeB, { mapState: ['count'] }) as unknown as (c: object) => { onLoad: (this: typeof h) => void })({ data: {} })
    pageA.onLoad.call(h)
    expect(() => pageB.onLoad.call(h)).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as TallyStoreError).code).toBe('INVALID_MAPPING')
    // B 的 count 不再写入（A 的值保留）
    expect((h.data as Record<string, unknown>).count).toBe(0)
    storeA.destroy()
    storeB.destroy()
  })

  it('同一 store 跨类别本地键冲突：生产期剔除 mapGetters 冲突键并上报，state 映射继续生效', async () => {
    const { createStore: createProd, withPageStore: withPage } = await import('../../../src/index.js')
    const { createHost: host } = await import('../../utils/host.js')
    const store = createProd({
      name: 'fr08-kind-prod',
      state: () => ({ count: 0 }),
      getters: { doubled: (state: { count: number }) => state.count * 2 },
    })
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const { host: h } = host()
    const page = (
      withPage(store, { mapState: { doubled: 'count' }, mapGetters: { doubled: 'doubled' } } as never) as unknown as (c: object) => {
        onLoad: (this: typeof h) => void
        onUnload: (this: typeof h) => void
      }
    )({ data: {} })

    expect(() => page.onLoad.call(h)).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as TallyStoreError).code).toBe('INVALID_MAPPING')
    expect(onError.mock.calls[0][1]).toBe('mapping')
    expect((h.data as Record<string, unknown>).doubled).toBe(0)
    // getter 冲突键已被剔除：值仍来自 state 映射（count*2 若生效会是 6）
    store.setState('count', 3)
    expect((h.data as Record<string, unknown>).doubled).toBe(3)
    page.onUnload.call(h)
    store.destroy()
  })
})
