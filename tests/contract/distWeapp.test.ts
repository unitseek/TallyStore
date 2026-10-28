/**
 *  契约测试：发布产物（dist-weapp）的入口、导出面与核心行为与源码一致（AS-13）。
 *
 * 只断言「对外契约」：入口存在、导出名与类型声明一致、核心语义（写入口/通知/action/
 * getter/保护代理）在产物字节上成立。行为细节由 tests/unit 覆盖，这里防的是
 * 「源码对、产物错」——构建脚本漏文件、入口拼错、转译丢导出。
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { distAvailable, requireFromDist } from './loadDist.js'

const repoRoot = path.resolve(__dirname, '../..')

// jest 不收集此目录覆盖率；dist-weapp 是构建产物，不能出现在 coverage 里
const describeWithDist = distAvailable ? describe : describe.skip

describeWithDist(' 契约测试（dist-weapp）', () => {
  it('主入口导出完整：核心 API 一一在列', () => {
    const index = requireFromDist('.')
    const expected = ['createStore', 'Store', 'TallyStoreError', 'isTallyStoreError', 'withPageStore', 'withComponentStore', 'withAppStore']
    for (const name of expected) {
      expect(index[name]).toBeDefined()
    }
    expect(typeof index.createStore).toBe('function')
    expect(typeof index.withPageStore).toBe('function')
    // ErrorCode 当前是 type-only 导出（ 复核是否需要作为运行时值导出）
    expect(index.ErrorCode).toBeUndefined()
  })

  it('plugins 入口导出持久化与日志插件', () => {
    const plugins = requireFromDist('./plugins')
    expect(plugins.persistencePlugin).toBeDefined()
    expect(plugins.loggerPlugin).toBeDefined()
    expect(plugins.WxStorageBackend).toBeDefined()
  })

  it('四个运行时入口文件齐全（package.json exports 派生）', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { miniprogram: string; exports: Record<string, { types: string }> }
    const entries = ['./plugins', './plugins/persistence', './plugins/logger']
    const files = ['index.js', ...entries.map((entry) => entry.replace(/^\.\//, '') + '.js')]
    for (const file of files) {
      expect(existsSync(path.join(repoRoot, pkg.miniprogram, file))).toBe(true)
    }
    // types 声明文件与运行时入口一一对应（'./package.json' 是字符串形式条目，跳过）
    for (const [entry, value] of Object.entries(pkg.exports)) {
      if (value === null || typeof value !== 'object') {
        continue
      }
      const typeFile = value.types.replace(/^\.\//, '')
      expect(existsSync(path.join(repoRoot, typeFile))).toBe(true)
      if (entry !== '.') {
        const runtimeFile = entry.replace(/^\.\//, '') + '.js'
        expect(existsSync(path.join(repoRoot, pkg.miniprogram, runtimeFile))).toBe(true)
      }
    }
  })

  it('产物上的核心语义：写入口通知、dispatch 路由、getter、保护代理', () => {
    const { createStore } = requireFromDist('.') as typeof import('../../src/index.js')
    const store = createStore({
      name: 'contract-core',
      state: () => ({ count: 0 }),
      actions: {
        inc(step = 1) {
          this.setState('count', this.getState().count + step)
        },
      },
      getters: { doubled: (state) => state.count * 2 },
    })
    const listener = jest.fn()
    store.subscribe(listener, { readOnly: true })
    store.actions.inc(2)
    store.dispatch('inc', 3)
    expect(store.getState().count).toBe(5)
    expect(store.getter('doubled')).toBe(10)
    expect(listener).toHaveBeenCalledTimes(2)
    // 保护代理：开发期（NODE_ENV 非 production）直写抛错
    expect(() => {
      store.state.count = 99
    }).toThrow(/Direct mutation/)
    try {
      store.dispatch('missing')
      throw new Error('should throw')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('ACTION_NOT_FOUND')
    }
    store.destroy()
  })

  it('产物上的集成语义：withPageStore 建立映射并自动解绑（宿主模拟）', () => {
    const { createStore, withPageStore } = requireFromDist('.') as typeof import('../../src/index.js')
    const store = createStore({
      name: 'contract-page',
      state: () => ({ count: 0 }),
      actions: {
        inc() {
          this.setState('count', this.getState().count + 1)
        },
      },
    })
    const setDataCalls: Array<Record<string, unknown>> = []
    const host = {
      data: {} as Record<string, unknown>,
      setData(patch: Record<string, unknown>) {
        setDataCalls.push(patch)
        Object.assign(host.data, patch)
      },
    }
    const decorator = withPageStore(store, { mapState: ['count'] })
    const page = (decorator as unknown as (config: Record<string, unknown>) => { onLoad: (this: typeof host) => void; onUnload: (this: typeof host) => void })({
      data: {},
    })
    page.onLoad.call(host)
    setDataCalls.splice(0, setDataCalls.length)

    store.actions.inc()
    expect(setDataCalls.length).toBe(1)
    expect(setDataCalls[0]).toEqual({ count: 1 })

    page.onUnload.call(host)
    setDataCalls.splice(0, setDataCalls.length)
    store.actions.inc()
    // 卸载后订阅已解绑：无残留 setData
    expect(setDataCalls.length).toBe(0)
    store.destroy()
  })

  it('产物上的持久化语义：白名单落盘与恢复往返', () => {
    const memory = new Map<string, string>()
    ;(globalThis as { wx?: unknown }).wx = {
      getStorageSync: (key: string) => (memory.has(key) ? memory.get(key) : ''),
      setStorageSync: (key: string, value: string) => memory.set(key, value),
      removeStorageSync: (key: string) => memory.delete(key),
      getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    }
    try {
      const { createStore } = requireFromDist('.') as typeof import('../../src/index.js')
      const { persistencePlugin } = requireFromDist('./plugins') as typeof import('../../src/plugins.js')
      const filter = (state: { count: number; secret: string }) => ({ count: state.count })
      const store = createStore({ name: 'contract-persist', state: () => ({ count: 0, secret: 'x' }) })
      store.use(persistencePlugin({ key: 'contract_persist', filter }))
      store.setState('count', 7)
      store.setState('secret', 'leak')
      // 白名单外字段不落盘
      const raw = memory.get('contract_persist') as string
      expect(raw).toContain('"count":7')
      expect(raw).not.toContain('leak')
      store.destroy()

      const restored = createStore({ name: 'contract-persist', state: () => ({ count: 0, secret: '' }) })
      restored.use(persistencePlugin({ key: 'contract_persist', filter }))
      expect(restored.getState().count).toBe(7)
      restored.destroy()
    } finally {
      delete (globalThis as { wx?: unknown }).wx
    }
  })
})
