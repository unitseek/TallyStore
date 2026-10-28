import { HookSystem } from '../../../src/core/hooks/HookSystem.js'
import { createStore } from '../../../src/index.js'
import type { IHookSystem } from '../../../src/types/plugin.js'

describe('HookSystem · 注册与触发', () => {
  it('on 返回退订句柄，emit 按注册顺序调用并透传实参', () => {
    const hooks = new HookSystem()
    const calls: unknown[][] = []
    hooks.on('beforeSetState', (...args) => calls.push(['first', ...args]))
    hooks.on('beforeSetState', (...args) => calls.push(['second', ...args]))

    hooks.emit('beforeSetState', 'count', 1)
    expect(calls).toEqual([
      ['first', 'count', 1],
      ['second', 'count', 1],
    ])
  })

  it('退订幂等，且只移除自己那次注册', () => {
    const hooks = new HookSystem()
    const handler = jest.fn()
    const offFirst = hooks.on('afterSetState', handler)
    hooks.on('afterSetState', handler)

    offFirst()
    offFirst()
    hooks.emit('afterSetState', 'a', 1)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(hooks.listenerCount('afterSetState')).toBe(1)
  })

  it('clear 清空指定钩子或全部钩子', () => {
    const hooks = new HookSystem()
    const before = jest.fn()
    const after = jest.fn()
    hooks.on('beforePatch', before)
    hooks.on('afterPatch', after)

    hooks.clear('beforePatch')
    hooks.emit('beforePatch', {})
    expect(before).not.toHaveBeenCalled()
    expect(hooks.listenerCount('beforePatch')).toBe(0)
    expect(hooks.size('afterPatch')).toBe(1)

    hooks.clear()
    hooks.emit('afterPatch', {})
    expect(after).not.toHaveBeenCalled()
    expect(hooks.size()).toBe(0)
  })

  it('clear 后旧退订句柄是 no-op，不会误删重新注册的新记录', () => {
    const hooks = new HookSystem()
    const handler = jest.fn()
    const staleOff = hooks.on('beforeDispatch', handler)
    hooks.clear('beforeDispatch')
    // 钩子表里已无该条目：旧句柄必须直接 no-op
    staleOff()

    hooks.on('beforeDispatch', handler)
    staleOff()
    hooks.emit('beforeDispatch', 'inc', [])
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('退订最后一个处理器后钩子条目被移除', () => {
    const hooks = new HookSystem()
    const off = hooks.on('afterDispatch', jest.fn())
    expect(hooks.size()).toBe(1)
    off()
    expect(hooks.size()).toBe(0)
    expect(hooks.size('afterDispatch')).toBe(0)
    // 移除后重新注册仍能正常触发（旧句柄已 consumed）
    off()
    const again = jest.fn()
    hooks.on('afterDispatch', again)
    hooks.emit('afterDispatch', 'inc', [], 1)
    expect(again).toHaveBeenCalledTimes(1)
  })

  it('emit 无监听器时是 no-op；size/listenerCount 未注册返回 0', () => {
    const hooks = new HookSystem()
    expect(() => hooks.emit('onError', new Error('x'))).not.toThrow()
    expect(hooks.size()).toBe(0)
    expect(hooks.size('onError')).toBe(0)
    expect(hooks.listenerCount('onError')).toBe(0)
  })

  it('emit 使用快照：本轮新增的 handler 不在本轮调用，本轮移除的仍收到最后一次', () => {
    const hooks = new HookSystem()
    const calls: string[] = []
    const late = jest.fn()
    const offSecond = hooks.on('beforeReplaceState', () => {
      calls.push('first')
      hooks.on('beforeReplaceState', late)
      offSecond()
    })
    hooks.on('beforeReplaceState', () => calls.push('second'))

    hooks.emit('beforeReplaceState', {})
    expect(calls).toEqual(['first', 'second'])
    expect(late).not.toHaveBeenCalled()
  })
})

describe('HookSystem · 异常隔离与 onError 转投', () => {
  it('处理器抛错不中断其余处理器，并在开发期打印来源', () => {
    const hooks = new HookSystem()
    const second = jest.fn()
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    hooks.on('afterPatch', () => {
      throw new Error('boom')
    })
    hooks.on('afterPatch', second)

    expect(() => hooks.emit('afterPatch', {})).not.toThrow()
    expect(second).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith('[TallyStore] Error in hook afterPatch:', expect.any(Error))
    errorSpy.mockRestore()
  })

  it('处理器抛错会转投 onError，第二参为来源钩子名', () => {
    const hooks = new HookSystem()
    const onError = jest.fn()
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    hooks.on('onError', onError)
    hooks.on('beforePatch', () => {
      throw new Error('patch failed')
    })

    hooks.emit('beforePatch', {})
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as Error).message).toBe('patch failed')
    expect(onError.mock.calls[0][1]).toBe('beforePatch')
    errorSpy.mockRestore()
  })

  it('onError 处理器自身抛错时不再递归（直接递归守卫）', () => {
    const hooks = new HookSystem()
    let calls = 0
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    hooks.on('onError', () => {
      calls += 1
      throw new Error('onError self')
    })
    hooks.on('beforeSetState', () => {
      throw new Error('source')
    })

    expect(() => hooks.emit('beforeSetState', 'k', 1)).not.toThrow()
    expect(calls).toBe(1)
    // 两次开发期日志：来源钩子 + onError 自身
    expect(errorSpy).toHaveBeenCalledTimes(2)
    errorSpy.mockRestore()
  })

  it('onError 处理器触发的其他钩子再抛错时不重复转投（间接递归守卫）', () => {
    const hooks = new HookSystem()
    let calls = 0
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    hooks.on('onError', () => {
      calls += 1
      hooks.emit('beforePatch', {})
    })
    hooks.on('beforePatch', () => {
      throw new Error('indirect')
    })
    hooks.on('beforeSetState', () => {
      throw new Error('source')
    })

    hooks.emit('beforeSetState', 'k', 1)
    expect(calls).toBe(1)
    errorSpy.mockRestore()
  })
})

describe('HookSystem · 泛型签名', () => {
  it('类满足 IHookSystem 契约，emit/on 的实参由 HookArgsMap 校验（编译期）', () => {
    const hooks = new HookSystem()
    const asInterface: IHookSystem = hooks
    const received: unknown[][] = []
    const off = asInterface.on('afterDispatch', (actionName, args, result) => {
      received.push([actionName, args, result])
    })

    hooks.emit('afterDispatch', 'inc', [1], 'ok')
    off()

    // 以下调用只用于编译期断言（@ts-expect-error）：运行时已退订，不会触达处理器
    // @ts-expect-error afterDispatch 需要 3 个实参：缺 result 不再被 unknown[] 放行
    hooks.emit('afterDispatch', 'inc', [])
    // @ts-expect-error onError 的 source 必须是 string
    hooks.emit('onError', new Error('x'), 42)
    // @ts-expect-error beforeSetState 的 key 必须是 string | number | symbol
    hooks.emit('beforeSetState', null, 1)

    expect(received).toEqual([['inc', [1], 'ok']])
  })

  it('Store.hooks 暴露具体 HookSystem：公开调用点同样保留实参检查（编译期）', () => {
    const store = createStore({ name: 'hook-typing', state: () => ({ count: 0 }) })

    // @ts-expect-error afterDispatch 缺 args / result 两个实参
    store.hooks.emit('afterDispatch', 'ghost')
    // @ts-expect-error onNotify 需要 { listeners } 元数据
    store.hooks.emit('onNotify')

    expect(() => store.hooks.emit('onNotify', { listeners: 0 })).not.toThrow()
    store.destroy()
  })
})

describe('HookSystem · 生产模式静默', () => {
  it('生产环境处理器抛错不打印，但 onError 仍被转投', async () => {
    const originalEnv = process.env.NODE_ENV
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const mod = await import('../../../src/core/hooks/HookSystem.js')
      const hooks = new mod.HookSystem()
      const onError = jest.fn()
      hooks.on('onError', onError)
      hooks.on('beforePatch', () => {
        throw new Error('prod fail')
      })

      hooks.emit('beforePatch', {})
      expect(onError).toHaveBeenCalledTimes(1)
      expect(errorSpy).not.toHaveBeenCalled()
      expect(hooks.size('beforePatch')).toBe(1)
    } finally {
      process.env.NODE_ENV = originalEnv
      jest.resetModules()
      errorSpy.mockRestore()
    }
  })
})
