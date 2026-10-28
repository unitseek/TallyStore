import { createStore, Store, TallyStoreError } from '../../../src/index.js'

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('Store 构造与状态访问', () => {
  it('默认配置：自动命名、状态保护开启、配置可读且为副本', () => {
    const store = createStore({ state: { count: 0 } })
    expect(store).toBeInstanceOf(Store)
    expect(store.name).toMatch(/^store-\d+$/)
    expect(store.isStateProtectionEnabled()).toBe(true)
    expect(store.getStateProtectionConfig()).toEqual({ enabled: true, deep: true, productionHandler: 'warn' })
    const snapshot = store.getStateProtectionConfig()
    ;(snapshot as { enabled?: boolean }).enabled = false
    expect(store.isStateProtectionEnabled()).toBe(true)
    store.destroy()
  })

  it('显式状态保护配置生效', () => {
    const store = createStore({ state: { count: 0 }, stateProtection: { enabled: false, deep: false, productionHandler: 'silent' } })
    expect(store.isStateProtectionEnabled()).toBe(false)
    expect(store.getStateProtectionConfig()).toEqual({ enabled: false, deep: false, productionHandler: 'silent' })
    store.destroy()
  })

  it('保护开启时 state 返回只读代理，直接写入被拒绝', () => {
    const store = createStore({ name: 'protected', state: { count: 0 } })
    expect(() => {
      ;(store.state as { count: number }).count = 1
    }).toThrow(/Direct mutation/)
    expect(store.getState().count).toBe(0)
    store.destroy()
  })

  it('保护关闭时 state 返回原始引用，可直接写入', () => {
    const store = createStore({ state: { count: 0 }, stateProtection: { enabled: false } })
    const raw = store.getState()
    expect(store.state).toBe(raw)
    ;(store.state as { count: number }).count = 2
    expect(store.getState().count).toBe(2)
    store.destroy()
  })

  it('getState 返回稳定的内部原始引用', () => {
    const store = createStore({ state: { nested: { value: 1 } } })
    expect(store.getState()).toBe(store.getState())
    expect(store.getState().nested).toBe(store.getState().nested)
    store.destroy()
  })

  it('setStateProtection 可运行时切换保护开关', () => {
    const store = createStore({ state: { count: 0 } })
    store.setStateProtection(false)
    expect(store.isStateProtectionEnabled()).toBe(false)
    ;(store.state as { count: number }).count = 3
    expect(store.getState().count).toBe(3)
    store.setStateProtection(true)
    expect(store.isStateProtectionEnabled()).toBe(true)
    expect(() => {
      ;(store.state as { count: number }).count = 4
    }).toThrow(/Direct mutation/)
    store.destroy()
  })
})

describe('Store 构造期失败回滚', () => {
  it('state 工厂抛错时注销全局注册表条目，name 可复用', () => {
    const boomState = (() => {
      throw new Error('state factory boom')
    }) as () => Record<string, unknown>
    expect(() => createStore({ name: 'init-fail', state: boomState })).toThrow('state factory boom')
    // 未泄漏注册条目：开发期同名登记会因重名抛 INVALID_CONFIG
    const store = createStore({ name: 'init-fail', state: () => ({ ok: true }) })
    expect(store.getState()).toEqual({ ok: true })
    store.destroy()
  })

  it('action 初始化抛错同样注销注册表条目', () => {
    const hostileActions = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('actions boom')
        },
      },
    )
    expect(() => createStore({ name: 'init-fail-actions', actions: hostileActions as never })).toThrow('actions boom')
    const store = createStore({ name: 'init-fail-actions', state: () => ({ ok: true }) })
    store.destroy()
  })
})

describe('Store.$reset · 非纯对象根', () => {
  it('数组根 Store 以初始状态整树替换，并通知一次', () => {
    const store = createStore({ state: [1, 2] })
    const listener = jest.fn()
    store.subscribe(listener)
    store.getState().push(3)
    store.$reset()
    expect(store.getState()).toEqual([1, 2])
    expect(listener).toHaveBeenCalledTimes(1)
    store.destroy()
  })

  it('Map 根与 Set 根 Store 同样可重置', () => {
    const mapStore = createStore({ state: new Map([['k', 1]]) })
    mapStore.getState().set('k', 2)
    mapStore.$reset()
    expect(mapStore.getState().get('k')).toBe(1)
    mapStore.destroy()

    const setStore = createStore({ state: new Set([1]) })
    setStore.getState().add(2)
    setStore.$reset()
    expect([...setStore.getState()]).toEqual([1])
    setStore.destroy()
  })

  it('销毁后调用 $reset 抛错', () => {
    const store = createStore({ state: { count: 0 } })
    store.destroy()
    expect(() => store.$reset()).toThrow(/destroyed/)
  })
})

describe('Store.setState', () => {
  it('写入新值并通知一次，值可从 getState 读到', () => {
    const store = createStore({ state: { count: 0 } })
    const listener = jest.fn()
    store.subscribe(listener)
    store.setState('count', 1)
    expect(store.getState().count).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0]).toEqual({ count: 1 })
    store.destroy()
  })

  it('等值写入短路：不通知但发 afterSetState 钩子', () => {
    const store = createStore({ state: { count: 0 } })
    const listener = jest.fn()
    const afterSetState = jest.fn()
    store.subscribe(listener)
    store.hooks.on('afterSetState', afterSetState)
    store.setState('count', 0)
    expect(listener).not.toHaveBeenCalled()
    expect(afterSetState).toHaveBeenCalledWith('count', 0)
    store.destroy()
  })

  it('key 为 null/undefined 抛 TypeError', () => {
    const store = createStore({ state: { count: 0 } })
    expect(() => store.setState(null as never, 1 as never)).toThrow(TypeError)
    expect(() => store.setState(undefined as never, 1 as never)).toThrow(TypeError)
    store.destroy()
  })

  it('__proto__ / constructor 作为普通自有属性写入，不污染原型链', () => {
    const store = createStore({ state: { count: 0 } })
    store.setState('__proto__' as never, { hacked: true } as never)
    store.setState('constructor' as never, 'own-constructor' as never)
    const state = store.getState() as Record<string, unknown>
    expect(Object.getPrototypeOf(state)).toBe(Object.prototype)
    expect(Object.prototype).not.toHaveProperty('hacked')
    expect((state as { __proto__: unknown }).__proto__).toEqual({ hacked: true })
    expect(state.constructor).toBe('own-constructor')
    store.destroy()
  })

  it('通知回调内重入写入会在下一轮通知中可见', () => {
    const store = createStore({ state: { a: 0, b: 0 } })
    const seen: Array<{ a: number; b: number }> = []
    let reentered = false
    store.subscribe((state) => {
      seen.push({ a: state.a, b: state.b })
      if (!reentered) {
        reentered = true
        store.setState('b', 1)
      }
    })
    store.setState('a', 1)
    expect(seen.length).toBe(2)
    expect(seen[0]).toEqual({ a: 1, b: 0 })
    expect(seen[1]).toEqual({ a: 1, b: 1 })
    store.destroy()
  })

  it('dispatch 期间 setState 被抑制，收尾只通知一次', () => {
    const store = createStore({
      state: { a: 0, b: 0 },
      actions: {
        setBoth() {
          this.setState('a', 1)
          this.setState('b', 2)
        },
      },
    })
    const listener = jest.fn()
    store.subscribe(listener)
    store.dispatch('setBoth')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState()).toEqual({ a: 1, b: 2 })
    store.destroy()
  })

  it('batch 期间 setState 被抑制，批收尾只通知一次', () => {
    const store = createStore({ state: { a: 0, b: 0 } })
    const listener = jest.fn()
    store.subscribe(listener)
    store.batch(() => {
      store.setState('a', 1)
      store.setState('b', 2)
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState()).toEqual({ a: 1, b: 2 })
    store.destroy()
  })

  it('notify.async 时同一 tick 内的写入合并为一次通知', async () => {
    const store = createStore({ state: { a: 0 }, notify: { async: true } })
    const listener = jest.fn()
    store.subscribe(listener)
    store.setState('a', 1)
    store.setState('a', 2)
    expect(listener).not.toHaveBeenCalled()
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState().a).toBe(2)
    store.destroy()
  })

  it('notify.clone 时订阅者拿到与内部状态隔离的副本', () => {
    const store = createStore({ state: { count: 0 }, notify: { clone: true } })
    const received: Array<{ count: number }> = []
    store.subscribe((state) => {
      received.push(state)
      state.count = 99
    })
    store.setState('count', 1)
    expect(received[0]).not.toBe(store.getState())
    expect(store.getState().count).toBe(1)
    store.destroy()
  })

  it('数字键写入按字符串键记账，脏键查询同口径', () => {
    const store = createStore({ state: { 0: 'a' } as Record<number, string> })
    let dirtyInNotify: boolean | null = null
    store.subscribe(() => {
      dirtyInNotify = store.isStateKeyDirty(0 as never)
    })
    store.setState(0 as never, 'b' as never)
    expect(dirtyInNotify).toBe(true)
    expect((store.getState() as Record<string, string>)['0']).toBe('b')
    store.destroy()
  })
})

describe('Store.$patch', () => {
  it('深合并嵌套对象并标脏顶层键', () => {
    const store = createStore({ state: { nested: { a: 1 } as { a: number; b?: number }, count: 0 } })
    let nestedDirty: boolean | null = null
    store.subscribe(() => {
      nestedDirty = store.isStateKeyDirty('nested')
    })
    store.$patch({ nested: { b: 2 } } as never)
    expect(store.getState().nested).toEqual({ a: 1, b: 2 })
    expect(nestedDirty).toBe(true)
    store.destroy()
  })

  it('空 patch 与等值 patch 不通知但发 afterPatch 钩子', () => {
    const store = createStore({ state: { count: 0 } })
    const listener = jest.fn()
    const afterPatch = jest.fn()
    store.subscribe(listener)
    store.hooks.on('afterPatch', afterPatch)
    store.$patch({})
    store.$patch({ count: 0 })
    expect(listener).not.toHaveBeenCalled()
    expect(afterPatch).toHaveBeenCalledTimes(2)
    store.destroy()
  })

  it('非法入参抛 TypeError', () => {
    const store = createStore({ state: { count: 0 } })
    expect(() => store.$patch(null as never)).toThrow(TypeError)
    expect(() => store.$patch('x' as never)).toThrow(TypeError)
    store.destroy()
  })

  it('根状态为数组或 Map 时拒绝 $patch', () => {
    const arrayStore = createStore({ state: [] as unknown as Record<string, unknown> })
    expect(() => arrayStore.$patch({ length: 1 } as never)).toThrow(/state root must be a plain object/)
    arrayStore.destroy()
    const mapStore = createStore({ state: new Map() as unknown as Record<string, unknown> })
    expect(() => mapStore.$patch({ a: 1 } as never)).toThrow(/state root must be a plain object/)
    mapStore.destroy()
  })

  it('符号键 patch 会写入并标脏', () => {
    const symbol = Symbol('flag')
    const store = createStore({ state: { count: 0 } as Record<string | symbol, number> })
    let dirty: boolean | null = null
    store.subscribe(() => {
      dirty = store.isStateKeyDirty(symbol)
    })
    store.$patch({ [symbol]: 1 } as never)
    expect((store.getState() as Record<symbol, number>)[symbol]).toBe(1)
    expect(dirty).toBe(true)
    store.destroy()
  })

  it('__proto__ patch 写为自有属性且不改原型', () => {
    const store = createStore({ state: { count: 0 } })
    store.$patch({ ['__proto__']: { polluted: true } } as never)
    const state = store.getState() as Record<string, unknown>
    expect(Object.getPrototypeOf(state)).toBe(Object.prototype)
    expect((state as { __proto__: unknown }).__proto__).toEqual({ polluted: true })
    store.destroy()
  })

  it('deepMerge 中途抛错时已写入部分保留、异常上抛、脏键仍推进', () => {
    const store = createStore({ state: { first: 0 } })
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('merge boom')
        },
      },
    )
    let notified = 0
    store.subscribe(() => {
      notified += 1
    })
    expect(() => store.$patch({ first: 1, hostile } as never)).toThrow('merge boom')
    expect(store.getState().first).toBe(1)
    expect(notified).toBe(1)
    store.destroy()
  })

  it('dispatch 期间 $patch 被抑制，收尾只通知一次', () => {
    const store = createStore({
      state: { nested: { a: 1 } as { a: number; b?: number } },
      actions: {
        patchIt() {
          this.$patch({ nested: { b: 2 } } as never)
        },
      },
    })
    const listener = jest.fn()
    store.subscribe(listener)
    store.dispatch('patchIt')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState().nested).toEqual({ a: 1, b: 2 })
    store.destroy()
  })
})

describe('Store.$replaceState / $snapshot / $restore', () => {
  it('对象与工厂函数两种形态都能整体替换', () => {
    const store = createStore({ state: { count: 0 } })
    store.$replaceState({ count: 1 })
    expect(store.getState()).toEqual({ count: 1 })
    store.$replaceState(() => ({ count: 2 }))
    expect(store.getState()).toEqual({ count: 2 })
    store.destroy()
  })

  it('非法入参抛 TypeError', () => {
    const store = createStore({ state: { count: 0 } })
    expect(() => store.$replaceState(null as never)).toThrow(TypeError)
    expect(() => store.$replaceState(undefined as never)).toThrow(TypeError)
    expect(() => store.$replaceState(1 as never)).toThrow(TypeError)
    // 与 $patch 同口径：数组 / Map / Set 根都不受支持
    expect(() => store.$replaceState([] as never)).toThrow(TypeError)
    expect(() => store.$replaceState(new Map() as never)).toThrow(TypeError)
    expect(() => store.$replaceState(new Set() as never)).toThrow(TypeError)
    store.destroy()
  })

  it('替换值与外部对象隔离', () => {
    const store = createStore({ state: { count: 0 } })
    const next = { count: 5 }
    store.$replaceState(next)
    next.count = 99
    expect(store.getState().count).toBe(5)
    store.setState('count', 6)
    expect(store.getState().count).toBe(6)
    store.destroy()
  })

  it('旧键与新键都标脏（消失型变更可见）', () => {
    const store = createStore({ state: { oldKey: 1, keep: 1 } })
    let oldDirty: boolean | null = null
    let keepDirty: boolean | null = null
    store.subscribe(() => {
      oldDirty = store.isStateKeyDirty('oldKey')
      keepDirty = store.isStateKeyDirty('keep')
    })
    store.$replaceState({ keep: 2, newKey: 3 } as never)
    expect(oldDirty).toBe(true)
    expect(keepDirty).toBe(true)
    expect(store.isStateKeyDirty('newKey')).toBe(false)
    store.destroy()
  })

  it('dispatch 期间 $replaceState 被抑制，收尾只通知一次', () => {
    const store = createStore({
      state: { count: 0 },
      actions: {
        replaceIt() {
          this.$replaceState({ count: 9 })
        },
      },
    })
    const listener = jest.fn()
    store.subscribe(listener)
    store.dispatch('replaceIt')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState().count).toBe(9)
    store.destroy()
  })

  it('$snapshot 返回深冻结副本，且与活状态隔离', () => {
    const store = createStore({ state: { nested: { value: 1 }, list: [1, 2] } })
    const snapshot = store.$snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.nested)).toBe(true)
    expect(Object.isFrozen(snapshot.list)).toBe(true)
    ;(store.getState().nested as { value: number }).value = 2
    expect(snapshot.nested.value).toBe(1)
    store.destroy()
  })

  it('$snapshot 对非纯对象节点保留可变（部分冻结口径）', () => {
    const store = createStore({ state: { date: new Date(0) } })
    const snapshot = store.$snapshot()
    expect(Object.isFrozen(snapshot.date)).toBe(false)
    snapshot.date.setTime(1000)
    expect(snapshot.date.getTime()).toBe(1000)
    store.destroy()
  })

  it('$restore 用快照覆盖当前状态', () => {
    const store = createStore({ state: { count: 0 } })
    const snapshot = store.$snapshot()
    store.setState('count', 5)
    store.$restore(snapshot)
    expect(store.getState().count).toBe(0)
    store.destroy()
  })
})

describe('Store dispatch / getter', () => {
  it('dispatch 返回值原样透传，action 上下文方法可用', () => {
    const store = createStore({
      name: 'ctx',
      state: { count: 0 },
      actions: {
        describe() {
          return {
            name: this.name,
            count: this.getState().count,
            hasSetState: typeof this.setState === 'function',
            hasPatch: typeof this.$patch === 'function',
            hasReplace: typeof this.$replaceState === 'function',
            hasDispatch: typeof this.dispatch === 'function',
          }
        },
      },
    })
    expect(store.dispatch('describe')).toEqual({
      name: 'ctx',
      count: 0,
      hasSetState: true,
      hasPatch: true,
      hasReplace: true,
      hasDispatch: true,
    })
    store.destroy()
  })

  it('嵌套 dispatch 只在外层收尾通知一次', () => {
    const store = createStore({
      state: { inner: 0, outer: 0 },
      actions: {
        inner() {
          this.setState('inner', 1)
        },
        outer() {
          this.dispatch('inner')
          this.setState('outer', 1)
        },
      },
    })
    const listener = jest.fn()
    store.subscribe(listener)
    store.dispatch('outer')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState()).toEqual({ inner: 1, outer: 1 })
    store.destroy()
  })

  it('action 抛错包装 ACTION_EXECUTION_ERROR，并补发之前的写入', () => {
    const store = createStore({
      state: { loading: false },
      actions: {
        fail() {
          this.setState('loading', true)
          throw new Error('network down')
        },
      },
    })
    const listener = jest.fn()
    store.subscribe(listener)
    try {
      store.dispatch('fail')
      throw new Error('should throw')
    } catch (error) {
      expect(error).toBeInstanceOf(TallyStoreError)
      expect((error as TallyStoreError).code).toBe('ACTION_EXECUTION_ERROR')
      expect(((error as TallyStoreError).cause as Error).message).toBe('network down')
      expect((error as TallyStoreError).context).toEqual(expect.objectContaining({ actionName: 'fail' }))
    }
    expect(store.getState().loading).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    store.destroy()
  })

  it('未知 action 抛 ACTION_NOT_FOUND', () => {
    const store = createStore({ state: { count: 0 } })
    expect(() => store.dispatch('missing')).toThrow(TallyStoreError)
    try {
      store.dispatch('missing')
    } catch (error) {
      expect((error as TallyStoreError).code).toBe('ACTION_NOT_FOUND')
    }
    store.destroy()
  })

  it('getter 执行、未知 getter 与执行抛错分别给出对应错误码', () => {
    const store = createStore({
      state: { count: 2 },
      getters: {
        doubled: (state) => state.count * 2,
        boom: () => {
          throw new Error('getter boom')
        },
        mutate: (state) => {
          ;(state as { count: number }).count = 99
          return state.count
        },
      },
    })
    expect(store.getter('doubled')).toBe(4)
    try {
      store.getter('missing')
    } catch (error) {
      expect((error as TallyStoreError).code).toBe('GETTER_NOT_FOUND')
    }
    try {
      store.getter('boom')
    } catch (error) {
      expect((error as TallyStoreError).code).toBe('GETTER_EXECUTION_ERROR')
      expect(((error as TallyStoreError).cause as Error).message).toBe('getter boom')
    }
    try {
      store.getter('mutate')
    } catch (error) {
      expect((error as TallyStoreError).code).toBe('GETTER_EXECUTION_ERROR')
    }
    store.destroy()
  })

  it('getter 每次读取都重算（无缓存）：同一状态连续两次调用计数=2、返回值一致（ 验收 1）', () => {
    let calls = 0
    const store = createStore({
      state: { count: 2 },
      getters: {
        doubled: (state) => {
          calls += 1
          return state.count * 2
        },
      },
    })
    // 同一状态连续两次读取：getter 函数执行两次（不缓存），返回值一致
    expect(store.getter('doubled')).toBe(4)
    expect(store.getter('doubled')).toBe(4)
    expect(calls).toBe(2)
    store.destroy()
  })

  it('异步 action 在 settle 时补发通知', async () => {
    const store = createStore({
      state: { count: 0 },
      actions: {
        async load() {
          await Promise.resolve()
          this.setState('count', 10)
          return 'loaded'
        },
      },
    })
    const listener = jest.fn()
    store.subscribe(listener)
    const promise = store.dispatch('load')
    await expect(promise).resolves.toBe('loaded')
    await flush()
    expect(store.getState().count).toBe(10)
    expect(listener).toHaveBeenCalled()
    store.destroy()
  })
})

describe('Store subscribe', () => {
  it('同一监听器重复注册通知多次，退订一次只减一', () => {
    const store = createStore({ state: { count: 0 } })
    const listener = jest.fn()
    const off1 = store.subscribe(listener)
    const off2 = store.subscribe(listener)
    store.setState('count', 1)
    expect(listener).toHaveBeenCalledTimes(2)
    off1()
    store.setState('count', 2)
    expect(listener).toHaveBeenCalledTimes(3)
    off2()
    off2()
    store.setState('count', 3)
    expect(listener).toHaveBeenCalledTimes(3)
    store.destroy()
  })

  it('readOnly 订阅标记不影响通知语义', () => {
    const store = createStore({ state: { count: 0 } })
    const readOnly = jest.fn()
    const writable = jest.fn()
    store.subscribe(readOnly, { readOnly: true })
    store.subscribe(writable)
    store.setState('count', 1)
    expect(readOnly).toHaveBeenCalledTimes(1)
    expect(writable).toHaveBeenCalledTimes(1)
    store.destroy()
  })

  it('监听器抛错不影响其他监听器，且经 onError 钩子上报', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = createStore({ state: { count: 0 } })
    const onError = jest.fn()
    const second = jest.fn()
    store.hooks.on('onError', onError)
    store.subscribe(() => {
      throw new Error('listener boom')
    })
    store.subscribe(second)
    store.setState('count', 1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    error.mockRestore()
    store.destroy()
  })
})

describe('Store · snapshot.maxBytes 校验', () => {
  it.each([Number.NaN, 0, -1, Number.POSITIVE_INFINITY])('maxBytes=%p 时构造期抛 TypeError', (bad) => {
    const looseCreateStore = createStore as unknown as (config: unknown) => unknown
    expect(() => looseCreateStore({ state: { a: 1 }, snapshot: { maxBytes: bad } })).toThrow(TypeError)
  })

  it('合法正数上限正常生效', () => {
    const store = createStore({ state: { blob: 'x'.repeat(2048) }, snapshot: { maxBytes: 1024 } })
    expect(() => store.$snapshot()).toThrow(/超过上限/)
    store.destroy()
  })

  it('snapshot.maxBytes 为 (0,1) 小数时构造期抛 TypeError', () => {
    const looseCreateStore = createStore as unknown as (config: unknown) => unknown
    expect(() => looseCreateStore({ state: { a: 1 }, snapshot: { maxBytes: 0.5 } })).toThrow(TypeError)
  })
})

describe('Store · batch 收尾错误上报', () => {
  it('onEnd 失败经 onError("notify") 上报，不让异常逃逸出 endBatch', () => {
    const store = createStore({ state: { count: 0 } })
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    ;(store as unknown as { _onBatchEnd: () => void })._onBatchEnd = () => {
      throw new Error('batch end boom')
    }
    store.startBatch()
    expect(() => store.endBatch()).not.toThrow()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'batch end boom' }), 'notify')
    store.destroy()
  })
})

describe('Store.$patch · 非纯对象根', () => {
  it('class 实例根状态在 $patch 时响亮失败，不再静默跳过合并并误通知', () => {
    class Root {
      count = 0
    }
    const store = createStore({ state: new Root() })
    const listener = jest.fn()
    store.subscribe(listener)
    expect(() => store.$patch({ count: 1 } as never)).toThrow(/state root must be a plain object/)
    expect(listener).not.toHaveBeenCalled()
    store.destroy()
  })
})

describe('Store · 初始状态不可序列化校验', () => {
  const looseCreateStore = createStore as unknown as (config: unknown) => { getState(): Record<string, unknown>; destroy(): void }

  it('函数 / BigInt / Symbol / 循环 / DOM 在开发期构造时抛 INVALID_CONFIG 并指出路径', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const cases: Array<[unknown, string]> = [
      [{ user: { notify: () => undefined } }, 'user.notify'],
      [{ big: 1n }, 'big'],
      [{ sym: Symbol('s') }, 'sym'],
      [cyclic, 'self'],
      [{ el: { nodeType: 1, nodeName: 'DIV' } }, 'el'],
    ]
    for (const [state, path] of cases) {
      let caught: unknown
      try {
        looseCreateStore({ state })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(TallyStoreError)
      expect((caught as TallyStoreError).code).toBe('INVALID_CONFIG')
      expect((caught as TallyStoreError).message).toContain(path)
      expect((caught as TallyStoreError).context).toEqual(expect.objectContaining({ paths: expect.arrayContaining([path]) }))
    }
  })

  it('Map / Set / Date / 类实例根与嵌套不误杀', () => {
    class Root {
      n = 1
    }
    const store = looseCreateStore({
      state: { map: new Map([['k', { v: 1 }]]), set: new Set([1]), date: new Date(0), inst: new Root() },
    })
    expect(store.getState().map).toBeInstanceOf(Map)
    store.destroy()

    for (const root of [new Map([['k', 1]]), new Set([1]), new Date(0), new Root()]) {
      expect(() => looseCreateStore({ state: root }).destroy()).not.toThrow()
    }
  })

  it('state 工厂返回值同样校验', () => {
    expect(() => looseCreateStore({ state: () => ({ handler: () => undefined }) })).toThrow(/不可序列化/)
  })
})

describe('Store · 通知载荷零拷贝与克隆对照（ 验收 1）', () => {
  it('全部只读订阅：监听器收到的载荷 === store.state 保护代理（零拷贝）', () => {
    const store = createStore({ name: 'fr05-zero-copy', state: { count: 0, nested: { n: 1 } } })
    const seen: unknown[] = []
    store.subscribe((payload) => seen.push(payload), { readOnly: true })
    store.setState('count', 1)

    expect(seen).toHaveLength(1)
    // 零拷贝：通知载荷就是 store.state 返回的同一保护代理（createStateProxy 缓存身份稳定）
    expect(seen[0]).toBe(store.state)
    expect(store.getState().count).toBe(1)
    store.destroy()
  })

  it('存在可写订阅者时按份克隆：只读共享副本、可写各拿独立深拷贝（对照）', () => {
    const store = createStore({ name: 'fr05-clone', state: { count: 0, nested: { n: 1 } } })
    const readOnlySeen: unknown[] = []
    const writableSeen: Array<{ nested: { n: number } }> = []
    store.subscribe((payload) => readOnlySeen.push(payload), { readOnly: true })
    store.subscribe((payload) => {
      writableSeen.push(payload)
      payload.nested.n = 99
    })
    store.subscribe((payload) => writableSeen.push(payload))
    store.setState('count', 1)

    expect(readOnlySeen).toHaveLength(1)
    expect(writableSeen).toHaveLength(2)
    // 有可写订阅者时必须拷贝：所有载荷都不是 store.state 代理
    expect(readOnlySeen[0]).not.toBe(store.state)
    expect(writableSeen[0]).not.toBe(store.state)
    // 可写注册各拿一份独立深拷贝：彼此隔离，也不污染 Store 内部状态
    expect(writableSeen[0]).not.toBe(writableSeen[1])
    expect(store.getState().nested.n).toBe(1)
    store.destroy()
  })
})
