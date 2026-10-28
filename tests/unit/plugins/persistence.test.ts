/**
 * persistencePlugin：默认键、后端注入、恢复准入、防抖与卸载补写
 *
 * 覆盖 src/plugins/persistence.ts 的公开契约与错误分支；生产模式分支用
 * NODE_ENV + jest.resetModules() + 动态 import 单独覆盖（见文件末尾）。
 */
import { createStore } from '../../../src/core/store/factory.js'
import { TallyStoreError } from '../../../src/core/errors/TallyStoreError.js'
import { persistencePlugin } from '../../../src/plugins/persistence.js'
import { installWxStorage } from '../../utils/host.js'
import type { IHookSystem } from '../../../src/types/plugin.js'
import type { StorageBackend } from '../../../src/types/plugins.js'

/** 持久化必须显式声明 filter；旧用例默认语义为「全量落盘」，这里显式给恒等白名单保留原语义 */
const keepAll = <S extends object>(state: S): S => state
const persistencePluginWithFilter = (options: Record<string, unknown> = {}) =>
  persistencePlugin({ filter: keepAll, ...options } as never) as ReturnType<typeof persistencePlugin>

interface ErrorEvent {
  error: unknown
  source?: string
}

function memoryBackend(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  const calls: Array<{ op: 'get' | 'set' | 'remove'; key: string; value?: string }> = []
  const backend: StorageBackend = {
    getItem(key) {
      calls.push({ op: 'get', key })
      return map.has(key) ? (map.get(key) as string) : null
    },
    setItem(key, value) {
      calls.push({ op: 'set', key, value })
      map.set(key, value)
    },
    removeItem(key) {
      calls.push({ op: 'remove', key })
      map.delete(key)
    },
  }
  return { backend, map, calls, writes: () => calls.filter((c) => c.op === 'set') }
}

function makeStore(options: { name?: string; notifyAsync?: boolean } = {}) {
  const base = {
    name: options.name ?? 'app',
    state: () => ({ count: 0, user: { name: '' } }),
  }
  return options.notifyAsync ? createStore({ ...base, notify: { async: true } }) : createStore(base)
}

function trackErrors(store: { hooks: IHookSystem }): ErrorEvent[] {
  const events: ErrorEvent[] = []
  store.hooks.on('onError', (error, source) => {
    events.push({ error, source })
  })
  return events
}

/** 进入生产模式并拿到一套全新的模块（isProduction 按模块实例缓存） */
async function enterProduction() {
  process.env.NODE_ENV = 'production'
  jest.resetModules()
  const factory = await import('../../../src/core/store/factory.js')
  const pluginModule = await import('../../../src/plugins/persistence.js')
  // 生产模式用例同样必须显式 filter；默认注入恒等白名单，用例显式传 filter 时覆盖
  const persistencePlugin = ((options: Record<string, unknown> = {}) =>
    pluginModule.persistencePlugin({ filter: keepAll, ...options } as never)) as typeof pluginModule.persistencePlugin
  return { createStore: factory.createStore, persistencePlugin }
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('persistencePlugin · 安装与落盘', () => {
  it('默认键由 store.name 派生，setState 后同步落盘', () => {
    const wxMemory = installWxStorage()
    const store = makeStore()
    const uninstall = store.use(persistencePluginWithFilter())

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Plugin "persistence" installed'))

    store.setState('count', 1)
    expect(JSON.parse(wxMemory.get('tallystore_app') as string)).toEqual({ count: 1, user: { name: '' } })

    uninstall()
    store.destroy()
  })

  it('key 支持固定字符串与函数两种形态', () => {
    const wxMemory = installWxStorage()
    const fixed = makeStore({ name: 'one' })
    fixed.use(persistencePluginWithFilter({ key: 'session' }))
    fixed.setState('count', 1)
    expect(wxMemory.has('session')).toBe(true)

    const derived = makeStore({ name: 'two' })
    derived.use(persistencePluginWithFilter({ key: (storeName: string) => 'k:' + storeName }))
    derived.setState('count', 2)
    expect(JSON.parse(wxMemory.get('k:two') as string).count).toBe(2)

    fixed.destroy()
    derived.destroy()
  })

  it('显式 storage 后端优先于 wx，并按 StorageBackend 契约调用', () => {
    const wxMemory = installWxStorage()
    const { backend, map, calls } = memoryBackend()
    const store = makeStore()
    store.use(persistencePluginWithFilter({ key: 'k', storage: backend }))
    store.setState('count', 3)

    expect(JSON.parse(map.get('k') as string).count).toBe(3)
    expect(wxMemory.has('k')).toBe(false)
    expect(calls.some((c) => c.op === 'get')).toBe(true)
    store.destroy()
  })

  it('storage 传 null 时回落到 wx 同步存储', () => {
    const wxMemory = installWxStorage()
    const store = makeStore()
    store.use(persistencePluginWithFilter({ storage: null as unknown as StorageBackend }))
    store.setState('count', 4)
    expect(JSON.parse(wxMemory.get('tallystore_app') as string).count).toBe(4)
    store.destroy()
  })

  it('storage 缺少方法时在安装期抛 TypeError，不留半安装插件', () => {
    const partial = { getItem: () => null } as unknown as StorageBackend
    const store = makeStore()
    expect(() => store.use(persistencePluginWithFilter({ storage: partial }))).toThrow(TypeError)
    expect(console.error).not.toHaveBeenCalled()

    // 安装失败已回滚：同一个 store 仍可正常安装别的插件
    const wxMemory = installWxStorage()
    store.use(persistencePluginWithFilter())
    store.setState('count', 9)
    expect(wxMemory.has('tallystore_app')).toBe(true)
    store.destroy()
  })

  it('wx 同步 API 不齐备时降级内存并告警', () => {
    delete (globalThis as { wx?: unknown }).wx
    ;(globalThis as { wx?: unknown }).wx = { getStorageSync: () => '' }
    const store = makeStore()
    const errors = trackErrors(store)
    store.use(persistencePluginWithFilter())

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('降级为内存存储'))
    expect(errors).toHaveLength(0)
    expect(() => store.setState('count', 1)).not.toThrow()
    store.destroy()
  })

  it('无 wx 环境降级内存存储，不抛错', () => {
    delete (globalThis as { wx?: unknown }).wx
    const store = makeStore()
    const errors = trackErrors(store)
    store.use(persistencePluginWithFilter())
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('降级为内存存储'))
    expect(() => store.setState('count', 1)).not.toThrow()
    expect(errors).toHaveLength(0)
    store.destroy()
  })

  it('filter 只落盘其返回的键', () => {
    const { backend, map } = memoryBackend()
    const store = makeStore()
    store.use(persistencePluginWithFilter({ storage: backend, filter: (state: { count: number; user: { name: string } }) => ({ count: state.count }) }))
    store.setState('user', { name: 'alice' })
    expect(JSON.parse(map.get('tallystore_app') as string)).toEqual({ count: 0 })
    store.destroy()
  })

  it('写入失败不中断状态变更，并上报 onError', () => {
    const failing: StorageBackend = {
      getItem: () => null,
      setItem: () => {
        throw new Error('disk full')
      },
      removeItem: () => {
        throw new Error('disk full')
      },
    }
    const store = makeStore()
    const errors = trackErrors(store)
    store.use(persistencePluginWithFilter({ storage: failing }))
    expect(() => store.setState('count', 5)).not.toThrow()
    expect(store.getState().count).toBe(5)
    expect(errors.some((e) => (e.error as Error).message === 'disk full' && e.source === 'persistence')).toBe(true)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to persist state'), expect.any(Error))
    store.destroy()
  })

  it('异步后端返回值被拒绝并上报 onError', () => {
    const asyncBackend: StorageBackend = {
      getItem: () => null,
      setItem: () => Promise.resolve() as unknown as void,
      removeItem: () => Promise.resolve() as unknown as void,
    }
    const store = makeStore()
    const errors = trackErrors(store)
    store.use(persistencePluginWithFilter({ storage: asyncBackend }))
    store.setState('count', 6)
    expect(errors.some((e) => String((e.error as Error).message ?? '').includes('Promise'))).toBe(true)
    store.destroy()
  })

  it('卸载后不再落盘', () => {
    const { backend, map, writes } = memoryBackend()
    const store = makeStore()
    const uninstall = store.use(persistencePluginWithFilter({ storage: backend }))
    uninstall()
    // 卸载时按契约补写一次当前状态；之后订阅已退订，变更不再产生写入
    const writesAfterUninstall = writes().length
    store.setState('count', 7)
    expect(writes()).toHaveLength(writesAfterUninstall)
    expect(JSON.parse(map.get('tallystore_app') as string).count).toBe(0)
    store.destroy()
  })

  it('重复安装同一插件实例幂等，只保留一份副作用', () => {
    const { backend, writes } = memoryBackend()
    const plugin = persistencePluginWithFilter({ storage: backend })
    const store = makeStore()
    const firstUninstall = store.use(plugin)
    const secondUninstall = store.use(plugin)

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('已安装'))
    store.setState('count', 1)
    expect(writes()).toHaveLength(1)

    // 第二次 use 返回的句柄同样能卸载既有安装（幂等语义）
    secondUninstall()
    store.setState('count', 2)
    expect(writes()).toHaveLength(1)
    firstUninstall()
    store.destroy()
  })

  it('工厂产生的多个插件实例各自独立', () => {
    const { backend, writes } = memoryBackend()
    const store = makeStore()
    const first = store.use(persistencePluginWithFilter({ storage: backend }))
    store.use(persistencePluginWithFilter({ storage: backend }))
    store.setState('count', 1)
    expect(writes()).toHaveLength(2)

    first()
    store.setState('count', 2)
    expect(writes()).toHaveLength(3)
    store.destroy()
  })

  it('store.destroy() 触发卸载，并补写最后一次状态', () => {
    const { backend, map } = memoryBackend()
    const store = makeStore()
    store.use(persistencePluginWithFilter({ storage: backend }))
    store.setState('count', 8)
    store.destroy()
    expect(JSON.parse(map.get('tallystore_app') as string).count).toBe(8)
    expect(console.error).not.toHaveBeenCalled()
  })

  it('插件对象直连 install：显式 filter 生效；缺省 filter 抛 INVALID_CONFIG；filter:false 禁用', () => {
    const { backend, map } = memoryBackend()
    const store = makeStore()
    type Install = (s: typeof store, o: { key: string; storage: StorageBackend; filter: typeof keepAll } | null) => void
    const installWithOptions = persistencePlugin.install as unknown as Install
    installWithOptions(store, { key: 'direct', storage: backend, filter: keepAll })
    store.setState('count', 1)
    expect(map.has('direct')).toBe(true)

    // options 为 null 等价缺省 filter → 开发期抛 INVALID_CONFIG，不再自动全量落盘
    const other = makeStore({ name: 'nul' })
    const installWithNull = persistencePlugin.install as unknown as (s: typeof other, o: null) => void
    expect(() => installWithNull(other, null)).toThrow(TallyStoreError)
    expect(() => other.setState('count', 1)).not.toThrow()

    // filter:false 显式关闭：不写盘、不报错
    const disabled = makeStore({ name: 'disabled' })
    const installDisabled = persistencePlugin.install as unknown as (s: typeof disabled, o: { filter: false }) => void
    installDisabled(disabled, { filter: false })
    disabled.setState('count', 2)
    expect(map.has('tallystore_disabled')).toBe(false)
    disabled.destroy()
    store.destroy()
    other.destroy()
  })
})

describe(' /：持久化必须显式声明 filter', () => {
  it('开发期缺省 filter：抛 INVALID_CONFIG 并指出必须显式声明；零 storage 调用、不恢复、不落盘', () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend, calls } = memoryBackend({ tallystore_app: JSON.stringify({ count: 9 }) })
    const store = makeStore()
    const errors = trackErrors(store)
    let caught: unknown
    try {
      store.use(persistencePlugin({ storage: backend }))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TallyStoreError)
    expect((caught as { code?: string }).code).toBe('INVALID_CONFIG')
    const message = (caught as Error).message
    expect(message).toContain('filter')
    expect(message).toContain('禁止自动全量')
    // 缺省 filter 恰好在解析/读取 storage 之前被拦截：零 getItem / setItem / removeItem
    expect(calls).toHaveLength(0)
    // 未恢复：即使后端有数据也保持默认值
    expect(store.getState().count).toBe(0)
    store.setState('count', 1)
    store.destroy()
    expect(calls).toHaveLength(0)
    expect(errors).toHaveLength(0)
  })

  it('开发期非法 filter 值（非函数/非 false）同样抛 INVALID_CONFIG', () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend } = memoryBackend()
    const store = makeStore()
    expect(() => store.use(persistencePlugin({ storage: backend, filter: 123 as never }))).toThrow(TallyStoreError)
    store.destroy()
  })

  it('filter: false 显式关闭（开发期）：不读/不恢复/不订阅/不写盘/不清理、不报错、uninstall 幂等', () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend, map, calls } = memoryBackend({ tallystore_app: JSON.stringify({ count: 9 }) })
    const store = makeStore()
    const errors = trackErrors(store)
    const uninstall = store.use(persistencePlugin({ storage: backend, filter: false, debounce: 100, clearOnUninstall: true }))

    expect(store.getState().count).toBe(0)
    expect(errors).toHaveLength(0)
    store.setState('count', 1)
    uninstall()
    uninstall()
    store.destroy()
    expect(calls).toHaveLength(0)
    // 已有存储数据不被清理（clearOnUninstall 也不生效）
    expect(map.has('tallystore_app')).toBe(true)
  })

  it('filter:false 显式关闭（生产期）：零 storage 调用、无 onError、无 console 输出', async () => {
    const prod = await enterProduction()
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { backend, calls } = memoryBackend({ tallystore_app: JSON.stringify({ count: 9 }) })
      const store = prod.createStore({ name: 'd1-off-prod', state: () => ({ count: 0 }) })
      const errors = trackErrors(store)
      store.use(prod.persistencePlugin({ storage: backend, filter: false, debounce: 100, clearOnUninstall: true }))
      store.setState('count', 1)
      store.destroy()
      expect(calls).toHaveLength(0)
      expect(errors).toHaveLength(0)
    } finally {
      delete process.env.NODE_ENV
      jest.resetModules()
    }
  })

  it('生产期缺省 filter：onError(INVALID_CONFIG, persistence) 上报后禁用持久化；getItem/setItem/removeItem 零调用', async () => {
    const prod = await enterProduction()
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      // 动态模块重置后重新 import：拿未注入默认 filter 的原始工厂
      const pluginModule = await import('../../../src/plugins/persistence.js')
      const { backend, calls } = memoryBackend({ tallystore_app: JSON.stringify({ count: 9 }) })
      const store = prod.createStore({ name: 'd1-missing-prod', state: () => ({ count: 0 }) })
      const errors = trackErrors(store)
      const uninstall = store.use(pluginModule.persistencePlugin({ storage: backend, debounce: 100, clearOnUninstall: true }))

      expect(errors).toHaveLength(1)
      expect(errors[0].source).toBe('persistence')
      const error = errors[0].error as { code?: string; message: string }
      expect(error.code).toBe('INVALID_CONFIG')
      expect(error.message).toContain('filter')
      expect(store.getState().count).toBe(0)

      store.setState('count', 1)
      uninstall()
      uninstall()
      store.destroy()
      expect(calls).toHaveLength(0)
    } finally {
      delete process.env.NODE_ENV
      jest.resetModules()
    }
  })

  it('filter 返回空对象：只落盘空对象（默认不落盘任何字段）', () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend, map } = memoryBackend()
    const store = makeStore()
    store.use(persistencePlugin({ storage: backend, filter: () => ({}) }))
    store.setState('count', 3)
    expect(map.get('tallystore_app')).toBe('{}')
    store.destroy()
  })
})

describe('persistencePlugin · 恢复准入', () => {
  it('默认恢复落盘状态，且不对恢复载荷回写', () => {
    const { backend, writes } = memoryBackend({ tallystore_app: JSON.stringify({ count: 7, user: { name: 'restored' } }) })
    const store = makeStore()
    store.use(persistencePluginWithFilter({ storage: backend }))

    expect(store.getState().count).toBe(7)
    expect(store.getState().user).toEqual({ name: 'restored' })
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('State restored from storage'), 'tallystore_app')

    // lastSaved 被恢复载荷种子化：卸载时的最终补写应被去重
    store.destroy()
    expect(writes()).toHaveLength(0)
  })

  it('restore:false 完全不读取后端', () => {
    const { backend, calls } = memoryBackend({ tallystore_app: JSON.stringify({ count: 7 }) })
    const store = makeStore()
    store.use(persistencePluginWithFilter({ storage: backend, restore: false }))
    expect(store.getState().count).toBe(0)
    expect(calls.filter((c) => c.op === 'get')).toHaveLength(0)
    store.destroy()
  })

  it('函数值（如 toJSON）在 JSON.stringify 前被 persistence 校验拒绝并上报', () => {
    const { backend, calls } = memoryBackend()
    const store = makeStore()
    const errors = trackErrors(store)
    const state = { count: 0, toJSON: () => undefined }
    store.use(persistencePluginWithFilter({ storage: backend, filter: () => state as never }))
    store.setState('count', 1)

    expect(calls.filter((c) => c.op === 'set')).toHaveLength(0)
    const hit = errors.find((e) => e.source === 'persistence' && (e.error as Error).message.includes('不可序列化'))
    expect(hit).toBeDefined()
    expect((hit!.error as Error).message).toContain('toJSON')
    store.destroy()
  })

  it('filter 返回非对象时拒绝写入并上报 onError', () => {
    const { backend, calls } = memoryBackend()
    const store = makeStore()
    const errors = trackErrors(store)
    store.use(persistencePluginWithFilter({ storage: backend, filter: (() => undefined) as never }))
    store.setState('count', 1)

    expect(calls.filter((c) => c.op === 'set')).toHaveLength(0)
    expect(errors.some((e) => (e.error as Error).message.includes('plain object'))).toBe(true)
    store.destroy()
  })

  it('恢复时 filter 只合并过滤后的键', () => {
    const { backend } = memoryBackend({ tallystore_app: JSON.stringify({ count: 5, user: { name: 'x' }, extra: 1 }) })
    const store = makeStore()
    store.use(persistencePluginWithFilter({ storage: backend, filter: (state: { count: number; user: { name: string } }) => ({ user: state.user }) }))
    expect(store.getState().count).toBe(0)
    expect(store.getState().user).toEqual({ name: 'x' })
    store.destroy()
  })

  it('恢复时 filter 返回非纯对象：跳过恢复并上报，不把数组键/类实例静默合并进状态', () => {
    for (const bad of [[1, 2], new Date(0), undefined]) {
      const { backend } = memoryBackend({ tallystore_app: JSON.stringify({ count: 5 }) })
      const store = makeStore()
      const errors = trackErrors(store)
      store.use(persistencePluginWithFilter({ storage: backend, filter: (() => bad) as never }))

      // 旧行为：数组会以数字键被 $patch 合并（state['0']=1），Date/undefined 静默 no-op；
      // 恢复「看起来成功」但状态不对。新口径与 saveState 的落盘校验一致：拒绝并上报
      expect(store.getState()).toEqual({ count: 0, user: { name: '' } })
      expect(Object.keys(store.getState())).toEqual(['count', 'user'])
      expect(errors.some((e) => e.source === 'persistence' && (e.error as Error).message.includes('不是纯对象'))).toBe(true)
      store.destroy()
    }
  })

  it('validate 返回 false 时跳过恢复并上报 onError', () => {
    const { backend } = memoryBackend({ tallystore_app: JSON.stringify({ count: 1 }) })
    const store = makeStore()
    const errors = trackErrors(store)
    store.use(persistencePluginWithFilter({ storage: backend, validate: (() => false) as never }))
    expect(store.getState().count).toBe(0)
    expect(errors.some((e) => (e.error as Error).message.includes('validation'))).toBe(true)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('failed validation'))
    store.destroy()
  })

  it('validate 抛错时走恢复失败通道', () => {
    const { backend } = memoryBackend({ tallystore_app: JSON.stringify({ count: 1 }) })
    const store = makeStore()
    const errors = trackErrors(store)
    store.use(
      persistencePluginWithFilter({
        storage: backend,
        validate: (() => {
          throw new Error('validator boom')
        }) as never,
      }),
    )
    expect(store.getState().count).toBe(0)
    expect(errors.some((e) => (e.error as Error).message === 'validator boom')).toBe(true)
    store.destroy()
  })

  it('非纯对象载荷（数组 / 标量）被拒绝', () => {
    for (const payload of ['[1,2]', '5', '"str"']) {
      const { backend } = memoryBackend({ tallystore_app: payload })
      const store = makeStore()
      const errors = trackErrors(store)
      store.use(persistencePluginWithFilter({ storage: backend }))
      expect(store.getState().count).toBe(0)
      expect(errors.some((e) => (e.error as Error).message.includes('not a plain object'))).toBe(true)
      store.destroy()
    }
  })

  it('带 __proto__ 自有属性的载荷被拒绝，且不污染原型', () => {
    const { backend } = memoryBackend({ tallystore_app: '{"__proto__":{"polluted":true}}' })
    const store = makeStore()
    const errors = trackErrors(store)
    store.use(persistencePluginWithFilter({ storage: backend }))
    expect(store.getState().count).toBe(0)
    expect(errors).toHaveLength(1)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    store.destroy()
  })

  it('损坏 JSON 走恢复失败通道', () => {
    const { backend } = memoryBackend({ tallystore_app: '{bad json' })
    const store = makeStore()
    const errors = trackErrors(store)
    store.use(persistencePluginWithFilter({ storage: backend }))
    expect(store.getState().count).toBe(0)
    expect(errors).toHaveLength(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to restore state'), expect.any(SyntaxError))
    store.destroy()
  })

  it('读取后端抛错走恢复失败通道', () => {
    const backend: StorageBackend = {
      getItem: () => {
        throw new Error('read failed')
      },
      setItem: () => {},
      removeItem: () => {},
    }
    const store = makeStore()
    const errors = trackErrors(store)
    store.use(persistencePluginWithFilter({ storage: backend }))
    expect(errors.some((e) => (e.error as Error).message === 'read failed')).toBe(true)
    store.destroy()
  })

  it('异步 getItem 返回值被拒绝', () => {
    const backend: StorageBackend = {
      getItem: () => Promise.resolve('{}') as unknown as string,
      setItem: () => {},
      removeItem: () => {},
    }
    const store = makeStore()
    const errors = trackErrors(store)
    store.use(persistencePluginWithFilter({ storage: backend }))
    expect(errors.some((e) => String((e.error as Error).message ?? '').includes('Promise'))).toBe(true)
    store.destroy()
  })

  it('空存储不产生恢复日志', () => {
    const { backend } = memoryBackend()
    const store = makeStore()
    store.use(persistencePluginWithFilter({ storage: backend }))
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('State restored'), expect.anything())
    store.destroy()
  })
})

describe('persistencePlugin · 防抖与卸载', () => {
  it('debounce>0 时合并多次变更为一次写入', () => {
    jest.useFakeTimers()
    const { backend, writes } = memoryBackend()
    const store = makeStore()
    store.use(persistencePluginWithFilter({ storage: backend, debounce: 100 }))

    store.setState('count', 1)
    store.setState('count', 2)
    expect(writes()).toHaveLength(0)

    jest.advanceTimersByTime(100)
    expect(writes()).toHaveLength(1)
    expect(mapValue(writes()).count).toBe(2)
    store.destroy()
  })

  it('debounce 超过 setTimeout 上限时被钳位', () => {
    jest.useFakeTimers()
    const timeoutSpy = jest.spyOn(globalThis, 'setTimeout')
    const { backend } = memoryBackend()
    const store = makeStore()
    store.use(persistencePluginWithFilter({ storage: backend, debounce: 3e9 }))
    store.setState('count', 1)

    const clamped = timeoutSpy.mock.calls.some((call) => call[1] === 2147483647)
    expect(clamped).toBe(true)
    store.destroy()
  })

  it('防抖窗口内卸载：同步补写待写状态，定时器被清掉', () => {
    jest.useFakeTimers()
    const { backend, writes } = memoryBackend()
    const store = makeStore()
    const uninstall = store.use(persistencePluginWithFilter({ storage: backend, debounce: 100 }))

    store.setState('count', 2)
    uninstall()
    expect(writes()).toHaveLength(1)
    expect(mapValue(writes()).count).toBe(2)

    jest.advanceTimersByTime(1000)
    expect(writes()).toHaveLength(1)
    store.destroy()
  })

  it('notify.async 下未触发订阅时，卸载仍补写当前状态', async () => {
    const { backend, writes } = memoryBackend()
    const store = makeStore({ notifyAsync: true })
    const uninstall = store.use(persistencePluginWithFilter({ storage: backend }))

    store.setState('count', 3)
    uninstall()
    expect(writes()).toHaveLength(1)
    expect(mapValue(writes()).count).toBe(3)

    await Promise.resolve()
    expect(writes()).toHaveLength(1)
    store.destroy()
  })

  it('clearOnUninstall 清空存储并丢弃防抖中的待写状态', () => {
    jest.useFakeTimers()
    const { backend, map, calls } = memoryBackend()
    const store = makeStore()
    const uninstall = store.use(persistencePluginWithFilter({ storage: backend, debounce: 100, clearOnUninstall: true }))

    store.setState('count', 4)
    uninstall()
    expect(map.has('tallystore_app')).toBe(false)
    expect(calls.filter((c) => c.op === 'remove')).toHaveLength(1)
    expect(calls.filter((c) => c.op === 'set')).toHaveLength(0)

    jest.advanceTimersByTime(1000)
    expect(map.has('tallystore_app')).toBe(false)
    store.destroy()
  })

  it('通知派发中销毁 Store：卸载后残留的订阅回调不再落盘', () => {
    const { backend, map } = memoryBackend()
    const store = makeStore()
    let destroyed = false
    // 用户监听器先注册：它在通知派发中销毁 Store；persistence 的只读监听器
    // 仍在同一轮快照里，卸载后才被调用，saveState 的卸载守卫必须拦住这次写入
    store.subscribe(() => {
      if (destroyed) return
      destroyed = true
      store.destroy()
    })
    store.use(persistencePluginWithFilter({ storage: backend, debounce: 0, clearOnUninstall: true }))

    store.setState('count', 9)

    expect(destroyed).toBe(true)
    expect(map.has('tallystore_app')).toBe(false)
  })

  it('clearOnUninstall 清理失败上报 onError', () => {
    const backend: StorageBackend = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error('remove failed')
      },
    }
    const store = makeStore()
    const errors = trackErrors(store)
    const uninstall = store.use(persistencePluginWithFilter({ storage: backend, clearOnUninstall: true }))
    uninstall()
    expect(errors.some((e) => (e.error as Error).message === 'remove failed' && e.source === 'persistence')).toBe(true)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to clear persisted state'), expect.any(Error))
    store.destroy()
  })

  it('内存降级后端 + clearOnUninstall 时 removeItem 被调用', () => {
    delete (globalThis as { wx?: unknown }).wx
    const store = makeStore()
    const uninstall = store.use(persistencePluginWithFilter({ clearOnUninstall: true }))
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('降级为内存存储'))
    store.setState('count', 1)
    uninstall()
    expect(console.error).not.toHaveBeenCalled()
    store.destroy()
  })

  it('卸载时 filter 抛错上报 onError（不进 saveState 的兜底）', () => {
    const { backend } = memoryBackend()
    const store = makeStore({ notifyAsync: true })
    const errors = trackErrors(store)
    const uninstall = store.use(
      persistencePluginWithFilter({
        storage: backend,
        restore: false,
        filter: () => {
          throw new Error('filter boom')
        },
      }),
    )
    uninstall()
    expect(errors.some((e) => (e.error as Error).message === 'filter boom' && e.source === 'persistence')).toBe(true)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to persist state on uninstall'), expect.any(Error))
    store.destroy()
  })

  it('恢复后的延迟通知被吸收，不回写磁盘；后续真实变更正常落盘', async () => {
    const { backend, writes } = memoryBackend({ tallystore_app: JSON.stringify({ count: 3, user: { name: '' } }) })
    const store = makeStore({ notifyAsync: true })
    store.use(persistencePluginWithFilter({ storage: backend }))
    await Promise.resolve()
    expect(writes()).toHaveLength(0)

    store.setState('count', 4)
    await Promise.resolve()
    expect(writes()).toHaveLength(1)
    expect(mapValue(writes()).count).toBe(4)
    store.destroy()
  })

  it('恢复后同一 tick 内的新写入不被吸收，正常落盘', async () => {
    const { backend, writes } = memoryBackend({ tallystore_app: JSON.stringify({ count: 3, user: { name: '' } }) })
    const store = makeStore({ notifyAsync: true })
    store.use(persistencePluginWithFilter({ storage: backend }))

    store.setState('count', 9)
    await Promise.resolve()
    expect(writes()).toHaveLength(1)
    expect(mapValue(writes()).count).toBe(9)
    store.destroy()
  })

  it('吸收比较阶段序列化失败时转入 saveState 兜底并上报 onError', async () => {
    let filterCalls = 0
    const filter = (state: { count: number }) => {
      filterCalls += 1
      if (filterCalls <= 2) return { count: state.count }
      const circular: Record<string, unknown> = {}
      circular.self = circular
      return circular
    }
    const { backend } = memoryBackend({ tallystore_app: JSON.stringify({ count: 5, user: { name: '' } }) })
    const store = makeStore({ notifyAsync: true })
    const errors = trackErrors(store)
    store.use(persistencePluginWithFilter({ storage: backend, filter: filter as never }))

    await Promise.resolve()
    expect(errors.length).toBeGreaterThan(0)
    store.destroy()
  })

  it('循环引用状态在落盘前被 persistence 校验拒绝：不写盘并经 onError 暴露', async () => {
    const circular: Record<string, unknown> = { a: 0 }
    circular.self = circular
    const { backend, writes } = memoryBackend({ tallystore_circular: '{"a":1}' })
    const store = createStore({ name: 'circular', state: () => ({ a: 0, payload: null as unknown }), notify: { async: true } })
    const errors = trackErrors(store)

    store.use(persistencePluginWithFilter({ storage: backend }))
    await Promise.resolve()
    await Promise.resolve()

    // 构造期 state 校验会拦函数/BigInt/循环，故循环在构造完成后经 setState 注入，验证落盘前 fail-closed
    store.setState('payload' as never, circular as never)
    await Promise.resolve()
    await Promise.resolve()

    expect(writes()).toHaveLength(0)
    expect(errors.some((e) => (e.error as Error).message.includes('不可序列化'))).toBe(true)
    store.destroy()
  })
})

describe('persistencePlugin · 生产模式（console 静默、失败统一走 onError）', () => {
  it('安装、恢复、保存、清理与末次补写全部不写 console', async () => {
    const previousEnv = process.env.NODE_ENV
    try {
      const prod = await enterProduction()

      // 1) 无 wx：降级内存触发 onError，而不是 console.warn
      delete (globalThis as { wx?: unknown }).wx
      const noBackend = prod.createStore({ name: 'p1', state: () => ({ count: 0 }) })
      const noBackendErrors = trackErrors(noBackend)
      noBackend.use(prod.persistencePlugin())
      expect(noBackendErrors.some((e) => (e.error as Error).message.includes('降级为内存存储'))).toBe(true)

      // 2) 恢复成功不打日志（显式后端，避免场景之间共享 wx 全局）
      const restoreBackend = memoryBackend({ tallystore_p2: JSON.stringify({ count: 2 }) }).backend
      const restored = prod.createStore({ name: 'p2', state: () => ({ count: 0 }) })
      restored.use(prod.persistencePlugin({ storage: restoreBackend }))
      expect(restored.getState().count).toBe(2)

      // 3) validate 拒绝：走 onError，不打 console.error
      const rejectBackend = memoryBackend({ tallystore_p3: JSON.stringify({ count: 1 }) }).backend
      const rejecting = prod.createStore({ name: 'p3', state: () => ({ count: 0 }) })
      const rejectingErrors = trackErrors(rejecting)
      rejecting.use(prod.persistencePlugin({ storage: rejectBackend, validate: (() => false) as never }))
      expect(rejectingErrors.some((e) => (e.error as Error).message.includes('validation'))).toBe(true)

      // 4) 读取抛错：走 onError
      const readFailBackend: StorageBackend = {
        getItem: () => {
          throw new Error('read fail')
        },
        setItem: () => {},
        removeItem: () => {},
      }
      const readFail = prod.createStore({ name: 'p4', state: () => ({ count: 0 }) })
      const readFailErrors = trackErrors(readFail)
      readFail.use(prod.persistencePlugin({ storage: readFailBackend }))
      expect(readFailErrors.some((e) => (e.error as Error).message === 'read fail')).toBe(true)

      // 5) 写入抛错：走 onError
      const writeFailBackend: StorageBackend = {
        getItem: () => null,
        setItem: () => {
          throw new Error('write fail')
        },
        removeItem: () => {},
      }
      const writeFail = prod.createStore({ name: 'p5', state: () => ({ count: 0 }) })
      const writeFailErrors = trackErrors(writeFail)
      writeFail.use(prod.persistencePlugin({ storage: writeFailBackend }))
      writeFail.setState('count', 1)
      expect(writeFailErrors.some((e) => (e.error as Error).message === 'write fail')).toBe(true)

      // 6) clearOnUninstall 清理失败：走 onError
      const removeFailBackend: StorageBackend = {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {
          throw new Error('remove fail')
        },
      }
      const removeFail = prod.createStore({ name: 'p6', state: () => ({ count: 0 }) })
      const removeFailErrors = trackErrors(removeFail)
      const removeFailUninstall = removeFail.use(prod.persistencePlugin({ storage: removeFailBackend, clearOnUninstall: true }))
      removeFailUninstall()
      expect(removeFailErrors.some((e) => (e.error as Error).message === 'remove fail')).toBe(true)

      // 7) 卸载末次补写时 filter 抛错：走 onError
      const filterFail = prod.createStore({ name: 'p7', state: () => ({ count: 0 }), notify: { async: true } })
      const filterFailErrors = trackErrors(filterFail)
      const filterFailUninstall = filterFail.use(
        prod.persistencePlugin({
          storage: memoryBackend().backend,
          restore: false,
          filter: () => {
            throw new Error('filter fail')
          },
        }),
      )
      filterFailUninstall()
      expect(filterFailErrors.some((e) => (e.error as Error).message === 'filter fail')).toBe(true)

      // 8) filter 返回非对象：生产期不打印 console.error，仍走 onError
      const badFilter = prod.createStore({ name: 'p8', state: () => ({ count: 0 }) })
      const badFilterErrors = trackErrors(badFilter)
      badFilter.use(
        prod.persistencePlugin({
          storage: memoryBackend().backend,
          restore: false,
          filter: () => undefined as never,
        }),
      )
      badFilter.setState('count', 1)
      expect(badFilterErrors.some((e) => (e.error as Error).message.includes('plain object'))).toBe(true)
      badFilter.destroy()

      expect(console.log).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
      expect(console.error).not.toHaveBeenCalled()

      noBackend.destroy()
      restored.destroy()
      rejecting.destroy()
      readFail.destroy()
      writeFail.destroy()
      removeFail.destroy()
      filterFail.destroy()
    } finally {
      process.env.NODE_ENV = previousEnv
      jest.resetModules()
    }
  })
})

/** 从一次 setItem 调用里取回写盘内容并解析 */
function mapValue(calls: Array<{ op: 'get' | 'set' | 'remove'; key: string; value?: string }>) {
  const last = calls[calls.length - 1]
  return JSON.parse(last.value as string) as Record<string, unknown>
}

describe('persistencePlugin · schemaVersion 恢复后卸载去重', () => {
  it('配置 schemaVersion 时 lastSaved 按信封序列化种子化：恢复后 destroy 不重复写', () => {
    // 存储载荷与「当前会写出的载荷」一致（含默认键 user）：这是  之后仍会种子化去重的前提
    const { backend, writes } = memoryBackend({ k: JSON.stringify({ $tallyV: 2, $tallyD: { count: 7, user: { name: '' } } }) })
    const store = makeStore()
    store.use(persistencePluginWithFilter({ storage: backend, key: 'k', schemaVersion: 2 }))
    expect(store.getState().count).toBe(7)
    expect(writes()).toHaveLength(0)

    // 回归：恢复种子化与 saveState 同为 { $tallyV, $tallyD } 信封口径，
    // 卸载末次补写应被 lastSaved 去重跳过；裸状态序列化会让两者永不相等、每次 destroy 重写一次
    store.destroy()
    expect(writes()).toHaveLength(0)
  })

  it('恢复后的真实变更仍按信封落盘一次，destroy 不重复写', () => {
    const { backend, map, writes } = memoryBackend({
      k: JSON.stringify({ $tallyV: 2, $tallyD: { count: 7, user: { name: 'restored' } } }),
    })
    const store = makeStore()
    store.use(persistencePluginWithFilter({ storage: backend, key: 'k', schemaVersion: 2 }))
    expect(writes()).toHaveLength(0)

    store.setState('count', 8)
    expect(writes()).toHaveLength(1)
    expect(JSON.parse(map.get('k') as string)).toEqual({
      $tallyV: 2,
      $tallyD: { count: 8, user: { name: 'restored' } },
    })

    store.destroy()
    expect(writes()).toHaveLength(1)
  })
})

describe('persistencePlugin ·  深层敏感键落盘审计', () => {
  it('嵌套敏感字段命中即拒绝整次落盘并上报完整路径（不做顶层 delete 后写其余）', () => {
    const { backend, writes } = memoryBackend()
    const store = makeStore()
    const errors = trackErrors(store)
    store.use(
      persistencePluginWithFilter({
        storage: backend,
        // 只持久化 count + 嵌套 profile（phone 是敏感键）：整包必须拒绝，不能只删顶层
        filter: ((state: { count: number }) => ({ count: state.count, profile: { phone: '13812345678' } })) as never,
      }),
    )
    store.setState('count', 1)

    expect(writes()).toHaveLength(0)
    expect(errors.some((e) => (e.error as Error).message.includes('profile.phone') && e.source === 'persistence')).toBe(true)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('profile.phone'))

    // 卸载末次补写同样命中：不写存储、不产生明文载荷
    store.destroy()
    expect(writes()).toHaveLength(0)
  })
})

describe('persistencePlugin · 非 Error 抛出的 String 兜底', () => {
  it('恢复阶段后端抛非 Error：onError 消息用 String(error)', () => {
    const backend: StorageBackend = {
      getItem: () => {
        throw 'read-string-boom'
      },
      setItem: () => {},
      removeItem: () => {},
    }
    const store = makeStore({ name: 'p-str-read' })
    const errors = trackErrors(store)
    store.use(persistencePluginWithFilter({ storage: backend, key: 'k' }))
    expect(errors.some((e) => e.source === 'persistence' && (e.error as Error).message === 'read-string-boom')).toBe(true)
    store.destroy()
  })

  it('保存阶段后端抛非 Error：onError 消息用 String(error)', () => {
    const backend: StorageBackend = {
      getItem: () => null,
      setItem: () => {
        throw 'write-string-boom'
      },
      removeItem: () => {},
    }
    const store = makeStore({ name: 'p-str-write' })
    const errors = trackErrors(store)
    store.use(persistencePluginWithFilter({ storage: backend, key: 'k', restore: false }))
    store.setState('count', 1)
    expect(errors.some((e) => (e.error as Error).message === 'write-string-boom')).toBe(true)
    store.destroy()
  })

  it('卸载末次补写时 filter 抛非 Error：onError 消息用 String(error)', () => {
    const store = makeStore({ name: 'p-str-uninstall' })
    const errors = trackErrors(store)
    store.use(
      persistencePluginWithFilter({
        storage: memoryBackend().backend,
        key: 'k',
        restore: false,
        filter: (() => {
          throw 'filter-string-boom'
        }) as never,
      }),
    )
    store.destroy()
    expect(errors.some((e) => e.source === 'persistence' && (e.error as Error).message === 'filter-string-boom')).toBe(true)
  })

  it('clearOnUninstall 清理抛非 Error：onError 消息用 String(error)', () => {
    const backend: StorageBackend = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw 'remove-string-boom'
      },
    }
    const store = makeStore({ name: 'p-str-remove' })
    const errors = trackErrors(store)
    store.use(persistencePluginWithFilter({ storage: backend, key: 'k', restore: false, clearOnUninstall: true }))
    store.destroy()
    expect(errors.some((e) => (e.error as Error).message === 'remove-string-boom')).toBe(true)
  })
})

describe('persistencePlugin · 生产模式：告警经 onError 而非 console', () => {
  it('未知选项：生产期不打印 console.warn，但仍上报 onError', async () => {
    const previousEnv = process.env.NODE_ENV
    try {
      const prod = await enterProduction()
      const store = prod.createStore({ name: 'p9', state: () => ({ count: 0 }) })
      const errors = trackErrors(store)
      store.use(prod.persistencePlugin({ storage: memoryBackend().backend, key: 'k', schemaVerion: 2 } as never))
      expect(errors.some((e) => (e.error as Error).message.includes('未识别的选项'))).toBe(true)
      expect(console.warn).not.toHaveBeenCalled()
      store.destroy()
    } finally {
      process.env.NODE_ENV = previousEnv
      jest.resetModules()
    }
  })

  it('配额告警：生产期不打印 console.warn，但仍上报 onError', async () => {
    const previousEnv = process.env.NODE_ENV
    try {
      const prod = await enterProduction()
      const store = prod.createStore({ name: 'p10', state: () => ({ blob: '' }) })
      const errors = trackErrors(store)
      store.use(prod.persistencePlugin({ storage: memoryBackend().backend, key: 'k' }))
      store.setState('blob', 'x'.repeat(950_000))
      expect(errors.some((e) => (e.error as Error).message.includes('接近单 key 上限'))).toBe(true)
      expect(console.warn).not.toHaveBeenCalled()
      store.destroy()
    } finally {
      process.env.NODE_ENV = previousEnv
      jest.resetModules()
    }
  })
})

describe('persistencePlugin · 配额告警按 UTF-8 字节折算', () => {
  it('中文/emoji 载荷：UTF-16 码元数低于阈值但 UTF-8 字节超阈值时仍告警', () => {
    const payloads = ['中'.repeat(310_000), '😀'.repeat(230_000)]
    for (const [index, blob] of payloads.entries()) {
      const { backend, writes } = memoryBackend()
      const store = createStore({ name: 'quota-utf8-' + index, state: () => ({ blob: '' }) })
      const errors = trackErrors(store)
      store.use(persistencePluginWithFilter({ storage: backend, key: 'quota-key-' + index }))

      store.setState('blob', blob)

      expect(writes()).toHaveLength(1)
      // 旧口径用 serialized.length（UTF-16 码元数）比较 900KB 阈值：这两份载荷都低于阈值
      expect((writes()[0].value as string).length).toBeLessThan(900_000)
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('接近单 key 上限'))
      expect(errors.some((e) => (e.error as Error).message.includes('收缩 filter'))).toBe(true)
      store.destroy()
    }
  })
})

describe('persistencePlugin · 恢复后升级写回 / 配额单次序列化', () => {
  it('存储载荷与当前状态仅差默认键：仍按恢复结果种子化去重，不强制重写', () => {
    const { backend, writes } = memoryBackend({
      k: JSON.stringify({ $tallyV: 2, $tallyD: { count: 7 } }),
    })
    const store = makeStore()
    store.use(persistencePluginWithFilter({ storage: backend, key: 'k', schemaVersion: 2 }))
    expect(store.getState().count).toBe(7)
    expect(writes()).toHaveLength(0)

    // 恢复状态（含默认 user）与磁盘文本并非逐字节一致，但版本一致、无待升级写回：
    // 种子化必须以恢复结果为基线（否则每次启动都重写，放大共享 key stale 覆盖风险）
    store.destroy()
    expect(writes()).toHaveLength(0)
  })

  it('配额告警直接折算已序列化文本的 UTF-8 字节：不再二次 JSON.stringify', () => {
    const stringifySpy = jest.spyOn(JSON, 'stringify')
    const { backend, writes } = memoryBackend()
    const store = createStore({ name: 'quota-once', state: () => ({ blob: '' }) })
    store.use(persistencePluginWithFilter({ storage: backend, key: 'k' }))

    // 载荷码元数超过旧实现的预筛上界（会触发 estimateJsonBytes 的二次 stringify）
    store.setState('blob', 'x'.repeat(310_000))

    expect(writes()).toHaveLength(1)
    // 保存路径只对载荷做一次 JSON.stringify；旧实现会为配额估算再序列化一遍
    expect(stringifySpy).toHaveBeenCalledTimes(1)
    store.destroy()
  })

  it('两字节区字符的 UTF-8 折算正确：字节未到阈值时不会误报配额告警', () => {
    const { backend, writes } = memoryBackend()
    const store = createStore({ name: 'quota-two-byte', state: () => ({ blob: '' }) })
    store.use(persistencePluginWithFilter({ storage: backend, key: 'k' }))

    // 'é' 为 2 字节：310k 字符约 620KB < 900KB 阈值；码元数×3 预筛会进入告警判定但不应告警
    store.setState('blob', 'é'.repeat(310_000))
    expect(writes()).toHaveLength(1)
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('接近单 key 上限'))
    store.destroy()
  })

  it('emoji 按码点计 4 字节：150k emoji 不会被旧口径误判为 900KB', () => {
    const { backend, writes } = memoryBackend()
    const store = createStore({ name: 'quota-emoji-codepoint', state: () => ({ blob: '' }) })
    store.use(persistencePluginWithFilter({ storage: backend, key: 'k' }))

    // 150k emoji = 300k UTF-16 码元：旧实现对代理对按 6 字节计会得到 900KB 而误报；
    // 码点口径为 4 字节 = 600KB，低于阈值
    store.setState('blob', '😀'.repeat(150_000))
    expect(writes()).toHaveLength(1)
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('接近单 key 上限'))
    store.destroy()
  })

  it('迁移待升级 + notify.async：恢复后的首个通知即完成升级写回，无需等 destroy', () => {
    const { backend, map, writes } = memoryBackend({
      k: JSON.stringify({ $tallyV: 1, $tallyD: { count: 5 } }),
    })
    const store = createStore({ name: 'async-upgrade', state: () => ({ count: 0, theme: 'light' }), notify: { async: true } })
    store.use(
      persistencePluginWithFilter({
        storage: backend,
        key: 'k',
        schemaVersion: 2,
        migrations: { 2: (data: Record<string, unknown>) => ({ ...data, theme: 'dark' }) },
      }),
    )
    expect(store.getState().theme).toBe('dark')
    expect(writes()).toHaveLength(0)

    return Promise.resolve().then(() => {
      // 升级待办时恢复通知不再被吸收：微任务通知直接触发一次升级写回
      expect(writes()).toHaveLength(1)
      expect(JSON.parse(map.get('k') as string)).toEqual({ $tallyV: 2, $tallyD: { count: 5, theme: 'dark' } })
      store.destroy()
      expect(writes()).toHaveLength(1)
    })
  })
})

describe('persistence · 落盘载荷不可序列化值 fail-closed', () => {
  class PersistInstance {
    value = 1
  }
  it.each<[string, Record<string, unknown>, string]>([
    ['Map', { bag: new Map([['k', 1]]) }, 'bag'],
    ['Set', { tags: new Set([1]) }, 'tags'],
    ['undefined', { extra: undefined }, 'extra'],
    ['函数', { handler: () => 1 }, 'handler'],
    ['RegExp', { re: /x/ }, 're'],
    ['类实例', { inst: new PersistInstance() }, 'inst'],
  ])('%s：拒绝整次落盘、不写后端并 onError(PERSISTENCE_ERROR)', (_label, bad, path) => {
    const { backend, calls } = memoryBackend()
    const store = makeStore()
    const errors = trackErrors(store)
    store.use(persistencePluginWithFilter({ storage: backend, filter: () => bad as never }))
    store.setState('count', 1)

    expect(calls.filter((c) => c.op === 'set')).toHaveLength(0)
    const hit = errors.find((e) => e.source === 'persistence' && (e.error as Error).message.includes('不可序列化'))
    expect(hit).toBeDefined()
    expect((hit!.error as Error).message).toContain(path)
    // 开发期额外 console.error；生产期仅 onError（见文件末尾生产块）
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('不可序列化'))
    store.destroy()
  })

  it('循环引用同样拒绝整次落盘，错误消息带首次回边路径', () => {
    const { backend, calls } = memoryBackend()
    const cyclic: Record<string, unknown> = { count: 0 }
    cyclic.self = cyclic
    const store = makeStore()
    const errors = trackErrors(store)
    store.use(persistencePluginWithFilter({ storage: backend, filter: () => cyclic as never }))
    store.setState('count', 1)

    expect(calls.filter((c) => c.op === 'set')).toHaveLength(0)
    expect(errors.some((e) => (e.error as Error).message.includes('不可序列化') && (e.error as Error).message.includes('self'))).toBe(true)
    store.destroy()
  })

  it('载荷遍历自身抛错时 fail-closed 拒绝并上报（dev console.error）', () => {
    const { backend, calls } = memoryBackend()
    const store = makeStore()
    const errors = trackErrors(store)
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys boom')
        },
        getPrototypeOf: () => Object.prototype,
      },
    )
    // 敏感键审计只遍历字符串键（Object.keys），符号键下的恶意 Proxy 能通过审计、在序列化遍历时才抛错，
    // 正好覆盖「序列化校验自身失败 → fail-closed」分支
    const payload: Record<PropertyKey, unknown> = {}
    payload[Symbol('hostile')] = hostile
    store.use(persistencePluginWithFilter({ storage: backend, filter: () => payload as never }))
    store.setState('count', 1)

    expect(calls.filter((c) => c.op === 'set')).toHaveLength(0)
    expect(errors.some((e) => e.source === 'persistence' && (e.error as Error).message.includes('序列化校验失败'))).toBe(true)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('序列化校验失败'), expect.any(Error))
    store.destroy()
  })

  it('Date 放行并落为 ISO 字符串', () => {
    const { backend, map, writes } = memoryBackend()
    const store = makeStore()
    store.use(persistencePluginWithFilter({ storage: backend, filter: () => ({ at: new Date(0) }) as never }))
    store.setState('count', 1)

    expect(writes()).toHaveLength(1)
    expect((JSON.parse(map.get('tallystore_app') as string) as { at: string }).at).toBe(new Date(0).toISOString())
    store.destroy()
  })
})
