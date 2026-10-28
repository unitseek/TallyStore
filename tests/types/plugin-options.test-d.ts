/**
 *  验收 3 /  补充：公开「选项类」类型的正向 + 负向类型测试（CI 经 typecheck:tests 阻断）。
 *
 * 覆盖（与 docs/API.md 的 Options 表对应）：
 * - StoreOptions / StateProtectionOptions / SubscriptionOptions / NotifyOptions（主入口导出）
 * - ConnectOptions（主入口导出；withPageStore/withAppStore 的 mapState/mapGetters/mapActions 口径）
 * - PersistenceOptions / LoggerPluginOptions / MetricsPluginOptions / StorageBackend / LogSink / MetricsSink（plugins 入口）
 * - Plugin / PluginHook 契约
 *
 * 注：本库没有单一「PluginOptions」类型（按插件拆成 PersistenceOptions / LoggerPluginOptions /
 * MetricsPluginOptions），故按实际公开类型逐组断言；负向用例使用 @ts-expect-error，类型退化到
 * 「不再报错」时 tsc 会因 Unused '@ts-expect-error' directive 失败。
 */

import type { ConnectOptions, NotifyOptions, Plugin, PluginHook, StateProtectionOptions, StoreOptions, SubscriptionOptions } from '../../src/index.js'
import type { LoggerPluginOptions, LogSink, MetricsPluginOptions, MetricsSink, PersistenceOptions, StorageBackend } from '../../src/plugins.js'

interface DemoState {
  count: number
  user: { name: string }
}
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false

// ==================== StoreOptions 及子选项 ====================

const stateProtection: StateProtectionOptions = { enabled: true, deep: false, productionHandler: 'warn' }
const subscription: SubscriptionOptions = { maxSubscribers: 100, onLimit: 'evict-oldest' }
const notify: NotifyOptions = { async: true, clone: false, onlyOnChange: true }
const storeOptions: StoreOptions<DemoState> = {
  name: 'type-options-store',
  state: () => ({ count: 0, user: { name: '' } }),
  stateProtection,
  subscription,
  notify,
  snapshot: { maxBytes: 1024 },
}
const optionsExact: Equal<typeof storeOptions.snapshot, { maxBytes?: number } | undefined> = true
void optionsExact

// 负向：枚举与字段类型不得放宽
// @ts-expect-error productionHandler 只接受 'error' | 'warn' | 'silent'
const badProtectionHandler: StateProtectionOptions = { productionHandler: 'boom' }
// @ts-expect-error onLimit 只接受 'evict-oldest' | 'throw'
const badLimitPolicy: SubscriptionOptions = { onLimit: 'evict' }
// @ts-expect-error notify.async 必须是 boolean
const badNotify: NotifyOptions = { async: 'yes' }
// @ts-expect-error snapshot.maxBytes 必须是 number
const badSnapshot: StoreOptions<DemoState> = { state: { count: 0, user: { name: '' } }, snapshot: { maxBytes: '1MB' } }
void badProtectionHandler
void badLimitPolicy
void badNotify
void badSnapshot

// ==================== ConnectOptions ====================

const connectOptions: ConnectOptions<DemoState> = {
  mapState: ['count'],
  mapGetters: { total: 'doubled' },
  mapActions: { add: 'inc' },
  maxPayloadBytes: 512 * 1024,
  backgroundUpdates: true,
  schedule: 'microtask',
}
const scheduleExact: Equal<typeof connectOptions.schedule, 'auto' | 'sync' | 'microtask' | undefined> = true
void scheduleExact

// 负向：未知 state 键、非法 schedule、选项类型
// @ts-expect-error mapState 的键必须存在于 DemoState
const badMapState: ConnectOptions<DemoState> = { mapState: ['missing'] }
// @ts-expect-error schedule 只接受 'auto' | 'sync' | 'microtask'
const badSchedule: ConnectOptions<DemoState> = { schedule: 'batched' }
// @ts-expect-error maxPayloadBytes 必须是 number
const badPayloadBudget: ConnectOptions<DemoState> = { maxPayloadBytes: '1MB' }
// @ts-expect-error backgroundUpdates 必须是 boolean
const badBackgroundUpdates: ConnectOptions<DemoState> = { backgroundUpdates: 'yes' }
void badMapState
void badSchedule
void badPayloadBudget
void badBackgroundUpdates

// ==================== PersistenceOptions ====================

const storage: StorageBackend = {
  getItem: (key: string) => (key === '' ? null : key),
  setItem: (key: string, value: string) => void [key, value],
  removeItem: (key: string) => void key,
}
const persistenceOptions: PersistenceOptions<DemoState> = {
  key: 'type-options-cart',
  storage,
  filter: (state) => ({ count: state.count }),
  validate: (state) => typeof state === 'object' && state !== null,
  restore: true,
  debounce: 100,
  clearOnUninstall: false,
  schemaVersion: 2,
  migrations: { 2: (data) => ({ ...data }) },
}
const keyFn: Equal<NonNullable<typeof persistenceOptions.key>, string | ((storeName: string) => string)> = true
void keyFn

// 负向：schemaVersion 类型、filter 返回类型、storage 契约
// @ts-expect-error schemaVersion 必须是 number
const badSchemaVersion: PersistenceOptions<DemoState> = { schemaVersion: '2' }
// @ts-expect-error filter 必须返回 Partial<DemoState>
const badFilter: PersistenceOptions<DemoState> = { filter: () => 1 }
// @ts-expect-error validate 必须返回 boolean
const badValidate: PersistenceOptions<DemoState> = { validate: () => 'yes' }
// @ts-expect-error StorageBackend 必须实现 removeItem
const badStorage: PersistenceOptions<DemoState> = { storage: { getItem: () => null, setItem: () => undefined } }
// @ts-expect-error migrations 必须返回普通对象（不得为 Promise）
const badMigrations: PersistenceOptions<DemoState> = { migrations: { 2: async (data) => data } }
void badSchemaVersion
void badFilter
void badValidate
void badStorage
void badMigrations

// ==================== LoggerPluginOptions / LogSink ====================

const logSink: LogSink = {
  log: (message: string, ...data: unknown[]) => void [message, data],
  error: (message: string, ...data: unknown[]) => void [message, data],
}
const loggerOptions: LoggerPluginOptions = { sink: logSink }

// 负向：sink 必须同时实现 log 与 error；参数类型不得放宽
// @ts-expect-error sink 缺少 error 方法
const badLoggerSink: LoggerPluginOptions = { sink: { log: () => undefined } }
// @ts-expect-error log 的首参必须是 string
const badLogSignature: LoggerPluginOptions = { sink: { log: (message: number) => void message, error: () => undefined } }
void loggerOptions
void badLoggerSink
void badLogSignature

// ==================== MetricsPluginOptions / MetricsSink ====================

const metricsSink: MetricsSink = { report: () => undefined }
const metricsOptions: MetricsPluginOptions = { sink: metricsSink, sampleRate: 0.5 }

// 负向：sampleRate 必须 number、sink 事件参数类型
// @ts-expect-error sampleRate 必须是 number
const badSampleRate: MetricsPluginOptions = { sampleRate: 'high' }
// @ts-expect-error report 的事件参数必须是 MetricsEvent
const badMetricsSink: MetricsPluginOptions = { sink: { report: (event: string) => void event } }
void metricsOptions
void badSampleRate
void badMetricsSink

// ==================== Plugin / PluginHook 契约 ====================

const pluginHook: PluginHook<DemoState> = (store) => {
  store.setState('count', 1)
}
const plugin: Plugin<DemoState> = {
  name: 'type-options-plugin',
  install: pluginHook,
}
const installReturn: Equal<ReturnType<typeof plugin.install>, void | (() => void)> = true
void installReturn

// 负向：缺少 name / install
// @ts-expect-error Plugin 必须同时提供 name 与 install
const badPlugin: Plugin<DemoState> = { name: 'missing-install' }
const badPluginHook: PluginHook<DemoState> = (store) => {
  // @ts-expect-error store 的状态键必须匹配 DemoState
  store.setState('missing', 1)
}
void badPlugin
void badPluginHook
