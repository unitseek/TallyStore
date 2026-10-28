import { StateProxyManager } from '../../../src/core/store/StateProxy.js'
import { createProxyCache } from '../../../src/core/store/proxyCore.js'
import type { InternalStateProtectionConfig } from '../../../src/core/store/types.js'
import { TallyStoreError } from '../../../src/core/errors/TallyStoreError.js'

type AnyRecord = Record<PropertyKey, any>

interface Harness {
  manager: StateProxyManager<AnyRecord>
  setInternal: (value: boolean) => void
}

function makeHarness(options: { deep?: boolean; productionHandler?: 'error' | 'warn' | 'silent'; enabled?: boolean } = {}): Harness {
  let internal = false
  const protection: InternalStateProtectionConfig = {
    enabled: options.enabled ?? true,
    deep: options.deep ?? true,
    productionHandler: options.productionHandler ?? 'warn',
  }
  const manager = new StateProxyManager<AnyRecord>({
    protection,
    proxyCache: createProxyCache(),
    isInternalAccess: () => internal,
  })
  return { manager, setInternal: (value) => (internal = value) }
}

describe('StateProxyManager · 构造校验', () => {
  it('productionHandler 非法时立即抛 TallyStoreError(INVALID_CONFIG)', () => {
    let caught: unknown
    expect(
      () =>
        new StateProxyManager({
          protection: { enabled: true, deep: true, productionHandler: 'boom' } as unknown as InternalStateProtectionConfig,
          proxyCache: createProxyCache(),
          isInternalAccess: () => false,
        }),
    ).toThrow(/productionHandler/)
    try {
      new StateProxyManager({
        protection: { enabled: true, deep: true, productionHandler: 'boom' } as unknown as InternalStateProtectionConfig,
        proxyCache: createProxyCache(),
        isInternalAccess: () => false,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TallyStoreError)
    expect((caught as TallyStoreError).code).toBe('INVALID_CONFIG')
  })

  it('error / warn / silent 三档都被接受', () => {
    for (const productionHandler of ['error', 'warn', 'silent'] as const) {
      expect(() => makeHarness({ productionHandler })).not.toThrow()
    }
  })
})

describe('StateProxyManager · 无需代理的值', () => {
  it('原始值、null、非 Map/Set 内建对象原样返回', () => {
    const { manager } = makeHarness()
    expect(manager.createStateProxy(1 as never, '')).toBe(1)
    expect(manager.createStateProxy(null as never, '')).toBe(null)
    expect(manager.createStateProxy('x' as never, '')).toBe('x')
    const date = new Date()
    expect(manager.createStateProxy(date as unknown as AnyRecord, '')).toBe(date)
  })

  it('同一对象永远拿到同一个代理（读路径缓存）', () => {
    const { manager } = makeHarness()
    const state: AnyRecord = { nested: { n: 1 } }
    const proxy = manager.createStateProxy(state, '')
    expect(manager.createStateProxy(state, '')).toBe(proxy)
    expect((proxy as AnyRecord).nested).toBe((proxy as AnyRecord).nested)
  })

  it('别名对象（两个顶层键指向同一对象）共用同一个子代理', () => {
    const { manager } = makeHarness()
    const shared = { n: 1 }
    const proxy = manager.createStateProxy({ a: shared, b: shared }, '') as AnyRecord
    expect(proxy.a).toBe(proxy.b)
  })
})

describe('StateProxyManager · 开发期写保护', () => {
  it('顶层写入抛错，消息含路径、操作与序列化后的值', () => {
    const { manager } = makeHarness()
    const proxy = manager.createStateProxy({ a: 1 }, '') as AnyRecord
    expect(() => {
      proxy.a = 2
    }).toThrow('Direct mutation of state "a" is prohibited. Use setState() or $patch() methods instead.')
    expect(() => {
      proxy.a = 2
    }).toThrow('Operation: set')
    expect(() => {
      proxy.a = 2
    }).toThrow('Attempted value: 2')
  })

  it('嵌套写入的消息用点号拼路径', () => {
    const { manager } = makeHarness()
    const state = { user: { name: 'a', tags: ['x'] } }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    expect(() => {
      proxy.user.name = 'b'
    }).toThrow('Direct mutation of state "user.name"')
    expect(() => {
      proxy.user.tags[0] = 'y'
    }).toThrow('Direct mutation of state "user.tags[0]"')
  })

  it('delete 操作拒绝并标明操作类型', () => {
    const { manager } = makeHarness()
    const proxy = manager.createStateProxy({ user: {} }, '') as AnyRecord
    expect(() => {
      delete proxy.user
    }).toThrow('Direct mutation of state "user"')
    expect(() => {
      delete proxy.user
    }).toThrow('Operation: delete')
  })

  it('defineProperty 拒绝：数据描述符带值，访问器描述符给出可辨识占位', () => {
    const { manager } = makeHarness()
    const proxy = manager.createStateProxy({ x: 1 }, '') as AnyRecord
    expect(() => Object.defineProperty(proxy, 'x', { value: 2 })).toThrow('Direct mutation of state "x"')
    expect(() => Object.defineProperty(proxy, 'x', { value: 2 })).toThrow('Operation: defineProperty')
    expect(() => Object.defineProperty(proxy, 'x', { value: 2 })).toThrow('Attempted value: 2')

    expect(() =>
      Object.defineProperty(proxy, 'g', {
        get() {
          return 1
        },
      }),
    ).toThrow('[accessor descriptor: get=true, set=false]')
    expect(() =>
      Object.defineProperty(proxy, 's', {
        set() {
          return undefined
        },
      }),
    ).toThrow('[accessor descriptor: get=false, set=true]')
  })
})

describe('StateProxyManager · 内部访问放行', () => {
  it('内部访问下顶层/嵌套写入、删除、defineProperty 都落到原始状态', () => {
    const { manager, setInternal } = makeHarness()
    const state: AnyRecord = { a: 1, nested: { n: 1 } }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    setInternal(true)
    proxy.a = 2
    proxy.nested.n = 3
    Object.defineProperty(proxy, 'defined', { value: 4, writable: true, configurable: true })
    delete proxy.nested
    expect(state.a).toBe(2)
    expect(state.nested).toBeUndefined()
    expect(state.defined).toBe(4)
  })

  it('内部访问下写冻结对象返回 false 且不落地（Reflect.set 语义）', () => {
    const { manager, setInternal } = makeHarness()
    const frozen = Object.freeze({ a: 1 })
    const proxy = manager.createStateProxy(frozen, '') as AnyRecord
    setInternal(true)
    expect(Reflect.set(proxy, 'a', 2)).toBe(false)
    expect(frozen.a).toBe(1)
  })

  it('内部访问下删除不可配置属性返回 false', () => {
    const { manager, setInternal } = makeHarness()
    const state: AnyRecord = {}
    Object.defineProperty(state, 'fixed', { value: 1, configurable: false, writable: true, enumerable: true })
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    setInternal(true)
    expect(Reflect.deleteProperty(proxy, 'fixed')).toBe(false)
    expect(state.fixed).toBe(1)
  })

  it('内部访问下 defineProperty 访问器描述符原样定义（_deepUnwrap normalize 分支）', () => {
    const { manager, setInternal } = makeHarness()
    const state: AnyRecord = {}
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    setInternal(true)
    Object.defineProperty(proxy, 'computed', { get: () => 7, enumerable: true, configurable: true })
    expect(proxy.computed).toBe(7)
    expect(typeof Object.getOwnPropertyDescriptor(state, 'computed')?.get).toBe('function')
  })

  it('set 透传 receiver：原型 setter 的 this 是代理，setter 内部写入仍受陷阱观测', () => {
    const { manager, setInternal } = makeHarness()
    const seen: unknown[] = []
    const proto = {
      set prop(value: number) {
        seen.push(this)
        ;(this as unknown as AnyRecord)._v = value
      },
    }
    const state: AnyRecord = Object.create(proto)
    state.a = 1
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    setInternal(true)
    proxy.prop = 5
    // OrdinarySet 的 receiver 语义：setter 以代理为 this（而非裸目标），内部写入也走陷阱
    expect(seen[0]).toBe(proxy)
    expect(state._v).toBe(5)
  })
})

describe('StateProxyManager · 浅保护模式', () => {
  it('只拦截顶层写入，嵌套对象拿到原始引用', () => {
    const { manager } = makeHarness({ deep: false })
    const state: AnyRecord = { top: 1, nested: { n: 1 } }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    expect(() => {
      proxy.top = 2
    }).toThrow('Direct mutation of state "top"')
    const nested = proxy.nested
    expect(nested).toBe(state.nested)
    nested.n = 2
    expect(state.nested.n).toBe(2)
  })

  it('浅保护下的根数组同样只挡顶层，元素是原始值', () => {
    const { manager } = makeHarness({ deep: false })
    const state: AnyRecord[] = [{ n: 1 }]
    const proxy = manager.createStateProxy(state as never, '') as unknown as AnyRecord
    expect(() => {
      proxy[0] = { n: 2 }
    }).toThrow('Direct mutation of state "[0]"')
    expect((proxy[0] as AnyRecord).n).toBe(1)
  })

  it('冻结根状态上的 Map/Set 先兑现 [[Get]] 不变量：读取不抛错且返回原始集合', () => {
    const { manager } = makeHarness({ deep: false })
    const bag = new Map([['k', 1]])
    const tags = new Set([1])
    const state = Object.freeze({ bag, tags })
    const proxy = manager.createStateProxy(state as never, '') as AnyRecord
    // 不可配置且不可写的自有数据属性被包装时，Proxy 运行时会直接抛 TypeError
    expect(() => proxy.bag).not.toThrow()
    expect(proxy.bag).toBe(bag)
    expect(proxy.tags).toBe(tags)
  })
})

describe('StateProxyManager · 数组代理', () => {
  it('索引、length 与九个变异方法都被拦截，方法拦截闭包身份稳定', () => {
    const { manager } = makeHarness()
    const state: AnyRecord = { list: [1, 2] }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    const list = proxy.list as AnyRecord

    expect(list.length).toBe(2)
    expect(list[0]).toBe(1)
    expect(() => {
      list[0] = 9
    }).toThrow('Direct mutation of state "list[0]"')
    expect(() => {
      list.length = 1
    }).toThrow('Direct mutation of state "list[length]"')
    expect(() => {
      list.push(3)
    }).toThrow('Direct mutation of state "list"')
    expect(() => {
      list.push(3)
    }).toThrow('Operation: push')
    expect(() => {
      list.push(3)
    }).toThrow('Attempted value: [3]')
    expect(() => list.sort()).toThrow('Operation: sort')

    expect(list.push).toBe(list.push)
    expect(list.splice).toBe(list.splice)
  })

  it('数组携带同名元数据时返回存储值而不是拦截器', () => {
    const { manager } = makeHarness()
    const raw = [3, 1] as AnyRecord
    raw.sort = 'name-asc'
    const proxy = manager.createStateProxy({ raw }, '') as AnyRecord
    expect((proxy.raw as AnyRecord).sort).toBe('name-asc')
  })

  it('变异方法被替换后重建拦截器', () => {
    const { manager } = makeHarness()
    const state: AnyRecord = { list: [1] }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    const list = proxy.list as AnyRecord
    const originalPush = list.push
    const originalPrototypePush = Array.prototype.push
    try {
      // 通过内部访问把能力挂到原型上：拦截器缓存必须认得底层函数已换
      Array.prototype.push = function patchedPush(this: unknown[], ...items: unknown[]) {
        return originalPrototypePush.apply(this, items)
      }
      const replaced = list.push
      expect(replaced).not.toBe(originalPush)
    } finally {
      Array.prototype.push = originalPrototypePush
    }
  })

  it('内部访问下变异方法真正执行并改变数组', () => {
    const { manager, setInternal } = makeHarness()
    const state: AnyRecord = { list: [1] }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    const list = proxy.list as AnyRecord
    setInternal(true)
    list.push(2)
    list.splice(0, 1)
    expect(state.list).toEqual([2])
  })

  it('内部访问下数组变异方法先解包对象参数，代理不进入裸数组', () => {
    const { manager, setInternal } = makeHarness()
    const child = { n: 1 }
    const state: AnyRecord = { list: [1, 2, 3], child }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    const childProxy = proxy.child
    setInternal(true)
    proxy.list.splice(0, 1, childProxy)
    expect(state.list[0]).toBe(state.child)
    proxy.list.fill(childProxy)
    expect(state.list.every((item: unknown) => item === state.child)).toBe(true)
    proxy.list.copyWithin(0, 1)
    expect(state.list[0]).toBe(state.child)
    expect(state.list).not.toContain(childProxy)
  })

  it('索引元素是对象时被递归保护，消息路径带方括号', () => {
    const { manager } = makeHarness()
    const state: AnyRecord = { list: [{ n: 1 }] }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    const list = proxy.list as AnyRecord
    expect(() => {
      list[0].n = 2
    }).toThrow('Direct mutation of state "list[0].n"')
    expect(() => Object.defineProperty(list, '0', { value: {} })).toThrow('Direct mutation of state "list[0]"')
  })

  it('数组自定义对象属性同样被包装保护', () => {
    const { manager } = makeHarness()
    const raw = [1] as AnyRecord
    raw.meta = { m: 1 }
    const state = { raw }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    const list = proxy.raw as AnyRecord
    expect(() => {
      list.meta.m = 2
    }).toThrow('Direct mutation of state "raw.meta.m"')
  })

  it('Symbol 键：函数原样返回，对象值仍被包装', () => {
    const { manager } = makeHarness()
    const tag = Symbol('tag')
    const raw = [1] as AnyRecord
    raw[tag] = { v: 1 }
    const state = { raw }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    const list = proxy.raw as AnyRecord

    expect(typeof list[Symbol.iterator]).toBe('function')
    expect(Array.from(list as unknown as unknown[])).toEqual([1])
    expect(() => {
      list[tag].v = 2
    }).toThrow('Direct mutation of state "raw[')
  })

  it('根数组也走数组代理：索引写入被拦截且带方括号路径', () => {
    const { manager } = makeHarness()
    const proxy = manager.createStateProxy([1, 2] as never, '') as unknown as AnyRecord
    expect(() => {
      proxy[0] = 9
    }).toThrow('Direct mutation of state "[0]"')
    expect(() => {
      proxy.push(3)
    }).toThrow('Operation: push')
    // 根数组的变异方法错误必须能定位到「根」而不是空路径
    expect(() => {
      proxy.push(3)
    }).toThrow('Direct mutation of state "<root>"')
  })
})

describe('StateProxyManager · 类实例与锁定属性', () => {
  class Service {
    #count = 0
    bump(): number {
      this.#count += 1
      return this.#count
    }
    get count(): number {
      return this.#count
    }
  }

  it('类实例方法绑定原始接收者，可访问 #private 字段', () => {
    const { manager } = makeHarness()
    const state: AnyRecord = { svc: new Service() }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    expect((proxy.svc as Service).bump()).toBe(1)
    expect((proxy.svc as Service).count).toBe(1)
  })

  it('普通对象上的函数原样返回（不绑定）', () => {
    const { manager } = makeHarness()
    const fn = function (this: unknown) {
      return this
    }
    const state: AnyRecord = { fn }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    expect(proxy.fn).toBe(fn)
  })

  it('锁定属性（不可配置且不可写）读出来是原始值，不做包装', () => {
    const { manager } = makeHarness()
    const locked = { v: 1 }
    const state: AnyRecord = { fixed: locked }
    Object.defineProperty(state, 'fixed', { value: locked, writable: false, configurable: false })
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    expect(proxy.fixed).toBe(locked)
    locked.v = 2
    expect(state.fixed.v).toBe(2)
  })

  it('锁定的函数属性原样返回', () => {
    const { manager } = makeHarness()
    const fn = () => 1
    const state: AnyRecord = {}
    Object.defineProperty(state, 'lockedFn', { value: fn, writable: false, configurable: false })
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    expect(proxy.lockedFn).toBe(fn)
  })
})

describe('StateProxyManager · 生产环境三档处理', () => {
  async function withProduction<T>(handler: 'error' | 'warn' | 'silent', run: (manager: any) => T, options: { deep?: boolean } = {}): Promise<T> {
    const originalEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const stateProxyModule = await import('../../../src/core/store/StateProxy.js')
      const coreModule = await import('../../../src/core/store/proxyCore.js')
      const manager = new stateProxyModule.StateProxyManager({
        protection: { enabled: true, deep: options.deep ?? true, productionHandler: handler },
        proxyCache: coreModule.createProxyCache(),
        isInternalAccess: () => false,
      })
      return run(manager)
    } finally {
      process.env.NODE_ENV = originalEnv
      jest.resetModules()
    }
  }

  it('warn：打印一次告警但放行写入', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const state = { a: 1 }
    try {
      await withProduction('warn', (manager) => {
        const proxy = manager.createStateProxy(state, '')
        expect(() => {
          proxy.a = 2
        }).not.toThrow()
        expect(state.a).toBe(2)
        expect(warnSpy).toHaveBeenCalledTimes(1)
        expect(String(warnSpy.mock.calls[0][0])).toContain('Direct mutation of state "a"')
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('silent：不打印任何东西且放行写入', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const state = { a: 1 }
    try {
      await withProduction('silent', (manager) => {
        const proxy = manager.createStateProxy(state, '')
        expect(() => {
          proxy.a = 2
        }).not.toThrow()
        expect(state.a).toBe(2)
        expect(warnSpy).not.toHaveBeenCalled()
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('warn：写回从 state 读出的代理值时先解包，裸状态存原始对象且读回身份稳定', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const state: AnyRecord = { a: { n: 1 }, bag: new Map([['k', 1]]), b: null, c: null }
    try {
      await withProduction('warn', (manager) => {
        const proxy = manager.createStateProxy(state, '') as AnyRecord
        const aProxy = proxy.a
        const bagProxy = proxy.bag
        proxy.b = aProxy
        proxy.c = bagProxy
        // 裸状态保存的是原始对象/原始集合，不再是本管理器的代理
        expect(state.b).toBe(state.a)
        expect(state.c).toBe(state.bag)
        // 读回仍是同一代理：缓存按原始目标命中，不会二次包装破坏身份
        expect(proxy.b).toBe(aProxy)
        expect(proxy.c).toBe(bagProxy)
      })
      // 每次非法写入只上报一次：receiver 引发的 defineProperty 反射步骤不重复上报
      expect(warnSpy).toHaveBeenCalledTimes(2)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('warn：数组变异方法写入前解包代理值，裸数组不存代理', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const child = { n: 1 }
    const state: AnyRecord = { list: [], child }
    try {
      await withProduction('warn', (manager) => {
        const proxy = manager.createStateProxy(state, '') as AnyRecord
        const childProxy = proxy.child
        proxy.list.push(childProxy)
        proxy.list.unshift(childProxy)
        expect(state.list).toEqual([state.child, state.child])
        expect(state.list[0]).not.toBe(childProxy)
        // 写入的是代理，但读回时按原始对象命中缓存，身份稳定
        expect(proxy.list[0]).toBe(childProxy)
      })
      expect(warnSpy).toHaveBeenCalledTimes(2)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('warn：写入值容器内嵌套的代理被递归解包', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    class Service {
      tag = 'svc'
    }
    const child = { n: 1 }
    const state: AnyRecord = { child, list: [], map: new Map(), set: new Set() }
    try {
      await withProduction('warn', (manager) => {
        const proxy = manager.createStateProxy(state, '') as AnyRecord
        const childProxy = proxy.child
        proxy.box = { nested: childProxy }
        proxy.list.push({ nested: childProxy })
        proxy.map.set({ keyRef: childProxy }, { nested: childProxy })
        proxy.set.add({ nested: childProxy })
        proxy.map3 = new Map([[proxy.child, 1]])
        proxy.nestedList = [childProxy]
        proxy.nestedMap = new Map([[proxy.child, { nested: childProxy }]])
        proxy.nestedSet = new Set([childProxy])
        const cyc: AnyRecord = { nested: childProxy }
        cyc.self = cyc
        proxy.cyc = cyc
        proxy.alias = childProxy
        const arrAcc = [1] as unknown[] & AnyRecord
        Object.defineProperty(arrAcc, 'acc', { get: () => 2, enumerable: true, configurable: true })
        proxy.arrAcc = arrAcc
        const withAccessor: AnyRecord = { child: childProxy }
        Object.defineProperty(withAccessor, 'g', { get: () => 1, enumerable: true, configurable: true })
        proxy.acc = withAccessor
        proxy.date = { d: new Date(1) }
        proxy.inst = { svc: new Service() }
        const unchangedPlain = { x: 1 }
        proxy.plain = unchangedPlain
        proxy.plain2 = { y: 2 }
        proxy.map2 = new Map([['k', 1]])
        proxy.set2 = new Set([1])

        expect(state.box.nested).toBe(state.child)
        expect(state.list[0].nested).toBe(state.child)
        const mapKey = [...state.map.keys()][0] as AnyRecord
        expect(mapKey.keyRef).toBe(state.child)
        expect(state.map.get(mapKey).nested).toBe(state.child)
        expect([...state.set][0].nested).toBe(state.child)
        expect([...state.map3.keys()][0]).toBe(state.child)
        expect(state.nestedList[0]).toBe(state.child)
        expect([...state.nestedMap.keys()][0]).toBe(state.child)
        expect(state.nestedMap.get(state.child).nested).toBe(state.child)
        expect([...state.nestedSet][0]).toBe(state.child)
        expect(state.cyc.self).toBe(state.cyc)
        expect(state.cyc.nested).toBe(state.child)
        expect(state.alias).toBe(state.child)
        expect(state.arrAcc.acc).toBe(2)
        expect(state.acc.child).toBe(state.child)
        expect(state.acc.g).toBe(1)
        expect((state.date.d as Date).getTime()).toBe(1)
        expect((state.inst.svc as Service).tag).toBe('svc')
        expect(state.plain).toBe(unchangedPlain)
        expect(state.plain2).toEqual({ y: 2 })
        expect(state.map2.get('k')).toBe(1)
        expect([...state.set2]).toEqual([1])
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('warn：代理值解包后继续遍历，清理裸状态中先前直写夹带的代理', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const child = { n: 1 }
    const state: AnyRecord = { child, holder: null, out: null }
    try {
      await withProduction('warn', (manager) => {
        const proxy = manager.createStateProxy(state, '') as AnyRecord
        const childProxy = proxy.child
        // 模拟 setState/$patch 这类裸写入口：代理被直接写进了裸状态
        state.holder = { nested: childProxy }
        const holderProxy = proxy.holder
        expect(holderProxy).not.toBe(state.holder)
        // set 陷阱收到代理：解包成裸 holder 后必须继续遍历，把 nested 里的代理也清掉
        proxy.out = holderProxy
        expect(state.out).toBe(state.holder)
        expect(state.out.nested).toBe(state.child)
        expect(state.out.nested).not.toBe(childProxy)
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('error：照常抛错且写入不落地', async () => {
    const state = { a: 1 }
    await withProduction('error', (manager) => {
      const proxy = manager.createStateProxy(state, '')
      expect(() => {
        proxy.a = 2
      }).toThrow('Direct mutation of state "a"')
      expect(state.a).toBe(1)
    })
  })

  it('生产环境下的嵌套路径同样按点号拼接', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const state = { user: { name: 'a' } }
    try {
      await withProduction('warn', (manager) => {
        const proxy = manager.createStateProxy(state, '')
        proxy.user.name = 'b'
        expect(String(warnSpy.mock.calls[0][0])).toContain('Direct mutation of state "user.name"')
      })
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('StateProxyManager · Map/Set 根集合与缓存身份', () => {
  it('根 Map 被代理：size/get/has 可用，同一对象同一代理', () => {
    const { manager } = makeHarness()
    const raw = new Map<unknown, unknown>([['k', 1]])
    const proxy = manager.createStateProxy(raw as never, '') as unknown as Map<unknown, unknown>
    expect(proxy).not.toBe(raw)
    expect(manager.createStateProxy(raw as never, '')).toBe(proxy as never)
    expect(proxy.size).toBe(1)
    expect(proxy.get('k')).toBe(1)
    expect(proxy.get('missing')).toBeUndefined()
    expect(proxy.has('k')).toBe(true)
    expect([...proxy.keys()]).toEqual(['k'])
    expect(proxy.constructor).toBe(Map)
  })

  it('根 Set 被代理：size/has 可用且同值同代理', () => {
    const { manager } = makeHarness()
    const raw = new Set<unknown>([1])
    const proxy = manager.createStateProxy(raw as never, '') as unknown as Set<unknown>
    expect(proxy).not.toBe(raw)
    expect(manager.createStateProxy(raw as never, '')).toBe(proxy as never)
    expect(proxy.size).toBe(1)
    expect(proxy.has(1)).toBe(true)
    expect(proxy.constructor).toBe(Set)
  })

  it('同一集合挂在两个键下共用同一代理；自引用集合的读取返回自身代理', () => {
    const { manager } = makeHarness()
    const shared = new Map<unknown, unknown>([['self', null]])
    shared.set('self', shared)
    const proxy = manager.createStateProxy({ a: shared, b: shared }, '') as AnyRecord
    expect(proxy.a).toBe(proxy.b)
    expect(proxy.a.get('self')).toBe(proxy.a)
  })

  it('集合方法读取身份稳定，重复读取复用同一拦截函数', () => {
    const { manager } = makeHarness()
    const proxy = manager.createStateProxy({ map: new Map() }, '') as AnyRecord
    const map = proxy.map as Map<unknown, unknown>
    expect(map.set).toBe(map.set)
    expect(map.get).toBe(map.get)
    expect(map.values).toBe(map.values)
    const set = (manager.createStateProxy({ set: new Set() }, '') as AnyRecord).set as Set<unknown>
    expect(set.add).toBe(set.add)
    expect(set.values).toBe(set.values)
  })
})

describe('StateProxyManager · Map/Set 开发期变异拦截', () => {
  it('根 Map 的 set/delete/clear 被拦截且不落地', () => {
    const { manager } = makeHarness()
    const raw = new Map<unknown, unknown>([['k', 1]])
    const proxy = manager.createStateProxy(raw as never, '') as unknown as Map<unknown, unknown>
    expect(() => proxy.set('k', 2)).toThrow('Direct mutation of state "<root>"')
    expect(() => proxy.set('k', 2)).toThrow('Operation: set')
    expect(() => proxy.set('k', 2)).toThrow('Attempted value: 2')
    expect(() => proxy.delete('k')).toThrow('Operation: delete')
    expect(() => proxy.clear()).toThrow('Operation: clear')
    expect(raw.get('k')).toBe(1)
    expect(raw.size).toBe(1)
  })

  it('嵌套 Map（对象属性 / 数组元素属性）的路径按所在位置拼接', () => {
    const { manager } = makeHarness()
    const state: AnyRecord = { map: new Map(), list: [{ meta: new Map() }] }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    expect(() => (proxy.map as Map<unknown, unknown>).set('a', 1)).toThrow('Direct mutation of state "map"')
    expect(() => (proxy.list[0].meta as Map<unknown, unknown>).set('a', 1)).toThrow('Direct mutation of state "list[0].meta"')
    expect(() => (proxy.list[0].meta as Map<unknown, unknown>).delete('a')).toThrow('Direct mutation of state "list[0].meta"')
    expect(state.map.size).toBe(0)
  })

  it('根 Set 的 add/delete/clear 被拦截且不落地', () => {
    const { manager } = makeHarness()
    const raw = new Set<unknown>()
    const proxy = manager.createStateProxy(raw as never, '') as unknown as Set<unknown>
    expect(() => proxy.add(1)).toThrow('Direct mutation of state "<root>"')
    expect(() => proxy.add(1)).toThrow('Operation: add')
    expect(() => proxy.add(1)).toThrow('Attempted value: 1')
    expect(() => proxy.delete(1)).toThrow('Operation: delete')
    expect(() => proxy.clear()).toThrow('Operation: clear')
    expect(raw.size).toBe(0)
  })

  it('内部访问下集合变异真正执行，set/add 返回代理支持链式调用', () => {
    const { manager, setInternal } = makeHarness()
    const rawMap = new Map<unknown, unknown>()
    const rawSet = new Set<unknown>()
    const proxy = manager.createStateProxy({ map: rawMap, set: rawSet }, '') as AnyRecord
    setInternal(true)
    const map = proxy.map as Map<unknown, unknown>
    map.set('a', 1).set('b', 2)
    expect(rawMap.get('a')).toBe(1)
    expect(rawMap.get('b')).toBe(2)
    expect(map.delete('a')).toBe(true)
    expect(map.delete('missing')).toBe(false)
    const set = proxy.set as Set<unknown>
    set.add(1).add(2)
    expect([...rawSet]).toEqual([1, 2])
    expect(set.delete(1)).toBe(true)
    expect(set.delete(1)).toBe(false)
    map.clear()
    set.clear()
    expect(rawMap.size).toBe(0)
    expect(rawSet.size).toBe(0)
  })

  it('集合自身的属性写入同样受写陷阱保护', () => {
    const { manager, setInternal } = makeHarness()
    const raw = new Map()
    const proxy = manager.createStateProxy({ map: raw }, '') as AnyRecord
    expect(() => {
      proxy.map.custom = 1
    }).toThrow('Direct mutation of state "map.custom"')
    expect((raw as unknown as AnyRecord).custom).toBeUndefined()
    setInternal(true)
    proxy.map.custom = 1
    expect((raw as unknown as AnyRecord).custom).toBe(1)
  })
})

describe('StateProxyManager · Map/Set 读取路径包装', () => {
  it('Map.get 取出的对象写入被拦截，路径带方括号键', () => {
    const { manager } = makeHarness()
    const state: AnyRecord = { map: new Map([['k', { n: 1 }]]) }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    const value = (proxy.map as Map<string, AnyRecord>).get('k') as AnyRecord
    expect(value).not.toBe(state.map.get('k'))
    expect(() => {
      value.n = 2
    }).toThrow('Direct mutation of state "map[k].n"')
    expect(state.map.get('k').n).toBe(1)
  })

  it('Map 的 keys/values/entries/Symbol.iterator/forEach 都提供包装后的键与值', () => {
    const { manager } = makeHarness()
    const key = { id: 1 }
    const state: AnyRecord = { map: new Map<unknown, AnyRecord>([[key, { n: 1 }]]) }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    const map = proxy.map as Map<unknown, AnyRecord>

    const [wrappedByValues] = [...map.values()]
    expect(wrappedByValues).not.toBe(state.map.get(key))
    expect(() => {
      wrappedByValues.n = 2
    }).toThrow('Direct mutation of state "map[[object Object]].n"')

    // keys() 与 values()/entries()/迭代器/forEach 同口径：对象键也被包装，写入受保护
    const [wrappedKey] = [...map.keys()]
    expect(wrappedKey).not.toBe(key)
    expect(() => {
      ;(wrappedKey as AnyRecord).id = 2
    }).toThrow('Direct mutation of state "map[[object Object]].id"')
    expect(key.id).toBe(1)
    // has/get 仍按 _unwrap 反查原始键，代理键可正常命中
    expect(map.has(wrappedKey)).toBe(true)
    expect(map.get(wrappedKey)).toBe(wrappedByValues)

    const [keyFromEntries, valueFromEntries] = [...map.entries()][0]
    expect(keyFromEntries).toBe(wrappedKey)
    expect(valueFromEntries).toBe(wrappedByValues)

    const [keyFromIterator, valueFromIterator] = [...map][0]
    expect(keyFromIterator).toBe(wrappedKey)
    expect(valueFromIterator).toBe(wrappedByValues)

    const seen: Array<[unknown, unknown, unknown]> = []
    map.forEach((value, entryKey, source) => {
      seen.push([entryKey, value, source])
    })
    expect(seen[0][0]).toBe(wrappedKey)
    expect(seen[0][1]).toBe(wrappedByValues)
    expect(seen[0][2]).toBe(map)
  })

  it('Map 内嵌集合也被保护，路径用外层键定位', () => {
    const { manager } = makeHarness()
    const state: AnyRecord = { map: new Map([['inner', new Map()]]) }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    const inner = (proxy.map as Map<string, Map<unknown, unknown>>).get('inner') as Map<unknown, unknown>
    expect(() => inner.set('x', 1)).toThrow('Direct mutation of state "map[inner]"')
  })

  it('Map 值为其它内建对象时原样返回，不包装', () => {
    const { manager } = makeHarness()
    const date = new Date(1)
    const state: AnyRecord = { map: new Map([['d', date]]) }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    expect((proxy.map as Map<string, unknown>).get('d')).toBe(date)
  })

  it('Map 的自定义对象属性同样被包装保护，锁定属性原样返回', () => {
    const { manager } = makeHarness()
    const raw = new Map() as unknown as AnyRecord
    raw.custom = { x: 1 }
    const locked = { y: 1 }
    Object.defineProperty(raw, 'locked', { value: locked, writable: false, configurable: false })
    const proxy = manager.createStateProxy({ map: raw }, '') as AnyRecord
    expect(() => {
      proxy.map.custom.x = 2
    }).toThrow('Direct mutation of state "map.custom.x"')
    expect(proxy.map.locked).toBe(locked)
  })

  it('Set 的成员写入被拦截；values/keys/entries/迭代器/forEach 提供包装成员', () => {
    const { manager } = makeHarness()
    const state: AnyRecord = { set: new Set<AnyRecord>([{ n: 1 }]) }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    const set = proxy.set as Set<AnyRecord>

    const [byValues] = [...set.values()]
    expect(() => {
      byValues.n = 2
    }).toThrow('Direct mutation of state "set[0].n"')
    const [byKeys] = [...set.keys()]
    expect(byKeys).toBe(byValues)
    const byIterator = [...set][0] as AnyRecord
    expect(byIterator).toBe(byValues)
    const [entryFirst, entrySecond] = [...set.entries()][0]
    expect(entryFirst).toBe(byValues)
    expect(entrySecond).toBe(byValues)

    const seen: AnyRecord[] = []
    set.forEach((member, memberAgain, source) => {
      seen.push(member)
      expect(memberAgain).toBe(member)
      expect(source).toBe(set)
    })
    expect(seen[0]).toBe(byValues)
  })

  it('Set 内嵌集合也被保护', () => {
    const { manager } = makeHarness()
    const state: AnyRecord = { set: new Set([new Set()]) }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    const inner = [...(proxy.set as Set<Set<unknown>>)][0]
    expect(() => inner.add(1)).toThrow('Direct mutation of state "set[0]"')
  })

  it('集合参数可用代理反查原始对象：has/get/delete/set/add', () => {
    const { manager, setInternal } = makeHarness()
    const key = { id: 1 }
    const value = { v: 1 }
    const state: AnyRecord = { key, value, map: new Map<unknown, unknown>([[key, 'hit']]) }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    const map = proxy.map as Map<unknown, unknown>
    const keyProxy = proxy.key
    const valueProxy = proxy.value

    expect(map.has(keyProxy)).toBe(true)
    expect(map.get(keyProxy)).toBe('hit')
    expect(map.has({ id: 1 })).toBe(false)

    setInternal(true)
    expect(map.delete(keyProxy)).toBe(true)
    map.set(keyProxy, valueProxy)
    expect(state.map.get(key)).toBe(value)
    expect(state.map.has(key)).toBe(true)
  })

  it('Set 参数可用代理反查原始成员', () => {
    const { manager, setInternal } = makeHarness()
    const member = { id: 1 }
    const state: AnyRecord = { member, set: new Set<unknown>([member]) }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    const set = proxy.set as Set<unknown>
    expect(set.has(proxy.member)).toBe(true)
    setInternal(true)
    expect(set.delete(proxy.member)).toBe(true)
    expect(state.set.has(member)).toBe(false)
    set.add(proxy.member)
    expect(state.set.has(member)).toBe(true)
  })

  it('Map 内的 Symbol 键同样按字符串化后的键定位错误路径', () => {
    const { manager } = makeHarness()
    const tag = Symbol('tag')
    const state: AnyRecord = { map: new Map([[tag, { n: 1 }]]) }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    const value = (proxy.map as Map<symbol, AnyRecord>).get(tag) as AnyRecord
    expect(() => {
      value.n = 2
    }).toThrow('Direct mutation of state "map[Symbol(tag)].n"')
  })

  it('白名单外的方法以原始集合为接收者绑定返回（子类自定义方法）', () => {
    class TaggedMap extends Map<unknown, unknown> {
      tag(): string {
        return 'tagged'
      }
    }
    const { manager } = makeHarness()
    const proxy = manager.createStateProxy({ map: new TaggedMap() }, '') as AnyRecord
    const map = proxy.map as TaggedMap
    expect(map.tag()).toBe('tagged')
    expect(() => map.set('a', 1)).toThrow('Direct mutation of state "map"')
  })
})

describe('StateProxyManager · Map/Set 浅保护', () => {
  it('浅保护下根 Map 仍拦截变异，内部对象值不递归包装', () => {
    const { manager } = makeHarness({ deep: false })
    const inner = { n: 1 }
    const raw = new Map<unknown, unknown>([['k', inner]])
    const proxy = manager.createStateProxy(raw as never, '') as unknown as Map<unknown, unknown>
    expect(() => proxy.set('x', 1)).toThrow('Direct mutation of state "<root>"')
    const value = proxy.get('k') as AnyRecord
    expect(value).toBe(inner)
    value.n = 2
    expect(inner.n).toBe(2)
  })

  it('浅保护下对象属性上的 Map/Set 仍保护变异方法', () => {
    const { manager } = makeHarness({ deep: false })
    const state: AnyRecord = { map: new Map([['k', { n: 1 }]]), set: new Set() }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    expect(() => (proxy.map as Map<unknown, unknown>).set('x', 1)).toThrow('Direct mutation of state "map"')
    expect(() => (proxy.set as Set<unknown>).add(1)).toThrow('Direct mutation of state "set"')
    expect((proxy.map as Map<string, AnyRecord>).get('k')).toBe(state.map.get('k'))
  })

  it('浅保护下根数组元素里的 Map 仍保护变异', () => {
    const { manager } = makeHarness({ deep: false })
    const state: AnyRecord = [new Map()]
    const proxy = manager.createStateProxy(state as never, '') as unknown as AnyRecord
    expect(() => (proxy[0] as Map<unknown, unknown>).set('x', 1)).toThrow('Direct mutation of state "[0]"')
  })
})

describe('StateProxyManager · Map/Set 生产环境三档', () => {
  async function withProduction<T>(handler: 'error' | 'warn' | 'silent', run: (manager: any) => T, options: { deep?: boolean } = {}): Promise<T> {
    const originalEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const stateProxyModule = await import('../../../src/core/store/StateProxy.js')
      const coreModule = await import('../../../src/core/store/proxyCore.js')
      const manager = new stateProxyModule.StateProxyManager({
        protection: { enabled: true, deep: options.deep ?? true, productionHandler: handler },
        proxyCache: coreModule.createProxyCache(),
        isInternalAccess: () => false,
      })
      return run(manager)
    } finally {
      process.env.NODE_ENV = originalEnv
      jest.resetModules()
    }
  }

  it('warn：集合变异打印告警但真正执行', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const raw = new Map<unknown, unknown>()
    try {
      await withProduction('warn', (manager) => {
        const proxy = manager.createStateProxy(raw, '') as Map<unknown, unknown>
        proxy.set('k', 1)
        expect(raw.get('k')).toBe(1)
        expect(warnSpy).toHaveBeenCalledTimes(1)
        expect(String(warnSpy.mock.calls[0][0])).toContain('Direct mutation of state "<root>"')
        expect(String(warnSpy.mock.calls[0][0])).toContain('Operation: set')
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('silent：集合变异不打印、直接执行', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const raw = new Set<unknown>()
    try {
      await withProduction('silent', (manager) => {
        const proxy = manager.createStateProxy(raw, '') as Set<unknown>
        proxy.add(1)
        expect([...raw]).toEqual([1])
        expect(warnSpy).not.toHaveBeenCalled()
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('error：集合变异抛错且不落地', async () => {
    const raw = new Set<unknown>()
    await withProduction('error', (manager) => {
      const proxy = manager.createStateProxy(raw, '') as Set<unknown>
      expect(() => proxy.add(1)).toThrow('Direct mutation of state "<root>"')
      expect(raw.size).toBe(0)
    })
  })

  it('warn：嵌套集合路径按属性位置拼接', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const state: AnyRecord = { map: new Map() }
    try {
      await withProduction('warn', (manager) => {
        const proxy = manager.createStateProxy(state, '') as AnyRecord
        ;(proxy.map as Map<unknown, unknown>).set('k', 1)
        expect(String(warnSpy.mock.calls[0][0])).toContain('Direct mutation of state "map"')
        expect(state.map.get('k')).toBe(1)
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('warn：浅保护下集合变异同样放行执行', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const raw = new Map<unknown, unknown>()
    try {
      await withProduction(
        'warn',
        (manager) => {
          const proxy = manager.createStateProxy(raw, '') as Map<unknown, unknown>
          proxy.set('k', 1)
          expect(raw.get('k')).toBe(1)
          expect(warnSpy).toHaveBeenCalledTimes(1)
        },
        { deep: false },
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('StateProxyManager · 读取热路径只在新建子代理时拼路径', () => {
  function spyJoin(): jest.SpyInstance {
    const proto = StateProxyManager.prototype as unknown as {
      _joinChildPath: (path: string, key: string | symbol, bracket: boolean) => string
    }
    return jest.spyOn(proto, '_joinChildPath')
  }

  it('嵌套对象第二次读取命中缓存，不再拼路径', () => {
    const { manager } = makeHarness()
    const proxy = manager.createStateProxy({ user: { name: 'a' } }, '') as AnyRecord
    const spy = spyJoin()
    try {
      const first = proxy.user
      const second = proxy.user
      expect(second).toBe(first)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith('', 'user', false)
    } finally {
      spy.mockRestore()
    }
  })

  it('数组与数组元素各拼一次，重复读取零拼接', () => {
    const { manager } = makeHarness()
    const proxy = manager.createStateProxy({ list: [{ n: 1 }] }, '') as AnyRecord
    const spy = spyJoin()
    try {
      expect(proxy.list).toBe(proxy.list)
      expect(proxy.list[0]).toBe(proxy.list[0])
      expect(spy).toHaveBeenCalledTimes(2)
      expect(spy).toHaveBeenCalledWith('', 'list', false)
      expect(spy).toHaveBeenCalledWith('list', '0', true)
    } finally {
      spy.mockRestore()
    }
  })

  it('Map 取值首次拼路径、二次命中缓存零拼接', () => {
    const { manager } = makeHarness()
    const proxy = manager.createStateProxy({ map: new Map([['k', { n: 1 }]]) }, '') as AnyRecord
    const spy = spyJoin()
    try {
      expect((proxy.map as Map<string, unknown>).get('k')).toBe((proxy.map as Map<string, unknown>).get('k'))
      expect(spy).toHaveBeenCalledTimes(2)
      expect(spy).toHaveBeenCalledWith('', 'map', false)
      expect(spy).toHaveBeenCalledWith('map', 'k', true)
    } finally {
      spy.mockRestore()
    }
  })

  it('内建对象（Date）直接返回，不拼路径也不缓存', () => {
    const { manager } = makeHarness()
    const proxy = manager.createStateProxy({ date: new Date(1) }, '') as AnyRecord
    const spy = spyJoin()
    try {
      const first = proxy.date
      expect(proxy.date).toBe(first)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('StateProxyManager · 代理回写与集合属性', () => {
  it('已是本管理器代理的值再读出时返回自身，不再包一层', () => {
    const { manager } = makeHarness()
    const state: AnyRecord = { a: { n: 1 }, b: null }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    const aProxy = proxy.a
    // 模拟生产降级期把代理写回裸状态后的遗留值
    state.b = aProxy
    expect(proxy.b).toBe(aProxy)
    // 代理保留创建时的原始路径（a.n）；关键是它没有被再包一层、写入仍被拦截
    expect(() => {
      proxy.b.n = 2
    }).toThrow('Direct mutation of state "a.n"')
  })

  it('集合自有同名属性优先于内建方法拦截', () => {
    const { manager } = makeHarness()
    const raw = new Map() as unknown as AnyRecord
    raw.set = () => 'shadowed'
    const proxy = manager.createStateProxy({ map: raw }, '') as AnyRecord
    expect((proxy.map as AnyRecord).set()).toBe('shadowed')
  })

  it('集合方法在运行期被替换后重建拦截器', () => {
    const { manager } = makeHarness()
    const state: AnyRecord = { map: new Map() }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    const map = proxy.map as Map<unknown, unknown>
    const originalSet = map.set
    const protoSet = Map.prototype.set
    try {
      Map.prototype.set = function patchedSet(this: Map<unknown, unknown>, key: unknown, value: unknown) {
        return protoSet.call(this, key, value)
      }
      const replaced = map.set
      expect(replaced).not.toBe(originalSet)
    } finally {
      Map.prototype.set = protoSet
    }
  })

  it('集合值包装与属性读取共用同一缓存/代理', () => {
    const { manager } = makeHarness()
    const state: AnyRecord = { map: new Map([['k', { n: 1 }]]) }
    const proxy = manager.createStateProxy(state, '') as AnyRecord
    const fromGet = (proxy.map as Map<string, AnyRecord>).get('k')
    const fromValues = [...(proxy.map as Map<string, AnyRecord>).values()][0]
    expect(fromGet).toBe(fromValues)
  })
})
