import { findUnserializablePaths } from '../../../src/core/utils/serializable.js'

describe('serializable · state 模式', () => {
  it('报函数 / BigInt / Symbol 的嵌套路径', () => {
    const value = {
      user: { notify: () => undefined, id: 1n, tag: Symbol('tag') },
      items: [{ token: 'ok' }],
    }
    expect(findUnserializablePaths(value, 'state')).toEqual(['user.notify', 'user.id', 'user.tag'])
  })

  it('循环引用报首次回边路径；DAG 共享引用不误报', () => {
    const cyclic: Record<string, unknown> = { a: { b: {} } }
    ;(cyclic.a as Record<string, unknown>).b = cyclic
    expect(findUnserializablePaths(cyclic, 'state')).toEqual(['a.b'])

    const shared = { ok: 1 }
    expect(findUnserializablePaths({ a: shared, b: shared }, 'state')).toEqual([])
  })

  it('Map / Set / Date / RegExp / 类实例根与嵌套允许，不误杀', () => {
    class Root {
      n = 1
    }
    expect(findUnserializablePaths(new Map([['k', () => 1]]), 'state')).toEqual([])
    expect(findUnserializablePaths(new Set([Symbol('x')]), 'state')).toEqual([])
    expect(findUnserializablePaths({ d: new Date(0), r: /x/, inst: new Root() }, 'state')).toEqual([])
    expect(findUnserializablePaths(new Root(), 'state')).toEqual([])
  })

  it('DOM 节点（鸭子类型）报路径；根值不可序列化报 <root>', () => {
    expect(findUnserializablePaths({ el: { nodeType: 1, nodeName: 'DIV' } }, 'state')).toEqual(['el'])
    expect(findUnserializablePaths(() => undefined, 'state')).toEqual(['<root>'])
  })
})

describe('serializable · mapping 模式', () => {
  it('报函数 / BigInt / Symbol / Map / Set / 类实例 / 循环；Date / RegExp / undefined / null 放行', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const value = {
      fn: () => 1,
      big: 1n,
      sym: Symbol('s'),
      map: new Map(),
      set: new Set(),
      inst: new (class A {})(),
      cyclic,
      date: new Date(0),
      re: /x/,
      undef: undefined,
      nil: null,
    }
    expect(findUnserializablePaths(value, 'mapping')).toEqual(['fn', 'big', 'sym', 'map', 'set', 'inst', 'cyclic.self'])
  })

  it('普通对象/数组递归，路径格式 user.profile.phone / items[0].token；根值报 <root>', () => {
    expect(findUnserializablePaths({ user: { profile: { phone: () => 1 } }, items: [{ token: 1n }] }, 'mapping')).toEqual([
      'user.profile.phone',
      'items[0].token',
    ])
    expect(findUnserializablePaths(Symbol('root'), 'mapping')).toEqual(['<root>'])
  })
})

describe('serializable · persistence 模式', () => {
  it('报 RegExp / undefined / Map / Set / 函数 / 类实例 / 循环；Date / null / 原始值放行', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const value = {
      date: new Date(0),
      re: /x/,
      undef: undefined,
      map: new Map(),
      set: new Set(),
      fn: () => 1,
      inst: new (class A {})(),
      cyclic,
      nil: null,
      count: 1,
    }
    expect(findUnserializablePaths(value, 'persistence')).toEqual(['re', 'undef', 'map', 'set', 'fn', 'inst', 'cyclic.self'])
  })

  it('数组下标路径与符号键路径', () => {
    expect(findUnserializablePaths([{ ok: new Date(0) }, { bad: undefined }], 'persistence')).toEqual(['[1].bad'])
    expect(findUnserializablePaths({ [Symbol('k')]: { v: 1n } }, 'persistence')).toEqual(['[Symbol(k)].v'])
    // 无描述符号键：路径为 [Symbol()]
    expect(findUnserializablePaths({ [Symbol()]: 1n }, 'mapping')).toEqual(['[Symbol()]'])
  })
})

describe('serializable · 边界分支', () => {
  it('Node 全局存在时用 instanceof 判定 DOM（真浏览器口径）', () => {
    class FakeNode {
      nodeType = 1
      nodeName = 'DIV'
    }
    ;(globalThis as { Node?: unknown }).Node = FakeNode
    try {
      expect(findUnserializablePaths({ el: new FakeNode() }, 'state')).toEqual(['el'])
    } finally {
      delete (globalThis as { Node?: unknown }).Node
    }
  })

  it('throwing getter：对象键与数组下标都按该路径命中，不向外抛错', () => {
    const obj: Record<string, unknown> = {}
    Object.defineProperty(obj, 'boom', {
      get() {
        throw new Error('boom')
      },
      enumerable: true,
    })
    expect(findUnserializablePaths(obj, 'state')).toEqual(['boom'])

    const arr = [1]
    Object.defineProperty(arr, '0', {
      get() {
        throw new Error('boom')
      },
      enumerable: true,
    })
    expect(findUnserializablePaths(arr, 'mapping')).toEqual(['[0]'])
  })

  it('mapping / persistence 的 DOM 节点命中；persistence 的 undefined 根命中 <root>', () => {
    expect(findUnserializablePaths({ el: { nodeType: 1, nodeName: 'DIV' } }, 'mapping')).toEqual(['el'])
    expect(findUnserializablePaths({ el: { nodeType: 1, nodeName: 'DIV' } }, 'persistence')).toEqual(['el'])
    expect(findUnserializablePaths(undefined, 'persistence')).toEqual(['<root>'])
  })

  it('自身遍历异常向上传播，由调用方 fail-closed', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys boom')
        },
        getPrototypeOf: () => Object.prototype,
      },
    )
    expect(() => findUnserializablePaths({ hostile }, 'persistence')).toThrow('ownKeys boom')
  })
})
