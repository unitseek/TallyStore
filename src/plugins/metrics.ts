/**
 * 指标插件：采集通知 / 宿主写入 / action 耗时 / 错误 / 订阅数，经可注入的
 * sink 上报；采样率可配置可关闭；事件白名单 schema 固定且不含个人信息。
 *
 * 口径：
 * - 生产默认 **不安装**（业务按需 use；装了也默认 sampleRate=0 不上报，仅计数可查）；
 * - sink 可注入可替换（`LogSink` 风格），库不内置任何厂商 SDK；
 * - 事件 schema 白名单见 docs/API.md：字段全为计数/耗时/字节/名称类，无状态值与个人信息；
 *   上报前有运行时白名单校验（非法事件不调用 sink，开发期 console.error + onError('metrics')）；
 * -  归因：事件含最近/最大单次宿主写入字节、最近宿主标签与最近 action 名，可定位
 *   「哪个 Action 导致哪个宿主更新」；
 * - 采样在**事件出口**做（计数器始终准确），sampleRate=0 时周期事件完全静默、=1 全量；
 * - **计数是累计快照**：counters 自安装起累加、上报后不清零，事件里的数值是累计值，
 *   下游按周期累加会重复计数；需要增量请在下游做差分；
 * - **卸载关账是唯一例外**：卸载时做最后一次全量上报，不受采样开关约束（见下方 close 分支）；
 *   sampleRate=0 时这是唯一会到达 sink 的事件（注入了 sink 才会发生）。
 */

import type { Store } from '../types/store.js'
import type { Plugin } from '../types/plugin.js'
import { isProduction } from '../core/store/utils.js'
import { TallyStoreError, ErrorCode } from '../core/errors/TallyStoreError.js'

/** 指标事件（sink 上报白名单 schema，全部字段不含个人信息） */
export interface MetricsEvent {
  type: 'metrics'
  storeName: string
  /** 自安装以来的**累计**计数快照（counters 从不因上报清零；下游按周期接收时需自行差分） */
  notifications: number
  hostWrites: number
  /** 自安装以来累计的宿主写入载荷估算字节（`lastHostWriteBytes` 是最近一次的同一口径） */
  hostWriteBytes: number
  /** 最近一次宿主写入的载荷估算字节（未写入为 0） */
  lastHostWriteBytes: number
  /** 历史最大单次宿主写入载荷估算字节（未写入为 0） */
  maxHostWriteBytes: number
  /** 最近一次写入的宿主标签（Page/Component/App 入口名；未写入为 null） */
  lastHost: string | null
  /** 最近一次 dispatch 的 action 名（用于 Action → 宿主更新归因；未 dispatch 为 null） */
  lastActionName: string | null
  actionCount: number
  actionTotalMs: number
  errors: number
  subscriptions: number
  schemaVersion: 1
}

/** 指标上报通道：可注入、可替换；上报失败不得影响业务 */
export interface MetricsSink {
  report(event: MetricsEvent): void
}

/**
 * sink 上报字段白名单 schema：字段名 → 运行时类型。
 * 只允许计数 / 耗时 / 字节 / 名称类字段，**不得**出现状态值或个人信息字段；
 * 上报前逐字段校验，出现白名单外字段、缺字段、类型/取值非法即拦截本次上报。
 */
const METRICS_EVENT_SCHEMA: Record<string, 'string' | 'nullableString' | 'number'> = {
  type: 'string',
  storeName: 'string',
  notifications: 'number',
  hostWrites: 'number',
  hostWriteBytes: 'number',
  lastHostWriteBytes: 'number',
  maxHostWriteBytes: 'number',
  lastHost: 'nullableString',
  lastActionName: 'nullableString',
  actionCount: 'number',
  actionTotalMs: 'number',
  errors: 'number',
  subscriptions: 'number',
  schemaVersion: 'number',
}

/**
 * 校验 sink 事件是否符合白名单 schema。
 * 返回问题列表；空数组 = 合法。导出供测试与 sink 自检复用（不是包入口 API，plugins 聚合入口不转发）。
 * 数值字段要求有限且非负：累计计数/耗时/字节出现 NaN/Infinity/负数说明采集链路被污染，
 * 不应继续上报给监控。
 */
export function validateMetricsEvent(event: unknown): string[] {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return ['事件必须是普通对象']
  }
  const record = event as Record<string, unknown>
  const problems: string[] = []
  for (const key of Object.keys(record)) {
    if (!Object.prototype.hasOwnProperty.call(METRICS_EVENT_SCHEMA, key)) {
      problems.push('非白名单字段 "' + key + '"（sink schema 只允许计数/耗时/字节/名称类字段）')
    }
  }
  for (const [key, expected] of Object.entries(METRICS_EVENT_SCHEMA)) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      problems.push('缺少字段 "' + key + '"')
      continue
    }
    const value = record[key]
    const valid =
      expected === 'string'
        ? typeof value === 'string'
        : expected === 'nullableString'
          ? value === null || typeof value === 'string'
          : typeof value === 'number' && Number.isFinite(value) && value >= 0
    if (!valid) {
      problems.push('字段 "' + key + '" 类型/取值非法（期望 ' + expected + '）')
    }
  }
  if (record.type !== 'metrics') problems.push('type 必须为 "metrics"')
  if (record.schemaVersion !== 1) problems.push('schemaVersion 必须为 1')
  return problems
}

/** metricsPlugin 选项 */
export interface MetricsPluginOptions {
  sink?: MetricsSink
  /**
   * 事件采样率 0-1（默认 0：只计数不上报；1 = 全量）。
   * 非有限值（NaN/Infinity）按 0 处理，越界值夹到 [0, 1]。
   */
  sampleRate?: number
}

/** 采集到的累计计数快照（测试与诊断可读；从不清零，口径与上报事件一致） */
export interface MetricsCollector {
  snapshot(): Omit<MetricsEvent, 'type' | 'schemaVersion' | 'storeName'>
}

const createMetricsPlugin = (options: MetricsPluginOptions = {}): Plugin & { collector?: MetricsCollector } => {
  let counters = {
    notifications: 0,
    hostWrites: 0,
    hostWriteBytes: 0,
    lastHostWriteBytes: 0,
    maxHostWriteBytes: 0,
    lastHost: null as string | null,
    lastActionName: null as string | null,
    actionCount: 0,
    actionTotalMs: 0,
    errors: 0,
  }
  const sink = options.sink
  // 采样率归一化：非有限值按 0（== 只计数不上报），越界值夹到 [0, 1]。
  // 不能原样使用：NaN 让 sampled() 恒 false 而静默失效，2 / -1 分别退化为全量与永久静默，
  // 二者都与「0-1 采样率」的文档约定不符。
  const rawSampleRate = options.sampleRate ?? 0
  const sampleRate = Number.isFinite(rawSampleRate) ? Math.min(1, Math.max(0, rawSampleRate)) : 0
  const sampled = (): boolean => sampleRate > 0 && Math.random() < sampleRate

  const plugin: Plugin & { collector?: MetricsCollector } = {
    name: 'metrics',
    install(store: Store) {
      // 事件构造的唯一出口：report 与卸载关账共用同一份 schema，避免两处漂移
      const buildEvent = (): MetricsEvent => ({
        type: 'metrics',
        storeName: store.name,
        ...counters,
        subscriptions: store.getSubscriptionCount(),
        schemaVersion: 1,
      })

      /**
       * 拦截未通过 schema 校验的事件：白名单外字段可能夹带状态值或个人信息，
       * 因此非法事件**不调用 sink**；开发期 console.error + 两期 onError(INVALID_CONFIG, 'metrics')。
       * 用 intercepting 防递归：emit('onError') 会触发本插件自己的 onError 处理器（计数后再次 report）。
       */
      let interceptingInvalidEvent = false
      const interceptInvalidEvent = (problems: string[]): void => {
        if (interceptingInvalidEvent) return
        interceptingInvalidEvent = true
        const message = '[TallyStore][metrics] 指标事件未通过 sink schema 校验，已拦截本次上报：' + problems.join('；')
        try {
          if (!isProduction()) {
            console.error(message)
          }
          try {
            store.hooks.emit('onError', new TallyStoreError(ErrorCode.INVALID_CONFIG, message, { storeName: store.name, problems }), 'metrics')
          } catch {
            // 上报通道异常不外溢：指标通道的失败不能制造业务崩溃
          }
        } finally {
          interceptingInvalidEvent = false
        }
      }

      /**
       * 上报一次累计快照。
       * @param force true = 关账路径，不受采样率抑制（但仍需注入 sink）
       */
      const report = (force = false): void => {
        if (sink === undefined || (!force && !sampled())) return
        const event = buildEvent()
        // 上报前做白名单 schema 运行时校验——非法事件不得进入 sink（防状态值/个人信息外泄）
        const problems = validateMetricsEvent(event)
        if (problems.length > 0) {
          interceptInvalidEvent(problems)
          return
        }
        try {
          sink.report(event)
        } catch {
          // 上报失败不得影响业务（sink 自身的异常在这里终结）
        }
      }

      const unhooks: Array<() => void> = [
        store.hooks.on('onNotify', () => {
          counters.notifications += 1
          report()
        }),
        store.hooks.on('onHostWrite', (meta) => {
          counters.hostWrites += 1
          const metaRecord = meta as { bytes?: unknown; host?: unknown } | undefined
          // 运行时数值校验：hook 可被 JS 调用方直接 emit，bytes 缺失/NaN 会让
          // hostWriteBytes 永久污染成 NaN 且后续无法恢复；非有限数/负数按 0 计
          const rawBytes = metaRecord?.bytes
          const bytes = typeof rawBytes === 'number' && Number.isFinite(rawBytes) && rawBytes >= 0 ? rawBytes : 0
          counters.hostWriteBytes += bytes
          //  单次载荷与归因：最近一次 / 历史最大 / 最近宿主标签（与 hostWriteBytes 累计口径互补）
          counters.lastHostWriteBytes = bytes
          if (bytes > counters.maxHostWriteBytes) counters.maxHostWriteBytes = bytes
          const host = metaRecord?.host
          counters.lastHost = typeof host === 'string' ? host : host === null || host === undefined ? null : String(host)
          report()
        }),
        store.hooks.on('onError', () => {
          counters.errors += 1
          report()
        }),
      ]

      // action 耗时：同 action 名维护 LIFO 起点栈——嵌套/递归调用同名 action 时，
      // 内层 before 不能覆盖外层起点、内层 after 也不能删掉外层（旧单值 Map 会因此漏计外层）；
      // 失败的 action 不会 emit afterDispatch（ActionManager 错误分支），其起点会残留；
      // 长期运行下持续失败会让单名栈无界增长，故封顶待配对数、超出时丢最旧起点。
      // 文档口径：以同步执行段耗时为准，异步续段计入下一对或另计
      const MAX_PENDING_STARTS = 32
      const starts = new Map<string, number[]>()
      const pushStart = (actionName: unknown): void => {
        const key = String(actionName)
        const stack = starts.get(key)
        if (stack === undefined) {
          starts.set(key, [Date.now()])
        } else {
          if (stack.length >= MAX_PENDING_STARTS) stack.shift()
          stack.push(Date.now())
        }
      }
      const popStart = (actionName: unknown): number | undefined => {
        const key = String(actionName)
        const stack = starts.get(key)
        const start = stack?.pop()
        if (stack !== undefined && stack.length === 0) {
          starts.delete(key)
        }
        return start
      }
      //  归因：记录最近一次 dispatch 的 action 名（before 即生效，action 内触发的宿主写入
      // 在事件里带上该名字；after 再确认一次，兼容 JS 调用方只 emit afterDispatch 的场景）
      const recordActionName = (actionName: unknown): void => {
        counters.lastActionName = typeof actionName === 'string' ? actionName : String(actionName)
      }
      unhooks.push(
        store.hooks.on('beforeDispatch', (actionName: unknown) => {
          recordActionName(actionName)
          pushStart(actionName)
        }),
      )
      unhooks.push(
        store.hooks.on('afterDispatch', (actionName: unknown) => {
          recordActionName(actionName)
          const start = popStart(actionName)
          if (start !== undefined) {
            counters.actionCount += 1
            counters.actionTotalMs += Date.now() - start
            report()
          }
        }),
      )

      plugin.collector = {
        snapshot: () => ({ ...counters, subscriptions: store.getSubscriptionCount() }),
      }

      return () => {
        // 卸载时做最后一次未采样的全量上报（关账口径：不受 sampleRate 抑制）。
        // 这是文件头「sampleRate=0 完全静默」的**唯一例外**——只要注入了 sink，
        // 卸载一定会收到一条累计快照；该行为已被测试固化（关账语义），故保留并在此写明，
        // 需要「完全静默」的业务不要注入 sink 或自行按 sink 侧开关过滤卸载事件。
        report(true)
        for (const unhook of unhooks) unhook()
        starts.clear()
      }
    },
  }
  return plugin
}

/** 指标插件（可作工厂直接调用） */
const _metricsPluginFactory = (options?: MetricsPluginOptions): Plugin & { collector?: MetricsCollector } => createMetricsPlugin(options)

Object.defineProperty(_metricsPluginFactory, 'name', { value: 'metrics', writable: true, configurable: true })
;(_metricsPluginFactory as unknown as Plugin & { collector?: MetricsCollector }).install = (store: Store) => createMetricsPlugin().install(store)

export const metricsPlugin = _metricsPluginFactory as Plugin & ((options?: MetricsPluginOptions) => Plugin & { collector?: MetricsCollector })
