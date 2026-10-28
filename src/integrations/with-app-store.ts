/** TallyStore - 微信小程序 App 集成 */

import type { Store, State, Actions, Getters } from '../types/store.js'
import type { AppThis, ConnectOptions, WithPageThis } from '../types/plugin.js'
import { resolveMappings, copyConfigPreservingPrototype, copyOwnEntries, assertConnectOptions, validateMappingDeclarations } from './utils.js'
import { connectHost } from './connect.js'
import { wrapVisibilityLifecycles } from './visibility.js'
import { isProduction } from '../core/store/utils.js'
import { TallyStoreError, ErrorCode } from '../core/errors/TallyStoreError.js'

export type { ConnectOptions } from '../types/plugin.js'

// ==================== 类型定义 ====================

/** `withAppStore` 处理的 App 配置对象 */
export interface AppOptions {
  /** 全局数据对象（微信原生字段） */
  globalData?: Record<string, unknown>
  /** 应用启动生命周期 */
  onLaunch?(...args: unknown[]): void
  /** 应用切前台生命周期 */
  onShow?(...args: unknown[]): void
  /** 应用切后台生命周期 */
  onHide?(): void
  /** 全局错误回调 */
  onError?(error: unknown): void
  /** 允许业务扩展自定义字段 */
  [key: string]: unknown
}

// ==================== App 集成 ====================

/** 映射写入 `globalData` 的键与宿主已有成员同名时告警（开发期 console，两期均经 onError 上报）。 */
function warnOnGlobalDataCollision(
  store: { hooks: { emit(event: 'onError', error: unknown, source?: string): void } },
  globalData: Record<string, unknown>,
  ...keyGroups: Array<Iterable<string>>
): void {
  const collided: string[] = []
  for (const keys of keyGroups) {
    for (const localKey of keys) {
      if (!collided.includes(localKey) && Object.prototype.hasOwnProperty.call(globalData, localKey)) {
        collided.push(localKey)
      }
    }
  }
  if (collided.length === 0) return
  const message =
    '[withAppStore] globalData 已有成员 ' +
    collided.map((key) => `"${key}"`).join(', ') +
    ' 将被 store 映射值持续覆盖（store 为唯一事实来源）；如需保留原值请调整映射本地名'
  if (!isProduction()) {
    console.warn(message)
  }
  // 生产期不刷控制台但必须可观测（P-06 降级不静默）
  store.hooks.emit('onError', new TallyStoreError(ErrorCode.INVALID_MAPPING, message, { keys: collided }), 'mapping')
}

/**
 * App 集成函数：把 Store 连到微信小程序 `App`（globalData 映射 + action 方法绑定）。
 * @param store - Store 实例
 * @param [options={}] - 连接选项
 * @returns App 装饰器（保持配置类型，并注入方法 this）
 */
export function withAppStore<S extends State, A extends Actions, G extends Getters<S>, O extends ConnectOptions<S, A, G>>(
  store: Store<S, A, G>,
  options: O = {} as O,
) {
  assertConnectOptions(options)
  //  装饰期早失败（口径同 Page/Component）
  if (!isProduction()) {
    validateMappingDeclarations(store, options, 'withAppStore')
  }
  const { stateMapping, gettersMapping } = resolveMappings(options)
  // globalData 冲突告警按「同一 globalData 对象只报一次」去重（布尔位会在宿主替换 globalData
  // 后永久关闭诊断；记录上次检查的引用，同一对象重入 onLaunch 不重复告警）
  let collisionCheckedGlobalData: Record<string, unknown> | undefined

  // WithPageThis 为 C 提供推断位点（保留自定义生命周期/字段），同时把顶层方法 this 重写为注入后的
  // 实例类型；M 位点用推断出的 O，写死时 AppThis 无法给出精确的 this 成员
  return function <C extends AppOptions>(AppConfig: WithPageThis<C, AppThis<S, A, G, O, C>> & ThisType<AppThis<S, A, G, O, C>>): C {
    //  / 三入口共用 copyConfigPreservingPrototype 保留原型——类实例 /
    // Object.create 组织的 App 配置，其原型上的生命周期/方法不能丢（展开只复制自有可枚举属性，
    // 会让 originalOnLaunch 变 undefined、用户启动逻辑静默不执行）；同时避免 Object.assign
    // 的 [[Set]] 在自有 "__proto__" 键上命中原型 setter。
    const enhancedConfig = copyConfigPreservingPrototype(AppConfig as object) as AppOptions

    const originalOnLaunch = enhancedConfig.onLaunch
    enhancedConfig.onLaunch = function (this: AppOptions, ...args: unknown[]) {
      if (this.globalData === undefined || this.globalData === null) {
        this.globalData = {}
      } else if (typeof this.globalData !== 'object' || Array.isArray(this.globalData)) {
        // onLaunch 位于 App 启动路径上，生产期不能让一处配置误用直接中断启动：
        // 开发期保持早失败；生产期经 onError 上报后以空对象兜底继续（用户 originalOnLaunch 仍会执行）
        const actual = Array.isArray(this.globalData) ? 'array' : typeof this.globalData
        if (!isProduction()) {
          throw new TypeError('[withAppStore] this.globalData must be an object')
        }
        const message =
          '[withAppStore] this.globalData 不是对象（实际为 ' + actual + '）：生产期已降级为空对象继续启动，请修正 App 配置（globalData 必须是普通对象）'
        store.hooks.emit('onError', new TallyStoreError(ErrorCode.INVALID_CONFIG, message, { actual }), 'mapping')
        this.globalData = {}
      }

      if (collisionCheckedGlobalData !== this.globalData) {
        // 检查成功后才记录引用：告警路径万一抛错，下一次 onLaunch 仍可重试诊断
        warnOnGlobalDataCollision(store, this.globalData, Object.keys(stateMapping), Object.keys(gettersMapping))
        collisionCheckedGlobalData = this.globalData
      }

      connectHost(store, options, this, {
        label: 'withAppStore',
        // 按自有属性写入：`Object.assign(globalData, ...)` 会让 `'__proto__'` 命中原型 setter
        write: (host, updates) => copyOwnEntries(host.globalData as Record<string, unknown>, updates),
        actionTarget: (host) => host as unknown as Record<string, unknown>,
      })

      originalOnLaunch?.call(this, ...args)
    }

    // 不在 onHide 中清理订阅：切后台/回前台在运行期内反复发生，清理且不重建会让状态同步永久失效
    // backgroundUpdates 默认开启时必须驱动可见性标志，否则 connectHost 创建的后台门控
    // 永远处于「可见」状态、该配置项静默无效。Page/Component/App 三入口共用
    // visibility 的 wrapVisibilityLifecycles（用户回调优先 / onShow 先切可见再跑回调）。
    if (options.backgroundUpdates !== false) {
      wrapVisibilityLifecycles(enhancedConfig, 'onHide', 'onShow')
    }

    return enhancedConfig as C
  }
}
