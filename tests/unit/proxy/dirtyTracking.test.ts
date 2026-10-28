import { createDirtyTrackingCache, createDirtyTrackingProxy } from '../../../src/core/store/dirtyTracking.js'

type AnyRecord = Record<PropertyKey, any>
type Keys = PropertyKey[]

interface Harness {
  state: AnyRecord
  proxy: AnyRecord
  mutations: Keys[]
  cache: ReturnType<typeof createDirtyTrackingCache>
}

function makeHarness(initial: AnyRecord = {}): Harness {
  const state = initial
  const mutations: Keys[] = []
  const cache = createDirtyTrackingCache()
  const proxy = createDirtyTrackingProxy(state, cache, (keys) => {
    mutations.push([...keys])
  }) as AnyRecord
  return { state, proxy, mutations, cache }
}

function lastKeys(mutations: Keys[]): Keys {
  return mutations[mutations.length - 1]
}

describe('dirtyTracking · 顶层与嵌套写入归因', () => {
  it('顶层写入上报该键，并同步计数', () => {
    const { state, proxy, mutations } = makeHarness({ a: 1 })
    proxy.a = 2
    expect(state.a).toBe(2)
    expect(mutations).toEqual([['a']])
  })

  it('嵌套写入把变更归到所属顶层键', () => {
    const { state, proxy, mutations } = makeHarness({ user: { name: 'a', address: { city: 'x' } }, other: 0 })
    proxy.user.name = 'b'
    proxy.user.address.city = 'y'
    expect(state.user.name).toBe('b')
    expect(mutations).toEqual([['user'], ['user']])
  })

  it('新增对象边之后，后续写入不再全量兜底（只报所属键）', () => {
    const { proxy, mutations } = makeHarness({ user: {}, other: {} })
    proxy.user = { name: 'a' }
    proxy.user.name = 'b'
    expect(mutations[mutations.length - 1]).toEqual(['user'])
  })

  it('嵌套赋值引入的别名同样登记归属：之后经共享对象的写入同时标脏两个顶层键', () => {
    const shared = { n: 1 }
    const { state, proxy, mutations } = makeHarness({ c: shared, a: { item: null as unknown } })
    proxy.a.item = shared
    expect(state.a.item).toBe(shared)
    expect(lastKeys(mutations)).toEqual(['a'])
    proxy.c.n = 2
    expect([...lastKeys(mutations)].sort()).toEqual(['a', 'c'])
  })

  it('同一对象挂在两个顶层键下时，写入同时归因到两个键', () => {
    const shared = { n: 1 }
    const { state, proxy, mutations } = makeHarness({ a: shared, b: shared })
    proxy.a.n = 2
    expect(state.a.n).toBe(2)
    expect([...lastKeys(mutations)].sort()).toEqual(['a', 'b'])
  })

  it('根对象自引用（state.self = state）时写入仍可归因且不无限递归', () => {
    const state: AnyRecord = {}
    state.self = state
    const { proxy, mutations } = makeHarness(state)
    proxy.self.extra = 1
    // root 同时经 'self' 可达：root 级写入归因到 self 与本键
    expect([...lastKeys(mutations)].sort()).toEqual(['extra', 'self'])
  })

  it('数组变异方法（push）经写陷阱归因到数组所在顶层键', () => {
    const { state, proxy, mutations } = makeHarness({ list: [1], other: 0 })
    proxy.list.push(2)
    expect(state.list).toEqual([1, 2])
    expect(lastKeys(mutations)).toEqual(['list'])
  })

  it('数组长度缩短删除对象元素时按删边处理', () => {
    const { state, proxy, mutations } = makeHarness({ list: [{ a: 1 }, { b: 2 }] })
    proxy.list.length = 1
    expect(state.list.length).toBe(1)
    expect(lastKeys(mutations)).toEqual(['list'])
  })

  it('数组长度缩短但尾部没有对象时仍可复用索引', () => {
    const { state, proxy, mutations } = makeHarness({ list: [1, 2], other: 0 })
    proxy.list.length = 1
    expect(state.list.length).toBe(1)
    expect(lastKeys(mutations)).toEqual(['list'])
  })

  it('数组 length 归零时删除尾部全部对象边', () => {
    const { state, proxy, mutations } = makeHarness({ list: [{ a: 1 }, { b: 2 }] })
    proxy.list.length = 0
    expect(state.list.length).toBe(0)
    expect(lastKeys(mutations)).toEqual(['list'])
  })
})

describe('dirtyTracking · Map 写入', () => {
  it('set 新键归因到所属顶层键，且登记值子树', () => {
    const { state, proxy, mutations } = makeHarness({ map: new Map(), other: 0 })
    proxy.map.set('k', { v: 1 })
    proxy.map.get('k').v = 2
    expect(state.map.get('k').v).toBe(2)
    expect(mutations[0]).toEqual(['map'])
    expect(lastKeys(mutations)).toEqual(['map'])
  })

  it('覆盖已有对象值按删边处理并重建索引', () => {
    const { state, proxy } = makeHarness({ map: new Map([['k', { v: 1 }]]), other: 0 })
    proxy.map.set('k', { v: 2 })
    expect(state.map.get('k')).toEqual({ v: 2 })
    proxy.map.get('k').v = 3
    expect(state.map.get('k').v).toBe(3)
  })

  it('set 原始值键时不登记边', () => {
    const { state, proxy, mutations } = makeHarness({ map: new Map(), other: 0 })
    proxy.map.set(1, 'x')
    expect(state.map.get(1)).toBe('x')
    expect(lastKeys(mutations)).toEqual(['map'])
  })

  it('重复 set 同一值不视为删边', () => {
    const shared = { v: 1 }
    const { proxy } = makeHarness({ map: new Map([['k', shared]]) })
    expect(() => proxy.map.set('k', shared)).not.toThrow()
  })

  it('delete 命中与未命中分别处理，clear 只对非空集合上报', () => {
    const { state, proxy, mutations } = makeHarness({ map: new Map([['a', 1]]), other: 0 })
    expect(proxy.map.delete('missing')).toBe(false)
    expect(proxy.map.delete('a')).toBe(true)
    expect(state.map.size).toBe(0)
    proxy.map.clear()
    expect(mutations.length).toBe(1)
    proxy.map.set('b', 2)
    proxy.map.clear()
    expect(mutations.length).toBe(3)
  })

  it('get/has/forEach/迭代器提供包装后的键值', () => {
    const { proxy } = makeHarness({ map: new Map([['a', { n: 1 }]]) })
    expect(proxy.map.has('a')).toBe(true)
    expect(proxy.map.get('missing')).toBeUndefined()

    const seen: Array<[unknown, unknown]> = []
    const thisArg = { tag: 'ctx' }
    proxy.map.forEach(function (this: unknown, value: unknown, key: unknown, collection: unknown) {
      seen.push([key, value])
      expect(this).toBe(thisArg)
      expect(collection).toBe(proxy.map)
    }, thisArg)
    expect(seen.length).toBe(1)

    expect([...proxy.map.entries()].map(([k, v]: [unknown, any]) => [k, v.n])).toEqual([['a', 1]])
    expect([...proxy.map.keys()]).toEqual(['a'])
    expect([...proxy.map.values()].map((v: any) => v.n)).toEqual([1])
    expect([...proxy.map].map(([k, v]: [unknown, any]) => [k, v.n])).toEqual([['a', 1]])
  })
})

describe('dirtyTracking · Set 写入', () => {
  it('add 新成员登记边，重复 add 不重复展开', () => {
    const member = { m: 1 }
    const { state, proxy, mutations } = makeHarness({ set: new Set(), other: 0 })
    proxy.set.add(member)
    proxy.set.add(member)
    expect(state.set.has(member)).toBe(true)
    proxy.set.forEach((value: any) => (value.m = 2))
    expect(member.m).toBe(2)
    expect(lastKeys(mutations)).toEqual(['set'])
  })

  it('delete 与 clear 各自的命中分支', () => {
    const member = {}
    const { state, proxy, mutations } = makeHarness({ set: new Set([member]), other: 0 })
    expect(proxy.set.delete({})).toBe(false)
    expect(proxy.set.delete(member)).toBe(true)
    expect(state.set.size).toBe(0)
    proxy.set.clear()
    expect(mutations.length).toBe(1)

    proxy.set.add(member)
    proxy.set.clear()
    expect(mutations.length).toBe(3)
  })

  it('Set 的 values/keys/迭代器都返回包装值', () => {
    const { proxy } = makeHarness({ set: new Set([{ n: 1 }]) })
    const viaValues = [...proxy.set.values()].map((v: any) => v.n)
    const viaKeys = [...proxy.set.keys()].map((v: any) => v.n)
    const viaIterator = [...proxy.set].map((v: any) => v.n)
    expect(viaValues).toEqual([1])
    expect(viaKeys).toEqual([1])
    expect(viaIterator).toEqual([1])
  })
})

describe('dirtyTracking · 对象替换与访问器归属', () => {
  it('对象换对象在覆盖关系成立时免于全量重建，且新子树继续被归因', () => {
    const replacement = { n: 1 }
    const { state, proxy, mutations } = makeHarness({ box: { slot: { old: 1 }, spare: replacement } })
    proxy.box.slot = replacement
    expect(state.box.slot).toBe(replacement)
    expect(lastKeys(mutations)).toEqual(['box'])
    proxy.box.slot.n = 2
    expect(replacement.n).toBe(2)
    expect(lastKeys(mutations)).toEqual(['box'])
  })

  it('换成新对象后仍按容器归属上报，新子树继续被归因', () => {
    const { state, proxy, mutations } = makeHarness({ box: { slot: { old: 1 } } })
    proxy.box.slot = { fresh: true }
    expect(state.box.slot).toEqual({ fresh: true })
    expect(lastKeys(mutations)).toEqual(['box'])
    proxy.box.slot.fresh = false
    expect(lastKeys(mutations)).toEqual(['box'])
  })

  it('通过访问器取出的对象不在索引内，写入时保守标记全部顶层键', () => {
    const hidden = { x: 1 }
    const state: AnyRecord = { other: 0 }
    Object.defineProperty(state, 'acc', { enumerable: true, configurable: true, get: () => hidden })
    const { proxy, mutations } = makeHarness(state)
    proxy.acc.x = 2
    expect(hidden.x).toBe(2)
    expect([...lastKeys(mutations)].filter((key) => typeof key === 'string').sort()).toEqual(['acc', 'other'])
  })

  it('访问器取出的对象上新增对象属性时同样保守上报', () => {
    const hidden: AnyRecord = {}
    const state: AnyRecord = { other: 0 }
    Object.defineProperty(state, 'acc', { enumerable: true, configurable: true, get: () => hidden })
    const { proxy, mutations } = makeHarness(state)
    proxy.acc.child = { n: 1 }
    expect(hidden.child).toEqual({ n: 1 })
    expect([...lastKeys(mutations)].filter((key) => typeof key === 'string').sort()).toEqual(['acc', 'other'])
  })

  it('原型上的访问器 setter：写入判为删边并经 Reflect.set 触达 setter', () => {
    const proto = {
      set prop(value: number) {
        ;(this as AnyRecord)._v = value
      },
    }
    const state: AnyRecord = Object.create(proto)
    state.a = 1
    const { proxy, mutations } = makeHarness(state)
    proxy.prop = 5
    expect(state._v).toBe(5)
    expect(lastKeys(mutations)).toContain('prop')
  })

  it('原型上的无 setter 访问器：写入返回 false 且不上报', () => {
    const proto = {
      get prop() {
        return 1
      },
    }
    const state: AnyRecord = Object.create(proto)
    state.a = 1
    const { proxy, mutations } = makeHarness(state)
    expect(Reflect.set(proxy, 'prop', 2)).toBe(false)
    expect(state.a).toBe(1)
    expect(mutations).toEqual([])
  })
})

describe('dirtyTracking · 类实例、集合子类与类型化数组', () => {
  class Service {
    #count = 0
    bump(): number {
      this.#count += 1
      return this.#count
    }
  }

  it('类实例方法调用前按所属顶层键保守上报，且方法可访问 #private', () => {
    const { proxy, mutations } = makeHarness({ svc: new Service(), other: 0 })
    expect(proxy.svc.bump()).toBe(1)
    expect(lastKeys(mutations)).toEqual(['svc'])
    // 第二次调用复用包装
    expect(proxy.svc.bump()).toBe(2)
    expect(lastKeys(mutations)).toEqual(['svc'])
  })

  it('类实例方法被替换后返回新的包装并调用新实现', () => {
    const { proxy } = makeHarness({ svc: new Service() })
    const first = proxy.svc.bump
    expect(typeof first).toBe('function')
    proxy.svc.bump = () => 42
    expect(proxy.svc.bump()).toBe(42)
  })

  it('Map 子类的自定义方法以原始实例为接收者，替换后重建绑定', () => {
    class MyMap extends Map<string, number> {
      custom(): number {
        return this.size
      }
    }
    const instance = new MyMap()
    const { proxy } = makeHarness({ box: instance })
    expect(proxy.box.custom()).toBe(0)
    expect(proxy.box.custom()).toBe(0)
    ;(instance as unknown as AnyRecord).custom = () => 'replaced'
    expect(proxy.box.custom()).toBe('replaced')
    expect(proxy.box.constructor).toBe(MyMap)
  })

  it('Set 子类的自定义方法同样以原始实例为接收者', () => {
    class MySet extends Set<number> {
      custom(): number {
        return this.size
      }
    }
    const { proxy } = makeHarness({ box: new MySet() })
    expect(proxy.box.custom()).toBe(0)
  })

  it('类型化数组：元素写入归因到所属键，自定义属性子树可增量归因', () => {
    const typed = new Uint8Array(2) as unknown as AnyRecord
    typed.custom = { x: 1 }
    const { proxy, mutations } = makeHarness({ buf: typed, other: 0 })
    proxy.buf[0] = 9
    expect(typed[0]).toBe(9)
    expect(lastKeys(mutations)).toEqual(['buf'])
    proxy.buf.custom.x = 2
    expect(typed.custom.x).toBe(2)
    expect(lastKeys(mutations)).toEqual(['buf'])
  })

  it('内建对象（Date）保持原引用，不被代理', () => {
    const date = new Date(1)
    const { proxy } = makeHarness({ d: date })
    expect(proxy.d).toBe(date)
    proxy.d = new Date(2)
  })
})

describe('dirtyTracking · 归属补充路径', () => {
  it('根是 Map 时集合变异仍可上报（根键集合为空，不抛错）', () => {
    const root = new Map<string, unknown>([['k', { n: 1 }]])
    const mutations: Keys[] = []
    const proxy = createDirtyTrackingProxy(root, createDirtyTrackingCache(), (keys) => mutations.push([...keys])) as AnyRecord
    proxy.set('k', { n: 2 })
    expect(root.get('k')).toEqual({ n: 2 })
    expect(mutations).toEqual([[]])
  })

  it('初始归属扫描跳过嵌套访问器属性，不影响其它子树的归因', () => {
    const nested: AnyRecord = { other: { n: 1 } }
    Object.defineProperty(nested, 'acc', { get: () => 1, enumerable: true, configurable: true })
    const { proxy, mutations } = makeHarness({ box: nested })
    proxy.box.other.n = 2
    expect(nested.other.n).toBe(2)
    expect(lastKeys(mutations)).toEqual(['box'])
  })

  it('集合上的自定义数据属性按原值返回，不当作方法绑定', () => {
    const map = new Map<string, number>()
    ;(map as unknown as AnyRecord).note = 'hello'
    const { proxy } = makeHarness({ box: map })
    expect((proxy.box as AnyRecord).note).toBe('hello')
  })

  it('Set 的 entries / Symbol.iterator 包装对象成员，写入归因到集合所在键', () => {
    const member = { n: 1 }
    const set = new Set<unknown>([member])
    const { proxy, mutations } = makeHarness({ box: set })
    const entries = [...((proxy.box as AnyRecord).entries as () => Array<[unknown, unknown]>)()]
    expect(entries).toHaveLength(1)
    const wrapped = entries[0][0] as AnyRecord
    wrapped.n = 2
    expect(member.n).toBe(2)
    expect(lastKeys(mutations)).toEqual(['box'])
    const iterated = [...(proxy.box as unknown as Iterable<AnyRecord>)][0]
    iterated.n = 3
    expect(member.n).toBe(3)
    expect(lastKeys(mutations)).toEqual(['box'])
  })

  it('Set forEach 包装成员；Map forEach 的键与值都包装', () => {
    const member = { n: 1 }
    const mapKey = { k: 1 }
    const map = new Map<unknown, unknown>([[mapKey, { v: 1 }]])
    const { proxy } = makeHarness({ box: map, set: new Set([member]) })
    const seenMap: Array<[unknown, unknown]> = []
    ;(proxy.box as AnyRecord).forEach((value: unknown, key: unknown) => seenMap.push([key, value]))
    expect(seenMap[0][0]).not.toBe(mapKey)
    ;(seenMap[0][0] as AnyRecord).k = 2
    expect(mapKey.k).toBe(2)
    const seenSet: unknown[] = []
    ;(proxy.set as AnyRecord).forEach((value: unknown) => seenSet.push(value))
    ;(seenSet[0] as AnyRecord).n = 9
    expect(member.n).toBe(9)
  })
})

describe('dirtyTracking · 属性操作细节', () => {
  it('defineProperty 写入数据属性并上报；新增对象属性登记边', () => {
    const { state, proxy, mutations } = makeHarness({ a: 1, other: 0 })
    Object.defineProperty(proxy, 'a', { value: 2, writable: true, enumerable: true, configurable: true })
    expect(state.a).toBe(2)
    Object.defineProperty(proxy, 'added', { value: { n: 1 }, writable: true, enumerable: true, configurable: true })
    proxy.added.n = 2
    expect(state.added.n).toBe(2)
    expect(mutations.length).toBeGreaterThanOrEqual(3)
  })

  it('defineProperty 定义访问器属性后读取走 getter', () => {
    const { proxy } = makeHarness({ a: 1 })
    Object.defineProperty(proxy, 'g', {
      get: () => 7,
      enumerable: true,
      configurable: true,
    })
    expect(proxy.g).toBe(7)
  })

  it('删除对象值键按删边处理，删除原始值键按稳定处理，删除不存在的键也可成功', () => {
    const { state, proxy, mutations } = makeHarness({ obj: { n: 1 }, prim: 1 })
    expect(Reflect.deleteProperty(proxy, 'obj')).toBe(true)
    expect(state.obj).toBeUndefined()
    expect(Reflect.deleteProperty(proxy, 'prim')).toBe(true)
    expect(Reflect.deleteProperty(proxy, 'missing')).toBe(true)
    expect(mutations.length).toBe(3)
  })

  it('删除不可配置属性返回 false 且不上报', () => {
    const state: AnyRecord = {}
    Object.defineProperty(state, 'fixed', { value: 1, configurable: false, writable: true, enumerable: true })
    const { proxy, mutations } = makeHarness(state)
    expect(Reflect.deleteProperty(proxy, 'fixed')).toBe(false)
    expect(mutations).toEqual([])
  })

  it('写入不可写属性返回 false 且不上报', () => {
    const state: AnyRecord = {}
    Object.defineProperty(state, 'readonly', { value: 1, configurable: true, writable: false, enumerable: true })
    const { proxy, mutations } = makeHarness(state)
    expect(Reflect.set(proxy, 'readonly', 2)).toBe(false)
    expect(state.readonly).toBe(1)
    expect(mutations).toEqual([])
  })

  it('嵌套对象上的不可写属性同样不触发上报', () => {
    const inner: AnyRecord = {}
    Object.defineProperty(inner, 'ro', { value: 1, configurable: true, writable: false, enumerable: true })
    const { proxy, mutations } = makeHarness({ inner })
    expect(Reflect.set(proxy.inner, 'ro', 2)).toBe(false)
    expect(mutations).toEqual([])
  })
})

describe('dirtyTracking · 代理缓存', () => {
  it('同一根对象与缓存返回同一代理（快路径）', () => {
    const state: AnyRecord = { a: 1 }
    const cache = createDirtyTrackingCache()
    const onMutate = jest.fn()
    const proxy = createDirtyTrackingProxy(state, cache, onMutate)
    expect(createDirtyTrackingProxy(state, cache, onMutate)).toBe(proxy)
  })

  it('把已有代理当根传入时解包后返回同一代理', () => {
    const state: AnyRecord = { a: 1 }
    const cache = createDirtyTrackingCache()
    const onMutate = jest.fn()
    const proxy = createDirtyTrackingProxy(state, cache, onMutate)
    expect(createDirtyTrackingProxy(proxy, cache, onMutate)).toBe(proxy)
  })

  it('读取子对象拿到稳定代理', () => {
    const { proxy } = makeHarness({ child: { n: 1 } })
    expect(proxy.child).toBe(proxy.child)
  })
})

describe('dirtyTracking · 增量索引与覆盖判定的深层路径', () => {
  it('新增边的目标对象已有其他归属时增量并入索引', () => {
    const shared = { n: 1 }
    const { proxy, mutations } = makeHarness({ map: new Map(), alias: shared })
    proxy.alias.n = 2
    proxy.map.set('k', shared)
    proxy.map.get('k').n = 3
    expect([...lastKeys(mutations)].sort()).toEqual(['alias', 'map'])
  })

  it('已建立索引后，覆盖关系成立的对象交换免于全量重建', () => {
    const replacement = { n: 1 }
    const { state, proxy, mutations } = makeHarness({ box: { slot: { old: 1 }, spare: replacement } })
    proxy.box.spare.n = 2
    proxy.box.slot = replacement
    expect(state.box.slot).toBe(replacement)
    proxy.box.slot.n = 3
    expect(lastKeys(mutations)).toEqual(['box'])
  })

  it('换成未索引的新对象时按删边处理（已建立索引）', () => {
    const { state, proxy } = makeHarness({ box: { slot: { old: 1 } } })
    proxy.box.slot.old = 2
    proxy.box.slot = { fresh: true }
    expect(state.box.slot).toEqual({ fresh: true })
    proxy.box.slot.fresh = false
    expect(state.box.slot.fresh).toBe(false)
  })

  it('顶层对象交换：root 容器把本次键并入覆盖判据，覆盖不成立走删边', () => {
    const b = { n: 1 }
    const { state, proxy } = makeHarness({ a: { x: 1 }, b })
    proxy.a.x = 2
    proxy.c = b
    expect(state.c).toBe(b)
    expect(proxy.c.n).toBe(1)
  })

  it('容器不在索引内（访问器取出）时对象交换不做覆盖判定', () => {
    const hidden: AnyRecord = { slot: { old: 1 } }
    const state: AnyRecord = { other: 0 }
    Object.defineProperty(state, 'acc', { enumerable: true, configurable: true, get: () => hidden })
    const { proxy } = makeHarness(state)
    proxy.other = 1
    proxy.acc.slot = { fresh: true }
    expect(hidden.slot).toEqual({ fresh: true })
  })

  it('集合白名单方法第二次读取复用缓存', () => {
    const { proxy } = makeHarness({ map: new Map([['a', 1]]) })
    expect(proxy.map.get('a')).toBe(1)
    expect(proxy.map.get('a')).toBe(1)
    expect(proxy.map.has('a')).toBe(true)
    expect(proxy.map.has('a')).toBe(true)
  })

  it('defineProperty 失败（不可配置属性）返回 false 且不上报', () => {
    const state: AnyRecord = {}
    Object.defineProperty(state, 'fixed', { value: 1, configurable: false, writable: false, enumerable: true })
    const { proxy, mutations } = makeHarness(state)
    expect(Reflect.defineProperty(proxy, 'fixed', { value: 2, writable: false, configurable: false, enumerable: true })).toBe(false)
    expect(mutations).toEqual([])
  })
})

describe('dirtyTracking · 锁定属性与 root 级对象交换', () => {
  it('锁定属性（不可配置不可写）原样返回，成为有意的追踪空洞', () => {
    const locked = { n: 1 }
    const state: AnyRecord = { other: 0 }
    Object.defineProperty(state, 'fixed', { value: locked, writable: false, configurable: false, enumerable: true })
    const { proxy, mutations } = makeHarness(state)
    expect(proxy.fixed).toBe(locked)
    locked.n = 2
    expect(state.fixed.n).toBe(2)
    expect(mutations).toEqual([])
  })

  it('root 级替换已有对象值：root 容器把本次键并入覆盖判据，覆盖不成立即删边', () => {
    const b = { n: 1 }
    const { state, proxy } = makeHarness({ a: { x: 1 }, c: { old: 1 }, b })
    proxy.a.x = 2
    proxy.c = b
    expect(state.c).toBe(b)
    proxy.c.n = 3
    expect(b.n).toBe(3)
  })
})

describe('dirtyTracking · 集合键参数解包', () => {
  it('Map.has / Set.has 与 get/delete 同口径解包代理键', () => {
    const key = { id: 1 }
    const member = { id: 2 }
    const { state, proxy } = makeHarness({ key, member, map: new Map(), set: new Set() })
    const keyProxy = proxy.key
    const memberProxy = proxy.member
    proxy.map.set(keyProxy, 'hit')
    proxy.set.add(memberProxy)
    expect(state.map.has(key)).toBe(true)
    expect(state.set.has(member)).toBe(true)
    // 修复前 has 走白名单外绑定、参数不解包：代理键 get 命中而 has 返回 false
    expect(proxy.map.has(keyProxy)).toBe(true)
    expect(proxy.map.get(keyProxy)).toBe('hit')
    expect(proxy.set.has(memberProxy)).toBe(true)
  })
})

describe('dirtyTracking · 集合自定义属性写入', () => {
  it('Map/Set 自定义属性：对象值包装、写入标脏、删除上报', () => {
    const map = new Map<string, number>() as AnyRecord
    const set = new Set<number>() as AnyRecord
    const { state, proxy, mutations } = makeHarness({ map, set, other: 0 })
    proxy.map.meta = { n: 1 }
    expect(state.map.meta).toEqual({ n: 1 })
    expect(lastKeys(mutations)).toEqual(['map'])
    // 读回的是包装代理：嵌套写入继续被跟踪并归因
    const meta = proxy.map.meta as AnyRecord
    expect(meta).not.toBe(state.map.meta)
    meta.n = 2
    expect(state.map.meta.n).toBe(2)
    expect(lastKeys(mutations)).toEqual(['map'])
    proxy.set.note = { text: 'x' }
    expect(state.set.note).toEqual({ text: 'x' })
    expect(lastKeys(mutations)).toEqual(['set'])
    delete proxy.map.meta
    expect(state.map.meta).toBeUndefined()
    expect(lastKeys(mutations)).toEqual(['map'])
  })

  it('自定义函数/原始值属性原样返回（不绑定、不包装）', () => {
    const map = new Map<string, number>() as AnyRecord
    const { proxy } = makeHarness({ map })
    proxy.map.customFn = () => 42
    expect((proxy.map as AnyRecord).customFn()).toBe(42)
    proxy.map.note = 'hello'
    expect((proxy.map as AnyRecord).note).toBe('hello')
    expect((proxy.map as AnyRecord)[Symbol.toStringTag]).toBe('Map')
  })

  it('锁定属性原样返回；写入/删除/重定义失败分支不上报', () => {
    const map = new Map<string, number>() as AnyRecord
    const locked = { y: 1 }
    Object.defineProperty(map, 'locked', { value: locked, writable: false, configurable: false })
    Object.defineProperty(map, 'readonly', { value: 1, writable: false, configurable: true })
    Object.defineProperty(map, 'fixed', { value: 1, writable: true, configurable: false })
    const { proxy, mutations } = makeHarness({ map })
    expect((proxy.map as AnyRecord).locked).toBe(locked)
    // set 失败（不可写）→ 返回 false 且不上报
    expect(Reflect.set(proxy.map, 'readonly', 2)).toBe(false)
    // delete 失败（不可配置）→ 返回 false 且不上报
    expect(Reflect.deleteProperty(proxy.map, 'fixed')).toBe(false)
    // defineProperty 失败（不可配置且不可写属性改值）→ 返回 false 且不上报
    expect(Reflect.defineProperty(proxy.map, 'locked', { value: 2 })).toBe(false)
    expect(mutations).toEqual([])
  })

  it('defineProperty 自定义属性写入同样上报并递归解包', () => {
    const child = { n: 1 }
    const { state, proxy, mutations } = makeHarness({ map: new Map(), child })
    Object.defineProperty(proxy.map, 'defined', { value: { nested: proxy.child }, writable: true, enumerable: true, configurable: true })
    expect(state.map.defined.nested).toBe(state.child)
    expect(lastKeys(mutations)).toEqual(['map'])
  })

  it('根集合的自定义属性按本次键上报（根集合没有顶层归属）', () => {
    const root = new Map<string, unknown>()
    const mutations: Keys[] = []
    const proxy = createDirtyTrackingProxy(root, createDirtyTrackingCache(), (keys) => mutations.push([...keys])) as AnyRecord
    proxy.meta = { n: 1 }
    expect((root as AnyRecord).meta).toEqual({ n: 1 })
    expect(mutations).toEqual([['meta']])
    const meta = proxy.meta as AnyRecord
    meta.n = 2
    expect((root as AnyRecord).meta.n).toBe(2)
    // 根集合子对象无归属：写入按根的 ownKeys 保守上报
    expect(mutations[mutations.length - 1]).toEqual(['meta'])
  })

  it('defineProperty 访问器描述符原样定义并上报', () => {
    const { proxy, mutations } = makeHarness({ map: new Map() })
    Object.defineProperty(proxy.map as AnyRecord, 'computed', { get: () => 7, enumerable: true, configurable: true })
    expect((proxy.map as AnyRecord).computed).toBe(7)
    expect(lastKeys(mutations)).toEqual(['map'])
  })
})

describe('dirtyTracking · 集合键/成员包装', () => {
  it('Map.keys / Set.keys / entries / 迭代器 / forEach 的键与值同口径包装', () => {
    const mapKey = { id: 1 }
    const setMember = { id: 2 }
    const { state, proxy, mutations } = makeHarness({ map: new Map([[mapKey, 1]]), set: new Set([setMember]) })
    const [mapKeyProxy] = [...(proxy.map as AnyRecord).keys()]
    expect(mapKeyProxy).not.toBe(mapKey)
    ;(mapKeyProxy as AnyRecord).x = 1
    expect((mapKey as AnyRecord).x).toBe(1)
    expect(lastKeys(mutations)).toEqual(['map'])
    const [setKeyProxy] = [...(proxy.set as AnyRecord).keys()]
    expect(setKeyProxy).not.toBe(setMember)
    ;(setKeyProxy as AnyRecord).y = 1
    expect((setMember as AnyRecord).y).toBe(1)
    expect(lastKeys(mutations)).toEqual(['set'])
    // 缓存复用：keys()/entries()/迭代器/forEach 得到同一代理
    const [entryKey] = [...(proxy.map as AnyRecord).entries()][0]
    expect(entryKey).toBe(mapKeyProxy)
    const iterEntries = [...(proxy.map as unknown as Iterable<[unknown, unknown]>)]
    expect(iterEntries[0][0]).toBe(mapKeyProxy)
    const seen: Array<[unknown, unknown]> = []
    ;(proxy.map as AnyRecord).forEach((value: unknown, key: unknown) => seen.push([key, value]))
    expect(seen[0][0]).toBe(mapKeyProxy)
    // 代理键可反查原始键
    expect((proxy.map as AnyRecord).has(mapKeyProxy)).toBe(true)
    expect((proxy.map as AnyRecord).get(mapKeyProxy)).toBe(1)
    expect(state.map.has(mapKey)).toBe(true)
  })
})

describe('dirtyTracking · 赋值容器内的代理递归解包', () => {
  it('数组/纯对象/Map/Set 容器内的代理值写回裸状态后是原始对象', () => {
    const child = { n: 1 }
    const key = { id: 1 }
    const { state, proxy } = makeHarness({ child, key, other: 0 })
    const childProxy = proxy.child

    proxy.list = [childProxy]
    expect(state.list[0]).toBe(state.child)

    proxy.obj = { nested: childProxy }
    expect(state.obj.nested).toBe(state.child)

    proxy.bag = new Map<string, unknown>([['k', childProxy]])
    expect(state.bag.get('k')).toBe(state.child)

    proxy.keyBag = new Map([[proxy.key as unknown, 'v']])
    expect(state.keyBag.has(state.key)).toBe(true)

    proxy.tags = new Set([childProxy])
    expect([...state.tags][0]).toBe(state.child)

    proxy.alias = childProxy
    expect(state.alias).toBe(state.child)
  })

  it('不含代理的容器保持调用方对象身份（零改动）', () => {
    const { state, proxy } = makeHarness({ other: 0 })
    const plain = { a: 1 }
    const list = [1, 2]
    const map = new Map([['k', { v: 1 }]])
    const set = new Set([1, 2])
    proxy.plain = plain
    proxy.list = list
    proxy.map = map
    proxy.set = set
    expect(state.plain).toBe(plain)
    expect(state.list).toBe(list)
    expect(state.map).toBe(map)
    expect(state.set).toBe(set)
  })

  it('空洞数组、内建对象、类实例与访问器属性按各自口径处理', () => {
    const child = { n: 1 }
    const { state, proxy } = makeHarness({ child, other: 0 })
    const sparse: unknown[] = new Array(2)
    sparse[1] = proxy.child
    proxy.sparse = sparse
    expect(state.sparse[0]).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(state.sparse, 0)).toBe(false)
    expect(state.sparse[1]).toBe(state.child)

    const date = new Date(1)
    proxy.date = date
    expect(state.date).toBe(date)

    class Box {
      inner: unknown
      constructor(inner: unknown) {
        this.inner = inner
      }
    }
    const box = new Box(proxy.child)
    proxy.box = box
    expect(state.box).toBe(box)

    const withAccessor: AnyRecord = { child: proxy.child }
    Object.defineProperty(withAccessor, 'g', { get: () => 1, enumerable: true, configurable: true })
    proxy.accessor = withAccessor
    expect(state.accessor.child).toBe(state.child)
    expect(state.accessor.g).toBe(1)
  })

  it('循环引用容器：自引用保持、嵌套代理仍被解包', () => {
    const child = { n: 1 }
    const { state, proxy } = makeHarness({ child, other: 0 })
    const container: AnyRecord = { child: proxy.child }
    container.self = container
    proxy.cyc = container
    expect(state.cyc.self).toBe(state.cyc)
    expect(state.cyc.child).toBe(state.child)
  })

  it('defineProperty 与 Map.set / Set.add 同样递归解包嵌套代理', () => {
    const child = { n: 1 }
    const { state, proxy, mutations } = makeHarness({ child, other: 0, bag: new Map(), tags: new Set() })
    const childProxy = proxy.child
    Object.defineProperty(proxy, 'defined', { value: { nested: childProxy }, writable: true, enumerable: true, configurable: true })
    expect(state.defined.nested).toBe(state.child)
    proxy.bag.set('k', { nested: childProxy })
    expect(state.bag.get('k').nested).toBe(state.child)
    proxy.tags.add([childProxy])
    const first = [...state.tags][0] as unknown[]
    expect(first[0]).toBe(state.child)
    expect(mutations.length).toBeGreaterThan(0)
  })
})

describe('dirtyTracking · 类方法返回值与集合归属时效', () => {
  class Builder {
    value = 0
    setValue(next: number): this {
      this.value = next
      return this
    }
  }

  it('类实例方法参数解包、返回值包装：builder 链式写入可追踪', () => {
    const { state, proxy, mutations } = makeHarness({ svc: new Builder(), other: 0 })
    const svc = proxy.svc as AnyRecord
    const chained = svc.setValue(1).setValue(2)
    expect(chained).toBe(svc)
    expect(state.svc.value).toBe(2)
    expect(lastKeys(mutations)).toEqual(['svc'])
  })

  it('方法参数中的代理被解包后再进入方法体', () => {
    class Holder {
      inner: AnyRecord | null = null
      capture(value: AnyRecord): void {
        this.inner = value
      }
    }
    const { state, proxy } = makeHarness({ holder: new Holder(), child: { n: 1 } })
    const childProxy = proxy.child
    ;(proxy.holder as AnyRecord).capture(childProxy)
    expect(state.holder.inner).toBe(state.child)
  })

  it('集合方法闭包缓存后 owner 变化时按新归属/全量兜底上报', () => {
    const shared = new Map<string, { n: number }>([['k', { n: 1 }]])
    const { state, proxy, mutations } = makeHarness({ a: shared, b: null })
    const get = (proxy.a as AnyRecord).get as (key: string) => AnyRecord
    // 先把 a 的 map 赋给 b：同一对象两个顶层键 → 归属变 AMBIGUOUS
    proxy.b = proxy.a
    const value = get('k')
    value.n = 2
    expect(state.a.get('k')!.n).toBe(2)
    expect([...lastKeys(mutations)].sort()).toEqual(['a', 'b'])
  })
})

describe('dirtyTracking · 数组容器解包的键枚举与附加键', () => {
  it('稀疏大 length 数组按自有键解包，不按 length 迭代', () => {
    const child = { n: 1 }
    const { state, proxy } = makeHarness({ child, other: 0 })
    const sparse: unknown[] = []
    sparse[2 ** 32 - 2] = proxy.child
    proxy.sparse = sparse
    expect(state.sparse[2 ** 32 - 2]).toBe(state.child)
    expect(state.sparse.length).toBe(2 ** 32 - 1)
  })

  it('数组非下标自有键（字符串/符号键）内的代理同样被解包', () => {
    const child = { n: 1 }
    const tag = Symbol('tag')
    const { state, proxy } = makeHarness({ child, other: 0 })
    const arr = [proxy.child] as unknown[] & Record<PropertyKey, unknown>
    arr.meta = { nested: proxy.child }
    arr[tag] = { nested: proxy.child }
    proxy.arr = arr
    expect(state.arr[0]).toBe(state.child)
    expect((state.arr.meta as AnyRecord).nested).toBe(state.child)
    expect((state.arr[tag] as AnyRecord).nested).toBe(state.child)
  })

  it('数组自有访问器属性不被解包流程改写', () => {
    const child = { n: 1 }
    const { state, proxy } = makeHarness({ child, other: 0 })
    const arr = [proxy.child] as unknown[] & Record<PropertyKey, unknown>
    Object.defineProperty(arr, 'acc', { get: () => child, enumerable: true, configurable: true })
    proxy.arr = arr
    expect(state.arr[0]).toBe(state.child)
    expect((state.arr as AnyRecord).acc).toBe(state.child)
  })
})

describe('dirtyTracking · 类方法返回值分类包装', () => {
  const fixedPlain = { ok: 1 }
  const fixedList = [1, 2]
  const fixedMap = new Map([['k', 1]])
  const fixedSet = new Set([1])
  class Worker {
    promise(): Promise<number> {
      return Promise.resolve(1)
    }
    plain(): AnyRecord {
      return fixedPlain
    }
    list(): number[] {
      return fixedList
    }
    map(): Map<string, number> {
      return fixedMap
    }
    set(): Set<number> {
      return fixedSet
    }
    instance(): Worker {
      return new Worker()
    }
    primitive(): number {
      return 7
    }
  }

  it('Promise 原样返回：await 不再进入 get 陷阱，方法调用只上报一次', async () => {
    const { proxy, mutations } = makeHarness({ worker: new Worker() })
    const promise = (proxy.worker as AnyRecord).promise()
    expect(promise).toBeInstanceOf(Promise)
    await expect(promise).resolves.toBe(1)
    expect(mutations).toHaveLength(1)
  })

  it('纯对象/数组/Map/Set 返回值包装后可追踪；类实例与原始值原样返回', () => {
    const { proxy } = makeHarness({ worker: new Worker() })
    const worker = proxy.worker as AnyRecord
    const plain = worker.plain()
    expect(plain).not.toBe(fixedPlain)
    plain.added = 2
    expect((fixedPlain as AnyRecord).added).toBe(2)
    expect(worker.list()).not.toBe(fixedList)
    expect(worker.map()).not.toBe(fixedMap)
    expect(worker.set()).not.toBe(fixedSet)
    expect(worker.instance()).toBeInstanceOf(Worker)
    expect(worker.primitive()).toBe(7)
  })
})
