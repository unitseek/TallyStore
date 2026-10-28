/**  / AS-14：指标插件——通知/宿主写入/字节/action 耗时/错误/订阅数，sink 注入与采样 */
import { createStore, withPageStore } from '../../../src/index.js'
import { metricsPlugin } from '../../../src/plugins.js'
import type { MetricsEvent, MetricsSink } from '../../../src/plugins.js'
import { validateMetricsEvent } from '../../../src/plugins/metrics.js'
import { createHost } from '../../utils/host.js'

afterEach(() => {
  jest.restoreAllMocks()
})

describe(' metricsPlugin', () => {
  it('采集通知次数 / 宿主写入次数与字节 / action 次数与耗时 / 订阅数（collector.snapshot）', async () => {
    const store = createStore({
      name: 'fr17-metrics',
      state: () => ({ count: 0 }),
      actions: {
        inc() {
          this.setState('count', this.getState().count + 1)
        },
      },
    })
    const plugin = metricsPlugin({ sampleRate: 0 })
    store.use(plugin)
    const collector = (plugin as { collector?: { snapshot: () => Record<string, number> } }).collector
    expect(collector).toBeDefined()

    const listener = jest.fn()
    store.subscribe(listener, { readOnly: true })
    store.actions.inc()
    store.actions.inc()

    const snap = collector!.snapshot()
    expect(snap.notifications).toBe(2)
    expect(snap.actionCount).toBe(2)
    expect(snap.actionTotalMs).toBeGreaterThanOrEqual(0)
    // action 归因字段 + 无宿主写入时的单次载荷默认值
    expect(snap.lastActionName).toBe('inc')
    expect(snap.lastHost).toBeNull()
    expect(snap.lastHostWriteBytes).toBe(0)
    expect(snap.maxHostWriteBytes).toBe(0)
    // metrics 经 hooks 采集、不建立订阅：在册 = 测试自己的 listener 一份
    expect(snap.subscriptions).toBe(1)
    store.destroy()
  })

  it('集成层 onHostWrite：写入次数与估算字节计入指标（热路径复用载荷估算）', () => {
    const store = createStore({ name: 'fr17-host', state: () => ({ payload: '' }) })
    const plugin = metricsPlugin({ sampleRate: 0 })
    store.use(plugin)
    const collector = (plugin as { collector?: { snapshot: () => Record<string, number> } }).collector!

    const page = withPageStore(store, { mapState: ['payload'] })({ data: {} }) as unknown as {
      onLoad: (this: Record<string, unknown>) => void
      onUnload: (this: Record<string, unknown>) => void
    }
    const { host } = createHost()
    page.onLoad.call(host)
    store.setState('payload', 'x'.repeat(100))

    const snap = collector.snapshot()
    expect(snap.hostWrites).toBeGreaterThanOrEqual(1)
    expect(snap.hostWriteBytes).toBeGreaterThan(100)
    // 单次载荷（最近/最大）与最近宿主标签；累计值继续保留
    expect(snap.lastHostWriteBytes).toBeGreaterThan(0)
    expect(snap.lastHostWriteBytes).toBeLessThanOrEqual(snap.hostWriteBytes)
    expect(snap.maxHostWriteBytes).toBeGreaterThanOrEqual(snap.lastHostWriteBytes)
    expect(snap.maxHostWriteBytes).toBeGreaterThan(0)
    expect(snap.lastHost).toBe('withPageStore')
    page.onUnload.call(host)
    store.destroy()
  })

  it('sink 可注入可替换：sampleRate=1 全量上报，事件 schema 不含状态值（AS-14）', () => {
    const events: MetricsEvent[] = []
    const sink: MetricsSink = { report: (event) => events.push(event) }
    const store = createStore({ name: 'fr17-sink', state: () => ({ count: 0, token: 'secret-value-should-not-appear' }) })
    store.use(metricsPlugin({ sink, sampleRate: 1 }))
    store.setState('count', 1)
    expect(events.length).toBeGreaterThanOrEqual(1)
    for (const event of events) {
      expect(event.type).toBe('metrics')
      expect(event.schemaVersion).toBe(1)
      expect(event.storeName).toBe('fr17-sink')
      // 白名单 schema：事件里只有计数/耗时/字节/名称，绝无状态值
      expect(JSON.stringify(event)).not.toContain('secret-value')
      expect(event.notifications).toBeGreaterThanOrEqual(1)
      // 新增字段存在且类型正确；合法事件通过运行时 schema 校验
      expect(typeof event.lastHostWriteBytes).toBe('number')
      expect(typeof event.maxHostWriteBytes).toBe('number')
      expect(event.lastHost === null || typeof event.lastHost === 'string').toBe(true)
      expect(event.lastActionName === null || typeof event.lastActionName === 'string').toBe(true)
      expect(validateMetricsEvent(event)).toEqual([])
    }
    store.destroy()
  })

  it('sampleRate=0（默认）不上报；卸载时关账全量上报一次', () => {
    const events: MetricsEvent[] = []
    const sink: MetricsSink = { report: (event) => events.push(event) }
    const store = createStore({ name: 'fr17-close', state: () => ({ count: 0 }) })
    const uninstall = store.use(metricsPlugin({ sink }))
    store.setState('count', 1)
    expect(events).toHaveLength(0)
    uninstall()
    // 关账：卸载时不受采样抑制，一次性全量上报
    expect(events).toHaveLength(1)
    expect(events[0].notifications).toBe(1)
    // 关账事件同样必须通过白名单 schema（与周期上报共用同一构造）
    expect(validateMetricsEvent(events[0])).toEqual([])
    expect(events[0].lastActionName).toBeNull()
    expect(events[0].lastHost).toBeNull()
    expect(events[0].lastHostWriteBytes).toBe(0)
    expect(events[0].maxHostWriteBytes).toBe(0)
    store.destroy()
  })

  it('sink 上报抛错不影响业务（隔离，AS-14）', () => {
    const store = createStore({ name: 'fr17-boom', state: () => ({ count: 0 }) })
    const failing: MetricsSink = {
      report: () => {
        throw new Error('sink boom')
      },
    }
    store.use(metricsPlugin({ sink: failing, sampleRate: 1 }))
    expect(() => store.setState('count', 1)).not.toThrow()
    expect(store.getState().count).toBe(1)
    store.destroy()
  })

  it('指标可定位「哪个 action 导致哪个宿主更新」：事件含 storeName，action 计数与宿主写入联动', async () => {
    const store = createStore({
      name: 'fr17-trace',
      state: () => ({ count: 0 }),
      actions: {
        bump() {
          this.setState('count', this.getState().count + 1)
        },
      },
    })
    const events: MetricsEvent[] = []
    const plugin = metricsPlugin({ sink: { report: (event) => events.push(event) }, sampleRate: 1 })
    store.use(plugin)
    const page = withPageStore(store, { mapState: ['count'] })({ data: {} }) as unknown as {
      onLoad: (this: Record<string, unknown>) => void
      onUnload: (this: Record<string, unknown>) => void
    }
    const { host } = createHost()
    page.onLoad.call(host)
    store.actions.bump()

    const last = events[events.length - 1]
    expect(last.storeName).toBe('fr17-trace')
    expect(last.actionCount).toBe(1)
    expect(last.hostWrites).toBeGreaterThanOrEqual(1)
    //  归因：最近一次 action 与宿主标签可定位「哪个 Action 导致哪个宿主更新」
    expect(last.lastActionName).toBe('bump')
    expect(last.lastHost).toBe('withPageStore')
    expect(last.lastHostWriteBytes).toBeGreaterThan(0)
    expect(last.maxHostWriteBytes).toBeGreaterThanOrEqual(last.lastHostWriteBytes)
    page.onUnload.call(host)
    store.destroy()
  })

  it('无参调用 metricsPlugin()：默认选项生效（只计数不上报）', () => {
    const store = createStore({ name: 'fr17-default-args', state: () => ({ count: 0 }) })
    const plugin = metricsPlugin()
    store.use(plugin)
    store.setState('count', 1)
    const collector = (plugin as { collector?: { snapshot: () => Record<string, number> } }).collector!
    expect(collector.snapshot().notifications).toBe(1)
    store.destroy()
  })

  it('孤立的 afterDispatch（缺少配对的 beforeDispatch）不计入 action 计数', () => {
    const store = createStore({ name: 'fr17-orphan-dispatch', state: () => ({ count: 0 }) })
    const plugin = metricsPlugin()
    store.use(plugin)
    const collector = (plugin as { collector?: { snapshot: () => Record<string, number> } }).collector!
    ;(store.hooks as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit('afterDispatch', 'ghost')
    expect(collector.snapshot().actionCount).toBe(0)
    store.destroy()
  })
})

describe(' metricsPlugin · 健壮性', () => {
  type Collector = { snapshot: () => Record<string, number> }

  function runWithSampleRate(sampleRate: number) {
    const events: MetricsEvent[] = []
    const store = createStore({ name: 'fr17-rate', state: () => ({ count: 0 }) })
    const uninstall = store.use(metricsPlugin({ sink: { report: (event) => events.push(event) }, sampleRate }))
    store.setState('count', 1)
    uninstall()
    store.destroy()
    return events
  }

  it('sampleRate 归一化：NaN → 只计数不上报；2 → 夹到 1 全量；-1 → 夹到 0 静默', () => {
    // NaN 旧实现会让 sampled() 恒 false，2 / -1 分别退化为全量与永久静默
    expect(runWithSampleRate(Number.NaN)).toHaveLength(1) // 只有卸载关账事件
    expect(runWithSampleRate(2).length).toBeGreaterThanOrEqual(2) // 周期事件 + 关账
    expect(runWithSampleRate(-1)).toHaveLength(1) // 只有卸载关账事件
  })

  it('onHostWrite 缺 bytes / bytes 为 NaN 时按 0 累计，不把 hostWriteBytes 污染成 NaN', () => {
    const store = createStore({ name: 'fr17-hw-bytes', state: () => ({ count: 0 }) })
    const plugin = metricsPlugin()
    store.use(plugin)
    const collector = (plugin as { collector?: Collector }).collector!
    const hooks = store.hooks as unknown as { emit: (event: string, ...args: unknown[]) => void }

    hooks.emit('onHostWrite', { host: 'page' })
    hooks.emit('onHostWrite', { host: 'page', bytes: Number.NaN })
    expect(collector.snapshot().hostWrites).toBe(2)
    expect(collector.snapshot().hostWriteBytes).toBe(0)
    // 非法 bytes 归一为 0：不得把 last/max 污染成 NaN
    expect(collector.snapshot().lastHostWriteBytes).toBe(0)
    expect(collector.snapshot().maxHostWriteBytes).toBe(0)
    expect(collector.snapshot().lastHost).toBe('page')

    hooks.emit('onHostWrite', { host: 'page', bytes: 128 })
    expect(collector.snapshot().hostWriteBytes).toBe(128)
    expect(collector.snapshot().lastHostWriteBytes).toBe(128)
    expect(collector.snapshot().maxHostWriteBytes).toBe(128)

    // 更小的一次写入只更新 last，max 保持历史最大；lastHost 跟随最近一次
    hooks.emit('onHostWrite', { host: 'component', bytes: 64 })
    expect(collector.snapshot().hostWriteBytes).toBe(192)
    expect(collector.snapshot().lastHostWriteBytes).toBe(64)
    expect(collector.snapshot().maxHostWriteBytes).toBe(128)
    expect(collector.snapshot().lastHost).toBe('component')

    // host 缺失/非字符串的归一：undefined → null；数字等非字符串 → String(host)
    hooks.emit('onHostWrite', { bytes: 8 })
    expect(collector.snapshot().lastHost).toBeNull()
    hooks.emit('onHostWrite', { host: 42, bytes: 8 })
    expect(collector.snapshot().lastHost).toBe('42')

    // onError 计数通道也走同一个累计快照
    hooks.emit('onError', new Error('boom'))
    expect(collector.snapshot().errors).toBe(1)
    store.destroy()
  })

  it('同名 action 的嵌套起点用 LIFO 栈配对：内层 after 不吞外层计数', () => {
    const store = createStore({ name: 'fr17-nested-start', state: () => ({ count: 0 }) })
    const plugin = metricsPlugin()
    store.use(plugin)
    const collector = (plugin as { collector?: Collector }).collector!
    const hooks = store.hooks as unknown as { emit: (event: string, ...args: unknown[]) => void }

    // 等价于 store.dispatch('recurse') 内再 this.dispatch('recurse')：两次 before / 两次 after
    hooks.emit('beforeDispatch', 'recurse', [])
    hooks.emit('beforeDispatch', 'recurse', [])
    hooks.emit('afterDispatch', 'recurse', [], undefined)
    hooks.emit('afterDispatch', 'recurse', [], undefined)
    expect(collector.snapshot().actionCount).toBe(2)
    expect(collector.snapshot().lastActionName).toBe('recurse')

    // 失败的 action 只 emit beforeDispatch（ActionManager 错误分支不 emit afterDispatch）：
    // 残留起点不影响后续同名 action 的栈顶配对与计数
    hooks.emit('beforeDispatch', 'fail', [])
    hooks.emit('beforeDispatch', 'fail', [])
    hooks.emit('afterDispatch', 'fail', [], undefined)
    expect(collector.snapshot().actionCount).toBe(3)

    // 非字符串 action 名同样归一为字符串（与起点栈 key 口径一致）
    hooks.emit('beforeDispatch', 7, [])
    expect(collector.snapshot().lastActionName).toBe('7')
    store.destroy()
  })

  it('卸载关账与周期上报共用同一事件构造：关账字段与 collector.snapshot 一致', () => {
    const events: MetricsEvent[] = []
    const store = createStore({ name: 'fr17-builder', state: () => ({ count: 0 }) })
    const plugin = metricsPlugin({ sink: { report: (event) => events.push(event) }, sampleRate: 1 })
    store.use(plugin)
    const collector = (plugin as { collector?: Collector }).collector!

    store.setState('count', 1)
    const periodic = events[events.length - 1]
    expect(periodic).toMatchObject(collector.snapshot())
    expect(periodic).toMatchObject({ type: 'metrics', schemaVersion: 1, storeName: 'fr17-builder' })

    const countBeforeClose = events.length
    store.destroy()
    expect(events).toHaveLength(countBeforeClose + 1)
    expect(events[events.length - 1]).toMatchObject({ ...collector.snapshot(), type: 'metrics', schemaVersion: 1 })
  })

  it('直接以插件对象使用（不调用工厂）：install 走默认选项也计数', () => {
    const store = createStore({ name: 'fr17-direct-install', state: () => ({ count: 0 }) })
    store.use(metricsPlugin as never)
    store.setState('count', 1)
    expect(() => store.destroy()).not.toThrow()
  })

  it('持续失败的 action 不会让单名待配对起点无界增长', () => {
    const store = createStore({ name: 'fr17-bounded-starts', state: () => ({ count: 0 }) })
    const plugin = metricsPlugin()
    store.use(plugin)
    const collector = (plugin as { collector?: Collector }).collector!
    const hooks = store.hooks as unknown as { emit: (event: string, ...args: unknown[]) => void }

    // 40 次失败 action：只有 beforeDispatch，没有 afterDispatch，起点栈封顶后丢弃最旧
    for (let i = 0; i < 40; i++) hooks.emit('beforeDispatch', 'flaky', [])
    // 随后的成功 action 仍从栈顶配对，计数正常
    hooks.emit('beforeDispatch', 'flaky', [])
    hooks.emit('afterDispatch', 'flaky', [], undefined)
    expect(collector.snapshot().actionCount).toBe(1)
    store.destroy()
  })
})

describe(' sink schema 运行时校验', () => {
  const makeValidEvent = (overrides: Partial<MetricsEvent> = {}): MetricsEvent => ({
    type: 'metrics',
    storeName: 'schema-store',
    notifications: 1,
    hostWrites: 1,
    hostWriteBytes: 128,
    lastHostWriteBytes: 64,
    maxHostWriteBytes: 128,
    lastHost: 'withPageStore',
    lastActionName: 'inc',
    actionCount: 1,
    actionTotalMs: 2,
    errors: 0,
    subscriptions: 1,
    schemaVersion: 1,
    ...overrides,
  })

  it('白名单校验：合法事件通过；非白名单字段 / 类型 / NaN / schemaVersion 被拒', () => {
    const valid = makeValidEvent()
    expect(validateMetricsEvent(valid)).toEqual([])

    // 状态值/敏感字段只能出现在白名单外字段：必须拦截（sink schema 不允许任何状态/个人信息）
    expect(validateMetricsEvent({ ...valid, state: { token: 'secret' } })).toEqual([expect.stringContaining('非白名单字段 "state"')])
    expect(validateMetricsEvent({ ...valid, lastHost: 123 })).toEqual([expect.stringContaining('"lastHost"')])
    expect(validateMetricsEvent({ ...valid, notifications: Number.NaN })).toEqual([expect.stringContaining('"notifications"')])
    expect(validateMetricsEvent({ ...valid, schemaVersion: 2 })).toEqual([expect.stringContaining('schemaVersion')])
    expect(validateMetricsEvent({ ...valid, type: 'log' })).toEqual([expect.stringContaining('type')])
    expect(validateMetricsEvent({ ...valid, hostWriteBytes: -1 })).toEqual([expect.stringContaining('"hostWriteBytes"')])
    expect(validateMetricsEvent(null)).toEqual(['事件必须是普通对象'])
    expect(validateMetricsEvent([])).toEqual(['事件必须是普通对象'])
    // nullableString 允许 null；缺字段单独报「缺少字段」
    expect(validateMetricsEvent({ ...valid, lastHost: null, lastActionName: null })).toEqual([])
    const { lastHost: _omittedHost, ...missingLastHost } = valid
    expect(validateMetricsEvent(missingLastHost)).toEqual([expect.stringContaining('缺少字段 "lastHost"')])
  })

  it('非法事件被拦截：不调用 sink、开发期 console.error + onError(INVALID_CONFIG, metrics)，计数继续', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const sink: MetricsSink = { report: jest.fn() }
    const store = createStore({ name: 'fr17-schema-guard', state: () => ({ count: 0 }) })
    const plugin = metricsPlugin({ sink, sampleRate: 1 })
    const errors: Array<{ code?: string; source?: string }> = []
    store.hooks.on('onError', (error, source) => {
      errors.push({ code: (error as { code?: string }).code, source })
    })
    store.use(plugin)
    const collector = (plugin as { collector?: { snapshot: () => Record<string, unknown> } }).collector!

    // 构造运行期非法事件：订阅数被篡改成 NaN（模拟采集链路被 JS 调用方污染）
    const originalCount = store.getSubscriptionCount.bind(store)
    ;(store as unknown as { getSubscriptionCount: () => number }).getSubscriptionCount = () => Number.NaN
    store.setState('count', 1)

    expect(sink.report).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('sink schema'))
    const metricsErrors = errors.filter((entry) => entry.source === 'metrics')
    expect(metricsErrors).toHaveLength(1)
    expect(metricsErrors[0].code).toBe('INVALID_CONFIG')
    // 计数器不受拦截影响：通知照常计数，非法事件不写 sink
    expect(collector.snapshot().notifications).toBe(1)
    expect(collector.snapshot().errors).toBe(1)

    // 恢复合法订阅计数后：下一次事件通过校验并正常上报
    ;(store as unknown as { getSubscriptionCount: () => number }).getSubscriptionCount = originalCount
    store.setState('count', 2)
    expect(sink.report).toHaveBeenCalledTimes(1)
    const event = (sink.report as jest.Mock).mock.calls[0][0] as MetricsEvent
    expect(validateMetricsEvent(event)).toEqual([])
    expect(event.notifications).toBe(2)
    store.destroy()
  })

  it('生产期非法事件：不刷 console，仅 onError 上报且不调用 sink', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const index = await import('../../../src/index.js')
      const plugins = await import('../../../src/plugins.js')
      const sink: MetricsSink = { report: jest.fn() }
      const store = index.createStore({ name: 'fr17-schema-prod', state: () => ({ count: 0 }) })
      const errors: Array<{ code?: string; source?: string }> = []
      store.hooks.on('onError', (error, source) => {
        errors.push({ code: (error as { code?: string }).code, source })
      })
      store.use(plugins.metricsPlugin({ sink, sampleRate: 1 }))
      ;(store as unknown as { getSubscriptionCount: () => number }).getSubscriptionCount = () => Number.NaN
      store.setState('count', 1)

      expect(sink.report).not.toHaveBeenCalled()
      expect(consoleError).not.toHaveBeenCalled()
      expect(errors.some((entry) => entry.source === 'metrics' && entry.code === 'INVALID_CONFIG')).toBe(true)
      store.destroy()
    } finally {
      consoleError.mockRestore()
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
      jest.resetModules()
    }
  })
})
