/**  / AS-07：持久化 schemaVersion 信封、迁移链、配额告警、未知选项告警 */
import { createStore } from '../../../src/index.js'
import { persistencePlugin } from '../../../src/plugins.js'
import type { StorageBackend } from '../../../src/plugins.js'

/** 持久化必须显式声明 filter；旧用例默认语义为「全量落盘」，这里显式给恒等白名单保留原语义 */
const keepAll = <S extends object>(state: S): S => state
const persistencePluginWithFilter = (options: Record<string, unknown> = {}) =>
  persistencePlugin({ filter: keepAll, ...options } as never) as ReturnType<typeof persistencePlugin>

function memoryBackend(initial: Record<string, string> = {}) {
  const memory = new Map(Object.entries(initial))
  const calls: Array<{ op: string }> = []
  const backend: StorageBackend = {
    getItem: (k) => {
      calls.push({ op: 'get' })
      return memory.get(k) ?? null
    },
    setItem: (k, v) => {
      calls.push({ op: 'set' })
      memory.set(k, v)
    },
    removeItem: (k) => {
      calls.push({ op: 'remove' })
      memory.delete(k)
    },
  }
  return { backend, memory, calls }
}

function makeStore<S extends Record<string, unknown>>(name: string, state: () => S) {
  return createStore({ name, state })
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe(' 版本信封与迁移', () => {
  it('配置 schemaVersion 时落盘为 { $tallyV, $tallyD } 信封，恢复往返一致', () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend, memory } = memoryBackend()
    const store = makeStore('fr19-rt', () => ({ count: 0 }))
    store.use(persistencePluginWithFilter({ storage: backend, key: 'k', schemaVersion: 2 }))
    store.setState('count', 7)
    const raw = memory.get('k') ?? ''
    expect(JSON.parse(raw)).toEqual({ $tallyV: 2, $tallyD: { count: 7 } })
    store.destroy()

    const restored = makeStore('fr19-rt', () => ({ count: 0 }))
    restored.use(persistencePluginWithFilter({ storage: backend, key: 'k', schemaVersion: 2 }))
    expect(restored.getState().count).toBe(7)
    restored.destroy()
  })

  it('版本升级触发迁移链：按 savedV+1 → 当前版本顺序执行（AS-07）', () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    // 磁盘上是 v1 数据
    const { backend } = memoryBackend({ k: JSON.stringify({ $tallyV: 1, $tallyD: { count: 5, theme: 'dark' } }) })
    const order: number[] = []
    const store = makeStore('fr19-mig', () => ({ count: 0, theme: 'light', locale: 'zh' }))
    store.use(
      persistencePluginWithFilter({
        storage: backend,
        key: 'k',
        schemaVersion: 3,
        migrations: {
          2: (data: Record<string, unknown>) => {
            order.push(2)
            return { ...data, theme: data.theme === 'dark' ? 'night' : data.theme }
          },
          3: (data: Record<string, unknown>) => {
            order.push(3)
            return { ...data, locale: 'zh-CN' }
          },
        },
      }),
    )
    expect(order).toEqual([2, 3])
    expect(store.getState().count).toBe(5)
    expect(store.getState().theme).toBe('night')
    expect(store.getState().locale).toBe('zh-CN')
    store.destroy()
  })

  it('迁移后不种子化 lastSaved：恢复后 destroy 把升级后的信封写回一次', () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend, memory, calls } = memoryBackend({ k: JSON.stringify({ $tallyV: 1, $tallyD: { count: 5 } }) })
    const store = makeStore('fr19-upgrade-writeback', () => ({ count: 0, theme: 'light' }))
    store.use(
      persistencePluginWithFilter({
        storage: backend,
        key: 'k',
        schemaVersion: 2,
        migrations: { 2: (data: Record<string, unknown>) => ({ ...data, theme: 'dark' }) },
      }),
    )
    expect(store.getState().count).toBe(5)
    expect(store.getState().theme).toBe('dark')

    // 迁移只发生在内存里：卸载时必须把升级后的 v2 信封写回，否则存储永远停在 v1、每次启动重跑迁移
    store.destroy()
    expect(calls.filter((call) => call.op === 'set')).toHaveLength(1)
    expect(JSON.parse(memory.get('k') as string)).toEqual({ $tallyV: 2, $tallyD: { count: 5, theme: 'dark' } })

    // 第二次启动：磁盘已是 v2 且等于当前载荷，恢复后 destroy 不再重写
    const restored = makeStore('fr19-upgrade-writeback', () => ({ count: 0, theme: 'light' }))
    restored.use(
      persistencePluginWithFilter({
        storage: backend,
        key: 'k',
        schemaVersion: 2,
        migrations: { 2: (data: Record<string, unknown>) => ({ ...data, theme: 'dark' }) },
      }),
    )
    expect(restored.getState().theme).toBe('dark')
    restored.destroy()
    expect(calls.filter((call) => call.op === 'set')).toHaveLength(1)
  })

  it('迁移抛错：回退默认值并上报，不注入坏数据', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend } = memoryBackend({ k: JSON.stringify({ $tallyV: 1, $tallyD: { count: 5 } }) })
    const store = makeStore('fr19-bad', () => ({ count: 0 }))
    const errors: Array<{ message: string }> = []
    store.hooks.on('onError', (error: unknown) => {
      errors.push({ message: (error as Error).message })
    })
    store.use(
      persistencePluginWithFilter({
        storage: backend,
        key: 'k',
        schemaVersion: 2,
        migrations: {
          2: () => {
            throw new Error('boom-migration')
          },
        },
      }),
    )
    expect(store.getState().count).toBe(0)
    expect(errors.some((e) => e.message.includes('迁移到 v2 失败') && e.message.includes('boom-migration'))).toBe(true)
    store.destroy()
  })

  it('迁移链缺步：跳过恢复并上报', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend } = memoryBackend({ k: JSON.stringify({ $tallyV: 1, $tallyD: { count: 5 } }) })
    const store = makeStore('fr19-gap', () => ({ count: 0 }))
    const errors: Array<{ message: string }> = []
    store.hooks.on('onError', (error: unknown) => {
      errors.push({ message: (error as Error).message })
    })
    store.use(persistencePluginWithFilter({ storage: backend, key: 'k', schemaVersion: 3, migrations: { 3: (d: Record<string, unknown>) => d } }))
    expect(store.getState().count).toBe(0)
    expect(errors.some((e) => e.message.includes('缺少 v2 的迁移函数'))).toBe(true)
    store.destroy()
  })

  it('存储版本高于当前（降级）：跳过恢复并上报', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend } = memoryBackend({ k: JSON.stringify({ $tallyV: 5, $tallyD: { count: 9 } }) })
    const store = makeStore('fr19-down', () => ({ count: 0 }))
    const errors: Array<{ message: string }> = []
    store.hooks.on('onError', (error: unknown) => {
      errors.push({ message: (error as Error).message })
    })
    store.use(persistencePluginWithFilter({ storage: backend, key: 'k', schemaVersion: 2 }))
    expect(store.getState().count).toBe(0)
    expect(errors.some((e) => e.message.includes('高于当前 schemaVersion') && e.message.includes('不支持降级'))).toBe(true)
    store.destroy()
  })

  it('$tallyV 缺失/非数字但 $tallyD 存在：判定信封损坏并跳过恢复', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const payloads = [{ $tallyD: { count: 9 } }, { $tallyV: 'x', $tallyD: { count: 9 } }]
    payloads.forEach((payload, index) => {
      const { backend } = memoryBackend({ k: JSON.stringify(payload) })
      const store = makeStore('fr19-envelope-corrupt-' + index, () => ({ count: 0 }))
      const errors: Array<{ message: string }> = []
      store.hooks.on('onError', (error: unknown) => {
        errors.push({ message: (error as Error).message })
      })
      store.use(persistencePluginWithFilter({ storage: backend, key: 'k', schemaVersion: 2 }))

      expect(store.getState().count).toBe(0)
      // 坏信封结构不得被当业务字段注入
      expect(Object.prototype.hasOwnProperty.call(store.getState(), '$tallyD')).toBe(false)
      expect(errors.some((e) => e.message.includes('版本信封损坏') && e.message.includes('$tallyV'))).toBe(true)
      store.destroy()
    })
  })

  it('未配置版本化时裸对象照常恢复（向后兼容）', () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend } = memoryBackend({ k: JSON.stringify({ count: 3 }) })
    const store = makeStore('fr19-legacy', () => ({ count: 0 }))
    store.use(persistencePluginWithFilter({ storage: backend, key: 'k' }))
    expect(store.getState().count).toBe(3)
    store.destroy()
  })

  it('信封数据非纯对象：跳过恢复并上报（不注入坏数据）', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend } = memoryBackend({ k: JSON.stringify({ $tallyV: 1, $tallyD: 'bad' }) })
    const store = makeStore('fr19-envelope-bad', () => ({ count: 0 }))
    const errors: Array<{ message: string }> = []
    store.hooks.on('onError', (error: unknown) => {
      errors.push({ message: (error as Error).message })
    })
    store.use(persistencePluginWithFilter({ storage: backend, key: 'k', schemaVersion: 2 }))
    expect(store.getState().count).toBe(0)
    expect(errors.some((e) => e.message.includes('Versioned payload data is not a plain object'))).toBe(true)
    store.destroy()
  })

  it('信封存在但未配置 schemaVersion：以存储版本为准，不执行迁移', () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend } = memoryBackend({ k: JSON.stringify({ $tallyV: 1, $tallyD: { count: 4 } }) })
    const store = makeStore('fr19-envelope-nov', () => ({ count: 0 }))
    const errors: Array<{ message: string }> = []
    store.hooks.on('onError', (error: unknown) => {
      errors.push({ message: (error as Error).message })
    })
    store.use(persistencePluginWithFilter({ storage: backend, key: 'k' }))
    expect(store.getState().count).toBe(4)
    expect(errors).toHaveLength(0)
    store.destroy()
  })

  it('迁移函数返回非纯对象：跳过恢复并上报（不注入坏数据）', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend } = memoryBackend({ k: JSON.stringify({ $tallyV: 1, $tallyD: { count: 5 } }) })
    const store = makeStore('fr19-mig-bad-return', () => ({ count: 0 }))
    const errors: Array<{ message: string }> = []
    store.hooks.on('onError', (error: unknown) => {
      errors.push({ message: (error as Error).message })
    })
    store.use(
      persistencePluginWithFilter({
        storage: backend,
        key: 'k',
        schemaVersion: 2,
        migrations: { 2: () => [1, 2] as never },
      }),
    )
    expect(store.getState().count).toBe(0)
    expect(errors.some((e) => e.message.includes('migration v2 returned non-plain object'))).toBe(true)
    store.destroy()
  })

  it('迁移函数抛非 Error：失败信息用 String(error) 兜底', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend } = memoryBackend({ k: JSON.stringify({ $tallyV: 1, $tallyD: { count: 5 } }) })
    const store = makeStore('fr19-mig-string', () => ({ count: 0 }))
    const errors: Array<{ message: string }> = []
    store.hooks.on('onError', (error: unknown) => {
      errors.push({ message: (error as Error).message })
    })
    store.use(
      persistencePluginWithFilter({
        storage: backend,
        key: 'k',
        schemaVersion: 2,
        migrations: {
          2: () => {
            throw 'migration-string-boom'
          },
        },
      }),
    )
    expect(store.getState().count).toBe(0)
    expect(errors.some((e) => e.message.includes('migration-string-boom'))).toBe(true)
    store.destroy()
  })
})

describe(' 配额与选项', () => {
  it('未知选项：开发期 console.warn + onError 上报（不再静默忽略）', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend } = memoryBackend()
    const store = makeStore('fr19-unknown', () => ({ count: 0 }))
    const errors: Array<{ message: string }> = []
    store.hooks.on('onError', (error: unknown) => {
      errors.push({ message: (error as Error).message })
    })
    store.use(persistencePluginWithFilter({ storage: backend, key: 'k', schemaVerion: 2 } as never))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('schemaVerion'))
    expect(errors.some((e) => e.message.includes('schemaVerion') && e.message.includes('未识别的选项'))).toBe(true)
    store.destroy()
  })

  it('接近单 key 上限（≥900KB）告警一次并给收缩建议', () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { backend } = memoryBackend()
    const store = makeStore('fr19-quota', () => ({ blob: '' }))
    const errors: Array<{ message: string }> = []
    store.hooks.on('onError', (error: unknown) => {
      errors.push({ message: (error as Error).message })
    })
    store.use(persistencePluginWithFilter({ storage: backend, key: 'k', filter: (s: { blob: string }) => ({ blob: s.blob }) }))
    store.setState('blob', 'x'.repeat(950_000))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('接近单 key 上限')
    expect(errors.some((e) => e.message.includes('收缩 filter'))).toBe(true)
    // 再次落盘不重复告警
    store.setState('blob', 'y'.repeat(950_000))
    expect(warn).toHaveBeenCalledTimes(1)
    store.destroy()
  })

  it('restore: false 时不读存储（启动路径零同步读，关闭口径）', () => {
    const { backend, calls } = memoryBackend({ k: JSON.stringify({ count: 9 }) })
    const store = makeStore('fr19-off', () => ({ count: 0 }))
    store.use(persistencePluginWithFilter({ storage: backend, key: 'k', restore: false }))
    expect(store.getState().count).toBe(0)
    expect(calls.filter((call) => call.op === 'get')).toHaveLength(0)
    store.destroy()
  })
})
