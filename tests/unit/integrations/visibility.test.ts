/**  前后台写入门控（createBackgroundGate）的边界分支 */

import { createBackgroundGate, markHostHidden, visibilityOf, wrapVisibilityLifecycles } from '../../../src/integrations/visibility.js'

afterEach(() => {
  jest.restoreAllMocks()
})

describe('createBackgroundGate · 后台缓存与回前台对齐', () => {
  it('回前台对齐时没有缓存写入：不调用 write', () => {
    const host: Record<string, unknown> = {}
    const write = jest.fn()
    const gate = createBackgroundGate(host, write)
    gate.registerRealign(() => {})
    markHostHidden(host, true)
    markHostHidden(host, false)
    expect(write).not.toHaveBeenCalled()
    gate.dispose()
  })

  it('registerRealign 可重复调用：只登记一个 reveal 回调，以最新实现对齐', () => {
    const host: Record<string, unknown> = {}
    const write = jest.fn()
    const gate = createBackgroundGate(host, write)
    const first = jest.fn()
    const second = jest.fn()
    gate.registerRealign(first)
    gate.registerRealign(second)
    expect(visibilityOf(host).revealCallbacks).toHaveLength(1)
    markHostHidden(host, true)
    markHostHidden(host, false)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    gate.dispose()
    expect(visibilityOf(host).revealCallbacks).toHaveLength(0)
  })

  it('注册时宿主已在后台：立即对齐一次（对齐抛错不阻断注册）', () => {
    const host: Record<string, unknown> = {}
    const write = jest.fn()
    markHostHidden(host, true)
    const gate = createBackgroundGate(host, write)
    const aligned = jest.fn()
    gate.registerRealign(aligned)
    expect(aligned).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()

    const failing = createBackgroundGate(host, write)
    expect(() =>
      failing.registerRealign(() => {
        throw new Error('realign boom')
      }),
    ).not.toThrow()
    markHostHidden(host, false)
    gate.dispose()
    failing.dispose()
  })

  it('后台写入合并为一次，回前台按最新值下发', () => {
    const host: Record<string, unknown> = {}
    const write = jest.fn()
    const gate = createBackgroundGate(host, write)
    gate.registerRealign(() => {})
    markHostHidden(host, true)
    gate.gatedWrite({ count: 1 })
    gate.gatedWrite({ count: 2 })
    expect(write).not.toHaveBeenCalled()
    markHostHidden(host, false)
    expect(write).toHaveBeenCalledWith({ count: 2 })
    gate.dispose()
  })
})

describe('createBackgroundGate · 对齐写入失败', () => {
  it('写入失败时缓存放回 pending、上报，并与失败期间的新缓存按键合并后重试', () => {
    const host: Record<string, unknown> = {}
    const reportError = jest.fn()
    let shouldFail = true
    const gate = createBackgroundGate(
      host,
      (updates) => {
        if (shouldFail) {
          // 失败期间宿主重入后台并写入新缓存：合并语义以新值覆盖旧值
          markHostHidden(host, true)
          gate.gatedWrite({ count: 2, extra: 1 })
          throw new Error('reveal write boom')
        }
        writes.push(updates)
      },
      reportError,
    )
    const writes: Array<Record<string, unknown>> = []
    gate.registerRealign(() => {})
    markHostHidden(host, true)
    gate.gatedWrite({ count: 1 })

    markHostHidden(host, false)
    expect(reportError).toHaveBeenCalledTimes(1)
    expect((reportError.mock.calls[0][0] as Error).message).toBe('reveal write boom')
    expect(writes).toHaveLength(0)

    // pending 已恢复（含失败期间的新值）：下一次 reveal 成功交付合并后的最新值
    shouldFail = false
    markHostHidden(host, false)
    expect(writes).toEqual([{ count: 2, extra: 1 }])
    gate.dispose()
  })
})

describe('可见性状态存储与对齐诊断', () => {
  it('宿主被冻结/不可扩展时不抛错，且不在宿主上挂内部属性', () => {
    const host = Object.freeze({})
    expect(() => markHostHidden(host, true)).not.toThrow()
    expect(visibilityOf(host).hidden).toBe(true)
    markHostHidden(host, false)
    expect(Object.keys(host)).toHaveLength(0)
  })

  it('业务已有 __tallyVisibility 同名属性不被覆盖', () => {
    const host: Record<string, unknown> = { __tallyVisibility: 'business-value' }
    markHostHidden(host, true)
    expect(host.__tallyVisibility).toBe('business-value')
    markHostHidden(host, false)
  })

  it('realign 抛错经 reportError 上报，且不阻断其他绑定的对齐', () => {
    const host: Record<string, unknown> = {}
    const reportError = jest.fn()
    const gate = createBackgroundGate(host, jest.fn(), reportError)
    gate.registerRealign(() => {
      throw new Error('realign boom')
    })
    markHostHidden(host, true)
    expect(() => markHostHidden(host, false)).not.toThrow()
    expect(reportError).toHaveBeenCalledTimes(1)
    expect((reportError.mock.calls[0][0] as Error).message).toBe('realign boom')
    gate.dispose()
  })

  it('对齐期间再次进入后台：缓存不下发，等下一次 reveal', () => {
    const host: Record<string, unknown> = {}
    const write = jest.fn()
    const gate = createBackgroundGate(host, write)
    let hideOnce = true
    gate.registerRealign(() => {
      if (hideOnce) {
        hideOnce = false
        // realign 内同步触发 hide：本轮对齐写回的缓存必须留在门控内
        markHostHidden(host, true)
      }
    })
    markHostHidden(host, true)
    gate.gatedWrite({ count: 1 })

    markHostHidden(host, false)
    expect(write).not.toHaveBeenCalled()

    markHostHidden(host, false)
    expect(write).toHaveBeenCalledWith({ count: 1 })
    gate.dispose()
  })

  it('gatedWrite 只做按键覆盖的契约：未出现的键不会产生删除（ 有意取舍）', () => {
    const host: Record<string, unknown> = {}
    const write = jest.fn()
    const gate = createBackgroundGate(host, write)
    gate.registerRealign(() => {})
    markHostHidden(host, true)
    gate.gatedWrite({ a: 1, b: 2 })
    gate.gatedWrite({ a: 3 })
    markHostHidden(host, false)
    // 完整快照契约下重复键取最新值；未出现的 b 保留（门控无删除语义）
    expect(write).toHaveBeenCalledWith({ a: 3, b: 2 })
    gate.dispose()
  })
})

describe('createBackgroundGate · 可见写入不得丢弃回前台失败的保留批', () => {
  it('reveal 写入失败后发生「脏键子集」可见写入：保留批按键合并后交付，不丢未出现的键', () => {
    const host: Record<string, unknown> = {}
    const writes: Array<Record<string, unknown>> = []
    let shouldFail = true
    const gate = createBackgroundGate(
      host,
      (updates) => {
        if (shouldFail) throw new Error('reveal write boom')
        writes.push({ ...updates })
      },
      () => {},
    )
    gate.registerRealign(() => {})
    markHostHidden(host, true)
    gate.gatedWrite({ count: 1, label: 'a' })
    markHostHidden(host, false) // reveal 写入失败：整批放回 pending
    expect(writes).toHaveLength(0)

    shouldFail = false
    // 下一次可见写入只带脏键子集（createMapper 只发变化键）：保留批必须按键 overlay 合并
    gate.gatedWrite({ count: 2 })
    expect(writes).toEqual([{ count: 2, label: 'a' }])
    gate.dispose()
  })
})

describe('createBackgroundGate · 可见写入失败期间的重入缓存不得丢弃', () => {
  it('可见分支写入失败时把失败期间的新缓存按键合并回保留批（与 onReveal 同口径）', () => {
    const host: Record<string, unknown> = {}
    const writes: Array<Record<string, unknown>> = []
    let revealFails = true
    let visibleFails = true
    const gate = createBackgroundGate(
      host,
      (updates) => {
        if (revealFails) throw new Error('reveal write boom')
        if (visibleFails) {
          // 失败期间宿主进入后台并重入写入：gatedWrite 会缓存到一个新的 pendingBackground 对象
          markHostHidden(host, true)
          gate.gatedWrite({ count: 5, extra: 7 })
          throw new Error('visible write boom')
        }
        writes.push({ ...updates })
      },
      () => {},
    )
    gate.registerRealign(() => {})
    markHostHidden(host, true)
    gate.gatedWrite({ count: 1, label: 'a' })
    markHostHidden(host, false) // reveal 失败 → pending = { count: 1, label: 'a' }
    expect(writes).toHaveLength(0)

    revealFails = false
    // 可见写入走保留批路径；写入失败时期间重入的新缓存不能被整体赋值丢弃
    expect(() => gate.gatedWrite({ count: 2 })).toThrow('visible write boom')

    visibleFails = false
    markHostHidden(host, false) // 下一次 reveal 交付「保留批 + 失败期间新缓存」的合并结果
    expect(writes).toEqual([{ count: 5, label: 'a', extra: 7 }])
    gate.dispose()
  })
})

describe('wrapVisibilityLifecycles：三入口共用的顺序语义', () => {
  it('hide 先跑用户回调再切后台；show 先切可见再跑用户回调', () => {
    const host: Record<string, unknown> = {}
    const order: string[] = []
    const config: Record<string, unknown> = {
      onHide(this: unknown) {
        order.push('hide-hidden=' + String(visibilityOf(this as object).hidden))
      },
      onShow(this: unknown) {
        order.push('show-hidden=' + String(visibilityOf(this as object).hidden))
      },
    }
    wrapVisibilityLifecycles(config, 'onHide', 'onShow')
    ;(config.onHide as () => void).call(host)
    expect(visibilityOf(host).hidden).toBe(true)
    ;(config.onShow as () => void).call(host)
    expect(visibilityOf(host).hidden).toBe(false)
    expect(order).toEqual(['hide-hidden=false', 'show-hidden=false'])
  })

  it('没有用户回调时同样驱动标志（可选生命周期）', () => {
    const host: Record<string, unknown> = {}
    const config: Record<string, unknown> = {}
    wrapVisibilityLifecycles(config, 'onHide', 'onShow')
    ;(config.onHide as () => void).call(host)
    expect(visibilityOf(host).hidden).toBe(true)
    ;(config.onShow as () => void).call(host)
    expect(visibilityOf(host).hidden).toBe(false)
  })
})
