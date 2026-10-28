/**
 * tests/utils/host.ts 的订阅统计助手：
 * 计数准确、uninstall 可组合（不覆盖之后被替换的 subscribe）、可重复包装。
 */
import { trackSubscriptions } from './host.js'

type FakeStore = { subscribe: (...args: unknown[]) => () => void }

function makeFakeStore(): { store: FakeStore; original: jest.Mock; received: Array<unknown> } {
  const received: unknown[] = []
  const original = jest.fn((callback: never) => {
    received.push(callback)
    return () => undefined
  })
  return { store: { subscribe: original as unknown as FakeStore['subscribe'] }, original, received }
}

describe('trackSubscriptions', () => {
  it('统计注册/在册次数，uninstall 还原原始 subscribe', () => {
    const { store, original } = makeFakeStore()
    const stats = trackSubscriptions(store)
    expect(store.subscribe).not.toBe(original)

    const offA = store.subscribe(() => undefined)
    const offB = store.subscribe(() => undefined)
    expect(stats.registered).toBe(2)
    expect(stats.active).toBe(2)

    offA()
    offA() // 幂等：同一退订句柄只减一次
    expect(stats.active).toBe(1)
    offB()
    expect(stats.active).toBe(0)

    stats.uninstall()
    expect(store.subscribe).toBe(original)
  })

  it('uninstall 可组合：之后被别的 wrapper 替换时不覆盖后来者', () => {
    const { store, original } = makeFakeStore()
    const stats = trackSubscriptions(store)
    const later = jest.fn(() => () => undefined) as unknown as FakeStore['subscribe']
    store.subscribe = later

    stats.uninstall()
    expect(store.subscribe).toBe(later)
    expect(store.subscribe).not.toBe(original)
    // 重复 uninstall 幂等
    stats.uninstall()
    expect(store.subscribe).toBe(later)
  })

  it('未 uninstall 前重复调用返回同一个 tracker（不双重包装）', () => {
    const { store } = makeFakeStore()
    const first = trackSubscriptions(store)
    const wrapped = store.subscribe
    expect(trackSubscriptions(store)).toBe(first)
    expect(store.subscribe).toBe(wrapped)
    first.uninstall()
  })
})
