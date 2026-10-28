/**  / AS-10：映射写入载荷守卫——超过 maxPayloadBytes 时告警（字段名、估算大小、拆分建议），不静默失败 */
import { createStore, TallyStoreError } from '../../../src/index.js'
import { withPageStore } from '../../../src/integrations/with-store.js'
import { createHost } from '../../utils/host.js'

type PageHost = {
  data: Record<string, unknown>
  setData: (patch: Record<string, unknown>) => void
  [key: string]: unknown
}

type DecoratedPage = {
  onLoad: (this: PageHost, ...args: unknown[]) => void
  onUnload: (this: PageHost) => void
  data: Record<string, unknown>
}

function makeStore() {
  return createStore({
    name: 'fr12-payload',
    state: () => ({ big: { pad: '' }, small: 1 }),
    actions: {
      setBig(pad: string) {
        this.state.big.pad = pad
      },
      setSmall(value: number) {
        this.setState('small', value)
      },
    },
  })
}

function decorate(store: ReturnType<typeof makeStore>, options: Record<string, unknown>): DecoratedPage {
  const decorator = withPageStore(store, options as never)
  return decorator({ data: {} }) as unknown as DecoratedPage
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe(' 载荷守卫（AS-10）', () => {
  it('maxPayloadBytes 配为 1KB，映射约 2KB 载荷写入：告警携带字段名、估算大小与拆分建议，数据仍下发', () => {
    const store = makeStore()
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const page = decorate(store, { mapState: ['big', 'small'], maxPayloadBytes: 1024 })
    const { host, setDataCalls } = createHost()
    page.onLoad.call(host as never)
    setDataCalls.splice(0, setDataCalls.length)

    // 2KB 字符串载荷（ASCII，估算字节数 = 字符数）
    store.actions.setBig('x'.repeat(2048))

    expect(onError).toHaveBeenCalledTimes(1)
    const [error, source] = onError.mock.calls[0]
    const message = (error as Error).message
    expect(source).toBe('payload')
    expect(message).toContain('maxPayloadBytes=1024')
    expect(message).toContain('big')
    expect(message).toContain('约 2')
    expect(message).toMatch(/建议/)
    expect(message).toMatch(/组件级|分页|切片/)
    // 不静默失败：数据照常下发，宿主 data 更新
    expect(setDataCalls.length).toBeGreaterThanOrEqual(1)
    expect((host.data as { big: { pad: string } }).big.pad.length).toBe(2048)
    page.onUnload.call(host as never)
    store.destroy()
  })

  it('阈值内的载荷写入不触发告警', () => {
    const store = makeStore()
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const page = decorate(store, { mapState: ['small'], maxPayloadBytes: 1024 })
    const { host, setDataCalls } = createHost()
    page.onLoad.call(host as never)
    setDataCalls.splice(0, setDataCalls.length)

    store.actions.setSmall(42)
    expect(onError).not.toHaveBeenCalled()
    expect(setDataCalls.length).toBe(1)
    expect((host.data as { small: number }).small).toBe(42)
    page.onUnload.call(host as never)
    store.destroy()
  })

  it('maxPayloadBytes=0 关闭守卫：超限载荷不告警', () => {
    const store = makeStore()
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const page = decorate(store, { mapState: ['big'], maxPayloadBytes: 0 })
    const { host } = createHost()
    page.onLoad.call(host as never)

    store.actions.setBig('y'.repeat(4096))
    expect(onError).not.toHaveBeenCalled()
    expect((host.data as { big: { pad: string } }).big.pad.length).toBe(4096)
    page.onUnload.call(host as never)
    store.destroy()
  })

  it('默认阈值 1MB：约 1.2MB 载荷触发告警（此前实测 0 告警）', () => {
    const store = makeStore()
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const page = decorate(store, { mapState: ['big'] })
    const { host } = createHost()
    page.onLoad.call(host as never)

    store.actions.setBig('z'.repeat(1024 * 1024 + 200))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][1]).toBe('payload')
    page.onUnload.call(host as never)
    store.destroy()
  })

  it('非法 maxPayloadBytes 在装饰期抛 TallyStoreError(INVALID_CONFIG)', () => {
    const store = makeStore()
    for (const bad of [-1, Number.NaN, '1kb' as never]) {
      try {
        decorate(store, { mapState: ['small'], maxPayloadBytes: bad })
        throw new Error('should throw')
      } catch (error) {
        expect(error).toBeInstanceOf(TallyStoreError)
        expect((error as TallyStoreError).code).toBe('INVALID_CONFIG')
      }
    }
    store.destroy()
  })

  it('多次超限写入逐次告警（不因重复而静默），小写入不重复告警', () => {
    const store = makeStore()
    const onError = jest.fn()
    store.hooks.on('onError', onError)
    const page = decorate(store, { mapState: ['big'], maxPayloadBytes: 512 })
    const { host } = createHost()
    page.onLoad.call(host as never)

    store.actions.setBig('a'.repeat(1024))
    store.actions.setBig('b'.repeat(1024))
    expect(onError).toHaveBeenCalledTimes(2)
    page.onUnload.call(host as never)
    store.destroy()
  })
})
