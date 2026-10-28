/**  / AS-06：前后台更新策略——后台 0 次 setData，回前台按最新状态对齐，可关闭 */
import { createStore, withPageStore, withComponentStore } from '../../../src/index.js'
import { createHost } from '../../utils/host.js'

type PageHost = {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  onHide?: () => void
  onShow?: (...args: unknown[]) => void
  [key: string]: unknown
}

type DecoratedPage = {
  onLoad: (this: PageHost) => void
  onUnload: (this: PageHost) => void
  onHide: (this: PageHost) => void
  onShow: (this: PageHost) => void
}

function makeStore(name: string) {
  return createStore({
    name,
    state: () => ({ count: 0 }),
    actions: {
      set(value: number) {
        this.setState('count', value)
      },
    },
    getters: { doubled: (state) => state.count * 2 },
  })
}

function decorate(store: ReturnType<typeof makeStore>, options: Record<string, unknown> = {}): DecoratedPage {
  return (withPageStore(store, { mapState: ['count'], mapGetters: ['doubled'], ...options } as never) as unknown as (c: object) => DecoratedPage)({ data: {} })
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe(' 前后台更新策略（AS-06）', () => {
  it('后台状态变更 0 次 setData；回前台一次性对齐最新值（不重放中间态）', () => {
    const store = makeStore('fr13-a')
    const page = decorate(store)
    const { host, setDataCalls } = createHost() as { host: PageHost; setDataCalls: Array<Record<string, unknown>> }
    page.onLoad.call(host)
    setDataCalls.splice(0, setDataCalls.length)

    page.onHide.call(host)
    store.actions.set(1)
    store.actions.set(2)
    store.actions.set(3)
    expect(setDataCalls.length).toBe(0)

    page.onShow.call(host)
    // 一次对齐：count=3 + doubled=6（state/getter 两个 mapper 的下发可合并或各一次，但不重放 1/2）
    expect(setDataCalls.length).toBeGreaterThanOrEqual(1)
    const countsSeen = setDataCalls.map((patch) => patch.count)
    expect(countsSeen.filter((value) => value === 3)).toHaveLength(1)
    expect(countsSeen).not.toContain(1)
    expect(countsSeen).not.toContain(2)
    expect((host.data as { count: number }).count).toBe(3)
    expect((host.data as { doubled: number }).doubled).toBe(6)

    page.onUnload.call(host)
    store.destroy()
  })

  it('回前台后恢复立即更新', () => {
    const store = makeStore('fr13-b')
    const page = decorate(store)
    const { host, setDataCalls } = createHost() as { host: PageHost; setDataCalls: Array<Record<string, unknown>> }
    page.onLoad.call(host)
    setDataCalls.splice(0, setDataCalls.length)
    page.onHide.call(host)
    store.actions.set(5)
    page.onShow.call(host)
    setDataCalls.splice(0, setDataCalls.length)

    store.actions.set(6)
    expect(setDataCalls.length).toBeGreaterThanOrEqual(1)
    expect((host.data as { count: number }).count).toBe(6)
    page.onUnload.call(host)
    store.destroy()
  })

  it('backgroundUpdates: false 关闭策略：后台也立即更新、不丢更新', () => {
    const store = makeStore('fr13-c')
    const page = decorate(store, { backgroundUpdates: false })
    const { host, setDataCalls } = createHost() as { host: PageHost; setDataCalls: Array<Record<string, unknown>> }
    page.onLoad.call(host)
    setDataCalls.splice(0, setDataCalls.length)

    // 策略关闭时装饰器不包装 onHide（page.onHide 为 undefined）——这正是回退语义
    store.actions.set(7)
    expect(setDataCalls.length).toBeGreaterThanOrEqual(1)
    expect((host.data as { count: number }).count).toBe(7)
    page.onUnload.call(host)
    store.destroy()
  })

  it('可见性信号缺失（未调用 onHide）时回退立即更新，不丢更新', () => {
    const store = makeStore('fr13-d')
    const page = decorate(store)
    const { host, setDataCalls } = createHost() as { host: PageHost; setDataCalls: Array<Record<string, unknown>> }
    page.onLoad.call(host)
    setDataCalls.splice(0, setDataCalls.length)
    // 不触发 onHide，直接变更（模拟宿主未走生命周期/信号缺失）
    store.actions.set(9)
    expect(setDataCalls.length).toBeGreaterThanOrEqual(1)
    expect((host.data as { count: number }).count).toBe(9)
    page.onUnload.call(host)
    store.destroy()
  })

  it('后台期间卸载：不产生对已卸载实例的 setData（gate dispose 清理对齐回调）', () => {
    const store = makeStore('fr13-e')
    const page = decorate(store)
    const { host, setDataCalls } = createHost() as { host: PageHost; setDataCalls: Array<Record<string, unknown>> }
    page.onLoad.call(host)
    setDataCalls.splice(0, setDataCalls.length)
    page.onHide.call(host)
    store.actions.set(1)
    page.onUnload.call(host)
    setDataCalls.splice(0, setDataCalls.length)

    page.onShow.call(host)
    store.actions.set(2)
    expect(setDataCalls.length).toBe(0)
    store.destroy()
  })

  it('Component pageLifetimes hide/show 同样驱动策略', () => {
    const store = makeStore('fr13-f')
    const decorator = withComponentStore(store, { mapState: ['count'] })
    const config = decorator({ data: {} }) as unknown as {
      lifetimes: { attached: (this: Record<string, unknown>) => void; detached: (this: Record<string, unknown>) => void }
      pageLifetimes: { hide: (this: Record<string, unknown>) => void; show: (this: Record<string, unknown>) => void }
    }
    const { host, setDataCalls } = createHost()
    config.lifetimes.attached.call(host)
    setDataCalls.splice(0, setDataCalls.length)

    config.pageLifetimes.hide.call(host)
    store.actions.set(4)
    expect(setDataCalls.length).toBe(0)
    config.pageLifetimes.show.call(host)
    expect((host.data as { count: number }).count).toBe(4)
    config.lifetimes.detached.call(host)
    store.destroy()
  })
})

describe(' 回前台对齐失败重试', () => {
  it('对齐写入失败：缓存放回 pending，写入失败经 onError 上报，下一次 reveal 重试成功', () => {
    let fragile = false
    const store = createStore({
      name: 'fr13-reveal-retry',
      state: () => ({ count: 0 }),
      getters: {
        fragile: () => {
          if (fragile) {
            throw new Error('fragile getter boom')
          }
          return 0
        },
      },
    })
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const page = (withPageStore(store, { mapState: ['count'], mapGetters: ['fragile'] } as never) as unknown as (c: object) => DecoratedPage)({ data: {} })
    const { host, setDataCalls } = createHost() as { host: PageHost; setDataCalls: Array<Record<string, unknown>> }
    page.onLoad.call(host)
    setDataCalls.splice(0, setDataCalls.length)

    page.onHide.call(host)
    store.setState('count', 1)
    expect(setDataCalls.length).toBe(0)

    // 对齐先因 getter 抛错失败（realign 被门控吞掉），随后兜底写缓存又遇 setData 失败：
    // 修复前整批缓存被丢弃且异常被 markHostHidden 吞掉；修复后放回 pending 并上报
    fragile = true
    const originalSetData = host.setData
    host.setData = () => {
      throw new Error('reveal setData boom')
    }
    page.onShow.call(host)

    const hostWriteErrors = onError.mock.calls.filter(
      ([error, source]) => (error as { code?: string }).code === 'HOST_WRITE_ERROR' && source === 'withPageStore',
    )
    expect(hostWriteErrors).toHaveLength(1)

    // 恢复写入能力后再走一次 hide/show：pending 仍在，下一次 reveal 成功交付 count=1
    fragile = false
    host.setData = originalSetData
    page.onHide.call(host)
    page.onShow.call(host)
    expect((host.data as Record<string, unknown>).count).toBe(1)
    expect(setDataCalls.some((patch) => patch.count === 1)).toBe(true)

    page.onUnload.call(host)
    consoleError.mockRestore()
    store.destroy()
  })
})
