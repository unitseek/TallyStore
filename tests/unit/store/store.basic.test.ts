import { createStore, Store, TallyStoreError, isTallyStoreError } from '../../../src/index.js'

describe('Store 基础行为', () => {
  it('createStore 构造并暴露状态与动作', () => {
    const store = createStore({
      name: 'counter',
      state: () => ({ count: 0 }),
      actions: {
        inc(step = 1) {
          this.setState('count', this.getState().count + step)
        },
      },
      getters: { doubled: (state) => state.count * 2 },
    })
    expect(store).toBeInstanceOf(Store)
    expect(store.name).toBe('counter')
    expect(store.getState()).toEqual({ count: 0 })
    expect(store.getter('doubled')).toBe(0)
    store.actions.inc(2)
    expect(store.getState().count).toBe(2)
    expect(store.getter('doubled')).toBe(4)
    store.destroy()
  })

  it('setState 触发订阅并在退订后停止', () => {
    const store = createStore({ state: () => ({ a: 0 }) })
    const listener = jest.fn()
    const unsubscribe = store.subscribe(listener)
    store.setState('a', 1)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    store.setState('a', 2)
    expect(listener).toHaveBeenCalledTimes(1)
    store.destroy()
  })

  it('dispatch 未知 action 抛 TallyStoreError', () => {
    const store = createStore({ state: () => ({}), actions: {} })
    try {
      store.dispatch('missing')
      throw new Error('should throw')
    } catch (error) {
      expect(isTallyStoreError(error)).toBe(true)
      expect((error as TallyStoreError).code).toBe('ACTION_NOT_FOUND')
    }
    store.destroy()
  })
})
