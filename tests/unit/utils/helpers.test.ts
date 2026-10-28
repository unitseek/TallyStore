import { PROTO_SENSITIVE_KEYS, deepMerge, defineOwnProperty, estimateJsonBytes, isObject, isPlainObject } from '../../../src/core/utils/helpers.js'

describe('isObject', () => {
  it('只认非数组、非 Map/Set 的对象', () => {
    expect(isObject({})).toBe(true)
    expect(isObject(Object.create(null))).toBe(true)
    expect(isObject([])).toBe(false)
    expect(isObject(new Map())).toBe(false)
    expect(isObject(new Set())).toBe(false)
    expect(isObject(null)).toBe(false)
    expect(isObject(1)).toBe(false)
    expect(isObject('x')).toBe(false)
    expect(isObject(() => undefined)).toBe(false)
  })
})

describe('isPlainObject', () => {
  it('只认字面量对象与 null 原型对象', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject(Object.create(null))).toBe(true)
    expect(isPlainObject(Object.create({}))).toBe(false)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject(1)).toBe(false)
    class Service {}
    expect(isPlainObject(new Service())).toBe(false)
  })
})

describe('defineOwnProperty', () => {
  it('以可写/可枚举/可配置的自有数据属性写入', () => {
    const target: Record<string, unknown> = {}
    defineOwnProperty(target, 'a', 1)
    const descriptor = Object.getOwnPropertyDescriptor(target, 'a')
    expect(descriptor).toEqual({ value: 1, writable: true, enumerable: true, configurable: true })
  })

  it('覆盖已有访问器属性时不触发 setter', () => {
    const target: Record<string, unknown> = {}
    const setter = jest.fn()
    Object.defineProperty(target, 'a', {
      get: () => 1,
      set: setter,
      configurable: true,
    })
    defineOwnProperty(target, 'a', 2)
    expect(setter).not.toHaveBeenCalled()
    expect(Object.getOwnPropertyDescriptor(target, 'a')?.value).toBe(2)
  })

  it('__proto__ 写成自有数据属性，不改目标原型', () => {
    const target: Record<string, unknown> = {}
    defineOwnProperty(target, '__proto__', { polluted: true })
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(target, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('PROTO_SENSITIVE_KEYS', () => {
  it('覆盖三个原型链敏感键', () => {
    expect([...PROTO_SENSITIVE_KEYS]).toEqual(['__proto__', 'constructor', 'prototype'])
  })
})

describe('deepMerge · 合并语义', () => {
  it('纯对象递归合并，保留未提及的键', () => {
    const target: Record<string, any> = { a: { x: 1, y: 2 }, keep: true }
    const nested = target.a
    deepMerge(target, { a: { y: 3 } })
    expect(target).toEqual({ a: { x: 1, y: 3 }, keep: true })
    expect(target.a).toBe(nested)
  })

  it('目标位置是非纯对象时整体替换为深拷贝', () => {
    const target: Record<string, unknown> = { a: 1 }
    deepMerge(target, { a: { x: 1 } })
    expect(target.a).toEqual({ x: 1 })
  })

  it('数组/Map/Date 整体替换为克隆副本，不与源共享引用', () => {
    const arr = [1, 2]
    const map = new Map([['k', 1]])
    const date = new Date(1)
    const target: Record<string, unknown> = {}
    deepMerge(target, { arr, map, date })
    expect(target.arr).not.toBe(arr)
    expect(target.arr).toEqual([1, 2])
    expect(target.map).not.toBe(map)
    expect((target.map as Map<string, number>).get('k')).toBe(1)
    expect(target.date).not.toBe(date)
    expect((target.date as Date).getTime()).toBe(1)
  })

  it('class 实例不可克隆，整体替换但保留原引用', () => {
    class Service {}
    const svc = new Service()
    const target: Record<string, unknown> = {}
    deepMerge(target, { svc })
    expect(target.svc).toBe(svc)
  })

  it('原型链敏感键写成自有数据属性，不递归合并进原型', () => {
    const source = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1}}') as Record<string, unknown>
    const target: Record<string, unknown> = {}
    deepMerge(target, source)
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(target, '__proto__')).toBe(true)
    expect((target.constructor as unknown as Record<string, unknown>).x).toBe(1)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('循环引用安全', () => {
    const source: Record<string, unknown> = { a: 1 }
    source.self = source
    const target: Record<string, unknown> = {}
    expect(() => deepMerge(target, source)).not.toThrow()
    expect(target.self).not.toBe(source)
    expect((target.self as Record<string, unknown>).self).toBe(target.self)
  })

  it('同一 (目标, 源) 组合只合并一次，避免重复读取访问器', () => {
    let reads = 0
    const source: Record<string, unknown> = {}
    Object.defineProperty(source, 'probe', {
      enumerable: true,
      get() {
        reads += 1
        return 1
      },
    })
    const target: Record<string, unknown> = {}
    deepMerge(target, source, source)
    expect(target.probe).toBe(1)
    expect(reads).toBe(1)
  })

  it('同一源对象合并进不同目标时各自独立展开', () => {
    const sharedSource = { n: 1 }
    const target: Record<string, unknown> = { a: {}, b: {} }
    deepMerge(target, { a: sharedSource, b: sharedSource })
    expect(target.a).toEqual({ n: 1 })
    expect(target.b).toEqual({ n: 1 })
    expect(target.a).not.toBe(target.b)
  })

  it('源为数组且目标非对象时，告警文案标明 source: array', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    deepMerge([1] as never, [2] as never)
    expect(String(warnSpy.mock.calls[0][0])).toContain('source: array')
    warnSpy.mockRestore()
  })

  it('falsy 的 source 直接跳过', () => {
    const target = { a: 1 }
    expect(deepMerge(target, null as never, undefined as never)).toEqual({ a: 1 })
  })
})

describe('deepMerge · 非法入参的开发期告警', () => {
  it('target 为数组时告警且不合并', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const target = [1]
    const result = deepMerge(target as never, { a: 1 } as never)
    expect(result).toBe(target)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('target: array')
    warnSpy.mockRestore()
  })

  it('target 为 null 时告警文案标明 null', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    deepMerge(null as never, { a: 1 } as never)
    expect(String(warnSpy.mock.calls[0][0])).toContain('target: null')
    warnSpy.mockRestore()
  })

  it('source 为原始值时告警文案给出类型', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    deepMerge({ a: 1 } as never, 'x' as never)
    expect(String(warnSpy.mock.calls[0][0])).toContain('source: string')
    warnSpy.mockRestore()
  })

  it('生产环境不打印告警', async () => {
    const originalEnv = process.env.NODE_ENV
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const mod = await import('../../../src/core/utils/helpers.js')
      const target = [1]
      expect(mod.deepMerge(target as never, { a: 1 } as never)).toBe(target)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      process.env.NODE_ENV = originalEnv
      jest.resetModules()
      warnSpy.mockRestore()
    }
  })
})

describe('estimateJsonBytes · UTF-8 字节估算', () => {
  it('ASCII 1 字节；两字节区 2 字节；其余 BMP 3 字节；BMP 外按真实 UTF-8 计 4 字节', () => {
    expect(estimateJsonBytes('a')).toBe(3)
    expect(estimateJsonBytes('é')).toBe(4)
    expect(estimateJsonBytes('中')).toBe(5)
    // 引号 2 + emoji 真实 UTF-8 4 字节（此前按两个 3 字节码元错误估成 8）
    expect(estimateJsonBytes('😀')).toBe(6)
  })

  it('不可序列化载荷（BigInt / 循环引用）返回 -1', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(estimateJsonBytes({ big: 1n })).toBe(-1)
    expect(estimateJsonBytes(cyclic)).toBe(-1)
  })

  it('JSON.stringify 返回 undefined（顶层 undefined / 函数 / Symbol / toJSON 返回 undefined）时返回 -1 而非抛 TypeError', () => {
    expect(() => estimateJsonBytes(undefined)).not.toThrow()
    expect(estimateJsonBytes(undefined)).toBe(-1)
    expect(estimateJsonBytes(() => undefined)).toBe(-1)
    expect(estimateJsonBytes(Symbol('s'))).toBe(-1)
    expect(estimateJsonBytes({ toJSON: () => undefined })).toBe(-1)
  })
})

describe('deepMerge · 非纯对象守卫', () => {
  it('Date 作为 target 时告警并跳过，不改写实例', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const date = new Date(0)
      const result = deepMerge(date as never, { a: 1 } as never)
      expect(result).toBe(date)
      expect((date as unknown as Record<string, unknown>).a).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a plain object'))
    } finally {
      warn.mockRestore()
    }
  })

  it('类实例作为 source 时不合并其自有字段', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      class Box {
        tag = 'x'
      }
      const target: Record<string, unknown> = {}
      deepMerge(target, new Box() as never)
      expect(target).toEqual({})
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
