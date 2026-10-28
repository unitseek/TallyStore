import { deepCloneState, isIndexKey, ownEnumerableKeys } from '../../../src/core/utils/clone.js'

describe('deepCloneState · 内建类型按内容重建', () => {
  it('Date / RegExp 重建为等价的新实例', () => {
    const date = new Date(1700000000000)
    const clonedDate = deepCloneState(date)
    expect(clonedDate).not.toBe(date)
    expect(clonedDate.getTime()).toBe(date.getTime())

    const regexp = /ab+c/gi
    const clonedRegExp = deepCloneState(regexp)
    expect(clonedRegExp).not.toBe(regexp)
    expect(clonedRegExp.source).toBe(regexp.source)
    expect(clonedRegExp.flags).toBe(regexp.flags)
  })

  it('Map 克隆键与值，支持自引用', () => {
    const key = { k: 1 }
    const map = new Map<unknown, unknown>([[key, { v: 2 }]])
    map.set('self', map)
    const cloned = deepCloneState(map)
    expect(cloned).not.toBe(map)
    expect(cloned.size).toBe(2)
    const clonedKey = [...cloned.keys()][0] as { k: number }
    expect(clonedKey).not.toBe(key)
    expect(clonedKey).toEqual({ k: 1 })
    expect(cloned.get('self')).toBe(cloned)
  })

  it('Set 克隆成员，支持自引用', () => {
    const member = { m: 1 }
    const set = new Set<unknown>([member])
    set.add(set)
    const cloned = deepCloneState(set)
    expect(cloned).not.toBe(set)
    expect(cloned.has(cloned)).toBe(true)
    const clonedMember = [...cloned].find((item) => item !== cloned) as { m: number }
    expect(clonedMember).not.toBe(member)
    expect(clonedMember).toEqual({ m: 1 })
  })

  it('内建子类实例保留原引用（只克隆恰好是内建类型的实例）', () => {
    class MyDate extends Date {}
    class MyMap extends Map {}
    class MySet extends Set {}
    class MyRegExp extends RegExp {}
    class MyArray extends Array {}
    const date = new MyDate()
    const map = new MyMap()
    const set = new MySet()
    const regexp = new MyRegExp('x')
    const array = new MyArray()
    expect(deepCloneState(date)).toBe(date)
    expect(deepCloneState(map)).toBe(map)
    expect(deepCloneState(set)).toBe(set)
    expect(deepCloneState(regexp)).toBe(regexp)
    expect(deepCloneState(array)).toBe(array)
  })
})

describe('deepCloneState · 数组', () => {
  it('保留 length 与空洞，不把空洞填成 undefined', () => {
    const arr = new Array(3)
    arr[1] = 'x'
    const cloned = deepCloneState(arr)
    expect(cloned).not.toBe(arr)
    expect(cloned.length).toBe(3)
    expect(Object.prototype.hasOwnProperty.call(cloned, 0)).toBe(false)
    expect(cloned[1]).toBe('x')
  })

  it('稀疏大 length 数组按自有索引键克隆，不按 length 迭代', () => {
    const arr: unknown[] = []
    const index = 2 ** 32 - 2
    arr[index] = { v: 1 }
    expect(arr.length).toBe(2 ** 32 - 1)
    const cloned = deepCloneState(arr)
    expect(cloned.length).toBe(2 ** 32 - 1)
    expect(cloned[index]).toEqual({ v: 1 })
    expect(cloned[index]).not.toBe(arr[index])
    // 空洞仍是空洞，不被填成值为 undefined 的实槽位
    expect(Object.prototype.hasOwnProperty.call(cloned, 0)).toBe(false)
  })

  it('克隆非下标自有键（字符串键、符号键）', () => {
    const tag = Symbol('tag')
    const arr = [1, 2] as unknown[] & Record<PropertyKey, unknown>
    arr.meta = { m: 1 }
    arr[tag] = { t: 1 }
    const cloned = deepCloneState(arr)
    expect((cloned as Record<PropertyKey, unknown>).meta).toEqual({ m: 1 })
    expect((cloned as Record<PropertyKey, unknown>).meta).not.toBe(arr.meta)
    expect((cloned as Record<PropertyKey, unknown>)[tag]).toEqual({ t: 1 })
    expect((cloned as Record<PropertyKey, unknown>)[tag]).not.toBe(arr[tag])
  })

  it('嵌套数组与对象逐层克隆', () => {
    const source = { nested: [[1], { a: [2] }] }
    const cloned = deepCloneState(source)
    expect(cloned).not.toBe(source)
    expect(cloned.nested).not.toBe(source.nested)
    expect(cloned.nested[1]).not.toBe(source.nested[1])
    expect(cloned).toEqual(source)
  })
})

describe('deepCloneState · 纯对象与循环引用', () => {
  it('循环引用安全，且自引用指向副本自身', () => {
    const source: Record<string, unknown> = { a: 1 }
    source.self = source
    const cloned = deepCloneState(source)
    expect(cloned).not.toBe(source)
    expect(cloned.self).toBe(cloned)
  })

  it('互相引用的两个对象在副本中仍互相引用', () => {
    const a: Record<string, unknown> = { name: 'a' }
    const b: Record<string, unknown> = { name: 'b', a }
    a.b = b
    const cloned = deepCloneState(a)
    expect(cloned.b).not.toBe(b)
    expect((cloned.b as Record<string, unknown>).a).toBe(cloned)
  })

  it('null 原型对象克隆后仍是 null 原型', () => {
    const source = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 })
    const cloned = deepCloneState(source)
    expect(Object.getPrototypeOf(cloned)).toBeNull()
    expect(cloned.a).toBe(1)
  })

  it('自有 __proto__ 键按自有数据属性复制，不污染原型', () => {
    const source = JSON.parse('{"__proto__":{"polluted":true},"a":1}') as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(source, '__proto__')).toBe(true)
    const cloned = deepCloneState(source)
    expect(Object.getPrototypeOf(cloned)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(cloned, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(cloned.a).toBe(1)
  })

  it('符号键随副本保留', () => {
    const tag = Symbol('tag')
    const source: Record<PropertyKey, unknown> = { a: 1 }
    source[tag] = { v: 1 }
    const cloned = deepCloneState(source)
    expect(cloned[tag]).toEqual({ v: 1 })
    expect(cloned[tag]).not.toBe(source[tag])
  })
})

describe('deepCloneState · 无法克隆的值保留原引用', () => {
  it('class 实例、函数、WeakMap、Promise 原样返回', () => {
    class Service {
      run(): number {
        return 1
      }
    }
    const svc = new Service()
    const fn = () => 1
    const weak = new WeakMap()
    const promise = Promise.resolve(1)
    expect(deepCloneState(svc)).toBe(svc)
    expect(deepCloneState(fn)).toBe(fn)
    expect(deepCloneState(weak)).toBe(weak)
    expect(deepCloneState(promise)).toBe(promise)
  })

  it('原始值直接返回', () => {
    expect(deepCloneState(1)).toBe(1)
    expect(deepCloneState('x')).toBe('x')
    expect(deepCloneState(null)).toBeNull()
    expect(deepCloneState(undefined)).toBeUndefined()
    expect(deepCloneState(true)).toBe(true)
  })
})

describe('isIndexKey', () => {
  it('只认规范十进制下标键', () => {
    expect(isIndexKey('0')).toBe(true)
    expect(isIndexKey('12')).toBe(true)
    expect(isIndexKey('4294967294')).toBe(true)
    expect(isIndexKey('00')).toBe(false)
    expect(isIndexKey('01')).toBe(false)
    expect(isIndexKey('-1')).toBe(false)
    expect(isIndexKey('1.5')).toBe(false)
    expect(isIndexKey('1e2')).toBe(false)
    expect(isIndexKey('0x10')).toBe(false)
    expect(isIndexKey('')).toBe(false)
    expect(isIndexKey('4294967295')).toBe(false)
    expect(isIndexKey('abc')).toBe(false)
  })
})

describe('ownEnumerableKeys', () => {
  it('无符号键时与 Object.keys 一致', () => {
    expect(ownEnumerableKeys({ a: 1, b: 2 })).toEqual(['a', 'b'])
  })

  it('字符串键在前、可枚举符号键在后；不可枚举符号键被过滤', () => {
    const enumerable = Symbol('enumerable')
    const hidden = Symbol('hidden')
    const target: Record<PropertyKey, unknown> = { a: 1 }
    target[enumerable] = 2
    Object.defineProperty(target, hidden, { value: 3, enumerable: false })
    const keys = ownEnumerableKeys(target)
    expect(keys[0]).toBe('a')
    expect(keys).toContain(enumerable)
    expect(keys).not.toContain(hidden)
    expect(keys.length).toBe(2)
  })
})

describe('deepCloneState · 内建对象 brand/身份/自有属性', () => {
  it('同一 Date/RegExp 的重复引用在副本中保持同一身份，RegExp.lastIndex 保留', () => {
    const date = new Date(1)
    const regexp = /a/g
    regexp.lastIndex = 2
    const source = { a: date, b: date, r1: regexp, r2: regexp }
    const cloned = deepCloneState(source)
    expect(cloned.a).not.toBe(date)
    expect(cloned.a).toBe(cloned.b)
    expect(cloned.r1).toBe(cloned.r2)
    expect(cloned.r1.lastIndex).toBe(2)
  })

  it('Date/RegExp/Map/Set 的自有可枚举属性一并克隆', () => {
    const date = Object.assign(new Date(1), { tag: 'x' })
    const regexp = Object.assign(/a/g, { tag: 'y' })
    const map = Object.assign(new Map([['k', 1]]), { meta: { n: 1 } })
    const set = Object.assign(new Set([1]), { meta: { n: 2 } })
    const cloned = deepCloneState({ date, regexp, map, set })
    expect(cloned.date.tag).toBe('x')
    expect(cloned.regexp.tag).toBe('y')
    expect(cloned.map.meta).toEqual({ n: 1 })
    expect(cloned.map.meta).not.toBe(map.meta)
    expect(cloned.set.meta).toEqual({ n: 2 })
  })

  it('伪内建对象（Object.create(原型)）保留原引用且不崩溃', () => {
    const fakeMap = Object.create(Map.prototype)
    const fakeSet = Object.create(Set.prototype)
    const fakeDate = Object.create(Date.prototype)
    const fakeRegExp = Object.create(RegExp.prototype)
    const cloned = deepCloneState({ fakeMap, fakeSet, fakeDate, fakeRegExp })
    expect(cloned.fakeMap).toBe(fakeMap)
    expect(cloned.fakeSet).toBe(fakeSet)
    expect(cloned.fakeDate).toBe(fakeDate)
    expect(cloned.fakeRegExp).toBe(fakeRegExp)
  })

  it('自有方法覆盖不执行注入代码：按不可克隆保留原引用', () => {
    const fakeMap = Object.create(Map.prototype) as Map<unknown, unknown> & { forEach: () => void }
    const spy = jest.fn()
    fakeMap.forEach = spy
    expect(deepCloneState(fakeMap)).toBe(fakeMap)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('deepCloneState · 数组键枚举与描述符口径', () => {
  it('非枚举自有下标按源描述符复制（描述符保真）', () => {
    const arr = [1, 2]
    Object.defineProperty(arr, 0, { value: { v: 9 }, enumerable: false, writable: true, configurable: true })
    const cloned = deepCloneState(arr)
    expect(Object.prototype.hasOwnProperty.call(cloned, 0)).toBe(true)
    expect(cloned[0]).toEqual({ v: 9 })
    expect(cloned[0]).not.toBe(arr[0])
    // 隐藏下标在副本里仍是隐藏的：不再被普通赋值改成可枚举
    expect(Object.prototype.propertyIsEnumerable.call(cloned, 0)).toBe(false)
    expect(Object.keys(cloned)).toEqual(['1'])
    expect(cloned[1]).toBe(2)
  })

  it('非枚举的非下标/符号自有键不复制（与纯对象分支的可枚举口径一致）', () => {
    const hidden = Symbol('hidden')
    const arr = [1] as unknown[] & Record<PropertyKey, unknown>
    Object.defineProperty(arr, 'secret', { value: { s: 1 }, enumerable: false, configurable: true })
    Object.defineProperty(arr, hidden, { value: { h: 1 }, enumerable: false, configurable: true })
    const cloned = deepCloneState(arr)
    expect(Object.prototype.hasOwnProperty.call(cloned, 'secret')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(cloned, hidden)).toBe(false)
  })
})

describe('deepCloneState · 内建对象自有同名访问器属性', () => {
  it('源 Map/Set 带自有可枚举 size 时，克隆以自有数据属性落位、不触发原型无 setter 访问器报错', () => {
    const map = new Map([['k', 1]])
    Object.defineProperty(map, 'size', { value: 99, writable: true, enumerable: true, configurable: true })
    const set = new Set([1])
    Object.defineProperty(set, 'size', { value: 88, writable: true, enumerable: true, configurable: true })
    const cloned = deepCloneState({ map, set })
    expect(Object.getOwnPropertyDescriptor(cloned.map, 'size')?.value).toBe(99)
    expect(Object.getOwnPropertyDescriptor(cloned.set, 'size')?.value).toBe(88)
  })
})
