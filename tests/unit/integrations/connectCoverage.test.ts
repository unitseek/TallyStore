/** connectHost / disconnectHost 的边界分支：写入失败包装、字节估算兜底、解绑期能力变化与生产期静默 */

import { createStore, TallyStoreError, withPageStore } from '../../../src/index.js'
import { connectHost, disconnectHost } from '../../../src/integrations/connect.js'
import { createHost } from '../../utils/host.js'
import type { HostSpec } from '../../../src/integrations/connect.js'
import type { Store } from '../../../src/types/store.js'

type Host = { data: Record<string, unknown>; [key: string]: unknown }

function fakeStore() {
  const unbind = jest.fn()
  const emit = jest.fn()
  const store = {
    name: 'fake-store',
    subscribe: jest.fn(() => unbind),
    dispatch: jest.fn(),
    state: { count: 1 },
    getState: jest.fn(() => ({ count: 1 })),
    getterNames: jest.fn(() => [] as string[]),
    actions: {},
    getter: jest.fn(),
    isStateKeyDirty: jest.fn(() => true),
    hooks: { emit },
  } as unknown as Store<{ count: number }>
  return { store, unbind, emit }
}

function defaultSpec(overrides: Partial<HostSpec<Host>> = {}): HostSpec<Host> {
  return { label: 'testHost', write: jest.fn(), ...overrides }
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('connectHost · 写入错误包装', () => {
  it('宿主写入抛非 Error：包装为 HOST_WRITE_ERROR，message 用 String(error) 兜底', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { store, unbind } = fakeStore()
    const host: Host = { data: {} }
    let caught: unknown
    try {
      connectHost(
        store,
        { mapState: ['count'] },
        host,
        defaultSpec({
          write: () => {
            throw 'string-write-boom'
          },
        }),
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TallyStoreError)
    expect((caught as TallyStoreError).code).toBe('HOST_WRITE_ERROR')
    expect((caught as Error).message).toContain('string-write-boom')
    // 初始映射在建立订阅之前同步下发：写入失败时还没有订阅可回滚
    expect(unbind).not.toHaveBeenCalled()
  })
})

describe('connectHost · 载荷字节估算兜底', () => {
  it('运行期载荷变为不可序列化（BigInt）：映射层剔除并上报 INVALID_MAPPING，不进入 writer/onHostWrite', () => {
    const store = createStore({ name: 'bytes-negative', state: () => ({ big: 0 as number | bigint }) })
    const onHostWrite = jest.fn()
    const onError = jest.fn()
    store.hooks.on('onHostWrite', onHostWrite)
    store.hooks.on('onError', onError)
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const page = (
      withPageStore(store, { mapState: ['big'] }) as unknown as (config: object) => {
        onLoad: (this: Record<string, unknown>) => void
        onUnload: (this: Record<string, unknown>) => void
      }
    )({ data: {} })
    const { host, setDataCalls } = createHost()
    page.onLoad.call(host)
    // 初始映射可序列化：成功写入后计一次指标
    expect(onHostWrite).toHaveBeenCalledTimes(1)
    expect((onHostWrite.mock.calls[0][0] as { bytes: number }).bytes).toBeGreaterThan(0)
    setDataCalls.splice(0, setDataCalls.length)

    // 运行期 BigInt 在 createMapper 组装载荷阶段即被剔除：整批无合法键 → 跳过 setter，writer/指标都不触发
    store.setState('big', 1n)
    expect(setDataCalls).toHaveLength(0)
    expect(onHostWrite).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    const [error, source] = onError.mock.calls[0]
    expect((error as { code?: string }).code).toBe('INVALID_MAPPING')
    expect(source).toBe('mapping')
    expect((error as { context?: { localKey?: string } }).context?.localKey).toBe('big')
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('big'))
    expect((host.data as Record<string, unknown>).big).toBe(0)
    page.onUnload.call(host)
    consoleError.mockRestore()
    store.destroy()
  })

  it('宿主写入成功后 onHostWrite 才上报；写入失败不计入已下发字节', () => {
    const store = createStore({ name: 'metrics-after-write', state: () => ({ count: 0 }) })
    const onHostWrite = jest.fn()
    const onError = jest.fn()
    store.hooks.on('onHostWrite', onHostWrite)
    store.hooks.on('onError', onError)
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const host: Record<string, unknown> = {
      data: {},
      setData(patch: Record<string, unknown>) {
        if ((patch as { count?: number }).count === 1) {
          throw new Error('setData boom')
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
    expect(onHostWrite).toHaveBeenCalledTimes(1)

    store.setState('count', 1)
    // 写入失败：同步通道已上报 HOST_WRITE_ERROR，但指标不应把它当成已下发载荷
    expect(onError.mock.calls.some(([error]) => (error as { code?: string }).code === 'HOST_WRITE_ERROR')).toBe(true)
    expect(onHostWrite).toHaveBeenCalledTimes(1)

    page.onUnload.call(host)
    consoleError.mockRestore()
    store.destroy()
  })
})

describe('connectHost · 生产期映射冲突与泄漏告警', () => {
  it('生产期 mapGetters 本地键被占用：跳过 getters 映射并上报，先绑定方继续生效', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const index = await import('../../../src/index.js')
      const storeA = index.createStore({
        name: 'prod-getters-a',
        state: () => ({ count: 0 }),
        getters: { doubled: (state: { count: number }) => state.count * 2 },
      })
      const storeB = index.createStore({
        name: 'prod-getters-b',
        state: () => ({ count: 5 }),
        getters: { doubled: (state: { count: number }) => state.count * 2 },
      })
      const onError = jest.fn()
      storeB.hooks.on('onError', onError)
      const { host } = createHost()
      const pageA = (
        index.withPageStore(storeA, { mapGetters: ['doubled'] }) as unknown as (config: object) => {
          onLoad: (this: Record<string, unknown>) => void
          onUnload: (this: Record<string, unknown>) => void
        }
      )({ data: {} })
      const pageB = (
        index.withPageStore(storeB, { mapGetters: ['doubled'] }) as unknown as (config: object) => {
          onLoad: (this: Record<string, unknown>) => void
          onUnload: (this: Record<string, unknown>) => void
        }
      )({ data: {} })
      pageA.onLoad.call(host)
      expect(() => pageB.onLoad.call(host)).not.toThrow()
      expect(onError).toHaveBeenCalledTimes(1)
      expect((onError.mock.calls[0][0] as { code?: string }).code).toBe('INVALID_MAPPING')
      // A 的 getter 映射继续生效；B 的冲突键被剔除，不产生幽灵写入
      storeA.setState('count', 3)
      expect((host.data as Record<string, unknown>).doubled).toBe(6)
      expect(storeB.getSubscriptionCount()).toBe(0)
      pageA.onUnload.call(host)
      pageB.onUnload.call(host)
      storeA.destroy()
      storeB.destroy()
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
      jest.resetModules()
    }
  })

  it('生产期泄漏告警静默；store 缺少 name 时消息用 (unknown) 兜底', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const connect = await import('../../../src/integrations/connect.js')
      const events: Array<{ event: string; args: unknown[] }> = []
      const emit = jest.fn((event: string, ...args: unknown[]) => {
        events.push({ event, args })
      })
      let listeners = 0
      const fake = {
        subscribe: jest.fn(() => {
          listeners += 1
          return () => {} // 退订失效：计数不下降
        }),
        dispatch: jest.fn(),
        state: { count: 1 },
        getState: () => ({ count: 1 }),
        getterNames: () => [] as string[],
        actions: {},
        getter: jest.fn(),
        isStateKeyDirty: () => true,
        getSubscriptionCount: () => listeners,
        hooks: { emit },
      } as never
      const host: Host = { data: {} }
      connect.connectHost(fake, { mapState: ['count'] } as never, host as never, { label: 'leakProd', write: () => {} } as never)
      connect.disconnectHost(host as object, fake as object)
      expect(warn).not.toHaveBeenCalled()
      const onErrorCalls = events.filter((entry) => entry.event === 'onError')
      expect(onErrorCalls).toHaveLength(1)
      expect(onErrorCalls[0].args[1]).toBe('unbind')
      expect((onErrorCalls[0].args[0] as Error).message).toContain('(unknown)')
    } finally {
      warn.mockRestore()
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
      jest.resetModules()
    }
  })

  it('解绑期间订阅计数能力消失：计数读取兜底为 -1，不误报泄漏', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const events: string[] = []
    let reads = 0
    const fake: Record<string, unknown> = {
      subscribe: jest.fn(() => () => {}),
      dispatch: jest.fn(),
      state: { count: 1 },
      getState: () => ({ count: 1 }),
      getterNames: () => [] as string[],
      actions: {},
      getter: jest.fn(),
      isStateKeyDirty: () => true,
      hooks: {
        emit: (event: string) => {
          events.push(event)
        },
      },
    }
    // typeof 与调用各读一次（前两次仍有能力，countBefore=3），countAfter 时能力已消失 → -1
    Object.defineProperty(fake, 'getSubscriptionCount', {
      configurable: true,
      get() {
        reads += 1
        return reads <= 2 ? () => 3 : undefined
      },
    })
    const host: Host = { data: {} }
    connectHost(fake as unknown as Store<{ count: number }>, { mapState: ['count'] }, host, defaultSpec())
    expect(reads).toBe(0)
    disconnectHost(host as object, fake as object)
    expect(reads).toBe(3)
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('订阅计数未下降'))
    expect(events.filter((event) => event === 'onError')).toHaveLength(0)
  })
})

describe('connectHost · maxPayloadBytes=0 跳过字节估算', () => {
  it('关闭载荷守卫时 onLoad 不做整树 JSON 序列化（守卫与指标都不活跃）', () => {
    const store = createStore({ name: 'bytes-skip-off', state: () => ({ count: 0 }) })
    const page = (
      withPageStore(store, { mapState: ['count'], maxPayloadBytes: 0 } as never) as unknown as (config: object) => {
        onLoad: (this: Record<string, unknown>) => void
        onUnload: (this: Record<string, unknown>) => void
      }
    )({ data: {} })
    const { host } = createHost()
    const stringifySpy = jest.spyOn(JSON, 'stringify')

    page.onLoad.call(host)
    expect(stringifySpy).not.toHaveBeenCalled()

    page.onUnload.call(host)
    store.destroy()
    stringifySpy.mockRestore()
  })

  it('守卫开启（默认）时照常估算一次，载荷守卫/指标可用', () => {
    const store = createStore({ name: 'bytes-skip-on', state: () => ({ count: 0 }) })
    const page = (
      withPageStore(store, { mapState: ['count'] } as never) as unknown as (config: object) => {
        onLoad: (this: Record<string, unknown>) => void
        onUnload: (this: Record<string, unknown>) => void
      }
    )({ data: {} })
    const { host } = createHost()
    const stringifySpy = jest.spyOn(JSON, 'stringify')

    page.onLoad.call(host)
    expect(stringifySpy).toHaveBeenCalled()

    page.onUnload.call(host)
    store.destroy()
    stringifySpy.mockRestore()
  })
})
