/**
 *  生产期行为：state 构造期不因校验抛错；重复插件实例经 onError(INVALID_CONFIG, 'plugin') 上报。
 * 生产模式分支按 tests/CONVENTIONS.md：NODE_ENV=production + resetModules + 动态 import。
 */

const flushModules = async (): Promise<typeof import('../../../src/index.js')> => {
  jest.resetModules()
  process.env.NODE_ENV = 'production'
  return import('../../../src/index.js')
}

const restoreEnv = (): void => {
  delete process.env.NODE_ENV
  jest.resetModules()
}

afterEach(restoreEnv)

describe(' · 生产期 state 校验与重复插件', () => {
  it('生产期构造期 state 校验不抛错：函数等硬不可序列化值仍可构造（仅开发期拦截）', async () => {
    const { createStore } = await flushModules()
    const looseCreateStore = createStore as unknown as (config: unknown) => { getState(): { count: number }; destroy(): void }
    const store = looseCreateStore({ name: 't1-prod-state', state: () => ({ handler: () => 1, count: 0 }) })
    expect(store.getState().count).toBe(0)
    store.destroy()
  })

  it('生产期 persistence 遇不可序列化值：仅 onError、不写盘、不打印 console.error', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      jest.resetModules()
      process.env.NODE_ENV = 'production'
      const factory = await import('../../../src/core/store/factory.js')
      const pluginModule = await import('../../../src/plugins/persistence.js')
      const memory = new Map<string, string>()
      const backend = {
        getItem: (key: string) => (memory.has(key) ? (memory.get(key) as string) : null),
        setItem: (key: string, value: string) => void memory.set(key, value),
        removeItem: (key: string) => void memory.delete(key),
      }
      const store = factory.createStore({ name: 't1-prod-persist', state: () => ({ count: 0, payload: null as unknown }) })
      const errors: Array<{ error: { message: string }; source?: string }> = []
      store.hooks.on('onError', (error, source) => errors.push({ error: error as { message: string }, source }))
      store.use(pluginModule.persistencePlugin({ storage: backend, restore: false, filter: (state: never) => state }))
      store.setState('payload' as never, new Map([['k', 1]]) as never)

      expect(memory.size).toBe(0)
      expect(errors.some((entry) => entry.source === 'persistence' && entry.error.message.includes('不可序列化'))).toBe(true)
      expect(consoleError).not.toHaveBeenCalled()
      store.destroy()
    } finally {
      consoleError.mockRestore()
      delete process.env.NODE_ENV
      jest.resetModules()
    }
  })

  it('生产期重复安装同一插件实例：经 onError(INVALID_CONFIG, "plugin") 上报，返回等效卸载句柄', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { createStore } = await flushModules()
      const store = createStore({ name: 't1-prod-plugin', state: () => ({ count: 0 }) })
      const errors: Array<{ error: { code?: string; message: string }; source?: string }> = []
      store.hooks.on('onError', (error, source) => errors.push({ error: error as { code?: string; message: string }, source }))
      const install = jest.fn()
      const uninstall = jest.fn()
      install.mockReturnValue(uninstall)
      const plugin = { name: 'dup-prod', install }
      const first = store.use(plugin)
      const second = store.use(plugin)

      expect(install).toHaveBeenCalledTimes(1)
      expect(warn).not.toHaveBeenCalled()
      const hit = errors.find((entry) => entry.source === 'plugin')
      expect(hit).toBeDefined()
      expect(hit!.error.code).toBe('INVALID_CONFIG')
      expect(hit!.error.message).toContain('已安装')

      second()
      expect(uninstall).toHaveBeenCalledTimes(1)
      first()
      expect(uninstall).toHaveBeenCalledTimes(1)
      store.destroy()
    } finally {
      warn.mockRestore()
    }
  })
})
