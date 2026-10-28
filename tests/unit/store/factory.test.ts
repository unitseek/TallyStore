import { createStore, Store } from '../../../src/index.js'

describe('createStore 工厂', () => {
  it('按 state 工厂函数创建 Store 实例', () => {
    const store = createStore({ state: () => ({ count: 1 }) })
    expect(store).toBeInstanceOf(Store)
    expect(store.getState()).toEqual({ count: 1 })
    store.destroy()
  })

  it('按 state 对象字面量创建 Store 实例', () => {
    const store = createStore({ state: { count: 2 } })
    expect(store).toBeInstanceOf(Store)
    expect(store.getState()).toEqual({ count: 2 })
    store.destroy()
  })

  it('未传 name 时自动生成 store- 前缀名称', () => {
    const first = createStore({ state: { a: 1 } })
    const second = createStore({ state: { a: 2 } })
    expect(first.name).toMatch(/^store-\d+$/)
    expect(first.name).not.toBe(second.name)
    first.destroy()
    second.destroy()
  })

  it('显式 name 原样保留', () => {
    const store = createStore({ name: 'explicit', state: { a: 1 } })
    expect(store.name).toBe('explicit')
    store.destroy()
  })

  it('初始状态与外部对象隔离（深拷贝）', () => {
    const source = { nested: { value: 1 } }
    const store = createStore({ state: source })
    source.nested.value = 99
    expect(store.getState()).toEqual({ nested: { value: 1 } })
    store.destroy()
  })

  it('省略 state 时得到空状态对象（类型与运行时一致）', () => {
    const store = createStore({})
    expect(store.getState()).toEqual({})
    store.destroy()
  })

  it('完全不传参也创建空 Store', () => {
    const store = createStore()
    expect(store.getState()).toEqual({})
    store.destroy()
  })

  it('省略 state 但仍可声明 actions，并通过 setState 添加状态键', () => {
    const store = createStore({
      name: 'lazy',
      actions: {
        set(key: string, value: unknown) {
          this.setState(key, value)
        },
      },
    })
    expect(store.name).toBe('lazy')
    store.actions.set('a', 1)
    expect(store.getState()).toEqual({ a: 1 })
    store.destroy()
  })

  it.each([null, [], 42, 'config'])('非法入参 %p 抛 TypeError', (bad) => {
    const looseCreateStore = createStore as unknown as (options: unknown) => unknown
    expect(() => looseCreateStore(bad)).toThrow(TypeError)
  })

  it.each([
    ['null', { state: null }],
    ['number', { state: 42 }],
    ['string', { state: 'x' }],
    ['boolean', { state: false }],
    ['bigint', { state: 1n }],
    ['symbol', { state: Symbol('s') }],
  ])('state 为非法值 %s 时构造期抛 TypeError', (_label, options) => {
    const looseCreateStore = createStore as unknown as (config: unknown) => unknown
    expect(() => looseCreateStore(options)).toThrow(TypeError)
  })

  it.each([
    ['null', null],
    ['number', 42],
    ['string', 'x'],
  ])('state 工厂返回非法值 %s 时构造期抛 TypeError', (_label, bad) => {
    const looseCreateStore = createStore as unknown as (config: unknown) => unknown
    expect(() => looseCreateStore({ state: () => bad })).toThrow(TypeError)
  })

  it('state 显式为 undefined 时回落空状态（与省略 state 同口径）', () => {
    const looseCreateStore = createStore as unknown as (config: unknown) => { getState(): unknown; destroy(): void }
    const store = looseCreateStore({ state: undefined })
    expect(store.getState()).toEqual({})
    store.destroy()
  })

  it('数组 / Map / Set 根仍允许构造（向后兼容契约，$reset 走非纯对象路径）', () => {
    const arrayStore = createStore({ state: [1, 2] })
    expect(arrayStore.getState()).toEqual([1, 2])
    arrayStore.destroy()
    const mapStore = createStore({ state: new Map([['k', 1]]) })
    expect([...mapStore.getState()]).toEqual([['k', 1]])
    mapStore.destroy()
    const setStore = createStore({ state: new Set([1]) })
    expect([...setStore.getState()]).toEqual([1])
    setStore.destroy()
  })
})
