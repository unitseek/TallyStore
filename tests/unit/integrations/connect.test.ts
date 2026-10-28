import type { Store } from '../../../src/types/store.js'
import { connectHost, disconnectHost } from '../../../src/integrations/connect.js'
import type { HostSpec } from '../../../src/integrations/connect.js'

type Host = {
  data: Record<string, unknown>
  [key: string]: unknown
}

function fakeStore() {
  const unbind = jest.fn()
  const subscribe = jest.fn(() => unbind)
  const dispatch = jest.fn(() => 'dispatched')
  const emit = jest.fn()
  const store = {
    name: 'fake-store',
    subscribe,
    dispatch,
    state: { count: 1 },
    getState: jest.fn(() => ({ count: 1 })),
    getterNames: jest.fn(() => [] as string[]),
    actions: { inc: dispatch },
    getter: jest.fn(() => 2),
    isStateKeyDirty: jest.fn(() => true),
    hooks: { emit },
  } as unknown as Store<{ count: number }>
  return { store, subscribe, unbind, dispatch, emit, getState: store.getState as jest.Mock }
}

function defaultSpec(overrides: Partial<HostSpec<Host>> = {}): HostSpec<Host> {
  return {
    label: 'testHost',
    write: jest.fn(),
    ...overrides,
  }
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('connectHost：宿主绑定骨架', () => {
  it('state 映射写入宿主并建立一条只读订阅；disconnectHost 退订', () => {
    const { store, subscribe, unbind } = fakeStore()
    const write = jest.fn()
    const host: Host = { data: {} }

    connectHost(store, { mapState: ['count'] }, host, defaultSpec({ write }))

    expect(write).toHaveBeenCalledWith(host, { count: 1 })
    expect(subscribe).toHaveBeenCalledWith(expect.any(Function), { readOnly: true })
    expect(Object.prototype.hasOwnProperty.call(host, 'count')).toBe(false)

    disconnectHost(host, store)
    expect(unbind).toHaveBeenCalledTimes(1)
    // 重复解绑是幂等的：没有登记可以清理
    expect(() => disconnectHost(host, store)).not.toThrow()
  })

  it('同一 store 重新绑定时先清理旧订阅，再建立新订阅', () => {
    const store = fakeStore()
    const host: Host = { data: {} }
    const firstSpec = defaultSpec()
    connectHost(store.store, { mapState: ['count'] }, host, firstSpec)
    const secondSpec = defaultSpec()
    connectHost(store.store, { mapState: ['count'] }, host, secondSpec)

    expect(store.unbind).toHaveBeenCalledTimes(1)
    expect(store.subscribe).toHaveBeenCalledTimes(2)
  })

  it('两个 store 在同一宿主上的绑定互不影响，可分别解绑（：本地键不得重复）', () => {
    const first = fakeStore()
    const second = fakeStore()
    ;(second.getState as jest.Mock).mockReturnValue({ count: 1, label: 'x' })
    const host: Host = { data: {} }
    connectHost(first.store, { mapState: ['count'] }, host, defaultSpec())
    connectHost(second.store, { mapState: { label2: 'label' } as never }, host, defaultSpec())

    disconnectHost(host, first.store)
    expect(first.unbind).toHaveBeenCalledTimes(1)
    expect(second.unbind).not.toHaveBeenCalled()

    disconnectHost(host, second.store)
    expect(second.unbind).toHaveBeenCalledTimes(1)
  })

  it('提供 actionTarget 时绑定 action，解绑时按原描述符还原宿主原成员', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, dispatch } = fakeStore()
    const original = jest.fn(() => 'old')
    const host: Host = { data: {}, inc: original }
    const spec = defaultSpec({ actionTarget: (h) => h as unknown as Record<string, unknown> })

    connectHost(store, { mapActions: ['inc'] }, host, spec)
    expect(host.inc).not.toBe(original)
    expect((host.inc as () => unknown)()).toBe('dispatched')
    expect(dispatch).toHaveBeenCalledWith('inc')

    disconnectHost(host, store)
    expect(host.inc).toBe(original)
  })

  it('空 options 时不建映射，仅登记写入器取消器；解绑不抛错', () => {
    const { store, subscribe } = fakeStore()
    const write = jest.fn()
    const host: Host = { data: {} }

    connectHost(store, {}, host, defaultSpec({ write }))

    expect(subscribe).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(() => disconnectHost(host, store)).not.toThrow()
  })

  it('首次写入抛错：回滚本次已登记绑定、告警并按原错误重抛，不建立订阅', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, subscribe } = fakeStore()
    const write = jest.fn(() => {
      throw new Error('write boom')
    })
    const host: Host = { data: {} }

    expect(() => connectHost(store, { mapState: ['count'] }, host, defaultSpec({ write }))).toThrow('write boom')

    expect(subscribe).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[testHost] 绑定映射失败，已回滚本次登记的订阅', expect.any(Error))
    expect(() => disconnectHost(host, store)).not.toThrow()
  })

  it('action 绑定阶段抛错：已登记的订阅被退订后再重抛', () => {
    const { store, unbind } = fakeStore()
    const throwingTarget = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('descriptor trap')
        },
      },
    )
    const host: Host = { data: {} }
    const spec = defaultSpec({ actionTarget: () => throwingTarget as unknown as Record<string, unknown> })

    expect(() => connectHost(store, { mapState: ['count'], mapActions: ['inc'] }, host, spec)).toThrow('descriptor trap')

    expect(unbind).toBeDefined()
    expect(unbind).toHaveBeenCalledTimes(1)
  })
})
