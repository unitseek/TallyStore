/**
 *  /：生产期非法直写的三档降级（error / warn / silent）统一经 onError 上报。
 * 生产模式分支按 tests/CONVENTIONS.md：NODE_ENV=production + resetModules + 动态 import。
 */

const flushModules = async (): Promise<typeof import('../../../src/index.js')> => {
  jest.resetModules()
  process.env.NODE_ENV = 'production'
  return import('../../../src/index.js')
}

const restoreEnv = (): void => {
  delete process.env.NODE_ENV
  jest.resetModules()
}

afterEach(restoreEnv)

async function makeProductionStore(productionHandler: 'error' | 'warn' | 'silent') {
  const { createStore } = await flushModules()
  const store = createStore({
    name: 'fr02-prod',
    state: () => ({ count: 0, nested: { flag: false } }),
    stateProtection: { enabled: true, deep: true, productionHandler },
  })
  return store
}

describe.each(['error', 'warn', 'silent'] as const)(' 生产期 %s 档非法直写', (handler) => {
  it('统一经 onError 上报（source=stateProtection），且按档位决定是否抛错', async () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const onError = jest.fn()
    const store = await makeProductionStore(handler)
    store.hooks.on('onError', onError)

    // 直接写嵌套字段（非 action 内）：走保护代理的 set 陷阱
    if (handler === 'error') {
      expect(() => {
        store.state.nested.flag = true
      }).toThrow(/Direct mutation/)
    } else {
      store.state.nested.flag = true
    }

    expect(onError).toHaveBeenCalledTimes(1)
    const [error, source] = onError.mock.calls[0]
    expect((error as Error).message).toMatch(/Direct mutation of state "nested\.flag"/)
    expect(source).toBe('stateProtection')

    // silent 档：控制台无输出（只关 console，不关上报）
    if (handler === 'silent') {
      expect(consoleWarn).not.toHaveBeenCalled()
    }
    consoleWarn.mockRestore()
    consoleError.mockRestore()
    store.destroy()
  })

  it('生产期 Map/Set 变异同样走 onError 上报', async () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { createStore } = await flushModules()
    const store = createStore({
      name: 'fr02-prod-map',
      state: () => ({ bag: new Map<string, number>() }),
      stateProtection: { enabled: true, deep: true, productionHandler: handler },
    })
    const onError = jest.fn()
    store.hooks.on('onError', onError)

    if (handler === 'error') {
      expect(() => store.state.bag.set('k', 1)).toThrow(/Direct mutation/)
    } else {
      store.state.bag.set('k', 1)
    }
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][1]).toBe('stateProtection')
    consoleWarn.mockRestore()
    store.destroy()
  })
})

describe.each(['warn', 'silent'] as const)(' 生产期 %s 档写回代理值', (handler) => {
  it('写入前解包代理：getState 内保存原始对象/集合，读回身份稳定', async () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { createStore } = await flushModules()
    const store = createStore({
      name: 'fr02-prod-unwrap',
      state: () => ({ a: { n: 1 }, bag: new Map([['k', 1]]), b: null as unknown, c: null as unknown }),
      stateProtection: { enabled: true, deep: true, productionHandler: handler },
    })
    const stateProxy = store.state as Record<string, any>
    const aProxy = stateProxy.a
    const bagProxy = stateProxy.bag
    // 生产降级档位允许写入继续：写回的值本身就是 state 读出的代理
    stateProxy.b = aProxy
    stateProxy.c = bagProxy
    const raw = store.getState() as Record<string, any>
    expect(raw.b).toBe(raw.a)
    expect(raw.c).toBe(raw.bag)
    expect(stateProxy.b).toBe(aProxy)
    expect(stateProxy.c).toBe(bagProxy)
    if (handler === 'warn') {
      // 一次非法写入只产生一条告警（receiver 引发的 defineProperty 反射步骤不重复上报）
      expect(consoleWarn).toHaveBeenCalledTimes(2)
    }
    consoleWarn.mockRestore()
    store.destroy()
  })
})

describe(' 开发期行为不受影响', () => {
  it('onError 处理器自身抛错时不影响宿主流程（降级护栏自身不制造崩溃）', async () => {
    const { createStore } = await flushModules()
    const store = createStore({
      name: 'fr02-prod-reporter',
      state: () => ({ a: 1 }),
      stateProtection: { enabled: true, productionHandler: 'warn' },
    })
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    store.hooks.on('onError', () => {
      throw new Error('reporter boom')
    })
    // 上报处理器抛错：写入仍按档位完成，不外溢
    expect(() => {
      store.state.a = 2
    }).not.toThrow()
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    consoleWarn.mockRestore()
    store.destroy()
  })
})
