import { createStore, TallyStoreError } from '../../../src/index.js'
import { withPageStore } from '../../../src/integrations/with-store.js'
import { createHost } from '../../utils/host.js'

type DocStore = ReturnType<typeof createDocStore>

/**  / AS-15 回归：直接调用 action 与 dispatch 在所有写入形态下行为一致 */
function createDocStore(name = 'parity-doc') {
  return createStore({
    name,
    state: () => ({ user: { profile: { name: 'init' } }, tags: [] as string[] }),
    actions: {
      rename(name: string) {
        this.state.user.profile.name = name
      },
      addTag(tag: string) {
        this.state.tags.push(tag)
      },
      renameAndAdd(name: string, tag: string) {
        this.rename(name)
        this.addTag(tag)
      },
      async renameLater(name: string) {
        await Promise.resolve()
        this.state.user.profile.name = name
      },
      renameThenFail(name: string) {
        this.state.user.profile.name = name
        throw new Error('boom-after-write')
      },
    },
  })
}

describe(' 直接调用与 dispatch 行为一致', () => {
  it('直接调用执行就地嵌套写入：订阅者收到通知（此前为 0 次）', () => {
    const store = createDocStore()
    const listener = jest.fn()
    store.subscribe(listener)
    store.actions.rename('direct')
    expect(store.getState().user.profile.name).toBe('direct')
    expect(listener).toHaveBeenCalledTimes(1)
    store.destroy()
  })

  it('直接调用执行集合/数组变异写入：订阅者收到通知', () => {
    const store = createDocStore()
    const listener = jest.fn()
    store.subscribe(listener)
    store.actions.addTag('t1')
    expect(store.getState().tags).toEqual(['t1'])
    expect(listener).toHaveBeenCalledTimes(1)
    store.destroy()
  })

  it('action 内经 this 调用其他 action（嵌套写入）：只通知一次，两种调用方式通知次数一致', () => {
    const direct = createDocStore('parity-direct')
    const dispatchStore = createDocStore('parity-dispatch')
    const directListener = jest.fn()
    const dispatchListener = jest.fn()
    direct.subscribe(directListener)
    dispatchStore.subscribe(dispatchListener)
    direct.actions.renameAndAdd('a', 't')
    dispatchStore.dispatch('renameAndAdd', 'a', 't')
    expect(direct.getState()).toEqual(dispatchStore.getState())
    expect(directListener).toHaveBeenCalledTimes(1)
    expect(dispatchListener).toHaveBeenCalledTimes(1)
    direct.destroy()
    dispatchStore.destroy()
  })

  it('直接调用异步 action：await 之后的就地写入也补发通知，结果与 dispatch 一致', async () => {
    const store = createDocStore()
    const listener = jest.fn()
    store.subscribe(listener)
    await store.actions.renameLater('async-direct')
    expect(store.getState().user.profile.name).toBe('async-direct')
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(1)
    store.destroy()
  })

  it('直接调用抛错：写入前状态仍通知、错误与 dispatch 同口径包装并经 onError 上报', () => {
    const store = createDocStore()
    const listener = jest.fn()
    const onError = jest.fn()
    store.subscribe(listener)
    store.hooks.on('onError', onError)
    try {
      store.actions.renameThenFail('kept')
      throw new Error('should throw')
    } catch (error) {
      // 行为一致 = 与 dispatch 同口径：包装为 TallyStoreError，cause 保留原始错误
      expect(error).toBeInstanceOf(TallyStoreError)
      expect((error as TallyStoreError).code).toBe('ACTION_EXECUTION_ERROR')
      expect((error as TallyStoreError).cause).toBeInstanceOf(Error)
      expect(((error as TallyStoreError).cause as Error).message).toBe('boom-after-write')
    }
    // 抛错前的写入不能丢：状态已变化且订阅者已收到
    expect(store.getState().user.profile.name).toBe('kept')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    store.destroy()
  })
})

describe(' AS-15：宿主 data 在两种调用方式下均更新', () => {
  type PageHost = {
    data: Record<string, unknown>
    setData: (patch: Record<string, unknown>) => void
    [key: string]: unknown
  }

  function decorate(store: DocStore): { onLoad: (this: PageHost) => void; onUnload: (this: PageHost) => void } {
    const decorator = withPageStore(store, { mapState: ['user'] })
    return decorator({ data: {} }) as unknown as { onLoad: (this: PageHost) => void; onUnload: (this: PageHost) => void }
  }

  it('直接调用与 dispatch 就地嵌套写入后，宿主 data 更新一致', () => {
    const directStore = createDocStore('parity-page-direct')
    const dispatchStore = createDocStore('parity-page-dispatch')
    const directPage = decorate(directStore)
    const dispatchPage = decorate(dispatchStore)
    const { host: directHost, setDataCalls: directCalls } = createHost()
    const { host: dispatchHost, setDataCalls: dispatchCalls } = createHost()

    directPage.onLoad.call(directHost as never)
    dispatchPage.onLoad.call(dispatchHost as never)
    directCalls.splice(0, directCalls.length)
    dispatchCalls.splice(0, dispatchCalls.length)

    directStore.actions.rename('direct-mode')
    dispatchStore.dispatch('rename', 'direct-mode')

    const directData = directHost.data as { user: { profile: { name: string } } }
    const dispatchData = dispatchHost.data as { user: { profile: { name: string } } }
    expect(directData.user.profile.name).toBe('direct-mode')
    expect(dispatchData.user.profile.name).toBe('direct-mode')
    expect(directCalls.length).toBeGreaterThanOrEqual(1)
    expect(dispatchCalls.length).toBeGreaterThanOrEqual(1)

    directPage.onUnload.call(directHost as never)
    dispatchPage.onUnload.call(dispatchHost as never)
    directStore.destroy()
    dispatchStore.destroy()
  })
})
