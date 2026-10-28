/** TallyStore - 日志插件 */

import type { Store } from '../types/store.js'
import type { Plugin } from '../types/plugin.js'
import type { LoggerPluginOptions } from '../types/plugins.js'
import { isProduction } from '../core/store/utils.js'
import { isSensitiveKey, maskForLog, maskSensitiveValue } from '../core/security/sensitiveKeys.js'

/** loggerPlugin 的选项 */
export type { LoggerPluginOptions } from '../types/plugins.js'

const createLoggerPlugin = (options: LoggerPluginOptions = {}): Plugin => ({
  name: 'logger',

  install(store: Store) {
    // 生产环境保护：不输出日志，避免性能损耗和信息泄露
    if (isProduction()) {
      return () => {}
    }

    // 在 install 期取 sink：`options.sink ?? console` 若在工厂期取值，会固定住当时的 console 对象
    const sink = options.sink ?? console
    const emit = (message: string, ...data: unknown[]): void => {
      try {
        sink.log(message, ...data)
      } catch (error) {
        // 日志输出失败不得穿透 store 的变更链路；优先走 LogSink.error，缺失时退回 console.warn
        const detail = error instanceof Error ? error.message : String(error)
        try {
          if (typeof sink.error === 'function') {
            sink.error('[logger] 日志输出失败，已忽略（不影响业务调用）：', detail)
          } else {
            console.warn('[logger] 日志输出失败，已忽略（不影响业务调用）：', detail)
          }
        } catch {
          // 错误通道自身失败时只能放弃，不能反向打断业务写入
        }
      }
    }

    // 脱敏（maskForLog / maskSensitiveValue）在 emit 的 try/catch 边界之外：它会遍历载荷
    // （Object.keys / 属性读取 / Object.getPrototypeOf），遇到代理或抛错 getter 可能抛异常。
    // 若让异常冒到 store 的 hook/listener 错误通道，会把「日志脱敏失败」误报成业务错误
    // （dev console.error + onError/监控），与 sink 失败被吞的口径不一致。统一在此吞掉并
    // 放弃本次日志，保证 logger 永不打断业务写路径。
    const safeLog = (message: string, build: () => unknown[]): void => {
      let data: unknown[]
      try {
        data = build()
      } catch {
        return
      }
      emit(message, ...data)
    }

    emit(`[TallyStore] Plugin "logger" installed`)

    //  归因：记录最近一次 beforeDispatch 的 action 名，供 onHostWrite 日志回答
    // 「哪个 Action 导致哪个宿主更新」；只保存名字，不保存参数或状态值
    let lastActionName = '(none)'

    //  日志脱敏：state 深度脱敏后输出（敏感键保留前缀+后四位）；
    // 未命中敏感键的值原样传递，日志结构不变
    const unhookSubscribe = store.subscribe(
      (state) => {
        safeLog('[TallyStore] State changed:', () => [maskForLog(state)])
      },
      { readOnly: true },
    )

    // setState 的值脱敏：命中敏感键直接按键脱敏；非敏感键也要深度脱敏——
    // setState('profile', { password, accessToken }) 的嵌套敏感字段不能原样打印
    const maskStateValue = (key: unknown, value: unknown): unknown =>
      typeof key === 'string' && isSensitiveKey(key) ? maskSensitiveValue(value) : maskForLog(value)

    const unhookBeforeSetState = store.hooks.on('beforeSetState', (key: unknown, value: unknown) => {
      safeLog('[TallyStore] Setting state:', () => [key, '=>', maskStateValue(key, value)])
    })

    const unhookAfterSetState = store.hooks.on('afterSetState', (key: unknown, value: unknown) => {
      safeLog('[TallyStore] State set:', () => [key, '=>', maskStateValue(key, value)])
    })

    const unhookBeforeDispatch = store.hooks.on('beforeDispatch', (actionName: unknown, args: unknown) => {
      // 参数数组整体交给 maskForLog：数组元素里的对象会按键深度脱敏。
      // hook 契约里 args 恒为 readonly unknown[]，不再保留 Array.isArray 死分支的“原样输出”兜底。
      // 已知限制（保留文档口径）：位置参数是原始值，无法按键判定、不做脱敏——
      // 敏感实参请传对象并命名敏感键（见 SECURITY.md 与 docs/API.md）
      lastActionName = typeof actionName === 'string' ? actionName : String(actionName)
      safeLog('[TallyStore] Dispatching action:', () => [actionName, maskForLog(args)])
    })

    const unhookAfterDispatch = store.hooks.on('afterDispatch', (actionName: unknown, _args: unknown, result: unknown) => {
      safeLog('[TallyStore] Action dispatched:', () => [actionName, maskForLog(result)])
    })

    //  可观测性：重置审计日志——只输出 storeName / reason / timestamp（afterReset 再加 ok），
    // 不含任何状态值；用于排查「状态被谁清空」，并区分 direct 与 defineStores.resetAll 两种来源
    const unhookBeforeReset = store.hooks.on('beforeReset', (info) => {
      safeLog('[TallyStore] Resetting store:', () => [info.storeName, info.reason, info.timestamp])
    })

    const unhookAfterReset = store.hooks.on('afterReset', (info) => {
      safeLog('[TallyStore] Store reset:', () => [info.storeName, info.reason, info.timestamp, info.ok])
    })

    // 宿主写入归因日志（host / bytes + 最近一次 beforeDispatch 的 action 名），
    // 不含字段值，也不含被写入的状态内容
    const unhookHostWrite = store.hooks.on('onHostWrite', (meta) => {
      safeLog('[TallyStore] Host write:', () => [meta.host, meta.bytes + 'B', 'from action:', lastActionName])
    })

    return () => {
      unhookSubscribe()
      unhookBeforeSetState()
      unhookAfterSetState()
      unhookBeforeDispatch()
      unhookAfterDispatch()
      unhookBeforeReset()
      unhookAfterReset()
      unhookHostWrite()
    }
  },
})

/** 日志插件（可作工厂直接调用） */
const _loggerPluginFactory = (options?: LoggerPluginOptions): Plugin => createLoggerPlugin(options)

// 函数对象的 `name` 是只读的，而 store.use 在重复安装告警里会读 plugin.name
Object.defineProperty(_loggerPluginFactory, 'name', { value: 'logger', writable: true, configurable: true })
;(_loggerPluginFactory as unknown as Plugin).install = (store: Store) => createLoggerPlugin().install(store)

export const loggerPlugin = _loggerPluginFactory as Plugin & ((options?: LoggerPluginOptions) => Plugin)
