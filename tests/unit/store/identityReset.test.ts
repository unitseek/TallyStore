/**  / AS-03：身份/租户切换与状态重置——$reset / resetAll / 持久化草稿清理联动 */
import { createStore, defineStores, withPageStore } from '../../../src/index.js'
import { persistencePlugin } from '../../../src/plugins.js'
import { createHost } from '../../utils/host.js'
import type { StorageBackend } from '../../../src/plugins.js'

function memoryBackend() {
  const memory = new Map<string, string>()
  const backend: StorageBackend = {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => memory.set(k, v),
    removeItem: (k) => memory.delete(k),
  }
  return { backend, memory }
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe(' Store.$reset', () => {
  it('重置为初始状态：旧身份的筛选/草稿/缓存不展示（AS-03）', () => {
    const store = createStore({
      name: 'fr21-reset',
      state: () => ({ tenantId: '', filter: 'all', draft: '', cache: [] as string[] }),
      actions: {
        loginAs(tenant: string) {
          this.$patch({ tenantId: tenant, filter: 'recent', draft: '未发送草稿', cache: ['a', 'b'] })
        },
      },
    })
    store.actions.loginAs('tenant-x')
    expect(store.getState().draft).toBe('未发送草稿')

    store.$reset()
    expect(store.getState()).toEqual({ tenantId: '', filter: 'all', draft: '', cache: [] })
    store.destroy()
  })

  it('构造后外部修改初始状态对象不影响 $reset（初始源按克隆保存）', () => {
    const initial = { nested: { value: 1 }, count: 0 }
    const store = createStore({ name: 'fr21-source', state: initial })
    initial.nested.value = 99
    initial.count = 7
    store.setState('count', 3)
    store.$reset()
    expect(store.getState()).toEqual({ nested: { value: 1 }, count: 0 })
    store.destroy()
  })

  it('重置后订阅仍生效：继续更新（验收 3）', () => {
    const store = createStore({ name: 'fr21-sub', state: () => ({ count: 0 }) })
    const listener = jest.fn()
    store.subscribe(listener, { readOnly: true })
    store.setState('count', 5)
    store.$reset()
    expect(store.getState().count).toBe(0)
    expect(listener).toHaveBeenCalledTimes(2) // 5 的写入 + reset 通知
    store.setState('count', 7)
    expect(listener).toHaveBeenCalledTimes(3)
    expect(store.getState().count).toBe(7)
    store.destroy()
  })

  it('页面映射在 reset 后继续同步（订阅保持，无需重绑）', () => {
    const store = createStore({ name: 'fr21-page', state: () => ({ count: 0 }) })
    const page = withPageStore(store, { mapState: ['count'] })({ data: {} }) as unknown as {
      onLoad: (this: Record<string, unknown>) => void
      onUnload: (this: Record<string, unknown>) => void
    }
    const { host } = createHost()
    page.onLoad.call(host)
    store.setState('count', 3)
    store.$reset()
    expect((host.data as { count: number }).count).toBe(0)
    store.setState('count', 9)
    expect((host.data as { count: number }).count).toBe(9)
    page.onUnload.call(host)
    store.destroy()
  })

  it('重置与持久化联动：默认值写回存储，草稿清理（ 敏感联动）', () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend, memory } = memoryBackend()
    const store = createStore({ name: 'fr21-persist', state: () => ({ tenantId: '', draft: '' }) })
    store.use(
      persistencePlugin({
        storage: backend,
        key: 'k',
        // 白名单排除 tenantId（敏感倾向键，留 draft 演示草稿清理）
        filter: (state: { tenantId: string; draft: string }) => ({ draft: state.draft }),
      }),
    )
    store.$patch({ tenantId: 'tenant-x', draft: '切身份前的草稿' })
    expect(memory.get('k')).toContain('切身份前的草稿')

    store.$reset()
    // 重置通知触发落盘：存储回到默认值（草稿被清理）
    expect(JSON.parse(memory.get('k') ?? '{}')).toEqual({ draft: '' })
    expect(store.getState().tenantId).toBe('')
    store.destroy()
  })

  it('重置只影响目标模块：其它 Store 不受影响（验收 2/4）', () => {
    const user = createStore({ name: 'fr21-user', state: () => ({ tenantId: '' }) })
    const settings = createStore({ name: 'fr21-settings', state: () => ({ theme: 'light' }) })
    user.setState('tenantId', 't1')
    settings.setState('theme', 'dark')
    user.$reset()
    expect(user.getState().tenantId).toBe('')
    // 与身份无关的公共配置不受影响
    expect(settings.getState().theme).toBe('dark')
    user.destroy()
    settings.destroy()
  })
})

describe(' defineStores.resetAll', () => {
  it('全部已实例化模块重置为初始状态；未实例化模块不受影响、实例不销毁', () => {
    const factoryCalls: string[] = []
    const stores = defineStores({
      session: {
        factory: () => {
          factoryCalls.push('session')
          return createStore({ name: 'fr21-ra-session', state: () => ({ token: '' }) })
        },
      },
      profile: {
        dependsOn: ['session'],
        factory: () => {
          factoryCalls.push('profile')
          return createStore({ name: 'fr21-ra-profile', state: () => ({ name: '' }) })
        },
      },
    })
    const session = stores.get('session')
    session.setState('token', 'tk-old')
    stores.resetAll()
    expect(session.getState().token).toBe('')
    expect(session.destroyed).toBe(false)
    // 未实例化的 profile 不触发工厂
    expect(factoryCalls).toEqual(['session'])
    stores.reset()
  })
})

describe(' reset 审计事件（beforeReset / afterReset）', () => {
  it('$reset 发出 beforeReset/afterReset：reason 默认 direct、ok=true、不含状态值', () => {
    const store = createStore({ name: 'fr21-audit-direct', state: () => ({ count: 0, token: '' }) })
    const before = jest.fn()
    const after = jest.fn()
    store.hooks.on('beforeReset', before)
    store.hooks.on('afterReset', after)

    store.$patch({ count: 5 })
    store.$reset()

    expect(before).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledTimes(1)
    const beforeInfo = before.mock.calls[0][0] as { storeName: string; reason: string; timestamp: number }
    const afterInfo = after.mock.calls[0][0] as { storeName: string; reason: string; timestamp: number; ok?: boolean }
    expect(beforeInfo).toEqual({ storeName: 'fr21-audit-direct', reason: 'direct', timestamp: expect.any(Number) })
    expect(afterInfo).toEqual({ storeName: 'fr21-audit-direct', reason: 'direct', timestamp: beforeInfo.timestamp, ok: true })
    // 审计事件只含标识/时间，不携带状态值
    expect(JSON.stringify([beforeInfo, afterInfo])).not.toContain('token')
    store.destroy()
  })

  it('reason=resetAll 透传；重置失败时 afterReset.ok=false 后 rethrow', () => {
    const store = createStore({ name: 'fr21-audit-fail', state: () => ({ count: 0 }) })
    const before = jest.fn()
    const after = jest.fn()
    store.hooks.on('beforeReset', before)
    store.hooks.on('afterReset', after)
    const original = store.$replaceState
    store.$replaceState = (() => {
      throw new Error('replace boom')
    }) as typeof store.$replaceState

    expect(() => (store.$reset as (reason?: 'direct' | 'resetAll') => void)('resetAll')).toThrow('replace boom')
    expect(before.mock.calls[0][0]).toEqual(expect.objectContaining({ reason: 'resetAll' }))
    expect(after).toHaveBeenCalledTimes(1)
    expect(after.mock.calls[0][0]).toEqual(expect.objectContaining({ reason: 'resetAll', ok: false }))
    store.$replaceState = original
    store.destroy()
  })
})
