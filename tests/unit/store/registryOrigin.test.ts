/**  captureOrigin 的「无调用栈」环境兜底：受限宿主取不到 stack 时仍能定位冲突 */

import { createStore, TallyStoreError } from '../../../src/index.js'

afterEach(() => {
  jest.restoreAllMocks()
})

describe(' 创建现场捕获兜底', () => {
  it('Error.stack 缺失时来源记为 (unknown origin)，重名冲突信息仍可用', () => {
    const OriginalError = globalThis.Error
    class NoStackError extends OriginalError {
      constructor(message?: string) {
        super(message)
        Object.defineProperty(this, 'stack', { value: undefined, writable: true, configurable: true })
      }
    }
    let caught: unknown
    let first: { destroy(): void } | undefined
    try {
      ;(globalThis as { Error: ErrorConstructor }).Error = NoStackError as unknown as ErrorConstructor
      first = createStore({ name: 'origin-fallback', state: () => ({ a: 1 }) })
      try {
        createStore({ name: 'origin-fallback', state: () => ({ b: 2 }) })
      } catch (error) {
        caught = error
      }
    } finally {
      ;(globalThis as { Error: ErrorConstructor }).Error = OriginalError
    }
    first?.destroy()
    expect(caught).toBeInstanceOf(TallyStoreError)
    const conflict = caught as TallyStoreError
    expect(conflict.code).toBe('INVALID_CONFIG')
    expect(conflict.message).toContain('(unknown origin)')
    expect(conflict.message.match(/创建于/g)).toHaveLength(2)
  })
})
