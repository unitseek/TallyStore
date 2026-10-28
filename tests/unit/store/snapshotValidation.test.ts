/** 状态快照——体积上限、来源标记、非法快照丢弃上报 */
import { createStore, TallyStoreError } from '../../../src/index.js'

const MARK = Symbol.for('tallystore.snapshotMark')

afterEach(() => {
  jest.restoreAllMocks()
})

describe(' $snapshot 体积上限', () => {
  it('状态超过默认上限 1MB 时拒绝并附估算大小与建议', () => {
    const store = createStore({ name: 'fr06-big', state: () => ({ blob: 'x'.repeat(1024 * 1024 + 512) }) })
    try {
      store.$snapshot()
      throw new Error('should throw')
    } catch (error) {
      expect(error).toBeInstanceOf(TallyStoreError)
      const e = error as TallyStoreError
      expect(e.code).toBe('INVALID_CONFIG')
      expect(e.message).toContain('超过上限')
      expect(e.message).toContain('持久化')
    }
    // 状态本身不受影响
    expect((store.getState() as { blob: string }).blob.length).toBeGreaterThan(1024 * 1024)
    store.destroy()
  })

  it('自定义 maxBytes 生效：超限拒绝、限内正常（上限 = min(配置, 状态体积×2)）', () => {
    const store = createStore({ name: 'fr06-cap', state: () => ({ blob: 'x'.repeat(4096) }), snapshot: { maxBytes: 2048 } })
    expect(() => store.$snapshot()).toThrow(/超过上限/)
    store.destroy()

    const ok = createStore({ name: 'fr06-ok', state: () => ({ blob: 'x'.repeat(1024) }), snapshot: { maxBytes: 8192 } })
    const snap = ok.$snapshot() as { blob: string }
    expect(snap.blob).toBe('x'.repeat(1024))
    ok.destroy()
  })

  it('不可序列化状态（含 BigInt）不设限，保持既有行为（构造后经 setState 注入）', () => {
    //  起构造期 state 校验会拒绝 BigInt，故经 setState 注入后验证 $snapshot 的「不可序列化不设限」口径
    const store = createStore({ name: 'fr06-bigint', state: () => ({ big: 0 as unknown }) })
    store.setState('big', 1n as never)
    expect(() => store.$snapshot()).not.toThrow()
    store.destroy()
  })
})

describe(' 快照来源标记', () => {
  it('$snapshot 产出带 Symbol.for 标记的快照；标记不进 JSON 与 Object.keys', () => {
    const store = createStore({ name: 'fr06-mark', state: () => ({ count: 1 }) })
    const snap = store.$snapshot() as Record<symbol, unknown> & { count: number }
    expect(snap[MARK]).toBe(1)
    expect(Object.keys(snap)).toEqual(['count'])
    expect(JSON.stringify(snap)).toBe('{"count":1}')
    // 快照与活状态隔离
    store.setState('count', 2)
    expect(snap.count).toBe(1)
    store.destroy()
  })

  it('带标记的快照 $restore 不告警', () => {
    const store = createStore({ name: 'fr06-clean', state: () => ({ count: 1 }) })
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const snap = store.$snapshot()
    store.setState('count', 9)
    store.$restore(snap)
    expect(store.getState().count).toBe(1)
    expect(onError).not.toHaveBeenCalled()
    store.destroy()
  })

  it('$restore 剥离来源标记：活状态与通知期脏键都不含 SNAPSHOT_MARK，快照本身不变', () => {
    const store = createStore({ name: 'fr06-strip', state: () => ({ count: 1, nested: { v: 1 } }) })
    let dirtyMarkDuringNotify = false
    store.subscribe(() => {
      dirtyMarkDuringNotify = store.isStateKeyDirty(MARK)
    })
    const snap = store.$snapshot()
    store.setState('count', 9)
    dirtyMarkDuringNotify = false
    store.$restore(snap)
    const live = store.getState() as Record<symbol, unknown>
    expect(live[MARK]).toBeUndefined()
    expect(Object.getOwnPropertySymbols(live)).not.toContain(MARK)
    expect(dirtyMarkDuringNotify).toBe(false)
    // 快照对象本身保持原样：仍带标记、仍冻结
    expect((snap as Record<symbol, unknown>)[MARK]).toBe(1)
    expect(Object.isFrozen(snap)).toBe(true)
    store.destroy()
  })

  it('外部构造的无标记快照：开发期 warn + onError(restore) 上报，仍照常恢复', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = createStore({ name: 'fr06-foreign', state: () => ({ count: 1 }) })
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    store.$restore({ count: 5 } as never)
    expect(store.getState().count).toBe(5)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('无来源标记'))
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as TallyStoreError).code).toBe('INVALID_CONFIG')
    expect(onError.mock.calls[0][1]).toBe('restore')
    store.destroy()
  })
})

describe(' 全量审查回归：null 原型状态的自快照恢复', () => {
  it('Object.create(null) 初始状态的快照可以 $restore 回自己，且不触发校验告警', () => {
    const initial = Object.create(null) as { count: number }
    initial.count = 3
    const store = createStore({ name: 'fr06-nullproto', state: () => initial })
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const snap = store.$snapshot()
    store.setState('count', 99)
    expect(() => store.$restore(snap)).not.toThrow()
    expect(store.getState().count).toBe(3)
    expect(onError).not.toHaveBeenCalled()
    store.destroy()
  })
})

describe(' $restore 非法快照丢弃', () => {
  it.each([
    ['null', null],
    ['array', [1, 2]],
    ['原始值', 42],
  ])('%s 快照：状态不变 + onError(restore) 上报 + TypeError', (_label, bad) => {
    const store = createStore({ name: 'fr06-bad', state: () => ({ count: 1 }) })
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    expect(() => store.$restore(bad as never)).toThrow(TypeError)
    expect(store.getState().count).toBe(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as TallyStoreError).code).toBe('INVALID_CONFIG')
    expect(onError.mock.calls[0][1]).toBe('restore')
    store.destroy()
  })
})
