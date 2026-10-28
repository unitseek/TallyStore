/** TallyStore - 内置插件（可选能力，按需引入） */

export { loggerPlugin } from './plugins/logger.js'
export { metricsPlugin } from './plugins/metrics.js'
export type { MetricsPluginOptions, MetricsSink, MetricsEvent, MetricsCollector } from './plugins/metrics.js'
export { persistencePlugin } from './plugins/persistence.js'
export { WxStorageBackend } from './plugins/WxStorageBackend.js'

export type { PersistenceOptions, StorageBackend, LoggerPluginOptions, LogSink } from './types/plugins.js'
