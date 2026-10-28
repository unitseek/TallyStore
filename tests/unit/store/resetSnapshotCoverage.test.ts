/** Store 的 $reset / $restore 边界分支：销毁后调用、无初始状态、来源标记版本不匹配 */

import { createStore, TallyStoreError } from '../../../src/index.js'

const MARK = Symbol.for('tallystore.snapshotMark')

afterEach(() => {
  jest.restoreAllMocks()
})

describe('Store.$reset 边界', () => {
  it('已销毁的 Store 调用 $reset 抛错（与 setState/dispatch 同口径）', () => {
    const store = createStore({ name: 'cov-reset-destroyed', state: () => ({ count: 0 }) })
    store.destroy()
    expect(() => store.$reset()).toThrow(/destroyed/)
  })

  it('省略 state 创建（初始源为空）时 $reset 复位为空对象', () => {
    const store = createStore()
    store.setState('count', 3)
    store.$reset()
    expect(store.getState()).toEqual({})
    store.destroy()
  })
})

describe('Store.$restore 来源标记版本不匹配', () => {
  it('开发期：warn + onError 上报，形态合法则照常恢复', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = createStore({ name: 'cov-restore-version', state: () => ({ count: 1 }) })
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const forged = { ...(store.$snapshot() as unknown as Record<string, unknown>), [MARK]: 2 }
    store.$restore(forged as never)
    expect(store.getState().count).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('不同版本标记'))
    expect(onError).toHaveBeenCalledTimes(1)
    store.destroy()
  })

  it('生产期：不打印 console.warn，仍经 onError 上报', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { createStore: createProd } = await import('../../../src/index.js')
      const store = createProd({ name: 'cov-restore-prod', state: () => ({ count: 1 }) })
      const onError = jest.fn()
      store.hooks.on('onError', onError)
      const forged = { ...(store.$snapshot() as unknown as Record<string, unknown>), [MARK]: 3 }
      store.$restore(forged as never)
      expect(store.getState().count).toBe(1)
      expect(warn).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledTimes(1)
      expect((onError.mock.calls[0][0] as TallyStoreError).code).toBe('INVALID_CONFIG')
      store.destroy()
    } finally {
      warn.mockRestore()
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
      jest.resetModules()
    }
  })
})
