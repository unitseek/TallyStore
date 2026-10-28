/**
 * loggerPlugin：默认 console sink、自定义 sink、sink 失败隔离、安装/卸载与生产静默
 */
import { createStore } from '../../../src/core/store/factory.js'
import { loggerPlugin } from '../../../src/plugins/logger.js'
import type { LoggerPluginOptions, LogSink } from '../../../src/types/plugins.js'

function makeStore() {
  return createStore({
    name: 'log-app',
    state: () => ({ count: 0 }),
    actions: {
      inc(step: number) {
        this.setState('count', this.getState().count + step)
        return step
      },
    },
  })
}

function makeSink() {
  const calls: Array<{ message: string; data: unknown[] }> = []
  const sink: LogSink = {
    log: (message, ...data) => {
      calls.push({ message, data })
    },
    error: () => {},
  }
  return { sink, calls }
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('loggerPlugin · 默认 console sink', () => {
  it('安装即输出安装日志，setState 与 dispatch 的钩子都有输出', () => {
    const store = makeStore()
    store.use(loggerPlugin)

    expect(console.log).toHaveBeenCalledWith('[TallyStore] Plugin "logger" installed')

    store.setState('count', 1)
    expect(console.log).toHaveBeenCalledWith('[TallyStore] Setting state:', 'count', '=>', 1)
    expect(console.log).toHaveBeenCalledWith('[TallyStore] State set:', 'count', '=>', 1)
    expect(console.log).toHaveBeenCalledWith('[TallyStore] State changed:', expect.objectContaining({ count: 1 }))

    store.dispatch('inc', 2)
    expect(console.log).toHaveBeenCalledWith('[TallyStore] Dispatching action:', 'inc', [2])
    expect(console.log).toHaveBeenCalledWith('[TallyStore] Action dispatched:', 'inc', 2)
    store.destroy()
  })

  it('插件对象带 name 与 install，且 install 直连可用', () => {
    expect(loggerPlugin.name).toBe('logger')
    expect(typeof loggerPlugin.install).toBe('function')

    const store = makeStore()
    loggerPlugin.install(store)
    expect(console.log).toHaveBeenCalledWith('[TallyStore] Plugin "logger" installed')
    store.destroy()
  })
})

describe('loggerPlugin · 自定义 sink', () => {
  it('全部日志走注入的 sink，卸载后不再输出', () => {
    const store = makeStore()
    const { sink, calls } = makeSink()
    const uninstall = store.use(loggerPlugin({ sink }))

    expect(calls[0].message).toBe('[TallyStore] Plugin "logger" installed')

    store.setState('count', 1)
    const messages = calls.map((c) => c.message)
    expect(messages).toContain('[TallyStore] Setting state:')
    expect(messages).toContain('[TallyStore] State set:')
    expect(messages).toContain('[TallyStore] State changed:')
    expect(console.log).not.toHaveBeenCalled()

    const before = calls.length
    uninstall()
    store.setState('count', 2)
    store.dispatch('inc', 1)
    expect(calls.length).toBe(before)
    store.destroy()
  })

  it('工厂每次返回独立插件实例，可分别安装', () => {
    const store = makeStore()
    const first = makeSink()
    const second = makeSink()
    const firstPlugin = loggerPlugin({ sink: first.sink })
    const secondPlugin = loggerPlugin({ sink: second.sink })
    expect(firstPlugin).not.toBe(secondPlugin)

    store.use(firstPlugin)
    store.use(secondPlugin)
    store.setState('count', 1)
    expect(first.calls.some((c) => c.message === '[TallyStore] State changed:')).toBe(true)
    expect(second.calls.some((c) => c.message === '[TallyStore] State changed:')).toBe(true)
    store.destroy()
  })

  it('sink.log 抛 Error 时转投 sink.error，不影响状态变更', () => {
    const store = makeStore()
    const sinkError = jest.fn()
    const failingSink: LogSink = {
      log: () => {
        throw new Error('sink boom')
      },
      error: sinkError,
    }
    store.use(loggerPlugin({ sink: failingSink }))
    expect(sinkError).toHaveBeenCalledWith(expect.stringContaining('日志输出失败'), 'sink boom')

    expect(() => store.setState('count', 1)).not.toThrow()
    expect(store.getState().count).toBe(1)
    store.destroy()
  })

  it('sink.log 抛非 Error 值时按 String() 转投 sink.error', () => {
    const store = makeStore()
    const sinkError = jest.fn()
    const failingSink = {
      log: () => {
        throw 'plain string failure'
      },
      error: sinkError,
    } as unknown as LogSink
    store.use(loggerPlugin({ sink: failingSink }))
    expect(sinkError).toHaveBeenCalledWith(expect.stringContaining('日志输出失败'), 'plain string failure')
    store.destroy()
  })

  it('sink 缺少 log 方法时降级告警而非崩溃', () => {
    const store = makeStore()
    const brokenSink = {} as unknown as LoggerPluginOptions['sink']
    store.use(loggerPlugin({ sink: brokenSink }))
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('日志输出失败'), expect.any(String))
    expect(() => store.setState('count', 1)).not.toThrow()
    store.destroy()
  })
})

describe('loggerPlugin · 生产模式', () => {
  it('生产环境安装为 no-op：不写 console，也不影响状态', async () => {
    const previousEnv = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production'
      jest.resetModules()
      const factory = await import('../../../src/core/store/factory.js')
      const loggerModule = await import('../../../src/plugins/logger.js')
      const store = factory.createStore({ name: 'prod-log', state: () => ({ count: 0 }) })
      const uninstall = store.use(loggerModule.loggerPlugin)

      expect(typeof uninstall).toBe('function')
      store.setState('count', 1)
      expect(console.log).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
      expect(store.getState().count).toBe(1)

      uninstall()
      store.destroy()
    } finally {
      process.env.NODE_ENV = previousEnv
      jest.resetModules()
    }
  })
})

describe('loggerPlugin · setState / dispatch 深度脱敏', () => {
  it('setState 非敏感键：嵌套 password / token 深度脱敏后输出（before + after）', () => {
    const store = createStore({
      name: 'log-nested',
      state: () => ({ profile: { nickname: 'n', password: 'p@ssw0rd-long', auth: { accessToken: 'tk-abcdef123456' } } }),
    })
    const { sink, calls } = makeSink()
    store.use(loggerPlugin({ sink }))

    store.setState('profile', { nickname: 'n', password: 'p@ssw0rd-long', auth: { accessToken: 'tk-abcdef123456' } })

    const expected = { nickname: 'n', password: 'p***ng', auth: { accessToken: 't***56' } }
    const before = calls.find((call) => call.message === '[TallyStore] Setting state:')
    expect(before?.data).toEqual(['profile', '=>', expected])
    const after = calls.find((call) => call.message === '[TallyStore] State set:')
    expect(after?.data).toEqual(['profile', '=>', expected])
    store.destroy()
  })

  it('setState 顶层敏感键：值按单值策略脱敏', () => {
    const store = createStore({ name: 'log-top-sensitive', state: () => ({ token: '' }) })
    const { sink, calls } = makeSink()
    store.use(loggerPlugin({ sink }))
    store.setState('token', 'tk-abcdef123456')
    const before = calls.find((call) => call.message === '[TallyStore] Setting state:')
    expect(before?.data).toEqual(['token', '=>', 't***56'])
    store.destroy()
  })

  it('dispatch 参数数组整体脱敏：对象实参的敏感键被遮盖，不再有原样输出的死分支', () => {
    const store = createStore({
      name: 'log-dispatch',
      state: () => ({ count: 0 }),
      actions: {
        login(payload: { password: string; keep: number }) {
          return payload.keep
        },
      },
    })
    const { sink, calls } = makeSink()
    store.use(loggerPlugin({ sink }))
    store.dispatch('login', { password: 'p@ssw0rd-long', keep: 1 })
    const before = calls.find((call) => call.message === '[TallyStore] Dispatching action:')
    expect(before?.data).toEqual(['login', [{ password: 'p***ng', keep: 1 }]])
    // 位置参数/返回值是不带键名的原始值，无法按键判定、不做脱敏（docs/API.md 已声明限制）
    const after = calls.find((call) => call.message === '[TallyStore] Action dispatched:')
    expect(after?.data).toEqual(['login', 1])
    store.destroy()
  })
})

describe('loggerPlugin · 脱敏异常隔离', () => {
  it('maskForLog 抛错（抛错 getter）时不穿透为 store 错误：hook 与通知双路径都放弃本次日志', () => {
    const store = createStore({ name: 'log-mask-boom', state: () => ({ count: 0 }) })
    const errors: unknown[] = []
    store.hooks.on('onError', (error) => errors.push(error))
    store.use(loggerPlugin)
    const boom = {
      get bad(): number {
        throw new Error('mask boom')
      },
    }

    expect(() => store.setState('boom' as never, boom as never)).not.toThrow()

    // hook 路径（before/afterSetState 的 maskForLog）与通知订阅路径（State changed 的 maskForLog）
    // 都在 safeLog 内兜底：脱敏失败只放弃本次日志，既不打断写入也不转投 onError/console.error
    expect(errors).toHaveLength(0)
    expect(console.error).not.toHaveBeenCalled()
    expect((store.getState() as Record<string, unknown>).boom).toBe(boom)
    store.destroy()
  })
})

describe('loggerPlugin · reset 审计与宿主写入归因', () => {
  it('beforeReset / afterReset 输出脱敏审计日志（store/reason/timestamp/ok，不含状态值）', () => {
    const store = createStore({ name: 'log-reset-audit', state: () => ({ token: 'tk-secret' }) })
    const { sink, calls } = makeSink()
    store.use(loggerPlugin({ sink }))
    ;(store.$reset as (reason?: 'direct' | 'resetAll') => void)('resetAll')

    const before = calls.find((call) => call.message === '[TallyStore] Resetting store:')
    const after = calls.find((call) => call.message === '[TallyStore] Store reset:')
    expect(before?.data).toEqual(['log-reset-audit', 'resetAll', expect.any(Number)])
    expect(after?.data).toEqual(['log-reset-audit', 'resetAll', before?.data[2], true])
    // 只输出标识/时间/ok，不输出任何状态值
    expect(JSON.stringify(calls)).not.toContain('tk-secret')
    store.destroy()
  })

  it('onHostWrite 记录 host/bytes 与最近一次 beforeDispatch 的 actionName', () => {
    const store = makeStore()
    const { sink, calls } = makeSink()
    store.use(loggerPlugin({ sink }))

    store.dispatch('inc', 1) // 更新最近一次 actionNotice
    store.hooks.emit('onHostWrite', { host: 'withPageStore', bytes: 42 })

    const hostWrite = calls.find((call) => call.message === '[TallyStore] Host write:')
    expect(hostWrite?.data).toEqual(['withPageStore', '42B', 'from action:', 'inc'])
    store.destroy()
  })

  it('卸载后 reset / hostWrite 钩子不再输出（清理生效）', () => {
    const store = makeStore()
    const { sink, calls } = makeSink()
    const uninstall = store.use(loggerPlugin({ sink }))
    uninstall()

    const before = calls.length
    store.hooks.emit('beforeReset', { storeName: 'log-app', reason: 'direct', timestamp: Date.now() })
    store.hooks.emit('onHostWrite', { host: 'withPageStore', bytes: 1 })
    expect(calls.length).toBe(before)
    store.destroy()
  })
})
