import { createStore } from '../../../src/index.js'
import type { Store } from '../../../src/types/store.js'
import {
  parseMapping,
  resolveMappings,
  copyOwnEntries,
  createStoreSubscriber,
  createMapper,
  bindMapperPair,
  subscribeMappers,
  bindActions,
  cleanupBindings,
  bindWithRollback,
  createUpdatesWriter,
  createPayloadGuard,
  copyConfigPreservingPrototype,
  HOST_RESERVED_ACTIONS,
  COMPONENT_RESERVED_ACTIONS,
  unserializableKind,
} from '../../../src/integrations/utils.js'

/** 推进多个微任务：异步写入失败会自动重试（最多 3 次），需连续推进才能到达成功/耗尽 */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve()
  }
}

/** 仅实现 bindActions 会用到的两个成员的最小 Store 替身 */
function actionStore(dispatch = jest.fn()) {
  const emit = jest.fn()
  const store = { hooks: { emit }, dispatch } as unknown as Store
  return { store, emit, dispatch }
}

function createCounterStore() {
  return createStore({
    name: 'counter',
    state: () => ({ count: 0 }),
    getters: { doubled: (state) => state.count * 2 },
  })
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('parseMapping：映射归一化', () => {
  it('数组形态把键归一为自身的字符串', () => {
    expect(parseMapping(['count', 'total'])).toEqual({ count: 'count', total: 'total' })
  })

  it('数组里的数字键按 String 归一；符号键直接拒绝（无法命中真实状态键）', () => {
    expect(parseMapping([1])).toEqual({ '1': '1' })
    expect(() => parseMapping([Symbol('flag')])).toThrow(TypeError)
  })

  it('对象形态保留本地键、数字值 String 归一；符号值拒绝', () => {
    const parsed = parseMapping({ localCount: 'count', num: 1 })
    expect(parsed).toEqual({ localCount: 'count', num: '1' })
    expect(() => parseMapping({ sym: Symbol('x') })).toThrow(TypeError)
  })

  it('返回新对象而不是入参本身', () => {
    const source = { local: 'count' }
    const parsed = parseMapping(source)
    expect(parsed).not.toBe(source)
    parsed.local = 'hacked'
    expect(source.local).toBe('count')
  })

  it('原型敏感本地键与 setData 路径键直接拒绝，不进入宿主载荷', () => {
    const protoMapping: Record<string, PropertyKey> = {}
    Object.defineProperty(protoMapping, '__proto__', { value: 'count', enumerable: true, configurable: true, writable: true })
    expect(() => parseMapping(protoMapping)).toThrow(TypeError)
    expect(() => parseMapping({ 'nested.key': 'count' })).toThrow(TypeError)
    expect(() => parseMapping({ 'list[0]': 'count' })).toThrow(TypeError)
    expect(Object.getPrototypeOf(Object.prototype)).toBe(null)
  })
})

describe('resolveMappings：三类映射解析', () => {
  it('未提供任何映射时返回三个空对象', () => {
    expect(resolveMappings({})).toEqual({ stateMapping: {}, gettersMapping: {}, actionsMapping: {} })
  })

  it('只提供某一类映射时其余为空对象', () => {
    const resolved = resolveMappings({ mapState: ['count'] })
    expect(resolved.stateMapping).toEqual({ count: 'count' })
    expect(resolved.gettersMapping).toEqual({})
    expect(resolved.actionsMapping).toEqual({})
  })

  it('三类映射同时提供时各自解析（对象形态支持重命名）', () => {
    const resolved = resolveMappings({
      mapState: { localCount: 'count' },
      mapGetters: ['doubled'],
      mapActions: { bump: 'inc' },
    })
    expect(resolved).toEqual({
      stateMapping: { localCount: 'count' },
      gettersMapping: { doubled: 'doubled' },
      actionsMapping: { bump: 'inc' },
    })
  })
})

describe('copyOwnEntries：按自有属性写入', () => {
  it('逐项写入自有可枚举键', () => {
    const target: Record<string, unknown> = { keep: 1 }
    copyOwnEntries(target, { a: 1, b: 2 })
    expect(target).toEqual({ keep: 1, a: 1, b: 2 })
  })

  it('"__proto__" 写成自有属性且不污染原型', () => {
    const target: Record<string, unknown> = {}
    const source: Record<string, unknown> = {}
    Object.defineProperty(source, '__proto__', { value: 'danger', enumerable: true, configurable: true, writable: true })
    copyOwnEntries(target, source)
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(target, '__proto__')).toBe(true)
  })
})

describe('createStoreSubscriber：订阅函数透传', () => {
  it('调用 store.subscribe 并原样透传回调与 readOnly 选项，返回退订函数', () => {
    const unsubscribe = jest.fn()
    const subscribe = jest.fn(() => unsubscribe)
    const store = { subscribe } as unknown as Store
    const subscribeStore = createStoreSubscriber(store)
    const listener = jest.fn()
    const off = subscribeStore(listener, { readOnly: true })
    expect(subscribe).toHaveBeenCalledWith(listener, { readOnly: true })
    expect(off).toBe(unsubscribe)
  })

  it('不传选项时透传 undefined', () => {
    const subscribe = jest.fn(() => jest.fn())
    const subscribeStore = createStoreSubscriber({ subscribe } as unknown as Store)
    subscribeStore(jest.fn())
    expect(subscribe).toHaveBeenCalledWith(expect.any(Function), undefined)
  })
})

describe('createMapper：映射更新器', () => {
  it('空映射返回空 update 且不调用 setter', () => {
    const setter = jest.fn()
    const mapper = createMapper({}, () => 1, setter)
    mapper.update()
    expect(setter).not.toHaveBeenCalled()
  })

  it('初始值全量下发一次，undefined 值不下发（全 undefined 时完全不调用 setter）', () => {
    const setter = jest.fn()
    createMapper({ a: 'a', b: 'b' }, (key) => (key === 'a' ? 1 : undefined), setter)
    expect(setter).toHaveBeenCalledTimes(1)
    expect(setter).toHaveBeenCalledWith({ a: 1 })

    const emptySetter = jest.fn()
    createMapper({ missing: 'missing' }, () => undefined, emptySetter)
    expect(emptySetter).not.toHaveBeenCalled()
  })

  it('值未变化时不重复调用 setter', () => {
    const setter = jest.fn()
    const mapper = createMapper({ a: 'a' }, () => 1, setter)
    setter.mockClear()
    mapper.update()
    expect(setter).not.toHaveBeenCalled()
  })

  it('只下发发生变化的键', () => {
    const values: Record<string, unknown> = { a: 1, b: 2 }
    const setter = jest.fn()
    const mapper = createMapper({ a: 'a', b: 'b' }, (key) => values[key], setter)
    setter.mockClear()
    values.a = 10
    mapper.update()
    expect(setter).toHaveBeenCalledTimes(1)
    expect(setter).toHaveBeenCalledWith({ a: 10 })
  })

  it('NaN 与 NaN 视为相等，不与普通数字相等', () => {
    const values: Record<string, unknown> = { n: NaN }
    const setter = jest.fn()
    const mapper = createMapper({ n: 'n' }, (key) => values[key], setter)
    setter.mockClear()
    mapper.update()
    expect(setter).not.toHaveBeenCalled()
    values.n = 0
    mapper.update()
    expect(setter).toHaveBeenCalledWith({ n: 0 })
  })

  it('新值为 undefined 时显式下发 null 清除宿主旧值，且只清一次', () => {
    const values: Record<string, unknown> = { a: 1 }
    const setter = jest.fn()
    const mapper = createMapper({ a: 'a' }, (key) => values[key], setter)
    setter.mockClear()
    values.a = undefined
    mapper.update()
    expect(setter).toHaveBeenCalledWith({ a: null })
    setter.mockClear()
    mapper.update()
    expect(setter).not.toHaveBeenCalled()
    values.a = 2
    mapper.update()
    expect(setter).toHaveBeenCalledWith({ a: 2 })
  })

  it('对象值同引用时按 changedKeys 判脏：未脏跳过，脏则下发', () => {
    const list = { items: [1] }
    const values: Record<string, unknown> = { list }
    const dirty = { value: false }
    const setter = jest.fn()
    const mapper = createMapper(
      { list: 'list' },
      (key) => values[key],
      setter,
      () => dirty.value,
    )
    setter.mockClear()
    mapper.update()
    expect(setter).not.toHaveBeenCalled()

    dirty.value = true
    mapper.update()
    expect(setter).toHaveBeenCalledWith({ list })
  })

  it('对象值引用变化时无论脏键判定如何都下发', () => {
    const setter = jest.fn()
    const values: Record<string, unknown> = { list: { items: [] } }
    const mapper = createMapper(
      { list: 'list' },
      (key) => values[key],
      setter,
      () => false,
    )
    setter.mockClear()
    const next = { items: [2] }
    values.list = next
    mapper.update()
    expect(setter).toHaveBeenCalledWith({ list: next })
  })

  it('多个取值同时抛错时只抛出第一个错误', () => {
    const first = new Error('first')
    let armed = false
    const setter = jest.fn()
    const mapper = createMapper(
      { a: 'a', b: 'b' },
      (key) => {
        if (!armed) return 1
        if (key === 'a') throw first
        throw new Error('second')
      },
      setter,
    )
    setter.mockClear()
    armed = true
    expect(() => mapper.update()).toThrow(first)
    expect(setter).not.toHaveBeenCalled()
  })

  it('对象值没有 changedKeys 时按「宁多勿漏」始终发送', () => {
    const setter = jest.fn()
    const list = { items: [] }
    const values: Record<string, unknown> = { list }
    const mapper = createMapper({ list: 'list' }, (key) => values[key], setter)
    setter.mockClear()
    mapper.update()
    expect(setter).toHaveBeenCalledWith({ list })
    const next = { items: ['x'] }
    values.list = next
    mapper.update()
    expect(setter).toHaveBeenLastCalledWith({ list: next })
  })

  it('setter 抛错时异常透传且基线不推进（下次通知重新下发）', () => {
    let shouldThrow = false
    const setter = jest.fn(() => {
      if (shouldThrow) throw new Error('setData failed')
    })
    const values: Record<string, unknown> = { a: 1 }
    const mapper = createMapper({ a: 'a' }, (key) => values[key], setter)
    shouldThrow = true
    setter.mockClear()
    values.a = 2
    expect(() => mapper.update()).toThrow('setData failed')
    expect(() => mapper.update()).toThrow('setData failed')
    expect(setter).toHaveBeenCalledTimes(2)
  })

  it('单键取值抛错时其余键照常下发，批次结束后抛出第一个错误；坏键恢复后重新交付', () => {
    const values: Record<string, unknown> = { bad: 1, good: 1 }
    const badError = new Error('getter boom')
    let badThrows = false
    const setter = jest.fn()
    const mapper = createMapper(
      { bad: 'bad', good: 'good' },
      (key) => {
        if (key === 'bad' && badThrows) throw badError
        return values[key]
      },
      setter,
    )
    setter.mockClear()
    badThrows = true
    values.good = 2
    expect(() => mapper.update()).toThrow(badError)
    expect(setter).toHaveBeenCalledWith({ good: 2 })

    // 本批次成功下发的 good 已推进基线，不再重复下发；坏键仍抛错
    setter.mockClear()
    expect(() => mapper.update()).toThrow(badError)
    expect(setter).not.toHaveBeenCalled()

    // 坏键恢复后，其基线从未推进，所以下一次通知会重新交付
    badThrows = false
    values.bad = 5
    setter.mockClear()
    mapper.update()
    expect(setter).toHaveBeenCalledWith({ bad: 5 })
  })
  it('同时配置 state 与 getters 时各建一个更新器，并按映射分别下发', () => {
    const store = createCounterStore()
    const setter = jest.fn()
    const mappers = bindMapperPair(store, { count: 'count' }, { doubled: 'doubled' }, setter)
    expect(mappers).toHaveLength(2)
    expect(setter).toHaveBeenCalledTimes(2)
    expect(setter).toHaveBeenNthCalledWith(1, { count: 0 })
    expect(setter).toHaveBeenNthCalledWith(2, { doubled: 0 })
    const { unsubscribe } = subscribeMappers(createStoreSubscriber(store), mappers)
    setter.mockClear()
    store.setState('count', 2)
    expect(setter.mock.calls).toEqual([[{ count: 2 }], [{ doubled: 4 }]])
    unsubscribe()
    store.destroy()
  })

  it('只配置 getters 时仅建一个更新器', () => {
    const store = createCounterStore()
    expect(bindMapperPair(store, {}, { doubled: 'doubled' }, jest.fn())).toHaveLength(1)
    store.destroy()
  })

  it('全空映射返回空数组', () => {
    const store = createCounterStore()
    expect(bindMapperPair(store, {}, {}, jest.fn())).toEqual([])
    store.destroy()
  })

  it('state 映射用 isStateKeyDirty 判断对象值：改其它键不下发，替换引用才下发', () => {
    const store = createStore({ name: 'lists', state: () => ({ list: { items: 0 }, other: 0 }) })
    const setter = jest.fn()
    const mappers = bindMapperPair(store, { list: 'list' }, {}, setter)
    expect(mappers).toHaveLength(1)
    const { unsubscribe } = subscribeMappers(createStoreSubscriber(store), mappers)
    setter.mockClear()
    store.setState('other', 1)
    expect(setter).not.toHaveBeenCalled()
    const next = { items: 1 }
    store.setState('list', next)
    expect(setter).toHaveBeenCalledTimes(1)
    expect((setter.mock.calls[0]?.[0] as { list: unknown }).list).toStrictEqual(next)
    unsubscribe()
    store.destroy()
  })
})

describe('subscribeMappers：合并为一条只读订阅', () => {
  it('空更新器数组返回 no-op 且不建立订阅', () => {
    const subscribeStore = jest.fn(() => jest.fn())
    const { unsubscribe, runMappers } = subscribeMappers(subscribeStore, [])
    expect(subscribeStore).not.toHaveBeenCalled()
    expect(() => unsubscribe()).not.toThrow()
    expect(() => runMappers()).not.toThrow()
  })

  it('以 readOnly 订阅；一个更新器抛错不影响其余更新器，全部跑完后抛出第一个错误', () => {
    const subscribeStore = jest.fn((_callback: () => void, _options?: { readOnly?: boolean }) => jest.fn())
    const firstError = new Error('first')
    const secondError = new Error('second')
    const calls: string[] = []
    const mappers = [
      {
        update: () => {
          calls.push('a')
          throw firstError
        },
      },
      {
        update: () => {
          calls.push('b')
          throw secondError
        },
      },
      {
        update: () => {
          calls.push('c')
        },
      },
    ]
    subscribeMappers(subscribeStore, mappers)
    expect(subscribeStore).toHaveBeenCalledWith(expect.any(Function), { readOnly: true })
    const notify = subscribeStore.mock.calls[0]?.[0] as () => void
    expect(() => notify()).toThrow(firstError)
    expect(calls).toEqual(['a', 'b', 'c'])
  })

  it('全部更新器成功时通知回调不抛错', () => {
    const subscribeStore = jest.fn((_callback: () => void, _options?: { readOnly?: boolean }) => jest.fn())
    const update = jest.fn()
    subscribeMappers(subscribeStore, [{ update }])
    const notify = subscribeStore.mock.calls[0]?.[0] as () => void
    expect(() => notify()).not.toThrow()
    expect(update).toHaveBeenCalledTimes(1)
  })
})

describe('bindActions：action 方法绑定', () => {
  it('绑定到实例、调用时转发 dispatch、解绑时删除新增成员', () => {
    const { store, dispatch } = actionStore(jest.fn(() => 'result'))
    const target: Record<string, unknown> = {}
    const unbinds = bindActions(target, { bump: 'inc' }, store)
    expect(typeof target.bump).toBe('function')
    expect((target.bump as (step: number) => unknown)(3)).toBe('result')
    expect(dispatch).toHaveBeenCalledWith('inc', 3)
    unbinds.forEach((unbind) => unbind())
    expect('bump' in target).toBe(false)
  })

  it('覆盖宿主已有成员：开发期告警，解绑按原描述符还原', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { store } = actionStore()
    const original = jest.fn()
    const target: Record<string, unknown> = { inc: original }
    const unbinds = bindActions(target, { inc: 'inc' }, store)
    expect(target.inc).not.toBe(original)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('将被 action "inc" 覆盖'))
    unbinds.forEach((unbind) => unbind())
    expect(target.inc).toBe(original)
  })

  it('还原访问器成员时保留 get/set，不降级为数据属性', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { store } = actionStore()
    const getter = () => 'value'
    const setter = jest.fn()
    const target: Record<string, unknown> = {}
    Object.defineProperty(target, 'accessor', { get: getter, set: setter, enumerable: true, configurable: true })
    const unbinds = bindActions(target, { accessor: 'inc' }, store)
    expect(Object.getOwnPropertyDescriptor(target, 'accessor')?.get).toBeUndefined()
    unbinds.forEach((unbind) => unbind())
    const restored = Object.getOwnPropertyDescriptor(target, 'accessor')
    expect(restored?.get).toBe(getter)
    expect(restored?.set).toBe(setter)
  })

  it('保留不可配置成员的可配置性与枚举性，解绑按原描述符回放', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { store } = actionStore()
    const target: Record<string, unknown> = {}
    Object.defineProperty(target, 'frozen', { value: originalFn, writable: true, enumerable: false, configurable: false })
    function originalFn() {
      return 'original'
    }
    const unbinds = bindActions(target, { frozen: 'inc' }, store)
    const bound = Object.getOwnPropertyDescriptor(target, 'frozen')
    expect(bound?.enumerable).toBe(false)
    expect(bound?.configurable).toBe(false)
    unbinds.forEach((unbind) => unbind())
    expect((Object.getOwnPropertyDescriptor(target, 'frozen')?.value as () => string)()).toBe('original')
  })

  it('不可重定义成员跳过绑定、emit onError 并开发期告警', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, emit } = actionStore()
    const target: Record<string, unknown> = {}
    Object.defineProperty(target, 'locked', { value: 1, writable: false, configurable: false })
    const unbinds = bindActions(target, { locked: 'inc' }, store)
    expect(target.locked).toBe(1)
    expect(unbinds).toHaveLength(0)
    expect(emit).toHaveBeenCalledWith('onError', expect.any(Error), 'bindActions')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('不可重定义'))
  })

  it('"__proto__" 本地名写成自有属性，不污染目标原型，解绑可删除', () => {
    const { store } = actionStore()
    const target: Record<string, unknown> = {}
    const unbinds = bindActions(target, { ['__proto__']: 'inc' } as unknown as Record<string, string>, store)
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(target, '__proto__')).toBe(true)
    unbinds.forEach((unbind) => unbind())
    expect(Object.prototype.hasOwnProperty.call(target, '__proto__')).toBe(false)
  })
})

describe('cleanupBindings：解绑清理', () => {
  it('逐个执行并清空列表', () => {
    const a = jest.fn()
    const b = jest.fn()
    const unbinds = [a, b]
    cleanupBindings(unbinds)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(unbinds).toHaveLength(0)
  })

  it('单个解绑抛错不阻断其余解绑', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const b = jest.fn()
    const unbinds = [
      () => {
        throw new Error('unbind failed')
      },
      b,
    ]
    cleanupBindings(unbinds)
    expect(b).toHaveBeenCalledTimes(1)
    expect(unbinds).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith('[TallyStore] Error during cleanup:', expect.any(Error))
  })
})

describe('bindWithRollback：绑定失败回滚', () => {
  it('绑定成功时不清理', () => {
    const unbind = jest.fn()
    bindWithRollback('test', [unbind], () => {})
    expect(unbind).not.toHaveBeenCalled()
  })

  it('绑定抛错时清理已登记绑定、告警并原样重抛', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const unbind = jest.fn()
    const error = new Error('bind failed')
    expect(() =>
      bindWithRollback('withTest', [unbind], () => {
        throw error
      }),
    ).toThrow(error)
    expect(unbind).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[withTest] 绑定映射失败，已回滚本次登记的订阅', error)
  })
})

describe('生产模式：bindActions 告警静默', () => {
  const restoreNodeEnv = (previous: string | undefined): void => {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }

  it('production 下覆盖已有成员与不可重定义成员都不打印 console.warn，但绑定/上报行为不变', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const utils = await import('../../../src/integrations/utils.js')
      const dispatch = jest.fn()
      const emit = jest.fn()
      const store = { hooks: { emit }, dispatch } as unknown as Store
      const target: Record<string, unknown> = { inc: () => 'old' }
      const unbinds = utils.bindActions(target, { inc: 'inc' }, store)
      expect(warn).not.toHaveBeenCalled()
      expect((target.inc as () => unknown)()).toBeUndefined()
      expect(dispatch).toHaveBeenCalledWith('inc')

      Object.defineProperty(target, 'locked', { value: 1, writable: false, configurable: false })
      utils.bindActions(target, { locked: 'inc' }, store)
      expect(warn).not.toHaveBeenCalled()
      expect(emit).toHaveBeenCalledWith('onError', expect.any(Error), 'bindActions')

      unbinds.forEach((unbind) => unbind())

      // 生产期回滚/清理/保留名告警全部静默，但错误仍走 onError
      utils.cleanupBindings([
        () => {
          throw new Error('cleanup boom')
        },
      ])
      expect(warn).not.toHaveBeenCalled()
      expect(() =>
        utils.bindWithRollback('prodHost', [], () => {
          throw new Error('bind boom')
        }),
      ).toThrow('bind boom')
      expect(warn).not.toHaveBeenCalled()
      utils.bindActions({} as Record<string, unknown>, { onShow: 'inc' }, store)
      expect(warn).not.toHaveBeenCalled()
      expect(emit).toHaveBeenCalledWith('onError', expect.any(Error), 'bindActions')
    } finally {
      warn.mockRestore()
      restoreNodeEnv(previous)
      jest.resetModules()
    }
  })
})

describe('生产模式：映射值不可序列化降级上报', () => {
  it('production 下不抛错，改经 report 上报 INVALID_MAPPING；可序列化值直接放行', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const utils = await import('../../../src/integrations/utils.js')
      const report = jest.fn()
      expect(() => utils.assertMappedValueSerializable('prod-store', 'handler', 'mapGetters', () => 1, report)).not.toThrow()
      expect(report).toHaveBeenCalledTimes(1)
      expect((report.mock.calls[0][0] as { code?: string }).code).toBe('INVALID_MAPPING')
      expect(() => utils.assertMappedValueSerializable('prod-store', 'plain', 'mapState', { a: 1 }, report)).not.toThrow()
      expect(report).toHaveBeenCalledTimes(1)

      // 循环引用探测只保留在开发期（生产期由载荷守卫/HOST_WRITE_ERROR 兜底），
      // 不应为一次整树 JSON 序列化在每次绑定时付出成本
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      expect(() => utils.assertMappedValueSerializable('prod-store', 'cyclic', 'mapState', cyclic, report)).not.toThrow()
      expect(report).toHaveBeenCalledTimes(1)
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
      jest.resetModules()
    }
  })
})

describe('createUpdatesWriter', () => {
  it('同步模式直接写入，flushNow/cancel 都是空操作', () => {
    const write = jest.fn()
    const onError = jest.fn()
    const writer = createUpdatesWriter(write, false, onError)
    writer.write({ a: 1 })
    writer.flushNow()
    writer.cancel()
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith({ a: 1 })
    expect(onError).not.toHaveBeenCalled()
  })

  it('合并模式把同一 tick 的多次写入合并为一次，并保留后写值', async () => {
    const write = jest.fn()
    const onError = jest.fn()
    const writer = createUpdatesWriter(write, true, onError)
    writer.write({ a: 1 })
    writer.write({ b: 2 })
    writer.write({ a: 3 })
    expect(write).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith({ a: 3, b: 2 })
    expect(onError).not.toHaveBeenCalled()
  })

  it('flushNow 立即交付挂起写入，随后到达的微任务为空操作', async () => {
    const write = jest.fn()
    const writer = createUpdatesWriter(write, true, jest.fn())
    writer.write({ a: 1 })
    writer.flushNow()
    expect(write).toHaveBeenCalledWith({ a: 1 })
    await Promise.resolve()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('cancel 丢弃挂起写入，之后的 write 不再生效', async () => {
    const write = jest.fn()
    const writer = createUpdatesWriter(write, true, jest.fn())
    writer.write({ a: 1 })
    writer.cancel()
    writer.write({ b: 2 })
    await Promise.resolve()
    expect(write).not.toHaveBeenCalled()
  })

  it('异步写入瞬时失败自动重试，成功即停且不上报 onError', async () => {
    let attempts = 0
    const write = jest.fn(() => {
      attempts += 1
      if (attempts < 3) {
        throw new Error('transient setData boom')
      }
    })
    const onError = jest.fn()
    const writer = createUpdatesWriter(write, true, onError)
    writer.write({ a: 1 })
    await flushMicrotasks()

    expect(write).toHaveBeenCalledTimes(3)
    // 重试沿用同一批数据，直到成功交付
    const delivered = (write.mock.calls as unknown as Array<[Record<string, unknown>]>).map(([batch]) => batch.a)
    expect(delivered).toEqual([1, 1, 1])
    expect(onError).not.toHaveBeenCalled()
  })

  it('持续失败时最多自动重试 3 次后停止，只上报一次 onError 并保留 pending', async () => {
    const error = new Error('setData boom')
    const write = jest.fn(() => {
      throw error
    })
    const onError = jest.fn()
    const writer = createUpdatesWriter(write, true, onError)
    writer.write({ a: 1 })
    await flushMicrotasks()

    // 首次 + 3 次自动重试；耗尽后不再自动重排，避免无限刷屏
    expect(write).toHaveBeenCalledTimes(4)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(error)
    await flushMicrotasks(4)
    expect(write).toHaveBeenCalledTimes(4)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('重试耗尽后 pending 保留：下一次外部写入合并旧批次并再次尝试交付', async () => {
    let fail = true
    const write = jest.fn((batch: Record<string, unknown>) => {
      void batch
      if (fail) {
        throw new Error('setData boom')
      }
    })
    const onError = jest.fn()
    const writer = createUpdatesWriter(write, true, onError)
    writer.write({ a: 1 })
    await flushMicrotasks()
    expect(onError).toHaveBeenCalledTimes(1)

    // 恢复后用新写入触发一次合并重试：旧 pending 不能丢，新写入以最新值合并
    fail = false
    write.mockClear()
    const deliveries: Array<Record<string, unknown>> = []
    write.mockImplementation((batch: Record<string, unknown>) => {
      deliveries.push({ ...batch })
    })
    writer.write({ b: 2 })
    await flushMicrotasks(4)
    expect(deliveries).toEqual([{ a: 1, b: 2 }])
  })

  it('重试窗口内 cancel：停止后续自动重试，也不上报 onError', async () => {
    let writer: ReturnType<typeof createUpdatesWriter> | undefined
    const write = jest.fn(() => {
      writer?.cancel()
      throw new Error('setData boom')
    })
    const onError = jest.fn()
    writer = createUpdatesWriter(write, true, onError)
    writer.write({ a: 1 })
    await flushMicrotasks()

    expect(write).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('成功交付后重试额度复位：下一批失败仍享有完整的 3 次自动重试', async () => {
    // 第一批：失败 3 次后第 4 次成功（用满重试额度但成功）；第二批同样形态
    const outcomes = [false, false, false, true, false, false, false, true]
    const write = jest.fn(() => {
      const ok = outcomes.shift() ?? true
      if (!ok) {
        throw new Error('setData boom')
      }
    })
    const onError = jest.fn()
    const writer = createUpdatesWriter(write, true, onError)
    writer.write({ a: 1 })
    await flushMicrotasks()
    expect(write).toHaveBeenCalledTimes(4)

    writer.write({ b: 2 })
    await flushMicrotasks()
    expect(write).toHaveBeenCalledTimes(8)
    expect(onError).not.toHaveBeenCalled()
  })

  it('无挂起写入时 flushNow 是空操作', async () => {
    const write = jest.fn()
    const writer = createUpdatesWriter(write, true, jest.fn())
    writer.flushNow()
    await Promise.resolve()
    expect(write).not.toHaveBeenCalled()
  })

  it('cancel 后 flushNow 不再交付（取消优先于挂起数据）', () => {
    const write = jest.fn()
    const writer = createUpdatesWriter(write, true, jest.fn())
    writer.write({ a: 1 })
    writer.cancel()
    writer.flushNow()
    expect(write).not.toHaveBeenCalled()
  })

  it('flushNow 的写入错误原样抛出，交给绑定回滚处理', () => {
    const error = new Error('sync boom')
    const onError = jest.fn()
    const writer = createUpdatesWriter(
      () => {
        throw error
      },
      true,
      onError,
    )
    writer.write({ a: 1 })
    expect(() => writer.flushNow()).toThrow(error)
    expect(onError).not.toHaveBeenCalled()
  })

  it('失败期间合并的新写入在自动重试时以最新值为准', async () => {
    const error = new Error('setData boom')
    const onError = jest.fn()
    const deliveries: Array<Record<string, unknown>> = []
    let writer: ReturnType<typeof createUpdatesWriter> | undefined
    let calls = 0
    const write = jest.fn((batch: Record<string, unknown>) => {
      calls += 1
      deliveries.push({ ...batch })
      if (calls === 1) {
        // 模拟 setData 同步回调里又触发了一次状态写入
        writer?.write({ b: 2 })
        throw error
      }
    })
    writer = createUpdatesWriter(write, true, onError)
    writer.write({ a: 1 })
    await flushMicrotasks()

    // 首次失败批次合并在失败期间到达的 b，重试交付 {a:1,b:2}；成功后不再重试
    expect(deliveries).toEqual([{ a: 1 }, { a: 1, b: 2 }])
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('unserializableKind：初始映射可序列化校验', () => {
  it('bigint / symbol 判为不可序列化并给出明确类别', () => {
    expect(unserializableKind(1n)).toBe('BigInt')
    expect(unserializableKind(Symbol('flag'))).toBe('Symbol')
  })

  it('循环引用的纯对象 / 数组判为不可序列化', () => {
    const obj: Record<string, unknown> = {}
    obj.self = obj
    expect(unserializableKind(obj)).toContain('循环引用')

    const arr: unknown[] = []
    arr.push(arr)
    expect(unserializableKind(arr)).toContain('循环引用')
  })

  it('可序列化的值仍放行（Date / RegExp / null 原型对象 / 普通数组）', () => {
    expect(unserializableKind(new Date(0))).toBeNull()
    expect(unserializableKind(/x/)).toBeNull()
    expect(unserializableKind(Object.assign(Object.create(null) as Record<string, unknown>, { v: 1 }))).toBeNull()
    expect(unserializableKind([1, { a: 2 }])).toBeNull()
    expect(unserializableKind(null)).toBeNull()
  })
})

describe('parseMapping：对象形态 symbol 本地键', () => {
  it('symbol 本地键被显式拒绝（TypeError），而不是被 Object.entries 静默丢弃', () => {
    const mapping: Record<string | symbol, PropertyKey> = { count: 'count' }
    Object.defineProperty(mapping, Symbol('local'), { value: 'count', enumerable: true, configurable: true, writable: true })
    expect(() => parseMapping(mapping as never)).toThrow(TypeError)
  })
})

describe('createPayloadGuard：不可序列化与已知字节', () => {
  it('载荷不可序列化（估算 -1）时单独告警，而不是静默跳过', () => {
    const report = jest.fn()
    const guard = createPayloadGuard(1024, 'testHost', report)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    guard({ data: cyclic })
    expect(report).toHaveBeenCalledTimes(1)
    expect((report.mock.calls[0][0] as Error).message).toContain('无法序列化')
  })

  it('复用调用方已算好的字节数（避免同一载荷二次估算）', () => {
    const report = jest.fn()
    const guard = createPayloadGuard(100, 'testHost', report)
    guard({ small: 1 }, 101)
    expect(report).toHaveBeenCalledTimes(1)
    expect((report.mock.calls[0][0] as Error).message).toContain('超过 maxPayloadBytes=100B')
  })

  it('超限多字段：逐字段估算后按字节降序排序，告警按大小列出较大字段', () => {
    const report = jest.fn()
    const guard = createPayloadGuard(10, 'testHost', report)
    guard({ big: 'x'.repeat(100), small: 'yy' })
    expect(report).toHaveBeenCalledTimes(1)
    const message = (report.mock.calls[0][0] as Error).message
    expect(message).toContain('较大字段：')
    // 排序比较器执行：big 字节多，应排在 small 前
    expect(message.indexOf('big(约')).toBeGreaterThan(-1)
    expect(message.indexOf('small(约')).toBeGreaterThan(-1)
    expect(message.indexOf('big(约')).toBeLessThan(message.indexOf('small(约'))
  })

  it('逐字段估算失败（bytes<=0）的字段被过滤；全部字段不可估算时使用 fallback 文案', () => {
    const report = jest.fn()
    // 部分字段不可序列化（函数估算 -1）：只列可估算字段，且不出现 fallback
    const guard = createPayloadGuard(10, 'testHost', report)
    guard({ ok: 'x'.repeat(100), bad: () => undefined })
    const partial = (report.mock.calls[0][0] as Error).message
    expect(partial).toContain('ok(约')
    expect(partial).not.toContain('bad(')
    expect(partial).not.toContain('逐字段估算失败')

    // 全部字段都不可估算：fields 为空 → top 为空串 → fallback 文案
    report.mockClear()
    const allBadGuard = createPayloadGuard(1, 'testHost', report)
    allBadGuard({ onlyBad: () => undefined })
    expect(report).toHaveBeenCalledTimes(1)
    expect((report.mock.calls[0][0] as Error).message).toContain('(逐字段估算失败)')
  })
})

describe('bindActions：新增宿主保留成员', () => {
  it('Page / App 的框架成员本地名同样跳过绑定并上报', () => {
    const { store, emit, dispatch } = actionStore()
    const target: Record<string, unknown> = {}
    const unbinds = bindActions(
      target,
      { route: 'inc', getTabBar: 'inc', onPageNotFound: 'inc', onThemeChange: 'inc', inc: 'inc' } as Record<string, string>,
      store,
    )

    expect('route' in target).toBe(false)
    expect('getTabBar' in target).toBe(false)
    expect('onPageNotFound' in target).toBe(false)
    expect('onThemeChange' in target).toBe(false)
    expect(typeof target.inc).toBe('function')
    expect(dispatch).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledTimes(4)
    expect(HOST_RESERVED_ACTIONS.has('getOpenerEventChannel')).toBe(true)
    expect(HOST_RESERVED_ACTIONS.has('onUnhandledRejection')).toBe(true)
    unbinds.forEach((unbind) => unbind())
  })

  it('Page / App 可绑定组件独有名字：保留清单拆分后不再误伤', () => {
    const { store, emit, dispatch } = actionStore()
    const target: Record<string, unknown> = {}
    const unbinds = bindActions(
      target,
      { triggerEvent: 'inc', getRelationNodes: 'inc', dataset: 'inc', id: 'inc', is: 'inc', inc: 'inc' } as Record<string, string>,
      store,
    )

    // 这些是组件实例独有成员：在 Page/App 上是合法业务本地名，必须照常绑定
    expect(typeof target.triggerEvent).toBe('function')
    expect(typeof target.getRelationNodes).toBe('function')
    expect(typeof target.dataset).toBe('function')
    expect(typeof target.id).toBe('function')
    expect(typeof target.is).toBe('function')
    expect(typeof target.inc).toBe('function')
    expect(emit).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()

    // 清单拆分：组件独有名字不再进入 Page/App 共享清单，改由 COMPONENT_RESERVED_ACTIONS 承载
    expect(HOST_RESERVED_ACTIONS.has('triggerEvent')).toBe(false)
    expect(HOST_RESERVED_ACTIONS.has('dataset')).toBe(false)
    expect(HOST_RESERVED_ACTIONS.has('id')).toBe(false)
    expect(COMPONENT_RESERVED_ACTIONS.has('triggerEvent')).toBe(true)
    expect(COMPONENT_RESERVED_ACTIONS.has('dataset')).toBe(true)
    expect(COMPONENT_RESERVED_ACTIONS.has('id')).toBe(true)
    unbinds.forEach((unbind) => unbind())
  })

  it('Page/Component 共有的实例方法仍在共享清单：补媒体查询与 Skyline 动画 API', () => {
    expect(HOST_RESERVED_ACTIONS.has('selectComponent')).toBe(true)
    expect(HOST_RESERVED_ACTIONS.has('createMediaQueryObserver')).toBe(true)
    expect(HOST_RESERVED_ACTIONS.has('applyAnimatedStyle')).toBe(true)
    expect(HOST_RESERVED_ACTIONS.has('clearAnimatedStyle')).toBe(true)
    expect(HOST_RESERVED_ACTIONS.has('animate')).toBe(true)
    expect(HOST_RESERVED_ACTIONS.has('clearAnimation')).toBe(true)
  })
})

describe('copyConfigPreservingPrototype：原型保留与原型污染防护', () => {
  it('保留原型：原型上的方法可读，自有属性复制到副本', () => {
    const proto = { onLoad: () => 'proto-load' }
    const config = Object.create(proto) as Record<string, unknown>
    config.data = { count: 1 }
    const copy = copyConfigPreservingPrototype(config)

    expect(Object.getPrototypeOf(copy)).toBe(proto)
    expect((copy as { onLoad: () => string }).onLoad()).toBe('proto-load')
    expect(copy.data).toEqual({ count: 1 })
    expect(copy).not.toBe(config)
  })

  it('自有可枚举 "__proto__" 键不触发原型 setter：返回对象原型不变且自带该键', () => {
    const config = JSON.parse('{"__proto__":{"polluted":true},"onLaunch":null}') as Record<string, unknown>
    const copy = copyConfigPreservingPrototype(config)

    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(copy, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
