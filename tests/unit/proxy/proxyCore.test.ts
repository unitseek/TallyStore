import {
  ARRAY_MUTATING_METHODS,
  bindMethodToOwner,
  createBoundMethodCache,
  createProxyCache,
  isBuiltinObject,
  isMapLike,
  isSetLike,
  lockedOwnValue,
} from '../../../src/core/store/proxyCore.js'

class Counter {
  #n = 0
  bump(step = 1): number {
    this.#n += step
    return this.#n
  }
  value(): number {
    return this.#n
  }
}

describe('proxyCore · ARRAY_MUTATING_METHODS', () => {
  it('覆盖九个会改变数组内容的变异方法', () => {
    expect([...ARRAY_MUTATING_METHODS].sort()).toEqual(['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift'])
  })
})

describe('proxyCore · isBuiltinObject', () => {
  it('九类内建对象都判定为内建', () => {
    const values = [
      new Date(),
      /x/,
      new Map(),
      new Set(),
      new WeakMap(),
      new WeakSet(),
      new ArrayBuffer(2),
      new SharedArrayBuffer(2),
      new DataView(new ArrayBuffer(2)),
    ]
    for (const value of values) {
      expect(isBuiltinObject(value)).toBe(true)
    }
  })

  it('普通对象与函数不是内建对象', () => {
    expect(isBuiltinObject({})).toBe(false)
    expect(isBuiltinObject(Object.create(null))).toBe(false)
    expect(isBuiltinObject(() => undefined)).toBe(false)
  })

  it('宿主没有 SharedArrayBuffer 时判定不抛错且跳过该分支', () => {
    const holder = globalThis as { SharedArrayBuffer?: typeof SharedArrayBuffer }
    const saved = holder.SharedArrayBuffer
    try {
      delete holder.SharedArrayBuffer
      expect(typeof SharedArrayBuffer).toBe('undefined')
      expect(isBuiltinObject(new Date())).toBe(true)
      expect(isBuiltinObject({})).toBe(false)
    } finally {
      holder.SharedArrayBuffer = saved
    }
  })
})

describe('proxyCore · Map/Set 判定', () => {
  it('isMapLike 只认 Map', () => {
    expect(isMapLike(new Map())).toBe(true)
    expect(isMapLike(new Set())).toBe(false)
    expect(isMapLike({})).toBe(false)
  })

  it('isSetLike 只认 Set', () => {
    expect(isSetLike(new Set())).toBe(true)
    expect(isSetLike(new Map())).toBe(false)
    expect(isSetLike({})).toBe(false)
  })
})

describe('proxyCore · createProxyCache', () => {
  it('get/set/delete 按目标对象身份工作', () => {
    const cache = createProxyCache()
    const target = {}
    const proxy = { wrapped: true }

    expect(cache.get(target)).toBeUndefined()
    cache.set(target, proxy)
    expect(cache.get(target)).toBe(proxy)
    expect(cache.delete(target)).toBe(true)
    expect(cache.get(target)).toBeUndefined()
    expect(cache.delete(target)).toBe(false)
  })
})

describe('proxyCore · lockedOwnValue', () => {
  it('不可配置且不可写的自有数据属性判定为锁定并带回原值', () => {
    const target: Record<string, unknown> = {}
    Object.defineProperty(target, 'fixed', { value: { a: 1 }, writable: false, configurable: false })
    expect(lockedOwnValue(target, 'fixed')).toEqual({ locked: true, value: { a: 1 } })
  })

  it('可写或可配置的属性不判定为锁定', () => {
    const target: Record<string, unknown> = {}
    Object.defineProperty(target, 'writableOnly', { value: 1, writable: true, configurable: false })
    Object.defineProperty(target, 'configurableOnly', { value: 2, writable: false, configurable: true })
    expect(lockedOwnValue(target, 'writableOnly').locked).toBe(false)
    expect(lockedOwnValue(target, 'configurableOnly').locked).toBe(false)
  })

  it('访问器属性与不存在的键都不算锁定', () => {
    const target = {
      get getter(): number {
        return 1
      },
    }
    expect(lockedOwnValue(target, 'getter').locked).toBe(false)
    expect(lockedOwnValue(target, 'missing').locked).toBe(false)
  })
})

describe('proxyCore · bindMethodToOwner', () => {
  it('绑定后的方法以原始对象为 this，可访问 #private 字段', () => {
    const cache = createBoundMethodCache()
    const counter = new Counter()
    const proxy = new Proxy(counter, {
      get(target, key) {
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? bindMethodToOwner(cache, target, key, value) : value
      },
    })
    expect(proxy.bump(2)).toBe(2)
    expect(proxy.value()).toBe(2)
  })

  it('同一底层函数复用同一绑定，函数被替换后重建绑定', () => {
    const cache = createBoundMethodCache()
    const owner = {
      run(): string {
        return 'old'
      },
    }
    const first = bindMethodToOwner(cache, owner, 'run', owner.run)
    const second = bindMethodToOwner(cache, owner, 'run', owner.run)
    expect(first).toBe(second)

    owner.run = () => 'new'
    const replaced = bindMethodToOwner(cache, owner, 'run', owner.run)
    expect(replaced).not.toBe(first)
    expect((replaced as () => string)()).toBe('new')
  })

  it('绑定缓存按 owner 隔离', () => {
    const cache = createBoundMethodCache()
    const a = { run: () => 'a' }
    const b = { run: () => 'b' }
    expect((bindMethodToOwner(cache, a, 'run', a.run) as () => string)()).toBe('a')
    expect((bindMethodToOwner(cache, b, 'run', b.run) as () => string)()).toBe('b')
  })
})
