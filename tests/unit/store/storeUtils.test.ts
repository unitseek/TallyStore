import { BatchManager } from '../../../src/core/store/BatchManager.js'
import { createPluginUninstaller } from '../../../src/core/store/pluginSupport.js'
import { createMutationErrorMessage, deepCloneState, deepFreezeState } from '../../../src/core/store/utils.js'
import type { Plugin } from '../../../src/types/plugin.js'

const originalNodeEnv = process.env.NODE_ENV

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv
  delete (globalThis as { __DEV__?: unknown }).__DEV__
  jest.resetModules()
})

async function loadUtils(): Promise<typeof import('../../../src/core/store/utils.js')> {
  jest.resetModules()
  return import('../../../src/core/store/utils.js')
}

async function loadBatchManager(): Promise<typeof import('../../../src/core/store/BatchManager.js')> {
  jest.resetModules()
  return import('../../../src/core/store/BatchManager.js')
}

describe('BatchManager', () => {
  it('构造时 onEnd 非函数立即抛 TypeError', () => {
    expect(() => new BatchManager(null as never)).toThrow(TypeError)
    expect(() => new BatchManager('nope' as never)).toThrow(TypeError)
  })

  it('嵌套 start/end 只在深度归零时触发一次收尾', () => {
    const onEnd = jest.fn()
    const manager = new BatchManager(onEnd)
    expect(manager.isInBatch).toBe(false)
    manager.start()
    manager.start()
    expect(manager.isInBatch).toBe(true)
    manager.end()
    expect(onEnd).not.toHaveBeenCalled()
    expect(manager.isInBatch).toBe(true)
    manager.end()
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(manager.isInBatch).toBe(false)
  })

  it('未配对 end 开发期告警且不改变深度', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const onEnd = jest.fn()
    const manager = new BatchManager(onEnd)
    expect(() => manager.end()).not.toThrow()
    expect(warn).toHaveBeenCalledWith('[TallyStore] BatchManager.end() called without matching start()')
    expect(manager.isInBatch).toBe(false)
    expect(onEnd).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('批进行中 reset 会告警并清零深度', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const manager = new BatchManager(jest.fn())
    manager.start()
    manager.reset()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(manager.isInBatch).toBe(false)
    manager.reset()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('生产模式下告警静默', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    process.env.NODE_ENV = 'production'
    try {
      const mod = await loadBatchManager()
      const manager = new mod.BatchManager(jest.fn())
      manager.end()
      manager.start()
      manager.reset()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('pluginSupport', () => {
  interface TestPlugin extends Plugin<Record<string, unknown>> {
    name: string
  }

  function makeEntry(uninstall?: () => void) {
    const plugin: TestPlugin = { name: 'p', install: () => uninstall }
    const plugins: Plugin<Record<string, unknown>>[] = [plugin]
    const uninstallFns = new Map<Plugin<Record<string, unknown>>, (() => void) | undefined>([[plugin, uninstall]])
    const installation = {}
    const installations = new Map<Plugin<Record<string, unknown>>, object>([[plugin, installation]])
    return { plugin, plugins, uninstallFns, installations, installation }
  }

  it('卸载句柄移除插件、清理映射并调用清理函数', () => {
    const uninstall = jest.fn()
    const entry = makeEntry(uninstall)
    const handle = createPluginUninstaller(entry.plugin, entry.plugins, entry.uninstallFns, entry.installations, entry.installation)
    handle()
    expect(uninstall).toHaveBeenCalledTimes(1)
    expect(entry.plugins).toEqual([])
    expect(entry.uninstallFns.size).toBe(0)
    expect(entry.installations.size).toBe(0)
  })

  it('句柄幂等：第二次调用不再执行清理', () => {
    const uninstall = jest.fn()
    const entry = makeEntry(uninstall)
    const handle = createPluginUninstaller(entry.plugin, entry.plugins, entry.uninstallFns, entry.installations, entry.installation)
    handle()
    handle()
    expect(uninstall).toHaveBeenCalledTimes(1)
  })

  it('缺少安装令牌时句柄退化为无操作', () => {
    const uninstall = jest.fn()
    const entry = makeEntry(uninstall)
    const handle = createPluginUninstaller(entry.plugin, entry.plugins, entry.uninstallFns, entry.installations, undefined)
    handle()
    expect(uninstall).not.toHaveBeenCalled()
    expect(entry.plugins).toHaveLength(1)
  })

  it('代际不匹配（旧句柄）不动新安装', () => {
    const uninstall = jest.fn()
    const entry = makeEntry(uninstall)
    entry.installations.set(entry.plugin, {})
    const handle = createPluginUninstaller(entry.plugin, entry.plugins, entry.uninstallFns, entry.installations, entry.installation)
    handle()
    expect(uninstall).not.toHaveBeenCalled()
    expect(entry.plugins).toHaveLength(1)
  })

  it('插件已不在数组时仍清理映射并调用清理函数', () => {
    const uninstall = jest.fn()
    const entry = makeEntry(uninstall)
    entry.plugins.length = 0
    const handle = createPluginUninstaller(entry.plugin, entry.plugins, entry.uninstallFns, entry.installations, entry.installation)
    expect(() => handle()).not.toThrow()
    expect(uninstall).toHaveBeenCalledTimes(1)
  })

  it('没有清理函数时安全完成', () => {
    const entry = makeEntry(undefined)
    const handle = createPluginUninstaller(entry.plugin, entry.plugins, entry.uninstallFns, entry.installations, entry.installation)
    expect(() => handle()).not.toThrow()
    expect(entry.plugins).toEqual([])
  })

  it('清理函数抛错按原样外抛', () => {
    const entry = makeEntry(() => {
      throw new Error('cleanup boom')
    })
    const handle = createPluginUninstaller(entry.plugin, entry.plugins, entry.uninstallFns, entry.installations, entry.installation)
    expect(() => handle()).toThrow('cleanup boom')
  })
})

describe('utils.isProduction', () => {
  it('NODE_ENV 优先：production 为真，其余为假', async () => {
    process.env.NODE_ENV = 'production'
    expect((await loadUtils()).isProduction()).toBe(true)
    process.env.NODE_ENV = 'test'
    expect((await loadUtils()).isProduction()).toBe(false)
    process.env.NODE_ENV = 'development'
    expect((await loadUtils()).isProduction()).toBe(false)
  })

  it('无 NODE_ENV 时按构建期 __DEV__ 判定', async () => {
    delete process.env.NODE_ENV
    ;(globalThis as { __DEV__?: unknown }).__DEV__ = false
    expect((await loadUtils()).isProduction()).toBe(true)
    ;(globalThis as { __DEV__?: unknown }).__DEV__ = true
    expect((await loadUtils()).isProduction()).toBe(false)
  })

  it('无 NODE_ENV/__DEV__ 时按小程序 envVersion：release/trial 视为生产', async () => {
    delete process.env.NODE_ENV
    ;(globalThis as { wx?: unknown }).wx = { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }) }
    expect((await loadUtils()).isProduction()).toBe(true)
    ;(globalThis as { wx?: unknown }).wx = { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'trial' } }) }
    expect((await loadUtils()).isProduction()).toBe(true)
    ;(globalThis as { wx?: unknown }).wx = { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }) }
    expect((await loadUtils()).isProduction()).toBe(false)
  })

  it('envVersion 非法/缺失时继续兜底为开发模式', async () => {
    delete process.env.NODE_ENV
    ;(globalThis as { wx?: unknown }).wx = { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'beta' } }) }
    expect((await loadUtils()).isProduction()).toBe(false)
    ;(globalThis as { wx?: unknown }).wx = { getAccountInfoSync: () => ({}) }
    expect((await loadUtils()).isProduction()).toBe(false)
    ;(globalThis as { wx?: unknown }).wx = { getAccountInfoSync: () => undefined }
    expect((await loadUtils()).isProduction()).toBe(false)
  })

  it('wx 缺少 getAccountInfoSync 时兜底为开发模式', async () => {
    delete process.env.NODE_ENV
    ;(globalThis as { wx?: unknown }).wx = {}
    expect((await loadUtils()).isProduction()).toBe(false)
    ;(globalThis as { wx?: unknown }).wx = null
    expect((await loadUtils()).isProduction()).toBe(false)
  })

  it('getAccountInfoSync 抛错时兜底为开发模式', async () => {
    delete process.env.NODE_ENV
    ;(globalThis as { wx?: unknown }).wx = {
      getAccountInfoSync: () => {
        throw new Error('account boom')
      },
    }
    expect((await loadUtils()).isProduction()).toBe(false)
  })

  it('首次判定结果在模块实例内缓存', async () => {
    process.env.NODE_ENV = 'production'
    const utils = await loadUtils()
    expect(utils.isProduction()).toBe(true)
    process.env.NODE_ENV = 'test'
    expect(utils.isProduction()).toBe(true)
  })
})

describe('utils.deepFreezeState', () => {
  it('原始值原样返回', () => {
    expect(deepFreezeState(null)).toBeNull()
    expect(deepFreezeState(undefined)).toBeUndefined()
    expect(deepFreezeState(1)).toBe(1)
    expect(deepFreezeState('x')).toBe('x')
  })

  it('纯对象与数组递归冻结，循环引用安全', () => {
    const shared: Record<string, unknown> = { value: 1 }
    const state: Record<string, unknown> = { a: shared, b: shared, list: [{ deep: true }] }
    state.self = state
    deepFreezeState(state)
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(shared)).toBe(true)
    expect(Object.isFrozen(state.list)).toBe(true)
    expect(Object.isFrozen((state.list as unknown[])[0])).toBe(true)
  })

  it('Object.create(null) 的对象同样冻结', () => {
    const bare = Object.create(null) as Record<string, unknown>
    bare.value = 1
    deepFreezeState(bare)
    expect(Object.isFrozen(bare)).toBe(true)
  })

  it('内建对象与类实例保留可变（部分冻结口径）', () => {
    class Service {
      value = 1
    }
    const service = new Service()
    const state = { date: new Date(0), map: new Map(), service }
    deepFreezeState(state)
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.date)).toBe(false)
    expect(Object.isFrozen(service)).toBe(false)
    expect(Object.isFrozen(state.map)).toBe(false)
  })

  it('数组子类不冻结，也不冻结其成员', () => {
    class SubArray extends Array<number> {}
    const sub = SubArray.of(1, 2)
    const holder = { sub }
    deepFreezeState(holder)
    expect(Object.isFrozen(holder)).toBe(true)
    expect(Object.isFrozen(sub)).toBe(false)
  })

  it('已冻结对象重复冻结不抛错', () => {
    const frozen = Object.freeze({ a: 1 })
    expect(() => deepFreezeState(frozen)).not.toThrow()
  })

  it('冻结失败时吞掉异常继续返回（对象防扩展陷阱抛错）', () => {
    const hostileObject = new Proxy(
      {},
      {
        preventExtensions() {
          return false
        },
      },
    )
    expect(() => deepFreezeState(hostileObject)).not.toThrow()

    const hostileArray = new Proxy([], {
      preventExtensions() {
        return false
      },
    })
    expect(() => deepFreezeState(hostileArray)).not.toThrow()
  })

  it('可传入外部 seen 集合复用访问记录', () => {
    const seen = new WeakSet<object>()
    const state = { a: 1 }
    deepFreezeState(state, seen)
    expect(seen.has(state)).toBe(true)
  })
})

describe('utils.createMutationErrorMessage', () => {
  it('可序列化值给出 JSON 字面量', () => {
    const message = createMutationErrorMessage('user.name', { first: 'a' }, 'set')
    expect(message).toContain('Direct mutation of state "user.name" is prohibited')
    expect(message).toContain('Operation: set')
    expect(message).toContain('Attempted value: {"first":"a"}')
  })

  it('undefined 与函数经 String 回退', () => {
    expect(createMutationErrorMessage('a', undefined, 'set')).toContain('Attempted value: undefined')
    expect(createMutationErrorMessage('a', () => undefined, 'delete')).toContain('Attempted value: () => undefined')
  })

  it('BigInt 让 JSON.stringify 抛错时退回 String', () => {
    expect(createMutationErrorMessage('a', 10n, 'set')).toContain('Attempted value: 10')
  })

  it('stringify 与 String 都抛错时给出不可序列化占位', () => {
    const hostile = {
      toJSON() {
        throw new Error('json boom')
      },
      [Symbol.toPrimitive]() {
        throw new Error('primitive boom')
      },
    }
    expect(createMutationErrorMessage('a', hostile, 'set')).toContain('Attempted value: <unserializable object>')
  })
})

describe('utils.deepCloneState', () => {
  it('按值深拷贝且保留循环引用', () => {
    const source: Record<string, unknown> = { nested: { value: 1 } }
    source.self = source
    const clone = deepCloneState(source)
    expect(clone).not.toBe(source)
    expect((clone.nested as Record<string, unknown>).value).toBe(1)
    expect(clone.self).toBe(clone)
  })
})

describe('BatchManager · 收尾回调抛错兜底', () => {
  it('onEnd 抛错不外溢，记录 console.error，深度已归零', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const manager = new BatchManager(() => {
        throw new Error('notify boom')
      })
      manager.start()
      expect(() => manager.end()).not.toThrow()
      expect(manager.isInBatch).toBe(false)
      expect(consoleError).toHaveBeenCalledWith('[TallyStore] Error in BatchManager onEnd callback:', expect.any(Error))
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('deepFreezeState · 与 deepCloneState 键集一致', () => {
  it('数组非下标键与对象符号键下的嵌套对象都被冻结', () => {
    const tag = Symbol('tag')
    const list = [1, 2] as unknown[] & Record<PropertyKey, unknown>
    list.meta = { nested: { v: 1 } }
    const source: Record<PropertyKey, unknown> = { list, [tag]: { nested: { v: 2 } } }
    const frozen = deepFreezeState(source) as Record<PropertyKey, unknown>
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen.list)).toBe(true)
    expect(Object.isFrozen(list.meta)).toBe(true)
    expect(Object.isFrozen((list.meta as { nested: object }).nested)).toBe(true)
    expect(Object.isFrozen(frozen[tag])).toBe(true)
    expect(Object.isFrozen((frozen[tag] as { nested: object }).nested)).toBe(true)
  })
})

describe('deepFreezeState · 非枚举下标', () => {
  it('隐藏下标下的嵌套对象也被冻结（与 clone 的描述符保真对齐）', () => {
    const list = [0] as unknown as Record<number, unknown>
    Object.defineProperty(list, 0, { value: { nested: 1 }, enumerable: false, writable: true, configurable: true })
    const source = { list }
    const frozen = deepFreezeState(source) as { list: Record<number, unknown> }
    expect(Object.isFrozen(frozen.list[0])).toBe(true)
  })
})

describe('createMutationErrorMessage · 序列化截断', () => {
  it('超大值只保留 512 字符并标注省略', () => {
    const message = createMutationErrorMessage('big', 'x'.repeat(5000), 'set')
    expect(message).toContain('…')
    expect(message.length).toBeLessThan(1200)
    expect(message).not.toContain('x'.repeat(1000))
  })

  it('不可序列化值仍给出可读占位', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(createMutationErrorMessage('bigint', 1n, 'set')).toContain('Attempted value: 1')
    expect(createMutationErrorMessage('cyclic', cyclic, 'set')).toContain('Attempted value: [object Object]')
  })

  it('JSON 失败后 String 回退路径同样截断', () => {
    const huge = {
      toJSON() {
        throw new Error('json boom')
      },
      toString: () => 'y'.repeat(5000),
    }
    const message = createMutationErrorMessage('big-toString', huge, 'set')
    expect(message).toContain('…')
    expect(message.length).toBeLessThan(1200)
    expect(message).not.toContain('y'.repeat(1000))
  })
})

describe('BatchManager · 收尾错误上报通道', () => {
  it('提供 onEndError 时优先走上报通道，不再落 console.error', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const reporter = jest.fn()
    try {
      const manager = new BatchManager(() => {
        throw new Error('notify boom')
      }, reporter)
      manager.start()
      expect(() => manager.end()).not.toThrow()
      expect(reporter).toHaveBeenCalledWith(expect.any(Error))
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('deepFreezeState · 数组键枚举口径', () => {
  it('隐藏的非下标/符号自有键不冻结（clone 不复制它们，与可枚举口径一致）', () => {
    const hidden = Symbol('hidden')
    const list = [1] as unknown[] & Record<PropertyKey, unknown>
    Object.defineProperty(list, 'secret', { value: { s: 1 }, enumerable: false, configurable: true })
    Object.defineProperty(list, hidden, { value: { h: 1 }, enumerable: false, configurable: true })
    const frozen = deepFreezeState({ list }) as { list: Record<PropertyKey, unknown> }
    expect(Object.isFrozen(frozen.list)).toBe(true)
    expect(Object.isFrozen((frozen.list as Record<string, object>).secret)).toBe(false)
    expect(Object.isFrozen(frozen.list[hidden])).toBe(false)
  })

  it('数组可枚举符号键下的对象也被冻结（与 clone 复制口径一致）', () => {
    const tag = Symbol('tag')
    const list = [1] as unknown[] & Record<PropertyKey, unknown>
    list[tag] = { nested: 1 }
    const frozen = deepFreezeState({ list }) as { list: Record<PropertyKey, unknown> }
    expect(Object.isFrozen((frozen.list as Record<PropertyKey, unknown>)[tag])).toBe(true)
  })
})
