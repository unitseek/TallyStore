/**  /：运行期映射载荷不可序列化防护 */
import { createStore } from '../../../src/index.js'
import { withPageStore } from '../../../src/integrations/with-store.js'
import { createHost } from '../../utils/host.js'

type PageHost = { data: Record<string, unknown>; setData: (patch: Record<string, unknown>) => void; [key: string]: unknown }
type DecoratedPage = { onLoad: (this: PageHost) => void; onUnload: (this: PageHost) => void }

type AnyState = Record<string, unknown>

function makeStore(name: string, state: () => AnyState) {
  return createStore({ name, state })
}

function decoratePage(store: ReturnType<typeof makeStore>, options: Record<string, unknown>): DecoratedPage {
  return (withPageStore(store, options as never) as unknown as (config: object) => DecoratedPage)({ data: {} })
}

function setup(store: ReturnType<typeof makeStore>, options: Record<string, unknown>) {
  const page = decoratePage(store, options)
  const { host, setDataCalls } = createHost()
  page.onLoad.call(host as PageHost)
  setDataCalls.splice(0, setDataCalls.length)
  return { page, host, setDataCalls }
}

const consoleErrorSpy = () => jest.spyOn(console, 'error').mockImplementation(() => undefined)

afterEach(() => {
  jest.restoreAllMocks()
})

describe('运行期不可序列化映射值：剔除 + 上报', () => {
  it('Map 命中：本次 setData 载荷为空（跳过 setter）、onError(INVALID_MAPPING, mapping) 含 localKey，开发期 console.error', () => {
    const store = makeStore('rt-map', () => ({ payload: null as unknown }))
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const errorSpy = consoleErrorSpy()
    const { setDataCalls } = setup(store, { mapState: ['payload'] })

    store.setState('payload', new Map([['token', 'tk']]))

    expect(setDataCalls).toHaveLength(0)
    expect(onError).toHaveBeenCalledTimes(1)
    const [error, source] = onError.mock.calls[0]
    expect((error as { code?: string }).code).toBe('INVALID_MAPPING')
    expect(source).toBe('mapping')
    expect((error as { context?: { localKey?: string } }).context?.localKey).toBe('payload')
    expect((error as Error).message).toContain('payload')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('payload'))
    store.destroy()
  })

  it.each([
    ['函数', () => 1],
    ['BigInt', 1n],
    ['Symbol', Symbol('token')],
    ['Set', new Set([1])],
    [
      '类实例',
      new (class UserRecord {
        phone = '13812345678'
      })(),
    ],
  ])('运行期变为%s：不写入 setData、上报 localKey；恢复合法值后重新下发', (_label, invalidValue) => {
    const store = makeStore('rt-case-' + String(_label), () => ({ payload: null as unknown }))
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    consoleErrorSpy()
    const { setDataCalls } = setup(store, { mapState: ['payload'] })

    store.setState('payload', invalidValue)
    expect(setDataCalls).toHaveLength(0)
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as { context?: { localKey?: string } }).context?.localKey).toBe('payload')

    // 恢复为合法值：prevValues 未被非法值推进 → 下一次通知正常下发
    store.setState('payload', { ok: 1 })
    expect(setDataCalls).toEqual([{ payload: { ok: 1 } }])
    store.destroy()
  })

  it('校验自身抛错（ownKeys 陷阱）按不可序列化 fail-closed 处理并剔除', () => {
    const store = makeStore('rt-unverifiable', () => ({ payload: null as unknown }))
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    consoleErrorSpy()
    const { setDataCalls } = setup(store, { mapState: ['payload'] })

    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => Object.prototype,
        ownKeys: () => {
          throw new Error('ownKeys boom')
        },
      },
    )
    expect(() => store.setState('payload', hostile)).not.toThrow()
    expect(setDataCalls).toHaveLength(0)
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as Error).message).toContain('<unverifiable>')

    store.setState('payload', { ok: 3 })
    expect(setDataCalls).toEqual([{ payload: { ok: 3 } }])
    store.destroy()
  })

  it('循环引用命中：不写入 setData 并上报；恢复合法值后重新下发', () => {
    const store = makeStore('rt-cycle', () => ({ payload: null as unknown }))
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    consoleErrorSpy()
    const { setDataCalls } = setup(store, { mapState: ['payload'] })

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    store.setState('payload', cyclic)

    expect(setDataCalls).toHaveLength(0)
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as Error).message).toContain('payload')

    store.setState('payload', { ok: 2 })
    expect(setDataCalls).toEqual([{ payload: { ok: 2 } }])
    store.destroy()
  })
})

describe('运行期载荷：部分非法 / 全部非法 / 重试语义', () => {
  it('同一批里合法键照常下发、非法键剔除并上报', () => {
    const store = makeStore('rt-mixed', () => ({ good: 0 as unknown, bad: null as unknown }))
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    consoleErrorSpy()
    const { setDataCalls } = setup(store, { mapState: ['good', 'bad'] })

    store.batch(() => {
      store.setState('good', 1)
      store.setState('bad', new Map())
    })

    expect(setDataCalls).toEqual([{ good: 1 }])
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as { context?: { localKey?: string } }).context?.localKey).toBe('bad')
    store.destroy()
  })

  it('所有键都非法：跳过本次 setter；下一次通知仍会重试未下发的键，恢复后正常下发', () => {
    const store = makeStore('rt-all-invalid', () => ({ a: null as unknown, b: null as unknown }))
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    consoleErrorSpy()
    const { setDataCalls } = setup(store, { mapState: ['a', 'b'] })

    store.batch(() => {
      store.setState('a', new Map())
      store.setState('b', new Set())
    })
    expect(setDataCalls).toHaveLength(0)
    expect(onError).toHaveBeenCalledTimes(2)

    // 下次通知重试：a 恢复合法、b 仍非法 → 只下发 a，b 继续上报（未被 prevValues 吞掉）
    store.setState('a', 1)
    expect(setDataCalls).toEqual([{ a: 1 }])
    expect(onError).toHaveBeenCalledTimes(3)

    // b 也恢复 → 正常下发
    store.setState('b', 2)
    expect(setDataCalls).toEqual([{ a: 1 }, { b: 2 }])
    store.destroy()
  })
})

describe('放行值与既有语义', () => {
  it('undefined 仍按 undefined→null 下发且不报错', () => {
    const store = makeStore('rt-undefined', () => ({ payload: 1 as unknown }))
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const { setDataCalls } = setup(store, { mapState: ['payload'] })

    store.setState('payload', 'text')
    setDataCalls.splice(0, setDataCalls.length)
    store.setState('payload', undefined)
    expect(setDataCalls).toEqual([{ payload: null }])
    expect(onError).not.toHaveBeenCalled()
    store.destroy()
  })

  it('Date / RegExp 运行期放行：不剔除、不报错', () => {
    const store = makeStore('rt-date-regexp', () => ({ when: null as unknown, pattern: null as unknown }))
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    consoleErrorSpy()
    const { setDataCalls } = setup(store, { mapState: ['when', 'pattern'] })

    const date = new Date(0)
    const regexp = /token/
    store.setState('when', date)
    store.setState('pattern', regexp)

    expect(setDataCalls).toEqual([{ when: date }, { pattern: regexp }])
    expect(onError).not.toHaveBeenCalled()
    store.destroy()
  })

  it('getter 映射运行期返回 Map：同样剔除并上报 mapGetters', () => {
    let mode: 'ok' | 'map' = 'ok'
    const store = createStore({
      name: 'rt-getter',
      state: () => ({ count: 0 }),
      getters: { view: () => (mode === 'map' ? new Map([['a', 1]]) : { ok: 1 }) },
    })
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    consoleErrorSpy()
    const { setDataCalls } = setup(store as never, { mapGetters: ['view'] })

    mode = 'map'
    store.setState('count', 1)
    expect(setDataCalls).toHaveLength(0)
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as { context?: { localKey?: string; mapping?: string } }).context).toMatchObject({
      localKey: 'view',
      mapping: 'mapGetters',
    })

    mode = 'ok'
    store.setState('count', 2)
    expect(setDataCalls).toEqual([{ view: { ok: 1 } }])
    store.destroy()
  })

  it('初始绑定校验不回归：开发期初始映射 Map 仍抛 INVALID_MAPPING', () => {
    const store = createStore({ name: 'rt-initial', state: () => ({ bag: new Map([['a', 1]]) }) })
    const page = decoratePage(store as never, { mapState: ['bag'] })
    const { host } = createHost()
    expect(() => page.onLoad.call(host as PageHost)).toThrow(/不可直接映射/)
    store.destroy()
  })
})

describe('生产期：仅 onError、无 console.error、仍剔除', () => {
  it('生产期运行期 Map：不写 setData、onError 上报、console.error 静默', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    const errorSpy = consoleErrorSpy()
    try {
      const index = await import('../../../src/index.js')
      const mod = await import('../../../src/integrations/with-store.js')
      const store = index.createStore({ name: 'rt-prod', state: () => ({ payload: null as unknown }) })
      const onError = jest.fn()
      store.hooks.on('onError', onError)
      const page = (mod.withPageStore(store, { mapState: ['payload'] } as never) as unknown as (config: object) => DecoratedPage)({ data: {} })
      const { host, setDataCalls } = createHost()
      page.onLoad.call(host as PageHost)
      setDataCalls.splice(0, setDataCalls.length)

      store.setState('payload', new Map())
      expect(setDataCalls).toHaveLength(0)
      expect(onError).toHaveBeenCalledTimes(1)
      expect((onError.mock.calls[0][0] as { code?: string }).code).toBe('INVALID_MAPPING')
      expect(onError.mock.calls[0][1]).toBe('mapping')
      expect(errorSpy).not.toHaveBeenCalled()
      store.destroy()
    } finally {
      errorSpy.mockRestore()
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
      jest.resetModules()
    }
  })
})
