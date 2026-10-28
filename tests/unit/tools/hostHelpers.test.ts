/** tests/utils/host.ts 测试辅助契约：订阅跟踪、wx mock 与注册表清理 */
import { createStore } from '../../../src/index.js'
import { clearStoreRegistry, installWxStorage, trackSubscriptions, uninstallWxStorage } from '../../utils/host.js'

describe('trackSubscriptions', () => {
  it('统计注册/退订；uninstall 还原原始 subscribe', () => {
    const store = createStore({ name: 'host-track', state: () => ({ count: 0 }) })
    const originalSubscribe = store.subscribe
    const stats = trackSubscriptions(store)
    expect(store.subscribe).not.toBe(originalSubscribe)

    const off = store.subscribe(() => {}, { readOnly: true })
    expect(stats.registered).toBe(1)
    expect(stats.active).toBe(1)
    off()
    expect(stats.active).toBe(0)

    stats.uninstall()
    expect(store.subscribe).toBe(originalSubscribe)
    store.destroy()
  })

  it('对同一 store 重复调用返回同一 tracker，不会双重包装', () => {
    const store = createStore({ name: 'host-track-twice', state: () => ({ count: 0 }) })
    const first = trackSubscriptions(store)
    const second = trackSubscriptions(store)
    expect(second).toBe(first)

    const off = store.subscribe(() => {})
    // 若发生双重包装，registered 会是 2
    expect(first.registered).toBe(1)
    off()
    expect(first.active).toBe(0)
    first.uninstall()
    store.destroy()
  })

  it('subscribe 抛错时计数不虚增', () => {
    const store = {
      subscribe: () => {
        throw new Error('subscribe boom')
      },
    }
    const stats = trackSubscriptions(store as never)
    expect(() => (store.subscribe as (...args: unknown[]) => () => void)()).toThrow('subscribe boom')
    expect(stats.registered).toBe(0)
    expect(stats.active).toBe(0)
    stats.uninstall()
  })
})

describe('wx 宿主 mock', () => {
  it('installWxStorage / uninstallWxStorage 成对安装与清理', () => {
    expect((globalThis as { wx?: unknown }).wx).toBeUndefined()
    const memory = installWxStorage({ a: '1' })
    const wx = (globalThis as { wx?: { getStorageSync: (key: string) => string } }).wx
    expect(wx?.getStorageSync('a')).toBe('1')
    memory.set('b', '2')
    expect(wx?.getStorageSync('b')).toBe('2')
    uninstallWxStorage()
    expect((globalThis as { wx?: unknown }).wx).toBeUndefined()
  })
})

describe('Store 注册表清理', () => {
  it('clearStoreRegistry 删除全局注册表键', () => {
    const key = Symbol.for('tallystore.storeRegistry')
    ;(globalThis as Record<symbol, unknown>)[key] = new Map()
    clearStoreRegistry()
    expect((globalThis as Record<symbol, unknown>)[key]).toBeUndefined()
  })
})
