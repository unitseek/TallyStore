import { StoreNotifier } from '../../../src/core/store/StoreNotifier.js'

// 断言失败也要还原 console/间谍，避免跨用例污染
afterEach(() => {
  jest.restoreAllMocks()
})

type AnyNotifier = Record<string, any>

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

interface MakeOptions {
  state?: Record<string, unknown>
  ttl?: number
  maxSubscribers?: number
  onLimit?: 'evict-oldest' | 'throw'
  notifyClone?: boolean
  notifyAsync?: boolean
  notifyOnlyOnChange?: boolean
  buildPayload?: (needsClone: boolean) => Record<string, unknown>
  onListenerError?: (error: unknown) => void
  onSubscriberEvicted?: (info: { listener: (...args: never[]) => void; maxSubscribers: number; size: number }) => void
  onAsyncNotifyError?: (error: unknown) => void
}

function makeNotifier(options: MakeOptions = {}) {
  const state = options.state ?? { value: 0 }
  const buildPayload = options.buildPayload ?? jest.fn((needsClone: boolean) => (needsClone ? { ...state } : state))
  const notifier = new StoreNotifier<Record<string, unknown>>({
    storeName: 'notifier-test',
    maxSubscribers: options.maxSubscribers,
    onLimit: options.onLimit,
    notifyClone: options.notifyClone ?? false,
    notifyAsync: options.notifyAsync ?? false,
    notifyOnlyOnChange: options.notifyOnlyOnChange ?? false,
    buildPayload,
    onListenerError: options.onListenerError,
    onSubscriberEvicted: options.onSubscriberEvicted,
    onAsyncNotifyError: options.onAsyncNotifyError,
  })
  return { notifier: notifier as unknown as AnyNotifier, buildPayload, state }
}

describe('StoreNotifier 订阅注册', () => {
  it('注册后 size 计次，可写/只读计数分别维护', () => {
    const { notifier } = makeNotifier()
    expect(notifier.size).toBe(0)
    expect(notifier.hasWritableListeners()).toBe(false)
    const off1 = notifier.subscribe(jest.fn(), { readOnly: true })
    expect(notifier.size).toBe(1)
    expect(notifier.hasWritableListeners()).toBe(false)
    const off2 = notifier.subscribe(jest.fn())
    expect(notifier.size).toBe(2)
    expect(notifier.hasWritableListeners()).toBe(true)
    off1()
    off2()
    expect(notifier.size).toBe(0)
    expect(notifier.hasWritableListeners()).toBe(false)
  })

  it('同一 listener 注册两次通知两次，退订一次只减一', () => {
    const { notifier } = makeNotifier()
    const listener = jest.fn()
    const off1 = notifier.subscribe(listener)
    const off2 = notifier.subscribe(listener)
    notifier.notifyNow()
    expect(listener).toHaveBeenCalledTimes(2)
    off1()
    expect(notifier.size).toBe(1)
    notifier.notifyNow()
    expect(listener).toHaveBeenCalledTimes(3)
    off2()
    expect(notifier.size).toBe(0)
  })

  it('退订函数幂等，重复调用不重复扣减', () => {
    const { notifier } = makeNotifier()
    const off = notifier.subscribe(jest.fn())
    off()
    off()
    expect(notifier.size).toBe(0)
  })

  it('delete 未知 listener 或错误 registration 返回 false', () => {
    const { notifier } = makeNotifier()
    expect(notifier.delete(jest.fn())).toBe(false)
    const listener = jest.fn()
    notifier.subscribe(listener)
    expect(notifier.delete(listener, {})).toBe(false)
    expect(notifier.delete(listener)).toBe(true)
    expect(notifier.delete(listener)).toBe(false)
  })

  it('destroy 后 subscribe 抛错（销毁守卫）', () => {
    const { notifier } = makeNotifier()
    notifier.destroy()
    expect(() => notifier.subscribe(jest.fn())).toThrow('Cannot call subscribe on a destroyed Store')
  })
})

describe('StoreNotifier 订阅上限', () => {
  it('maxSubscribers 非有限值回退默认值并开发期告警', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { notifier } = makeNotifier({ maxSubscribers: Number.NaN })
    expect(notifier._maxSubscribers).toBe(50)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('未提供驱逐上报器时驱逐静默完成', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { notifier } = makeNotifier({ maxSubscribers: 1 })
    notifier.subscribe(jest.fn())
    expect(() => notifier.subscribe(jest.fn())).not.toThrow()
    expect(notifier.size).toBe(1)
    expect(warn).toHaveBeenCalled()
  })

  it('maxSubscribers 小数向下取整：2.5 实际放行 2 份注册', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { notifier } = makeNotifier({ maxSubscribers: 2.5 })
    notifier.subscribe(jest.fn())
    notifier.subscribe(jest.fn())
    expect(notifier.size).toBe(2)
    expect(notifier._maxSubscribers).toBe(2)
    notifier.subscribe(jest.fn())
    expect(notifier.size).toBe(2)
    expect(warn).toHaveBeenCalled()
  })

  it('onLimit=throw 达到上限时抛错', () => {
    const { notifier } = makeNotifier({ maxSubscribers: 1, onLimit: 'throw' })
    notifier.subscribe(jest.fn())
    expect(() => notifier.subscribe(jest.fn())).toThrow('Subscriber limit reached (1)')
    expect(notifier.size).toBe(1)
  })

  it('evict-oldest 驱逐最早注册并上报驱逐信息', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const onSubscriberEvicted = jest.fn()
    const { notifier } = makeNotifier({ maxSubscribers: 1, onSubscriberEvicted })
    const oldest = jest.fn()
    const next = jest.fn()
    notifier.subscribe(oldest)
    notifier.subscribe(next)
    expect(notifier.size).toBe(1)
    expect(onSubscriberEvicted).toHaveBeenCalledWith(expect.objectContaining({ listener: oldest, maxSubscribers: 1, size: 0 }))
    notifier.notifyNow()
    expect(oldest).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('已驱逐最早的监听器 ' + (oldest.name || '(匿名函数)'))
  })

  it('重复订阅触发上限时驱逐该 listener 自己最早的一份注册', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const onSubscriberEvicted = jest.fn()
    const { notifier } = makeNotifier({ maxSubscribers: 2, onSubscriberEvicted })
    const listener = jest.fn()
    notifier.subscribe(listener)
    notifier.subscribe(jest.fn())
    notifier.subscribe(listener)
    expect(notifier.size).toBe(2)
    expect(onSubscriberEvicted).toHaveBeenCalledTimes(1)
    expect(onSubscriberEvicted.mock.calls[0][0].listener).toBe(listener)
    expect(warn.mock.calls[0][0]).toContain('重复订阅改由该监听器自己最早的一份注册让位')
  })

  it('驱逐上报器抛错时开发期记录且不反噬注册', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const { notifier } = makeNotifier({
      maxSubscribers: 1,
      onSubscriberEvicted: () => {
        throw new Error('reporter failed')
      },
    })
    notifier.subscribe(jest.fn())
    expect(() => notifier.subscribe(jest.fn())).not.toThrow()
    expect(notifier.size).toBe(1)
    expect(error).toHaveBeenCalledWith('[TallyStore] Error in subscriber eviction reporter:', expect.any(Error))
    warn.mockRestore()
    error.mockRestore()
  })

  it('maxSubscribers<=0 时有效上限收敛为 1：首个订阅正常，之后按驱逐策略处理', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const onSubscriberEvicted = jest.fn()
    const { notifier } = makeNotifier({ maxSubscribers: 0, onSubscriberEvicted })
    expect(() => notifier.subscribe(jest.fn())).not.toThrow()
    expect(notifier.size).toBe(1)
    expect(onSubscriberEvicted).not.toHaveBeenCalled()
    notifier.subscribe(jest.fn())
    expect(notifier.size).toBe(1)
    expect(onSubscriberEvicted).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('订阅者数量已达到上限(1)')
    warn.mockRestore()
  })

  it('maxSubscribers 为 Infinity 同样回退默认值', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { notifier } = makeNotifier({ maxSubscribers: Number.POSITIVE_INFINITY })
    expect(notifier._maxSubscribers).toBe(50)
    warn.mockRestore()
  })
})

describe('StoreNotifier 通知与载荷', () => {
  it('无监听器时通知直接返回，不抛错', () => {
    const { notifier, buildPayload } = makeNotifier()
    expect(() => notifier.notifyNow()).not.toThrow()
    expect(buildPayload).toHaveBeenCalledWith(false)
  })

  it('destroy 后 notifyNow 不构建载荷、不回调', () => {
    const { notifier, buildPayload } = makeNotifier()
    const listener = jest.fn()
    notifier.subscribe(listener)
    notifier.destroy()
    notifier.notifyNow()
    expect(listener).not.toHaveBeenCalled()
    expect(buildPayload).not.toHaveBeenCalled()
  })

  it('needsClone 依据 notify.clone 与可写订阅者计算', () => {
    const { notifier, buildPayload } = makeNotifier()
    notifier.subscribe(jest.fn(), { readOnly: true })
    notifier.notifyNow()
    expect(buildPayload).toHaveBeenLastCalledWith(false)
    notifier.subscribe(jest.fn())
    notifier.notifyNow()
    expect(buildPayload).toHaveBeenLastCalledWith(true)
  })

  it('notify.clone=true 时全只读订阅者也拿隔离副本', () => {
    const state = { n: 0 }
    const buildPayload = jest.fn((needsClone: boolean) => (needsClone ? { n: state.n } : state))
    const { notifier } = makeNotifier({ notifyClone: true, state, buildPayload })
    const seen: Array<Record<string, unknown>> = []
    notifier.subscribe((payload: Record<string, unknown>) => seen.push(payload), { readOnly: true })
    notifier.notifyNow()
    expect(buildPayload).toHaveBeenLastCalledWith(true)
    expect(seen[0]).not.toBe(state)
    expect(seen[0].n).toBe(0)
  })

  it('可写订阅者各拿独立深拷贝，只读订阅共享只读副本', () => {
    const state = { n: 0 }
    const { notifier } = makeNotifier({ state, buildPayload: (needsClone: boolean) => (needsClone ? { n: state.n } : state) })
    const readOnlySeen: Array<{ n: number }> = []
    const writableSeen: Array<{ n: number }> = []
    notifier.subscribe(
      (payload: { n: number }) => {
        readOnlySeen.push(payload)
      },
      { readOnly: true },
    )
    notifier.subscribe((payload: { n: number }) => {
      writableSeen.push(payload)
      payload.n = 99
    })
    notifier.notifyNow()
    expect(readOnlySeen[0]).not.toBe(state)
    expect(readOnlySeen[0].n).toBe(0)
    expect(writableSeen[0]).not.toBe(state)
    expect(state.n).toBe(0)
  })

  it('单个监听器抛错不中断其余监听器，并交 onListenerError', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const onListenerError = jest.fn()
    const { notifier } = makeNotifier({ onListenerError })
    const boom = new Error('listener boom')
    const second = jest.fn()
    notifier.subscribe(() => {
      throw boom
    })
    notifier.subscribe(second)
    notifier.notifyNow()
    expect(onListenerError).toHaveBeenCalledWith(boom)
    expect(second).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith('[TallyStore] Error in state listener:', boom)
    error.mockRestore()
  })

  it('未提供 onListenerError 时监听器异常仅开发期打印', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const { notifier } = makeNotifier()
    notifier.subscribe(() => {
      throw new Error('lonely listener boom')
    })
    expect(() => notifier.notifyNow()).not.toThrow()
    expect(error).toHaveBeenCalledWith('[TallyStore] Error in state listener:', expect.any(Error))
  })

  it('onListenerError 自身抛错不反噬通知', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const { notifier } = makeNotifier({
      onListenerError: () => {
        throw new Error('reporter boom')
      },
    })
    const second = jest.fn()
    notifier.subscribe(() => {
      throw new Error('listener boom')
    })
    notifier.subscribe(second)
    expect(() => notifier.notifyNow()).not.toThrow()
    expect(second).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith('[TallyStore] Error in listener error reporter:', expect.any(Error))
    error.mockRestore()
  })

  it('本轮通知使用进入时快照：回调内退订不影响本轮已展开的注册', () => {
    const { notifier } = makeNotifier()
    const calls: string[] = []
    let offB: () => void = () => undefined
    notifier.subscribe(() => {
      calls.push('a')
      offB()
    })
    offB = notifier.subscribe(() => calls.push('b'))
    notifier.notifyNow()
    expect(calls).toEqual(['a', 'b'])
  })

  it('通知后脏键清空，lastNotifiedMutationCount 跟上变更计数', () => {
    const { notifier } = makeNotifier()
    expect(notifier.mutationCount).toBe(0)
    expect(notifier.bumpMutation()).toBe(1)
    notifier.markDirty(['a'])
    expect(notifier.isDirty('a')).toBe(true)
    notifier.notifyNow()
    expect(notifier.isDirty('a')).toBe(false)
    expect(notifier.lastNotifiedMutationCount).toBe(1)
  })

  it('数字键与字符串键归一到同一脏键', () => {
    const { notifier } = makeNotifier()
    notifier.markDirty([0])
    expect(notifier.isDirty('0')).toBe(true)
    expect(notifier.isDirty(0 as unknown as string)).toBe(true)
    notifier.notifyNow()
    expect(notifier.isDirty('0')).toBe(false)
  })
})

describe('StoreNotifier 重入与脏键轮转', () => {
  it('通知期间重入写入的脏键提升到下一轮，不被本轮清空', () => {
    const { notifier } = makeNotifier()
    const observed: boolean[] = []
    let nested = false
    notifier.subscribe(() => {
      observed.push(notifier.isDirty('b'))
      if (!nested) {
        nested = true
        notifier.bumpMutation()
        notifier.markDirty(['b'])
        notifier.notifyNow()
      }
    })
    notifier.bumpMutation()
    notifier.markDirty(['a'])
    notifier.notifyNow()
    expect(observed).toEqual([false, true])
    expect(notifier.isDirty('a')).toBe(false)
    expect(notifier.isDirty('b')).toBe(false)
  })

  it('batch 基线：onlyOnChange 下无变更不通知', () => {
    const { notifier } = makeNotifier({ notifyOnlyOnChange: true })
    notifier.noteBatchBaseline()
    expect(notifier.shouldNotifyAfterBatch()).toBe(false)
    notifier.bumpMutation()
    expect(notifier.shouldNotifyAfterBatch()).toBe(true)
  })

  it('batch 基线：默认模式始终通知', () => {
    const { notifier } = makeNotifier()
    notifier.noteBatchBaseline()
    expect(notifier.shouldNotifyAfterBatch()).toBe(true)
  })
})

describe('StoreNotifier 异步合并通知', () => {
  it('requestNotify 同步模式立即通知', () => {
    const { notifier } = makeNotifier()
    const listener = jest.fn()
    notifier.subscribe(listener)
    notifier.requestNotify()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('异步模式同一 tick 内多次请求合并为一次', async () => {
    const { notifier } = makeNotifier({ notifyAsync: true })
    const listener = jest.fn()
    notifier.subscribe(listener)
    notifier.requestNotify()
    notifier.requestNotify()
    notifier.requestNotify()
    expect(listener).not.toHaveBeenCalled()
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('异步待发期间 destroy 后不再通知', async () => {
    const { notifier } = makeNotifier({ notifyAsync: true })
    const listener = jest.fn()
    notifier.subscribe(listener)
    notifier.requestNotify()
    notifier.destroy()
    await flush()
    expect(listener).not.toHaveBeenCalled()
  })

  it('异步通知链路抛错交 onAsyncNotifyError', async () => {
    const onAsyncNotifyError = jest.fn()
    const { notifier } = makeNotifier({
      notifyAsync: true,
      onAsyncNotifyError,
      buildPayload: () => {
        throw new Error('payload boom')
      },
    })
    notifier.subscribe(jest.fn())
    notifier.requestNotify()
    await flush()
    expect(onAsyncNotifyError).toHaveBeenCalledWith(expect.objectContaining({ message: 'payload boom' }))
  })

  it('异步通知链路抛错且无上报器时记录 console.error，不外溢', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { notifier } = makeNotifier({
        notifyAsync: true,
        buildPayload: () => {
          throw new Error('payload boom')
        },
      })
      notifier.subscribe(jest.fn())
      notifier.requestNotify()
      await expect(flush()).resolves.toBeUndefined()
      expect(consoleError).toHaveBeenCalledWith('[TallyStore] Error in async notify:', expect.any(Error))
    } finally {
      consoleError.mockRestore()
    }
  })

  it('异步通知上报器自身抛错时降级 console.error，不产生未处理拒绝', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { notifier } = makeNotifier({
        notifyAsync: true,
        onAsyncNotifyError: () => {
          throw new Error('reporter boom')
        },
        buildPayload: () => {
          throw new Error('payload boom')
        },
      })
      notifier.subscribe(jest.fn())
      notifier.requestNotify()
      await expect(flush()).resolves.toBeUndefined()
      expect(consoleError).toHaveBeenCalledWith('[TallyStore] Error in async notify error reporter:', expect.any(Error))
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('StoreNotifier 生产模式分支', () => {
  it('生产模式：上限回退/驱逐/监听器抛错均静默，只走上报通道', async () => {
    const env = process.env.NODE_ENV
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const mod = await import('../../../src/core/store/StoreNotifier.js')
      const onListenerError = jest.fn()
      const onSubscriberEvicted = jest.fn()
      const notifier = new mod.StoreNotifier<Record<string, unknown>>({
        storeName: 'prod',
        maxSubscribers: Number.NaN,
        onListenerError,
        onSubscriberEvicted,
        buildPayload: (needsClone: boolean) => (needsClone ? { value: 0 } : { value: 0 }),
        notifyClone: false,
        notifyAsync: false,
        notifyOnlyOnChange: false,
        onLimit: 'evict-oldest',
      })
      notifier.subscribe(() => {
        throw new Error('boom')
      })
      notifier.notifyNow()
      expect(onListenerError).toHaveBeenCalledTimes(1)
      expect(warn).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()

      const limited = new mod.StoreNotifier<Record<string, unknown>>({
        storeName: 'prod2',
        maxSubscribers: 1,
        onSubscriberEvicted: () => {
          throw new Error('prod reporter')
        },
        buildPayload: () => ({}),
        notifyClone: false,
        notifyAsync: false,
        notifyOnlyOnChange: false,
      })
      limited.subscribe(jest.fn())
      limited.subscribe(jest.fn())
      ;(limited as Record<string, any>)._dispatch({}, false)

      // 监听器与上报器同时抛错：生产期只上交，不打印
      const reporterThrows = new mod.StoreNotifier<Record<string, unknown>>({
        storeName: 'prod3',
        buildPayload: () => ({}),
        notifyClone: false,
        notifyAsync: false,
        notifyOnlyOnChange: false,
        onListenerError: () => {
          throw new Error('prod reporter')
        },
      })
      reporterThrows.subscribe(() => {
        throw new Error('prod listener')
      })
      expect(() => reporterThrows.notifyNow()).not.toThrow()
      expect(error).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      process.env.NODE_ENV = env
      jest.resetModules()
      warn.mockRestore()
      error.mockRestore()
    }
  })
})
