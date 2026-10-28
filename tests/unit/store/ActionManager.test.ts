import { ActionManager, GetterManager } from '../../../src/core/store/ActionManager.js'
import { ErrorCode, TallyStoreError } from '../../../src/core/errors/TallyStoreError.js'

type AnyManager = ActionManager<Record<string, unknown>, Record<string, (...args: never[]) => unknown>> & Record<string, any>

interface MakeOptions {
  notifyOnlyOnChange?: boolean
  getMutationCount?: () => number
  getLastNotifiedMutationCount?: () => number
  isInBatch?: () => boolean
}

function makeHooks() {
  return { emit: jest.fn() } as { emit: jest.Mock } & Record<string, unknown>
}

function makeManager(actions: Record<string, (...args: never[]) => unknown>, options: MakeOptions = {}) {
  const hooks = makeHooks()
  const setDispatching = jest.fn()
  const notifyListeners = jest.fn()
  const contextBase = {
    name: 'manager-test',
    state: { n: 0 },
    setState: jest.fn(),
    $patch: jest.fn(),
    $replaceState: jest.fn(),
    getState: jest.fn(() => ({ n: 0 })),
    dispatch: (actionName: string, ...args: unknown[]) => manager.execute(actionName, ...args),
  }
  const manager = new ActionManager<Record<string, unknown>, Record<string, (...args: never[]) => unknown>>({
    storeName: 'manager-test',
    withInternalAccess: (fn) => fn(),
    setDispatching,
    notifyListeners,
    hooks: hooks as never,
    notifyOnlyOnChange: options.notifyOnlyOnChange,
    getMutationCount: options.getMutationCount,
    // onlyOnChange 现在强制要求两个读数；测试默认提供 lastNotified=0，需要自定义时显式传入
    getLastNotifiedMutationCount: options.getLastNotifiedMutationCount ?? (options.notifyOnlyOnChange ? () => 0 : undefined),
    isInBatch: options.isInBatch,
  }) as AnyManager
  manager.initialize(actions, contextBase as never)
  return { manager, hooks, setDispatching, notifyListeners, contextBase }
}

describe('ActionManager 构造与初始化', () => {
  it('notifyOnlyOnChange 缺少 getMutationCount 时构造即抛错', () => {
    expect(
      () =>
        new ActionManager({
          storeName: 'x',
          withInternalAccess: (fn) => fn(),
          setDispatching: jest.fn(),
          notifyListeners: jest.fn(),
          hooks: makeHooks() as never,
          notifyOnlyOnChange: true,
        }),
    ).toThrow(TypeError)
  })

  it('notifyOnlyOnChange 缺少 getLastNotifiedMutationCount 时构造即抛错', () => {
    expect(
      () =>
        new ActionManager({
          storeName: 'x',
          withInternalAccess: (fn) => fn(),
          setDispatching: jest.fn(),
          notifyListeners: jest.fn(),
          hooks: makeHooks() as never,
          notifyOnlyOnChange: true,
          getMutationCount: () => 0,
        }),
    ).toThrow(TypeError)
  })

  it('initialize 之前 actions 返回空对象', () => {
    const manager = new ActionManager({
      storeName: 'x',
      withInternalAccess: (fn) => fn(),
      setDispatching: jest.fn(),
      notifyListeners: jest.fn(),
      hooks: makeHooks() as never,
    })
    expect(manager.actions).toEqual({})
  })

  it('action 上下文可访问 name/state/其他 action，in 判定与 symbol 透传成立', () => {
    const symbol = Symbol('ctx')
    const { manager, contextBase } = makeManager({
      ping(): string {
        return 'pong'
      },
      probe(this: Record<string, unknown>): unknown {
        return {
          name: this.name,
          state: this.state,
          viaThis: typeof this.ping === 'function',
          hasAction: 'ping' in this,
          hasMissing: 'missing' in this,
          symbolValue: (this as Record<symbol, unknown>)[symbol],
        }
      },
    })
    ;(contextBase as Record<symbol, unknown>)[symbol] = 'symbol-ctx'
    manager.initialize(
      {
        ping() {
          return 'pong'
        },
        probe(this: Record<string, unknown>) {
          return {
            name: this.name,
            state: this.state,
            viaThis: typeof this.ping === 'function',
            hasAction: 'ping' in this,
            hasMissing: 'missing' in this,
            symbolValue: (this as Record<symbol, unknown>)[symbol],
          }
        },
      },
      contextBase as never,
    )
    expect(manager.actions.ping()).toBe('pong')
    expect(manager.execute('probe')).toEqual({
      name: 'manager-test',
      state: { n: 0 },
      viaThis: true,
      hasAction: true,
      hasMissing: false,
      symbolValue: 'symbol-ctx',
    })
  })
})

describe('ActionManager 执行与错误', () => {
  it('未知 action 抛 ACTION_NOT_FOUND，context 带可用 action 列表', () => {
    const { manager } = makeManager({})
    try {
      manager.execute('missing')
      throw new Error('should throw')
    } catch (error) {
      expect(error).toBeInstanceOf(TallyStoreError)
      expect((error as TallyStoreError).code).toBe('ACTION_NOT_FOUND')
      expect((error as TallyStoreError).context).toEqual(expect.objectContaining({ storeName: 'manager-test', actionName: 'missing', availableActions: [] }))
    }
  })

  it('action 收到实参并原样返回结果', () => {
    const { manager } = makeManager({
      add(a: number, b: number) {
        return a + b
      },
    })
    expect(manager.execute('add', 2, 3)).toBe(5)
  })

  it('同步 dispatch：setDispatching 先 true 后 false，结束后通知一次', () => {
    const { manager, setDispatching, notifyListeners } = makeManager({
      run() {
        return 1
      },
    })
    manager.execute('run')
    expect(setDispatching.mock.calls).toEqual([[true], [false]])
    expect(notifyListeners).toHaveBeenCalledTimes(1)
    expect(manager.dispatchDepth).toBe(0)
  })

  it('嵌套 dispatch：内层不通知，外层收尾只通知一次', () => {
    const { manager, setDispatching, notifyListeners } = makeManager({
      inner() {
        return 'inner'
      },
      outer(this: { dispatch: (name: string) => unknown }) {
        this.dispatch('inner')
        return 'outer'
      },
    })
    expect(manager.execute('outer')).toBe('outer')
    expect(notifyListeners).toHaveBeenCalledTimes(1)
    // 共享 dispatching 标志：外层进、内层进、内层退出仍为 true、外层退出才 false
    expect(setDispatching.mock.calls).toEqual([[true], [true], [true], [false]])
  })

  it('批处理期间不补发通知', () => {
    const { manager, notifyListeners } = makeManager(
      {
        run() {
          return 1
        },
      },
      { isInBatch: () => true },
    )
    manager.execute('run')
    expect(notifyListeners).not.toHaveBeenCalled()
  })

  it('action 抛错：包装 ACTION_EXECUTION_ERROR（cause/context），并补发已发生的写入', () => {
    let count = 0
    const { manager, notifyListeners, hooks } = makeManager(
      {
        boom() {
          count += 1
          throw new Error('action boom')
        },
      },
      { getMutationCount: () => count },
    )
    try {
      manager.execute('boom')
      throw new Error('should throw')
    } catch (error) {
      expect((error as TallyStoreError).code).toBe('ACTION_EXECUTION_ERROR')
      expect((error as TallyStoreError).cause).toBeInstanceOf(Error)
      expect(((error as TallyStoreError).cause as Error).message).toBe('action boom')
      expect((error as TallyStoreError).context).toEqual(expect.objectContaining({ storeName: 'manager-test', actionName: 'boom', args: [] }))
    }
    expect(notifyListeners).toHaveBeenCalledTimes(1)
    expect(hooks.emit).toHaveBeenCalledWith('onError', expect.any(Error), 'dispatch')
    expect(manager.dispatchDepth).toBe(0)
  })

  it('beforeDispatch 钩子抛错同样包装为 ACTION_EXECUTION_ERROR 并复位深度', () => {
    const { manager, hooks } = makeManager({ run: () => 1 } as never)
    hooks.emit.mockImplementation((name: string) => {
      if (name === 'beforeDispatch') throw new Error('hook boom')
    })
    expect(() => manager.execute('run')).toThrow(TallyStoreError)
    expect(manager.dispatchDepth).toBe(0)
  })

  it('afterDispatch 钩子抛错只上报，不改变返回值', () => {
    const { manager, hooks, notifyListeners } = makeManager({
      run() {
        return 'ok'
      },
    })
    hooks.emit.mockImplementation((name: string) => {
      if (name === 'afterDispatch') throw new Error('after boom')
    })
    expect(manager.execute('run')).toBe('ok')
    expect(notifyListeners).toHaveBeenCalledTimes(1)
    expect(hooks.emit).toHaveBeenCalledWith('onError', expect.any(Error))
  })

  it('onError 钩子自身抛错时回退 console.error，不顶掉原始错误', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const { manager, hooks } = makeManager({
      boom() {
        throw new Error('action boom')
      },
    })
    hooks.emit.mockImplementation(() => {
      throw new Error('emit boom')
    })
    expect(() => manager.execute('boom')).toThrow('Action "boom" execution failed')
    expect(error).toHaveBeenCalledWith('[TallyStore] Error while reporting action settle failure:', expect.any(Error))
    error.mockRestore()
  })

  it('notifyListeners 抛错被上报，不影响 action 返回值', () => {
    const { manager, hooks } = makeManager({ run: () => 'ok' })
    ;(manager as unknown as { _notifyListeners: () => void })._notifyListeners = () => {
      throw new Error('notify boom')
    }
    expect(manager.execute('run')).toBe('ok')
    expect(hooks.emit).toHaveBeenCalledWith('onError', expect.any(Error))
  })

  it('变更计数读取抛错时上报并按基线 0 继续', () => {
    const { manager, hooks, notifyListeners } = makeManager(
      { run: () => 'ok' },
      {
        getMutationCount: () => {
          throw new Error('count boom')
        },
      },
    )
    expect(manager.execute('run')).toBe('ok')
    expect(hooks.emit).toHaveBeenCalledWith('onError', expect.any(Error))
    expect(notifyListeners).toHaveBeenCalledTimes(1)
  })
})

describe('ActionManager thenable 与嵌套错误', () => {
  it('then 读取抛错：归一到 onError + settle 补发，不向调用方裸抛', () => {
    const { manager, hooks, notifyListeners } = makeManager(
      {
        run: () =>
          Object.defineProperty({}, 'then', {
            get() {
              throw new Error('then getter boom')
            },
          }),
      },
      {},
    )
    expect(() => manager.execute('run')).not.toThrow()
    expect(hooks.emit).toHaveBeenCalledWith('onError', expect.objectContaining({ message: 'then getter boom' }), 'dispatch')
    expect(notifyListeners).toHaveBeenCalled()
  })

  it('then 调用同步抛错：同样上报并补发 settle 通知', () => {
    const { manager, hooks, notifyListeners } = makeManager(
      {
        run: () => ({
          then() {
            throw new Error('then call boom')
          },
        }),
      },
      {},
    )
    expect(() => manager.execute('run')).not.toThrow()
    expect(hooks.emit).toHaveBeenCalledWith('onError', expect.objectContaining({ message: 'then call boom' }), 'dispatch')
    expect(notifyListeners).toHaveBeenCalled()
  })

  it('嵌套 dispatch 的本库错误原样上抛，且只上报一次', () => {
    const hooks = makeHooks()
    const manager = new ActionManager<Record<string, unknown>, Record<string, (...args: never[]) => unknown>>({
      storeName: 'nested',
      withInternalAccess: (fn) => fn(),
      setDispatching: jest.fn(),
      notifyListeners: jest.fn(),
      hooks: hooks as never,
    }) as AnyManager
    manager.initialize(
      {
        outer() {
          return manager.execute('missing')
        },
      },
      {
        name: 'nested',
        state: {},
        setState: jest.fn(),
        $patch: jest.fn(),
        $replaceState: jest.fn(),
        getState: jest.fn(() => ({})),
        dispatch: (name: string, ...args: unknown[]) => manager.execute(name, ...args),
      } as never,
    )
    let caught: unknown
    try {
      manager.execute('outer')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TallyStoreError)
    expect((caught as TallyStoreError).code).toBe('ACTION_NOT_FOUND')
    const errorEmits = hooks.emit.mock.calls.filter((call: unknown[]) => call[0] === 'onError')
    expect(errorEmits).toHaveLength(1)
  })
})

describe('ActionManager onlyOnChange', () => {
  it('无变更的 dispatch 不通知，变更后通知', () => {
    let count = 0
    const { manager, notifyListeners } = makeManager(
      {
        noop() {
          return 1
        },
        bump() {
          count += 1
        },
      },
      { notifyOnlyOnChange: true, getMutationCount: () => count },
    )
    manager.execute('noop')
    expect(notifyListeners).not.toHaveBeenCalled()
    manager.execute('bump')
    expect(notifyListeners).toHaveBeenCalledTimes(1)
  })

  it('批处理与 onlyOnChange 叠加时不越权通知', () => {
    let inBatch = true
    let count = 0
    const { manager, notifyListeners } = makeManager(
      {
        bump() {
          count += 1
        },
      },
      { notifyOnlyOnChange: true, getMutationCount: () => count, isInBatch: () => inBatch },
    )
    manager.execute('bump')
    expect(notifyListeners).not.toHaveBeenCalled()
    inBatch = false
    manager.execute('bump')
    expect(notifyListeners).toHaveBeenCalledTimes(1)
  })
})

describe('ActionManager 异步 action', () => {
  it('异步 action 返回原 promise，同步段与 settle 各补发一次通知', async () => {
    let count = 0
    let lastNotified = 0
    const { manager, notifyListeners } = makeManager(
      {
        async run() {
          count += 1
          await Promise.resolve()
          count += 1
          return 'done'
        },
      },
      { getMutationCount: () => count, getLastNotifiedMutationCount: () => lastNotified },
    )
    notifyListeners.mockImplementation(() => {
      lastNotified = count
    })
    const promise = manager.execute('run')
    expect(notifyListeners).toHaveBeenCalledTimes(1)
    await expect(promise).resolves.toBe('done')
    expect(notifyListeners).toHaveBeenCalledTimes(2)
    expect(count).toBe(2)
  })

  it('同步段无变更时不补发，settle 仍补发一次', async () => {
    let count = 0
    const { manager, notifyListeners } = makeManager(
      {
        async run() {
          await Promise.resolve()
          count += 1
        },
      },
      { getMutationCount: () => count },
    )
    await manager.execute('run')
    expect(notifyListeners).toHaveBeenCalledTimes(1)
  })

  it('onlyOnChange 下 settle 按已通知计数去重，不重复通知', async () => {
    let count = 0
    let lastNotified = 0
    const { manager, notifyListeners } = makeManager(
      {
        async run() {
          count += 1
          await Promise.resolve()
        },
      },
      { notifyOnlyOnChange: true, getMutationCount: () => count, getLastNotifiedMutationCount: () => lastNotified },
    )
    notifyListeners.mockImplementation(() => {
      lastNotified = count
    })
    await manager.execute('run')
    expect(notifyListeners).toHaveBeenCalledTimes(1)
  })

  it('无计数提供者时同步段不补发，settle 补发一次', async () => {
    const { manager, notifyListeners } = makeManager({
      async run() {
        await Promise.resolve()
      },
    })
    await manager.execute('run')
    expect(notifyListeners).toHaveBeenCalledTimes(1)
  })

  it('最近已通知计数读取抛错时回退 -1 并上报', async () => {
    let count = 0
    const { manager, hooks } = makeManager(
      {
        async run() {
          await Promise.resolve()
          count += 1
        },
      },
      {
        getMutationCount: () => count,
        getLastNotifiedMutationCount: () => {
          throw new Error('baseline boom')
        },
      },
    )
    await manager.execute('run')
    expect(hooks.emit).toHaveBeenCalledWith('onError', expect.any(Error))
  })

  it('rejected promise：上报 onError 并补发 settle 通知', async () => {
    const { manager, hooks, notifyListeners } = makeManager({
      run() {
        return Promise.reject(new Error('async boom'))
      },
    })
    const promise = manager.execute('run')
    await expect(promise).rejects.toThrow('async boom')
    await Promise.resolve()
    await Promise.resolve()
    expect(hooks.emit).toHaveBeenCalledWith('onError', expect.any(Error))
    expect(notifyListeners).toHaveBeenCalledTimes(1)
  })

  it('自定义 thenable 返回已拒绝 promise 时由终态闸门上报', async () => {
    const { manager, hooks } = makeManager({
      run() {
        return {
          then() {
            return Promise.reject(new Error('late rejection'))
          },
        }
      },
    })
    const result = manager.execute('run')
    expect(result).toBeDefined()
    await Promise.resolve()
    await Promise.resolve()
    expect(hooks.emit).toHaveBeenCalledWith('onError', expect.objectContaining({ message: 'late rejection' }))
  })

  it('同步段补发受批处理守卫拦截时不通知', async () => {
    let count = 0
    const { manager, notifyListeners } = makeManager(
      {
        async run() {
          count += 1
          await Promise.resolve()
        },
      },
      { getMutationCount: () => count, isInBatch: () => true },
    )
    await manager.execute('run')
    // 同步段与 settle 都被批处理守卫拦截，通知由 batch 收尾统一负责
    expect(notifyListeners).not.toHaveBeenCalled()
  })

  it('同步段与 settle 补发通知自身抛错时均上报且不外溢', async () => {
    let count = 0
    const { manager, hooks, notifyListeners } = makeManager(
      {
        async run() {
          count += 1
          await Promise.resolve()
        },
      },
      { getMutationCount: () => count },
    )
    notifyListeners.mockImplementation(() => {
      throw new Error('notify boom')
    })
    await expect(manager.execute('run')).resolves.toBeUndefined()
    expect(hooks.emit).toHaveBeenCalledWith('onError', expect.any(Error))
  })

  it('自定义 thenable 正常 resolve 时 settle 补发', async () => {
    const { manager, notifyListeners } = makeManager({
      run() {
        return {
          then(resolve: (value: string) => void) {
            resolve('ok')
            return Promise.resolve('ok')
          },
        }
      },
    })
    manager.execute('run')
    await Promise.resolve()
    await Promise.resolve()
    expect(notifyListeners).toHaveBeenCalledTimes(1)
  })
})

describe('ActionManager 深度守卫', () => {
  it('深度为 0 时退出 dispatch 不会出现负深度', () => {
    const { manager, setDispatching } = makeManager({})
    ;(manager as unknown as { _exitDispatch: () => void })._exitDispatch()
    expect(manager.dispatchDepth).toBe(0)
    expect(setDispatching).toHaveBeenCalledWith(false)
  })
})

describe('GetterManager', () => {
  it('初始化前执行 getter 抛 GETTER_NOT_FOUND', () => {
    const manager = new GetterManager<{ n: number }>('getter-test', () => ({ n: 1 }))
    try {
      manager.execute('missing')
      throw new Error('should throw')
    } catch (error) {
      expect(error).toBeInstanceOf(TallyStoreError)
      expect((error as TallyStoreError).code).toBe('GETTER_NOT_FOUND')
      expect((error as TallyStoreError).context).toEqual(expect.objectContaining({ availableGetters: [] }))
    }
  })

  it('初始化前 names() 为空数组（映射校验不把未初始化当成有 getter）', () => {
    const manager = new GetterManager<{ n: number }>('getter-test', () => ({ n: 1 }))
    expect(manager.names()).toEqual([])
    manager.initialize({ doubled: (state) => state.n * 2 })
    expect(manager.names()).toEqual(['doubled'])
  })

  it('初始化后执行 getter 并返回计算结果', () => {
    const manager = new GetterManager<{ n: number }, Record<string, (state: { n: number }) => unknown>>('getter-test', () => ({ n: 2 }))
    manager.initialize({ doubled: (state) => state.n * 2 })
    expect(manager.execute('doubled')).toBe(4)
  })

  it('getter 自身抛错包装 GETTER_EXECUTION_ERROR 并保留 cause', () => {
    const manager = new GetterManager<{ n: number }, Record<string, (state: { n: number }) => unknown>>('getter-test', () => ({ n: 2 }))
    manager.initialize({
      boom: () => {
        throw new Error('getter boom')
      },
    })
    try {
      manager.execute('boom')
      throw new Error('should throw')
    } catch (error) {
      expect((error as TallyStoreError).code).toBe('GETTER_EXECUTION_ERROR')
      expect(((error as TallyStoreError).cause as Error).message).toBe('getter boom')
      expect((error as TallyStoreError).context).toEqual(expect.objectContaining({ getterName: 'boom' }))
    }
  })
})

describe('ActionManager · 嵌套错误上报与 thenable 收尾', () => {
  const onErrorCalls = (hooks: { emit: jest.Mock }) => hooks.emit.mock.calls.filter((call: unknown[]) => call[0] === 'onError')

  function makeNestedManager(actions: Record<string, (...args: never[]) => unknown>) {
    const hooks = makeHooks()
    const notifyListeners = jest.fn()
    const manager = new ActionManager<Record<string, unknown>, Record<string, (...args: never[]) => unknown>>({
      storeName: 'nested',
      withInternalAccess: (fn) => fn(),
      setDispatching: jest.fn(),
      notifyListeners,
      hooks: hooks as never,
    }) as AnyManager
    manager.initialize(actions, {
      name: 'nested',
      state: {},
      setState: jest.fn(),
      $patch: jest.fn(),
      $replaceState: jest.fn(),
      getState: jest.fn(() => ({})),
      dispatch: (name: string, ...args: unknown[]) => manager.execute(name, ...args),
    } as never)
    return { manager, hooks, notifyListeners }
  }

  it('三层嵌套的非本库错误只上报一次', () => {
    let managerRef: AnyManager
    const { manager, hooks } = makeNestedManager({
      inner() {
        throw new Error('inner boom')
      },
      middle() {
        return managerRef.execute('inner')
      },
      outer() {
        return managerRef.execute('middle')
      },
    })
    managerRef = manager
    let caught: unknown
    try {
      manager.execute('outer')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TallyStoreError)
    expect((caught as TallyStoreError).code).toBe('ACTION_EXECUTION_ERROR')
    expect(onErrorCalls(hooks)).toHaveLength(1)
  })

  it('用户 action 抛出的 TallyStoreError 仍包装为 ACTION_EXECUTION_ERROR', () => {
    const original = new TallyStoreError(ErrorCode.GETTER_EXECUTION_ERROR, 'user thrown')
    const { manager } = makeNestedManager({
      run() {
        throw original
      },
    })
    let caught: unknown
    try {
      manager.execute('run')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TallyStoreError)
    expect((caught as TallyStoreError).code).toBe('ACTION_EXECUTION_ERROR')
    expect((caught as TallyStoreError).cause).toBe(original)
  })

  it('action 抛出非对象（string/null）时同样包装且不重复上报', () => {
    let managerRef: AnyManager
    const { manager, hooks } = makeNestedManager({
      throwString() {
        throw 'string boom'
      },
      throwNull() {
        throw null
      },
      viaString() {
        return managerRef.execute('throwString')
      },
      viaNull() {
        return managerRef.execute('throwNull')
      },
    })
    managerRef = manager
    const errors: unknown[] = []
    for (const name of ['viaString', 'viaNull']) {
      try {
        manager.execute(name)
      } catch (error) {
        errors.push(error)
      }
    }
    expect(errors).toHaveLength(2)
    for (const error of errors) {
      expect(error).toBeInstanceOf(TallyStoreError)
      expect((error as TallyStoreError).code).toBe('ACTION_EXECUTION_ERROR')
    }
    expect(onErrorCalls(hooks)).toHaveLength(2)
  })

  it('thenable 先同步调用完成回调再抛错：settle 补发只发生一次', () => {
    const { manager, hooks, notifyListeners } = makeNestedManager({
      run: () => ({
        then(onFulfilled: () => void) {
          onFulfilled()
          throw new Error('after fulfill boom')
        },
      }),
    })
    expect(() => manager.execute('run')).not.toThrow()
    expect(notifyListeners).toHaveBeenCalledTimes(1)
    expect(hooks.emit).toHaveBeenCalledWith('onError', expect.objectContaining({ message: 'after fulfill boom' }), 'dispatch')
  })
})
