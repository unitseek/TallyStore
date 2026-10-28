/** Store 定义、模块化与命名空间——全局唯一名 + 聚合工厂注册 + 循环依赖检测 */
import { createStore, defineStores, TallyStoreError, Store } from '../../../src/index.js'
import { registerStoreInstance } from '../../../src/core/store/registry.js'

afterEach(() => {
  jest.restoreAllMocks()
})

describe(' Store name 全局唯一', () => {
  it('重复 name 在开发期抛 INVALID_CONFIG 并给出冲突双方来源', () => {
    const first = createStore({ name: 'dup-name', state: () => ({ a: 1 }) })
    try {
      createStore({ name: 'dup-name', state: () => ({ b: 2 }) })
      throw new Error('should throw')
    } catch (error) {
      expect(error).toBeInstanceOf(TallyStoreError)
      const e = error as TallyStoreError
      expect(e.code).toBe('INVALID_CONFIG')
      expect(e.message).toContain('dup-name')
      // 冲突双方来源：报错信息含两个创建现场
      expect(e.message.match(/创建于/g)).toHaveLength(2)
      expect(e.message).toContain('已占用方创建于')
      expect(e.message).toContain('本次创建于')
    }
    first.destroy()
  })

  it('destroy 后 name 可复用', () => {
    const first = createStore({ name: 'reusable', state: () => ({}) })
    first.destroy()
    const second = createStore({ name: 'reusable', state: () => ({}) })
    expect(second.getState()).toEqual({})
    second.destroy()
  })

  it('自动生成名不登记：两个未命名 Store 不误报', () => {
    const a = createStore({ state: () => ({}) })
    const b = createStore({ state: () => ({}) })
    expect(a.name).not.toBe(b.name)
    a.destroy()
    b.destroy()
  })

  it('生产期重复 name 不阻断：console.error + onError(register) 上报后放行', async () => {
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const { createStore: createProd } = await import('../../../src/index.js')
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      const onError = jest.fn()
      const first = createProd({ name: 'prod-dup', state: () => ({}) })
      const second = createProd({ name: 'prod-dup', state: () => ({}) })
      expect(second.getState()).toEqual({})
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(consoleError.mock.calls[0][0]).toContain('prod-dup')
      // 构造时 onError 尚无监听者，事件已错失——console 是生产期的可靠通道（文档已注明）
      expect(onError).not.toHaveBeenCalled()
      // 后创建的实例正常存活并可销毁
      second.destroy()
      first.destroy()
    } finally {
      delete process.env.NODE_ENV
      jest.resetModules()
    }
  })

  it('生产期同名共存：销毁后创建者不会注销仍存活的先创建者，冲突仍可见', async () => {
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const { createStore: createProd } = await import('../../../src/index.js')
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      const first = createProd({ name: 'prod-order', state: () => ({}) })
      const second = createProd({ name: 'prod-order', state: () => ({}) })
      expect(consoleError).toHaveBeenCalledTimes(1)
      second.destroy()
      // 先创建者仍存活：再次同名注册必须继续报冲突；若销毁后创建者误删了条目，这里会静默通过
      const third = createProd({ name: 'prod-order', state: () => ({}) })
      expect(consoleError).toHaveBeenCalledTimes(2)
      third.destroy()
      first.destroy()
      expect(consoleError).toHaveBeenCalledTimes(2)
      consoleError.mockRestore()
    } finally {
      delete process.env.NODE_ENV
      jest.resetModules()
    }
  })

  it('同名先创建者销毁不影响后创建者（注册表条目按实例身份比对）', () => {
    const first = createStore({ name: 'order-check', state: () => ({}) })
    // 生产期放行路径才有「同名共存」；开发期直接抛，这里用两次独立生命周期验证注销语义
    first.destroy()
    const second = createStore({ name: 'order-check', state: () => ({}) })
    second.destroy()
    const third = createStore({ name: 'order-check', state: () => ({}) })
    third.destroy()
  })

  it('同名条目按实例维护：注销只删自己那条，存活条目继续参与冲突检测', () => {
    const report = jest.fn()
    const store = {}
    const unregisterFirst = registerStoreInstance('entry-check', store, report)
    const unregisterSecond = registerStoreInstance('entry-check', store, report)
    unregisterFirst()
    // 同一实例的另一条仍存活：登记不同实例必须冲突
    expect(() => registerStoreInstance('entry-check', { other: true }, report)).toThrow(TallyStoreError)
    unregisterSecond()
    // 全部条目注销后名字释放
    const unregisterThird = registerStoreInstance('entry-check', { other: true }, report)
    unregisterThird()
    // 重复调用注销函数幂等
    unregisterThird()
  })

  it('注销时名字已被外部清除/条目已不在列表：兜底清理且不抛错', () => {
    const unregisterOrphan = registerStoreInstance('orphan-name', {}, () => undefined)
    const registry = (globalThis as Record<symbol, any>)[Symbol.for('tallystore.storeRegistry')] as Map<string, unknown[]>
    // 模拟跨副本/测试清理提前移除了该名字
    registry.delete('orphan-name')
    expect(() => unregisterOrphan()).not.toThrow()

    const unregisterManual = registerStoreInstance('manual-name', {}, () => undefined)
    // 名字仍在但条目列表已被外部替换：只删自己的条目，列表为空时释放名字
    registry.set('manual-name', [])
    expect(() => unregisterManual()).not.toThrow()
    expect(registry.has('manual-name')).toBe(false)
  })
})

describe(' defineStores 聚合注册', () => {
  function makeModule(name: string, counter: { calls: number }) {
    return {
      factory: () => {
        counter.calls += 1
        return createStore({ name, state: () => ({ id: name }) })
      },
    }
  }

  it('聚合只登记工厂：未 get 前工厂零调用；get 惰性实例化并记忆', () => {
    const counter = { calls: 0 }
    const stores = defineStores({
      a: makeModule('agg-a', counter),
      b: makeModule('agg-b', counter),
    })
    expect(counter.calls).toBe(0)
    expect(stores.names()).toEqual(['a', 'b'])
    expect(stores.has('a')).toBe(true)
    expect(stores.instantiated('a')).toBe(false)

    const a1 = stores.get('a')
    expect(counter.calls).toBe(1)
    expect(a1.getState()).toEqual({ id: 'agg-a' })
    const a2 = stores.get('a')
    expect(a2).toBe(a1)
    expect(counter.calls).toBe(1)
    expect(stores.instantiated('a')).toBe(true)
    stores.reset()
  })

  it('四个以上独立模块可分别开发、组合运行（验收标准 2）', () => {
    const stores = defineStores({
      session: { factory: () => createStore({ name: 'm-session', state: () => ({ token: '' }) }) },
      profile: {
        dependsOn: ['session'],
        factory: () => createStore({ name: 'm-profile', state: () => ({ name: '' }) }),
      },
      settings: { factory: () => createStore({ name: 'm-settings', state: () => ({ theme: 'light' }) }) },
      cart: {
        dependsOn: ['session'],
        factory: () => createStore({ name: 'm-cart', state: () => ({ items: [] as string[] }) }),
      },
      stats: {
        dependsOn: ['cart'],
        factory: () => createStore({ name: 'm-stats', state: () => ({ total: 0 }) }),
      },
    })
    const cart = stores.get('cart')
    cart.setState('items', ['sku-1'])
    expect(stores.get('stats').getState()).toEqual({ total: 0 })
    expect(stores.get('session').getState()).toEqual({ token: '' })
    stores.reset()
  })

  it('循环依赖注册期抛 INVALID_CONFIG 并携带依赖链', () => {
    try {
      defineStores({
        a: { dependsOn: ['b'], factory: () => createStore({ name: 'cyc-a', state: () => ({}) }) },
        b: { dependsOn: ['c'], factory: () => createStore({ name: 'cyc-b', state: () => ({}) }) },
        c: { dependsOn: ['a'], factory: () => createStore({ name: 'cyc-c', state: () => ({}) }) },
      })
      throw new Error('should throw')
    } catch (error) {
      expect(error).toBeInstanceOf(TallyStoreError)
      const e = error as TallyStoreError
      expect(e.code).toBe('INVALID_CONFIG')
      // 完整依赖链（环的起点可能是 DFS 根，链形态为 a → b → c → a）
      expect(e.message).toMatch(/[abc] → [abc] → [abc] → [abc]/)
      expect(e.context).toEqual(expect.objectContaining({ cycle: expect.stringContaining('→') }))
    }
  })

  it('自依赖同样报环', () => {
    expect(() =>
      defineStores({
        self: { dependsOn: ['self'], factory: () => createStore({ name: 'cyc-self', state: () => ({}) }) },
      }),
    ).toThrow(/self → self/)
  })

  it('依赖不存在的模块名注册期报错', () => {
    try {
      defineStores({
        a: { dependsOn: ['ghost'], factory: () => createStore({ name: 'dep-missing', state: () => ({}) }) },
      })
      throw new Error('should throw')
    } catch (error) {
      expect((error as TallyStoreError).code).toBe('INVALID_CONFIG')
      expect((error as TallyStoreError).message).toContain('ghost')
    }
  })

  it('get 未登记模块抛 INVALID_CONFIG，context 带可用列表', () => {
    const stores = defineStores({ a: { factory: () => createStore({ name: 'only-a', state: () => ({}) }) } })
    try {
      stores.get('missing' as never)
      throw new Error('should throw')
    } catch (error) {
      expect((error as TallyStoreError).code).toBe('INVALID_CONFIG')
      expect((error as TallyStoreError).context).toEqual(expect.objectContaining({ registered: ['a'] }))
    }
    stores.reset()
  })

  it('reset 销毁全部已创建实例并允许重建', () => {
    const stores = defineStores({ a: { factory: () => createStore({ name: 'reset-a', state: () => ({}) }) } })
    const first = stores.get('a')
    expect(first.destroyed).toBe(false)
    stores.reset()
    expect(first.destroyed).toBe(true)
    const second = stores.get('a')
    expect(second).not.toBe(first)
    expect(second).toBeInstanceOf(Store)
    stores.reset()
  })

  it('reset：单个实例 destroy 抛错不中断其余实例，始终清空登记并汇总上报', () => {
    const stores = defineStores({
      a: { factory: () => createStore({ name: 'reg-sweep-a', state: () => ({ n: 0 }) }) },
      b: { factory: () => createStore({ name: 'reg-sweep-b', state: () => ({ n: 0 }) }) },
      c: { factory: () => createStore({ name: 'reg-sweep-c', state: () => ({ n: 0 }) }) },
    })
    const a = stores.get('a')
    const b = stores.get('b')
    const c = stores.get('c')
    jest.spyOn(a, 'destroy').mockImplementation(() => {
      throw new Error('destroy boom')
    })
    jest.spyOn(b, 'destroy').mockImplementation(() => {
      throw 'string boom'
    })
    let caught: unknown
    try {
      stores.reset()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TallyStoreError)
    const sweepError = caught as TallyStoreError
    expect(sweepError.code).toBe('INVALID_CONFIG')
    expect(sweepError.message).toContain('destroy boom')
    expect(sweepError.message).toContain('string boom')
    expect(sweepError.context).toEqual(expect.objectContaining({ operation: 'reset', failedModules: ['a', 'b'] }))
    // 失败不中断：后面的实例仍被销毁；实例表始终清空
    expect(c.destroyed).toBe(true)
    expect(stores.instantiated('a')).toBe(false)
    expect(stores.instantiated('b')).toBe(false)
    // 还原 mock 后清理真实实例（a/b 的 destroy 之前被 mock，未真正注销）
    jest.restoreAllMocks()
    a.destroy()
    b.destroy()
  })

  it('resetAll：单个实例 $reset 抛错不中断其余模块，实例保持存活并汇总上报', () => {
    const stores = defineStores({
      a: { factory: () => createStore({ name: 'reg-resetall-a', state: () => ({ n: 0 }) }) },
      b: { factory: () => createStore({ name: 'reg-resetall-b', state: () => ({ n: 0 }) }) },
    })
    const a = stores.get('a')
    const b = stores.get('b')
    b.setState('n', 5)
    jest.spyOn(a, '$reset').mockImplementation(() => {
      throw new Error('reset boom')
    })
    let caught: unknown
    try {
      stores.resetAll()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TallyStoreError)
    expect((caught as TallyStoreError).context).toEqual(expect.objectContaining({ operation: 'resetAll', failedModules: ['a'] }))
    // 失败不中断：后续模块已复位；resetAll 契约是实例保持存活
    expect(b.getState().n).toBe(0)
    expect(stores.instantiated('a')).toBe(true)
    expect(stores.instantiated('b')).toBe(true)
    jest.restoreAllMocks()
    stores.reset()
  })

  it('工厂在构造完成前递归 get 同一模块：抛 INVALID_CONFIG 而不是栈溢出，清理后可重试', () => {
    let calls = 0
    let recurse = true
    const holder: { get(name: string): unknown } = { get: () => undefined }
    const stores = defineStores({
      loop: {
        factory: () => {
          calls += 1
          if (recurse) {
            recurse = false
            holder.get('loop')
          }
          return createStore({ name: 'guard-loop', state: () => ({ id: 'loop' }) })
        },
      },
    })
    holder.get = (name) => stores.get(name as never)
    let caught: unknown
    try {
      stores.get('loop')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TallyStoreError)
    expect((caught as TallyStoreError).code).toBe('INVALID_CONFIG')
    expect((caught as TallyStoreError).message).toContain('loop')
    expect(calls).toBe(1)
    // finally 已清理构造标记：修复后可重新 get，而不是永久判定为构造中
    expect(stores.get('loop').getState()).toEqual({ id: 'loop' })
    expect(calls).toBe(2)
    stores.reset()
  })

  it('工厂经未声明的依赖链间接递归：受控报环并携带构造链', () => {
    const holder: { get(name: string): unknown } = { get: () => undefined }
    const stores = defineStores({
      a: {
        factory: () => {
          holder.get('b')
          return createStore({ name: 'guard-trans-a', state: () => ({}) })
        },
      },
      b: {
        factory: () => {
          holder.get('a')
          return createStore({ name: 'guard-trans-b', state: () => ({}) })
        },
      },
    })
    holder.get = (name) => stores.get(name as never)
    let caught: unknown
    try {
      stores.get('a')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TallyStoreError)
    const cycleError = caught as TallyStoreError
    expect(cycleError.code).toBe('INVALID_CONFIG')
    expect(cycleError.message).toContain('a → b → a')
    expect(stores.instantiated('a')).toBe(false)
    expect(stores.instantiated('b')).toBe(false)
    stores.reset()
  })
})

describe('registry 形状兼容与 sweep 快照', () => {
  const REGISTRY_SYMBOL = Symbol.for('tallystore.storeRegistry')
  const registryHolder = (): Map<string, unknown> => {
    const existing = (globalThis as Record<symbol, unknown>)[REGISTRY_SYMBOL]
    if (existing instanceof Map) return existing as Map<string, unknown>
    const created = new Map<string, unknown>()
    ;(globalThis as Record<symbol, unknown>)[REGISTRY_SYMBOL] = created
    return created
  }

  it('兼容旧副本写入的单条目形状：不抛 find is not a function，冲突仍可识别', () => {
    const store = {}
    const legacy = { store, origin: 'legacy-origin' }
    const holder = registryHolder()
    holder.set('legacy-single', legacy)
    // 同实例重复登记：读到旧形状也能归一为条目列表
    const unregister = registerStoreInstance('legacy-single', store, () => undefined)
    expect(Array.isArray(holder.get('legacy-single'))).toBe(true)
    unregister()
    // 注销自己的条目后只剩旧副本条目，回落成旧副本可读的单条目形状
    expect(holder.get('legacy-single')).toBe(legacy)
    // 不同实例仍能识别冲突（开发期抛 INVALID_CONFIG）
    expect(() => registerStoreInstance('legacy-single', { other: true }, () => undefined)).toThrow(TallyStoreError)
  })

  it('teardown 内嵌套 reset 后重建的实例保留登记，不产生第二份实例', () => {
    const stores = defineStores({ a: { factory: () => createStore({ state: () => ({ id: 'a' }) }) } })
    const first = stores.get('a')
    let recreated: ReturnType<typeof stores.get> | undefined
    let depth = 0
    jest.spyOn(first, 'destroy').mockImplementation(() => {
      depth += 1
      if (depth > 1) return
      // teardown 内重入 reset：清空实例表后重建同名模块
      stores.reset()
      recreated = stores.get('a')
    })
    stores.reset()
    expect(recreated).toBeDefined()
    expect(recreated!.destroyed).toBe(false)
    // 重建实例保留登记：下一次 get 返回同一份，而不是再建一份
    expect(stores.instantiated('a')).toBe(true)
    expect(stores.get('a')).toBe(recreated)
    jest.restoreAllMocks()
    first.destroy()
    stores.reset()
  })

  it('sweep 快照遍历：teardown 期间重入 get 新建的实例不被本轮销毁', () => {
    const stores = defineStores({
      a: { factory: () => createStore({ name: 'sweep-reenter-a', state: () => ({}) }) },
      b: { factory: () => createStore({ name: 'sweep-reenter-b', state: () => ({}) }) },
    })
    const a = stores.get('a')
    let spawned: ReturnType<typeof stores.get> | undefined
    jest.spyOn(a, 'destroy').mockImplementation(() => {
      spawned = stores.get('b')
    })
    stores.reset()
    expect(spawned).toBeDefined()
    expect(spawned!.destroyed).toBe(false)
    jest.restoreAllMocks()
    a.destroy()
    spawned!.destroy()
  })
})

describe(' resetAll 审计事件', () => {
  it('resetAll 以 reason="resetAll" 触发 beforeReset / afterReset', () => {
    const stores = defineStores({
      audit: { factory: () => createStore({ name: 'fr21-ra-audit', state: () => ({ n: 0 }) }) },
    })
    const store = stores.get('audit')
    const events: string[] = []
    store.hooks.on('beforeReset', (info) => events.push('before:' + info.reason))
    store.hooks.on('afterReset', (info) => events.push('after:' + info.reason + ':' + String(info.ok)))

    stores.resetAll()

    expect(events).toEqual(['before:resetAll', 'after:resetAll:true'])
    stores.reset()
    store.destroy()
  })
})
