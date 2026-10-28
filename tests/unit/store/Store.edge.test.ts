import { createStore, Store } from '../../../src/index.js'

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const originalNodeEnv = process.env.NODE_ENV

afterEach(() => {
  jest.restoreAllMocks()
  process.env.NODE_ENV = originalNodeEnv
})

describe('Store 销毁守卫', () => {
  it('destroy 后所有写入/读取入口按要求抛错', () => {
    const store = createStore({
      state: { count: 0 },
      actions: {
        noop() {
          return 1
        },
      },
      getters: { value: () => 1 },
    })
    store.destroy()
    expect(store.destroyed).toBe(true)
    expect(() => store.setState('count', 1)).toThrow('Cannot call setState on a destroyed Store')
    expect(() => store.$patch({ count: 1 })).toThrow('Cannot call $patch on a destroyed Store')
    expect(() => store.$replaceState({ count: 1 })).toThrow('Cannot call $replaceState on a destroyed Store')
    expect(() => store.$snapshot()).toThrow('Cannot call $snapshot on a destroyed Store')
    expect(() => store.$restore({ count: 0 })).toThrow('Cannot call $restore on a destroyed Store')
    expect(() => store.dispatch('noop')).toThrow('Cannot call dispatch on a destroyed Store')
    expect(() => store.getter('value')).toThrow('Cannot call getter on a destroyed Store')
    expect(() => store.subscribe(jest.fn())).toThrow('Cannot call subscribe on a destroyed Store')
    expect(() => store.use({ name: 'p', install: () => undefined })).toThrow('Cannot call use on a destroyed Store')
    expect(() => store.setStateProtection(false)).toThrow('Cannot call setStateProtection on a destroyed Store')
    expect(() => store.startBatch()).toThrow('Cannot call startBatch on a destroyed Store')
    expect(() => store.endBatch()).toThrow('Cannot call endBatch on a destroyed Store')
    expect(() => store.batch(() => 1)).toThrow('Cannot call batch on a destroyed Store')
  })

  it('destroy 幂等，重复调用不抛错', () => {
    const store = createStore({ state: { count: 0 } })
    store.destroy()
    expect(() => store.destroy()).not.toThrow()
    expect(store.destroyed).toBe(true)
  })
})

describe('Store 构造边界', () => {
  it('不传任何配置直接 new Store 时使用默认值', () => {
    const store = new Store()
    expect(store.getState()).toEqual({})
    expect(store.name).toMatch(/^store-\d+$/)
    expect(store.isStateProtectionEnabled()).toBe(true)
    expect(store.actions).toEqual({})
    store.destroy()
  })
})

describe('Store 插件生命周期', () => {
  it('destroy 时按安装逆序卸载插件', () => {
    const calls: string[] = []
    const store = createStore({ state: { count: 0 } })
    store.use({
      name: 'a',
      install: () => () => calls.push('a'),
    })
    store.use({
      name: 'b',
      install: () => () => calls.push('b'),
    })
    store.destroy()
    expect(calls).toEqual(['b', 'a'])
  })

  it('插件 install 无返回值/无 install 方法时安全安装与卸载', () => {
    const store = createStore({ state: { count: 0 } })
    expect(() => store.use({ name: 'no-uninstall', install: () => undefined })).not.toThrow()
    expect(() => store.use({ name: 'no-install' } as never)).not.toThrow()
    expect(() => store.destroy()).not.toThrow()
  })

  it('重复安装同一插件实例：开发期告警且不重复安装，句柄可卸载', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const install = jest.fn()
    const uninstall = jest.fn()
    install.mockReturnValue(uninstall)
    const store = createStore({ state: { count: 0 } })
    const plugin = { name: 'dup', install }
    const first = store.use(plugin)
    const second = store.use(plugin)
    expect(install).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    first()
    expect(uninstall).toHaveBeenCalledTimes(1)
    second()
    expect(uninstall).toHaveBeenCalledTimes(1)
    store.destroy()
  })

  it('install 抛错且插件已被移出列表时回滚逻辑不报错', () => {
    const store = createStore({ state: { count: 0 } })
    const sabotaging = {
      name: 'sabotage',
      install: () => {
        ;(store as unknown as { _plugins: unknown[] })._plugins = []
        throw new Error('sabotage boom')
      },
    }
    expect(() => store.use(sabotaging)).toThrow('sabotage boom')
    const uninstall = jest.fn()
    expect(() => store.use({ name: 'ok', install: () => uninstall })).not.toThrow()
    store.destroy()
    expect(uninstall).toHaveBeenCalledTimes(1)
  })

  it('install 抛错时回滚入列，失败后可用同一插件重试', () => {
    const store = createStore({ state: { count: 0 } })
    let attempt = 0
    const uninstall = jest.fn()
    const plugin = {
      name: 'flaky',
      install: () => {
        attempt += 1
        if (attempt === 1) throw new Error('install boom')
        return uninstall
      },
    }
    expect(() => store.use(plugin)).toThrow('install boom')
    expect(() => store.use(plugin)).not.toThrow()
    expect(attempt).toBe(2)
    store.destroy()
    expect(uninstall).toHaveBeenCalledTimes(1)
  })

  it('某个卸载函数抛错时记录错误并继续卸载其余插件', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const otherUninstall = jest.fn()
    const store = createStore({ state: { count: 0 } })
    store.use({
      name: 'bad',
      install: () => () => {
        throw new Error('uninstall boom')
      },
    })
    store.use({
      name: 'good',
      install: () => otherUninstall,
    })
    expect(() => store.destroy()).not.toThrow()
    expect(store.destroyed).toBe(true)
    expect(otherUninstall).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith('[TallyStore] Error uninstalling plugin:', expect.any(Error))
  })

  it('卸载过程中重入 use 的新插件也会被排空卸载', () => {
    const calls: string[] = []
    const store = createStore({ state: { count: 0 } })
    const latePlugin = {
      name: 'late',
      install: () => () => calls.push('late'),
    }
    store.use({
      name: 'early',
      install: () => () => {
        calls.push('early')
        store.use(latePlugin)
      },
    })
    store.destroy()
    expect(calls).toEqual(['early', 'late'])
    expect(store.destroyed).toBe(true)
  })

  it('清理无法收敛时在最大轮数后放弃并告警', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    // 重入注册在 finally 的第二次排空时已处于 destroyed 状态，卸载函数会抛错并被
    // _drainPluginUninstalls 接住；这是本用例的预期路径，静音 console.error 避免污染 CI 日志
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = createStore({ state: { count: 0 } })
    let index = 0
    const churn = (): { name: string; install: () => () => void } => {
      const id = index++
      return {
        name: 'churn-' + id,
        install: () => () => {
          store.use(churn())
        },
      }
    }
    store.use(churn())
    expect(() => store.destroy()).not.toThrow()
    expect(store.destroyed).toBe(true)
    expect(warn).toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
  })

  it('销毁流程内部抛错时记录错误但仍标记为已销毁', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = createStore({ state: { count: 0 } })
    ;(store as unknown as { _notifier: unknown })._notifier = {
      destroy: () => {
        throw new Error('notifier boom')
      },
    }
    store.destroy()
    expect(store.destroyed).toBe(true)
    expect(error).toHaveBeenCalledWith('[TallyStore] Error during Store destruction:', expect.any(Error))
  })
})

describe('Store batch', () => {
  it('嵌套 batch 只在最外层结束时通知一次', () => {
    const store = createStore({ state: { count: 0 } })
    const listener = jest.fn()
    store.subscribe(listener)
    store.batch(() => {
      store.setState('count', 1)
      store.batch(() => {
        store.setState('count', 2)
      })
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState().count).toBe(2)
    store.destroy()
  })

  it('startBatch/endBatch 手动配对同样合并通知', () => {
    const store = createStore({ state: { count: 0 } })
    const listener = jest.fn()
    store.subscribe(listener)
    store.startBatch()
    store.setState('count', 1)
    store.setState('count', 2)
    expect(listener).not.toHaveBeenCalled()
    store.endBatch()
    expect(listener).toHaveBeenCalledTimes(1)
    store.destroy()
  })

  it('batch 回调抛错时仍结束批处理并原样上抛', () => {
    const store = createStore({ state: { count: 0 } })
    expect(() =>
      store.batch(() => {
        store.setState('count', 1)
        throw new Error('batch boom')
      }),
    ).toThrow('batch boom')
    const listener = jest.fn()
    store.subscribe(listener)
    store.batch(() => store.setState('count', 2))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState().count).toBe(2)
    store.destroy()
  })

  it('batch 回调销毁 Store 时跳过 endBatch，返回回调结果', () => {
    const store = createStore({ state: { count: 0 } })
    const result = store.batch(() => {
      store.destroy()
      return 'done'
    })
    expect(result).toBe('done')
    expect(store.destroyed).toBe(true)
  })

  it('异步回调在批保护外变更逐条通知，并给出开发期告警', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = createStore({ state: { count: 0 } })
    const listener = jest.fn()
    store.subscribe(listener)
    const promise = store.batch(async () => {
      await Promise.resolve()
      store.setState('count', 1)
      return 'async-done'
    })
    await expect(promise).resolves.toBe('async-done')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('batch() 收到异步回调'))
    // 批收尾一次（此时尚无变更）+ await 之后的写入逐条通知一次
    expect(listener).toHaveBeenCalledTimes(2)
    store.destroy()
  })

  it('onlyOnChange 下无变更的 batch 不通知，有变更才通知', () => {
    const store = createStore({ state: { count: 0 }, notify: { onlyOnChange: true } })
    const listener = jest.fn()
    store.subscribe(listener)
    store.batch(() => undefined)
    expect(listener).not.toHaveBeenCalled()
    store.batch(() => store.setState('count', 1))
    expect(listener).toHaveBeenCalledTimes(1)
    store.destroy()
  })

  it('action 体内 batch 不提前通知，dispatch 收尾统一通知一次', () => {
    let store: any
    store = createStore({
      state: { count: 0 },
      actions: {
        batchRun() {
          store.batch(() => {
            store.setState('count', 1)
            store.setState('count', 2)
          })
        },
      },
    })
    const listener = jest.fn()
    store.subscribe(listener)
    store.dispatch('batchRun')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState().count).toBe(2)
    store.destroy()
  })
})

describe('Store onlyOnChange 与 action 脏跟踪', () => {
  it('只读 action 不通知，写 state 的 action 通知一次', () => {
    const store = createStore({
      state: { count: 0 },
      notify: { onlyOnChange: true },
      actions: {
        read() {
          return this.getState().count
        },
        write() {
          ;(this.state as { count: number }).count = 1
        },
      },
    })
    const listener = jest.fn()
    store.subscribe(listener)
    expect(store.dispatch('read')).toBe(0)
    expect(listener).not.toHaveBeenCalled()
    store.dispatch('write')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState().count).toBe(1)
    store.destroy()
  })

  it('action 写入嵌套对象同样标脏所属顶层键', () => {
    const store = createStore({
      state: { nested: { value: 0 } },
      notify: { onlyOnChange: true },
      actions: {
        writeNested() {
          ;(this.state as { nested: { value: number } }).nested.value = 2
        },
      },
    })
    let nestedDirty: boolean | null = null
    store.subscribe(() => {
      nestedDirty = store.isStateKeyDirty('nested')
    })
    store.dispatch('writeNested')
    expect(nestedDirty).toBe(true)
    expect(store.getState().nested.value).toBe(2)
    store.destroy()
  })

  it('onlyOnChange + 异步 action：同步段变更只通知一次（settle 去重）', async () => {
    const store = createStore({
      state: { count: 0 },
      notify: { onlyOnChange: true },
      actions: {
        async run() {
          this.setState('count', 1)
          await Promise.resolve()
        },
      },
    })
    const listener = jest.fn()
    store.subscribe(listener)
    await store.dispatch('run')
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)
    store.destroy()
  })

  it('onlyOnChange + 异步 action：仅在 await 之后变更时 settle 通知一次', async () => {
    const store = createStore({
      state: { count: 0 },
      notify: { onlyOnChange: true },
      actions: {
        async run() {
          await Promise.resolve()
          this.setState('count', 1)
        },
      },
    })
    const listener = jest.fn()
    store.subscribe(listener)
    await store.dispatch('run')
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState().count).toBe(1)
    store.destroy()
  })
})

describe('Store 通知通道 wiring', () => {
  it('订阅上限驱逐经 onError 钩子上报（来源 subscribe）', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = createStore({ state: { count: 0 }, subscription: { maxSubscribers: 1 } })
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    store.subscribe(jest.fn())
    store.subscribe(jest.fn())
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'subscribe')
    expect(warn).toHaveBeenCalled()
    store.destroy()
  })

  it('匿名监听器被驱逐时消息使用占位名', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = createStore({ state: { count: 0 }, subscription: { maxSubscribers: 1 } })
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const anonymous = (() => undefined) as () => void
    Object.defineProperty(anonymous, 'name', { value: '' })
    store.subscribe(anonymous)
    store.subscribe(jest.fn())
    expect(onError).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('(匿名函数)')
    store.destroy()
  })

  it('onLimit=throw 时超限订阅抛错', () => {
    const store = createStore({ state: { count: 0 }, subscription: { maxSubscribers: 1, onLimit: 'throw' } })
    store.subscribe(jest.fn())
    expect(() => store.subscribe(jest.fn())).toThrow('Subscriber limit reached (1)')
    store.destroy()
  })

  it('异步通知链路抛错经 onError 钩子上报（来源 notify）', async () => {
    const store = createStore({ state: { count: 0 }, notify: { async: true } })
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    store.subscribe(jest.fn(), { readOnly: true })
    ;(store as unknown as { _stateProxyManager: unknown })._stateProxyManager = {
      createStateProxy: () => {
        throw new Error('payload boom')
      },
    }
    store.setState('count', 1)
    await flush()
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'notify')
    store.destroy()
  })

  it('$restore 传入非法快照时由 $replaceState 校验拒绝', () => {
    const store = createStore({ state: { count: 0 } })
    expect(() => store.$restore(1 as never)).toThrow(TypeError)
    store.destroy()
  })
})

describe('Store 生产模式分支', () => {
  it('生产模式下重复安装插件与异步 batch 均不打印告警', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const mod = await import('../../../src/core/store/factory.js')
      const store = mod.createStore({ state: { count: 0 } })
      const plugin = { name: 'dup', install: () => () => undefined }
      store.use(plugin)
      store.use(plugin)
      await store.batch(async () => {
        await Promise.resolve()
      })
      expect(warn).not.toHaveBeenCalled()
      store.destroy()
    } finally {
      process.env.NODE_ENV = originalNodeEnv
      jest.resetModules()
    }
  })

  it('生产模式下清理不收敛也不打印告警', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    // 与开发模式同一路径：destroy 的最终排空会接住 cleaned-up use() 抛错，属预期
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const mod = await import('../../../src/core/store/factory.js')
      const store = mod.createStore({ state: { count: 0 } })
      let index = 0
      const churn = (): { name: string; install: () => () => void } => {
        const id = index++
        return {
          name: 'churn-' + id,
          install: () => () => {
            store.use(churn())
          },
        }
      }
      store.use(churn())
      store.destroy()
      expect(warn).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalled()
      expect(store.destroyed).toBe(true)
    } finally {
      process.env.NODE_ENV = originalNodeEnv
      jest.resetModules()
    }
  })
})
