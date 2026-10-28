/** TallyStore - 微信小程序 Page / Component 集成 */

import type { Store, State, Actions, Getters } from '../types/store.js'
import type {
  ConnectOptions,
  PageThis,
  PageConfig,
  ComponentThis,
  ComponentConfig,
  ComponentOwnMethods,
  ExtractPageData,
  WithPageThis,
  WithComponentThis,
} from '../types/plugin.js'
import {
  assertConnectOptions,
  canOwnKey,
  COMPONENT_RESERVED_ACTIONS,
  copyConfigPreservingPrototype,
  defineOwnValue,
  type ErrorReportingStore,
  HOST_RESERVED_ACTIONS,
  validateMappingDeclarations,
} from './utils.js'
import { connectHost, disconnectHost } from './connect.js'
import { wrapVisibilityLifecycles } from './visibility.js'
import { isProduction } from '../core/store/utils.js'
import { TallyStoreError, ErrorCode } from '../core/errors/TallyStoreError.js'

export type { ConnectOptions } from '../types/plugin.js'
export type { Actions } from '../types/store.js'

// ==================== 类型定义 ====================

interface PageOptions {
  data?: Record<string, unknown>
  /** Skyline 页面实例由框架提供的渲染器标识（'skyline' | 'webview'） */
  renderer?: string
  setData?: (data: Record<string, unknown>, callback?: () => void) => void
  onLoad?(...args: unknown[]): void
  onUnload?(): void
  onShow?(...args: unknown[]): void
  onHide?(): void
  [key: string]: unknown
}

/** 页面实例类型：框架注入 setData 后，实例侧 setData 恒可用 */
type PageInstance = PageOptions & {
  setData: (data: Record<string, unknown>, callback?: () => void) => void
}

interface ComponentOptions {
  data?: Record<string, unknown>
  /** Skyline 组件实例由框架提供的渲染器标识（'skyline' | 'webview'） */
  renderer?: string
  methods?: Record<string, unknown>
  /** 组件生命周期（对应微信 Component 的 `lifetimes` 字段） */
  lifetimes?: {
    created?(): void
    attached?(): void
    ready?(): void
    moved?(): void
    detached?(): void
    error?(error: Error): void
  }
  /** 组件所在页面的生命周期（对应微信 Component 的 `pageLifetimes` 字段） */
  pageLifetimes?: {
    show?(): void
    hide?(): void
    resize?(res: { size: { windowWidth: number; windowHeight: number } }): void
  }
  setData?: (data: Record<string, unknown>, callback?: () => void) => void
  [key: string]: unknown
}

/** 组件实例类型：框架注入 setData 后，实例侧 setData 恒可用 */
type ComponentInstance = ComponentOptions & {
  setData: (data: Record<string, unknown>, callback?: () => void) => void
}

/** Skyline 页面/组件实例上的 renderer；'auto' 调度据此启用合并 */
function readRenderer<H>(host: H): 'skyline' | undefined {
  return (host as { renderer?: unknown } | null | undefined)?.renderer === 'skyline' ? 'skyline' : undefined
}

/**
 * 生命周期收尾的清理隔离：单个清理步骤抛错不得覆盖用户生命周期异常，
 * 也不得阻断后续清理步骤；清理错误经 onError（source 'unbind'）上报，开发期额外 console.warn。
 */
function runLifecycleCleanup(store: ErrorReportingStore, label: string, cleanup: () => void): void {
  try {
    cleanup()
  } catch (error) {
    if (!isProduction()) {
      console.warn('[' + label + '] 生命周期清理失败（已隔离，不影响用户生命周期异常与其它清理步骤）：', error)
    }
    try {
      store.hooks.emit('onError', error instanceof Error ? error : new Error(String(error)), 'unbind')
    } catch {
      // 上报通道异常不外溢
    }
  }
}

// ==================== Page 集成 ====================

/**
 * Page 混入函数：把 store 的 state / getters / actions 绑定到页面实例。
 * @param store - Store 实例
 * @param [options={}] - 连接选项
 * @returns Page 装饰器：入参为「方法 `this` 已注入」的配置，返回增强后的配置
 */
export function withPageStore<S extends State, A extends Actions, G extends Getters<S>, O extends ConnectOptions<S, A, G>>(
  store: Store<S, A, G>,
  options: O = {} as O,
) {
  assertConnectOptions(options)
  //  装饰期早失败：开发期在此抛出（早于页面注册）；生产期的剔除+上报统一走绑定期，避免双报
  if (!isProduction()) {
    validateMappingDeclarations(store, options, 'withPageStore')
  }
  return function <C extends PageOptions>(
    pageConfig: WithPageThis<C, PageThis<S, A, G, O>> & { data: object } & ThisType<PageThis<S, A, G, O>>,
  ): PageConfig<S, O, G> & Omit<C, 'data'> & { data: (C extends { data: infer D } ? D : object) & ExtractPageData<S, O, G> } {
    // 与 App 同口径保留原型（类实例/原型组织的 Page 配置生命周期不丢）
    const enhancedConfig = copyConfigPreservingPrototype(pageConfig as PageOptions)

    const originalOnLoad = enhancedConfig.onLoad
    enhancedConfig.onLoad = function (this: PageInstance, ...args: unknown[]) {
      // 解绑列表挂在实例上：同一 Page 配置可能有多个实例（页面栈里的同名页面），
      // 实例级存储避免互相清理订阅；重入 onLoad 时由 connectHost 先清理旧绑定
      connectHost(store, options, this, {
        label: 'withPageStore',
        write: (host, updates) => host.setData(updates),
        actionTarget: (host) => host as unknown as Record<string, unknown>,
        // Skyline 实例上有 renderer 属性：'auto' 只在 Skyline 下合并 setData
        readRenderer,
      })

      originalOnLoad?.call(this, ...args)
    }

    //  前后台策略信号：onHide/onShow 驱动宿主可见性标志（多 Store 共享同一标志）。
    // 顺序语义（用户回调先执行 / onShow 先切可见）由 visibility 的共用 helper 统一维护
    if (options.backgroundUpdates !== false) {
      wrapVisibilityLifecycles(enhancedConfig, 'onHide', 'onShow')
    }

    const originalOnUnload = enhancedConfig.onUnload
    enhancedConfig.onUnload = function (this: PageOptions) {
      let lifecycleError: unknown
      let hasLifecycleError = false
      try {
        // 用户卸载逻辑仍可调用映射的 actions、读取同步状态
        originalOnUnload?.call(this)
      } catch (error) {
        lifecycleError = error
        hasLifecycleError = true
      }
      // 清理单独隔离并上报——清理失败不能覆盖用户 onUnload 的原始异常
      runLifecycleCleanup(store, 'withPageStore', () => disconnectHost(this, store))
      if (hasLifecycleError) {
        throw lifecycleError
      }
    }

    return enhancedConfig as unknown as PageConfig<S, O, G> & Omit<C, 'data'> & { data: (C extends { data: infer D } ? D : object) & ExtractPageData<S, O, G> }
  }
}

// ==================== Component 集成 ====================

/** Component 集成只依赖的 Store 能力（结构类型，避免泛型耦合；错误通道复用共享契约） */
interface ComponentActionStore extends ErrorReportingStore {
  dispatch(actionName: string, ...args: unknown[]): unknown
}

/**
 * 单实例上已注入的 action 方法记录（detached / 重入 attached 时据此回放）：
 * - target='methods'：宿主提供实例 methods 命名空间（wrapper/测试宿主，旧路径）
 * - target='instance'：原生组件宿主——config.methods 由框架提升为实例顶层方法
 */
interface ComponentActionBinding {
  target: 'methods' | 'instance'
  /** 本次实际注入（经声明校验 + 宿主本地键占用校验后仍有效）的 action 本地名 */
  localNames: string[]
  /** target='methods'：本地名 → 注入前原方法（实例同名优先，其次配置同名） */
  shadowedMethods: Map<string, unknown>
  /** target='instance'：本地名 → 注入前的实例自有属性描述符（缺失表示原无该成员，解绑时删除） */
  shadowedProps: Map<string, PropertyDescriptor>
}

/** 宿主实例 → store → 本次注入的 action 方法（同一宿主可叠多个 store、同一配置可多实例，各自独立回放） */
const componentActionBindings = new WeakMap<object, Map<object, ComponentActionBinding>>()

/**
 * Component 路径复用 bindActions 的宿主保留成员清单——本地名遮蔽 setData/data/onLoad
 * 等框架成员时跳过该 action 并上报，与 withPageStore 口径一致，不生成幽灵方法。
 * 组件独有成员（triggerEvent / getRelationNodes / id / dataset / is 等）在
 * COMPONENT_RESERVED_ACTIONS 单独维护，不污染 Page/App 共用的 HOST_RESERVED_ACTIONS。
 * report=false 用于 attached 期对「有效映射」再次过滤（装饰期已上报过，避免双报）。
 */
function filterReservedActions(store: ComponentActionStore, actionsMapping: Record<string, string>, report: boolean): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [localName, actionName] of Object.entries(actionsMapping)) {
    if (!HOST_RESERVED_ACTIONS.has(localName) && !COMPONENT_RESERVED_ACTIONS.has(localName)) {
      result[localName] = actionName
      continue
    }
    if (!report) continue
    const message = '[withComponentStore] 本地名 "' + localName + '" 是宿主保留成员，已跳过 action "' + actionName + '" 的绑定；请改用其他本地名'
    store.hooks.emit('onError', new TallyStoreError(ErrorCode.INVALID_MAPPING, message, { localName, actionName }), 'bindActions')
    if (!isProduction()) {
      console.warn(message)
    }
  }
  return result
}

/** 生成绑定到 store.dispatch 的 action 方法（配置级 methods 与实例级绑定共用同一闭包形态） */
function createActionMethod(store: ComponentActionStore, actionName: string): (...args: unknown[]) => unknown {
  return (...args: unknown[]) => store.dispatch(actionName, ...args)
}

/** 从有效 actions 映射构建绑定到 store 的方法表（按自有属性写入，防 '__proto__' 命中原型 setter） */
function buildActionMethods(store: ComponentActionStore, actionsMapping: Record<string, string>): Record<string, (...args: unknown[]) => unknown> {
  const boundMethods: Record<string, (...args: unknown[]) => unknown> = {}
  for (const [localName, actionName] of Object.entries(actionsMapping)) {
    Object.defineProperty(boundMethods, localName, {
      value: createActionMethod(store, actionName),
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
  return boundMethods
}

/** 该值是否为本装饰器注入的 dispatch 闭包（框架会把 config.methods 提升/复制到实例成员上） */
function isInjectedActionMethod(declaredBoundMethods: Record<string, (...args: unknown[]) => unknown>, localName: string, value: unknown): boolean {
  return Object.prototype.hasOwnProperty.call(declaredBoundMethods, localName) && declaredBoundMethods[localName] === value
}

/** 记录本次注入（同一宿主多 store / 同一配置多实例各自独立回放） */
function recordComponentBinding(host: Record<string, unknown>, store: object, binding: ComponentActionBinding): void {
  let byStore = componentActionBindings.get(host)
  if (byStore === undefined) {
    byStore = new Map()
    componentActionBindings.set(host, byStore)
  }
  byStore.set(store, binding)
}

/** 按「解绑恢复原值」口径回放某 store 注入到宿主上的 action 方法（detached / 重入 attached 前置清理） */
function restoreComponentActions(store: object, host: Record<string, unknown>): void {
  const byStore = componentActionBindings.get(host)
  const binding = byStore?.get(store)
  if (byStore === undefined || binding === undefined) {
    return
  }
  byStore.delete(store)
  if (byStore.size === 0) {
    componentActionBindings.delete(host)
  }
  if (binding.target === 'methods') {
    const current = host.methods as Record<string, unknown> | undefined
    if (current === undefined) {
      return
    }
    // 实例级浅拷贝后写回：避免污染所有实例共用的配置级对象
    const methods = { ...current }
    for (const localName of binding.localNames) {
      if (binding.shadowedMethods.has(localName)) {
        Object.defineProperty(methods, localName, {
          value: binding.shadowedMethods.get(localName),
          writable: true,
          enumerable: true,
          configurable: true,
        })
      } else {
        delete methods[localName]
      }
    }
    host.methods = methods
    return
  }
  for (const localName of binding.localNames) {
    const original = binding.shadowedProps.get(localName)
    if (original !== undefined) {
      try {
        Object.defineProperty(host, localName, original)
      } catch {
        // 绑定后实例被冻结/属性被改为不可配置等极端情况：放弃回放，不阻断 detached 清理
      }
    } else {
      delete host[localName]
    }
  }
}

/**
 * 清除「claim 阶段被剔除、但已被框架从 config.methods 提升为实例成员」的注入闭包。
 *
 * 装饰期只做声明级校验；宿主 data 冲突 / 跨 store 本地键冲突要等 attached 的 claimLocalKeys
 * 才被剔除，这些本地名不在本次有效映射里。若不清掉，它们会作为幽灵方法活到 detached——
 * 调用仍走 store.dispatch，且 detached 时不会被移除（错误地保留 store 引用）。
 * 有配置级用户原方法时恢复用户方法，否则删除。
 */
function removeRejectedInjectedMethods(
  host: Record<string, unknown>,
  actionsMapping: Record<string, string>,
  declaredBoundMethods: Record<string, (...args: unknown[]) => unknown>,
  configShadowed: ReadonlyMap<string, unknown>,
): void {
  const existingMethods = host.methods
  if (existingMethods !== undefined && existingMethods !== null && typeof existingMethods === 'object') {
    const methods = { ...(existingMethods as Record<string, unknown>) }
    let changed = false
    for (const localName of Object.keys(declaredBoundMethods)) {
      if (Object.prototype.hasOwnProperty.call(actionsMapping, localName)) continue
      if (!isInjectedActionMethod(declaredBoundMethods, localName, methods[localName])) continue
      if (configShadowed.has(localName)) {
        methods[localName] = configShadowed.get(localName)
      } else {
        delete methods[localName]
      }
      changed = true
    }
    if (changed) {
      host.methods = methods
    }
    return
  }
  for (const localName of Object.keys(declaredBoundMethods)) {
    if (Object.prototype.hasOwnProperty.call(actionsMapping, localName)) continue
    if (!isInjectedActionMethod(declaredBoundMethods, localName, host[localName])) continue
    if (configShadowed.has(localName)) {
      defineOwnValue(host, localName, configShadowed.get(localName), Object.getOwnPropertyDescriptor(host, localName))
    } else {
      // 严格模式下 delete 不可配置属性会抛错：用 Reflect 语义「删不掉就保留」，不阻断 attached
      Reflect.deleteProperty(host, localName)
    }
  }
}

/**
 * 把「本次绑定实际生效的 actions 映射」注入宿主（attached 内、connectHost 之后）。
 *
 * 必须用 connectHost 返回的有效映射（声明校验 + 本地键占用校验后的结果），
 * 而不是装饰期的原始映射——否则生产期被剔除的非法/冲突键会留下调用即报错的幽灵方法。
 * 原生组件实例没有 this.methods（config.methods 被框架提升为实例顶层方法），
 * 因此两种宿主形态都支持：有 methods 命名空间则合并进 methods，否则绑定实例顶层并在 detached 回放。
 * 实例上与 declaredBoundMethods 同引用的是本装饰器注入的闭包而非用户原成员——
 * 既不能登记为「被遮蔽原值」，也不能在 detached 回放，否则 action 会一直存活（幽灵方法）。
 */
function applyComponentActions(
  store: ComponentActionStore,
  host: Record<string, unknown>,
  actionsMapping: Record<string, string>,
  configShadowed: ReadonlyMap<string, unknown>,
  declaredBoundMethods: Record<string, (...args: unknown[]) => unknown>,
): void {
  // 重入 attached：先还原本 store 上一轮注入，避免把自身注入的方法误登记成「被遮蔽」；
  // 只按 store 维度回放，同一宿主上其他 store 注入的方法不受影响
  restoreComponentActions(store as object, host)
  // 先清理 claim 阶段被剔除的注入闭包：即使有效映射为空也必须执行
  removeRejectedInjectedMethods(host, actionsMapping, declaredBoundMethods, configShadowed)
  if (Object.keys(actionsMapping).length === 0) {
    // 没有有效 action：不碰宿主方法（生产期非法/冲突映射被剔除后不留任何痕迹）
    return
  }
  const existingMethods = host.methods
  if (existingMethods !== undefined && existingMethods !== null && typeof existingMethods === 'object') {
    const methods = { ...(existingMethods as Record<string, unknown>) }
    const shadowedMethods = new Map<string, unknown>()
    for (const [localName, actionName] of Object.entries(actionsMapping)) {
      const hasInstanceOwn = Object.prototype.hasOwnProperty.call(methods, localName)
      if (hasInstanceOwn && !isInjectedActionMethod(declaredBoundMethods, localName, methods[localName])) {
        // 实例自带同名方法：优先按实例原值登记，detached 恢复
        shadowedMethods.set(localName, methods[localName])
      } else if (configShadowed.has(localName)) {
        // 实例上尚未体现配置级同名方法（或只是本装饰器注入的闭包）：按配置级原值登记，
        // 保持「detached 恢复被遮蔽成员」口径；不能把注入闭包当成用户原方法
        shadowedMethods.set(localName, configShadowed.get(localName))
      }
      defineOwnValue(methods, localName, createActionMethod(store, actionName), undefined)
    }
    host.methods = methods
    recordComponentBinding(host, store, { target: 'methods', localNames: Object.keys(actionsMapping), shadowedMethods, shadowedProps: new Map() })
    return
  }
  // 原生组件宿主：实例没有 methods 命名空间，框架已把 config.methods 提升为实例顶层方法，
  // 直接在顶层绑定并记录原成员，detached 时按原描述符/用户方法回放
  const shadowedProps = new Map<string, PropertyDescriptor>()
  const boundNames: string[] = []
  for (const [localName, actionName] of Object.entries(actionsMapping)) {
    if (!canOwnKey(host, localName)) {
      const message = '[withComponentStore] 实例成员 "' + localName + '" 不可重定义（非 configurable 且非 writable），已跳过 action "' + actionName + '" 的绑定'
      store.hooks.emit('onError', new TallyStoreError(ErrorCode.INVALID_MAPPING, message, { localName, actionName }), 'bindActions')
      if (!isProduction()) {
        console.warn(message)
      }
      continue
    }
    const original = Object.getOwnPropertyDescriptor(host, localName)
    const injected = original !== undefined && isInjectedActionMethod(declaredBoundMethods, localName, original.value)
    if (configShadowed.has(localName)) {
      // 配置级用户同名方法已在装饰期登记原值：解绑时按用户原方法回放
      shadowedProps.set(localName, { value: configShadowed.get(localName), writable: true, enumerable: true, configurable: true })
    } else if (original !== undefined && !injected) {
      // 框架提升上来的只是本装饰器注入的闭包时不算「用户原成员」，不登记 → detached 删除
      shadowedProps.set(localName, original)
    }
    defineOwnValue(host, localName, createActionMethod(store, actionName), original)
    boundNames.push(localName)
  }
  if (boundNames.length > 0) {
    recordComponentBinding(host, store, { target: 'instance', localNames: boundNames, shadowedMethods: new Map(), shadowedProps })
  }
}

/**
 * Component 混入函数：把 store 的 state / getters 绑定到组件 data、actions 合并进 methods。
 * @param store - Store 实例
 * @param [options={}] - 连接选项
 * @returns Component 装饰器：入参为「各命名空间内方法 `this` 已注入」的配置，返回增强后的配置
 */
export function withComponentStore<S extends State, A extends Actions, G extends Getters<S>, O extends ConnectOptions<S, A, G>>(
  store: Store<S, A, G>,
  options: O = {} as O,
): <C extends ComponentOptions>(
  // 外层声明必须与实现签名一致，否则命名空间级的 ThisType 不会生效
  componentConfig: WithComponentThis<C, ComponentThis<S, A, G, O, ComponentOwnMethods<C>>>,
) => ComponentConfig<S, A, G, O, ComponentOwnMethods<C>> &
  Omit<C, 'data' | 'methods'> & { data: (C extends { data: infer D } ? D : object) & ExtractPageData<S, O, G> } {
  assertConnectOptions(options)
  //  装饰期得到「净化后的声明映射」：开发期非法映射在此早失败；生产期静默剔除，
  // 上报统一留给 attached 的 connectHost（避免同一非法键被上报两次）。
  // 配置级 methods 只由净化后的映射构建，非法映射不产生幽灵方法；
  // 宿主保留成员本地名与 bindActions 同口径——装饰期跳过并上报，不进入配置级 methods
  const declaredValidation = isProduction()
    ? validateMappingDeclarations(store, options, 'withComponentStore', 'silent')
    : validateMappingDeclarations(store, options, 'withComponentStore')
  const declaredActionsMapping = filterReservedActions(store, declaredValidation.actionsMapping, true)
  const declaredBoundMethods = buildActionMethods(store, declaredActionsMapping)

  return function <C extends ComponentOptions>(
    componentConfig: WithComponentThis<C, ComponentThis<S, A, G, O, ComponentOwnMethods<C>>>,
  ): ComponentConfig<S, A, G, O, ComponentOwnMethods<C>> &
    Omit<C, 'data' | 'methods'> & { data: (C extends { data: infer D } ? D : object) & ExtractPageData<S, O, G> } {
    // 与 App/Page 同口径保留原型（class 组织的 Component 配置 lifetimes 不丢）
    const enhancedConfig: ComponentOptions = copyConfigPreservingPrototype(componentConfig as ComponentOptions)

    // action 本地名与组件自身 methods 同名时的遮蔽表（键 → 用户原方法）：
    // 配置级 methods 排在后覆盖同名方法，detached 时需按原值回放而非直接 delete。
    // 判定在配置级做一次，告警随之只刷一次；只登记「声明有效」的映射，非法映射不参与
    const shadowedMethods = new Map<string, unknown>()
    const configMethods = enhancedConfig.methods
    if (configMethods) {
      for (const [localName, actionName] of Object.entries(declaredActionsMapping)) {
        if (Object.prototype.hasOwnProperty.call(configMethods, localName)) {
          shadowedMethods.set(localName, configMethods[localName])
          if (!isProduction()) {
            console.warn(`[withComponentStore] 组件已有同名方法 "${localName}"，将被 action "${actionName}" 覆盖，detached 时恢复原值`)
          }
        }
      }
    }

    // 仅从 lifetimes 捕获原始 attached/detached：基础库 3.15.0+ 只支持 lifetimes 写法
    const originalLifetimes = enhancedConfig.lifetimes || {}
    const originalAttached = originalLifetimes.attached
    const originalDetached = originalLifetimes.detached
    enhancedConfig.lifetimes = {
      ...originalLifetimes,
      attached: function (this: ComponentInstance) {
        // 解绑列表挂实例；重入 attached 时由 connectHost 先清理旧订阅。
        // connectHost 返回本次实际生效的映射（声明校验 + 宿主本地键占用校验后的结果），
        // methods 只按它合并：生产期被剔除的非法/冲突 action 不产生幽灵方法。
        // 保留名二次过滤静默执行（装饰期已上报过，避免双报）
        const { actionsMapping } = connectHost(store, options, this, {
          label: 'withComponentStore',
          write: (host, updates) => host.setData(updates),
          readRenderer,
        })
        applyComponentActions(
          store,
          this as unknown as Record<string, unknown>,
          filterReservedActions(store, actionsMapping, false),
          shadowedMethods,
          declaredBoundMethods,
        )

        originalAttached?.call(this)
      },

      detached: function (this: ComponentInstance) {
        let lifecycleError: unknown
        let hasLifecycleError = false
        try {
          // 与 Page 一致：用户生命周期结束前保留绑定
          originalDetached?.call(this)
        } catch (error) {
          lifecycleError = error
          hasLifecycleError = true
        }
        // 两步清理各自隔离——disconnectHost 抛错不得跳过方法回放，
        // 清理错误也不得覆盖用户 detached 的原始异常（经 onError 上报）
        runLifecycleCleanup(store, 'withComponentStore', () => disconnectHost(this, store))
        runLifecycleCleanup(store, 'withComponentStore', () => restoreComponentActions(store, this as unknown as Record<string, unknown>))
        if (hasLifecycleError) {
          throw lifecycleError
        }
      },
    }

    //  前后台策略信号：组件所在页面的 hide/show 走 pageLifetimes（多 Store 共享同一标志）。
    // 先实例级浅拷贝再包装，顺序语义由 visibility 的共用 helper 统一维护
    if (options.backgroundUpdates !== false) {
      enhancedConfig.pageLifetimes = { ...(enhancedConfig.pageLifetimes || {}) }
      wrapVisibilityLifecycles(enhancedConfig.pageLifetimes, 'hide', 'show')
    }

    // 声明有效的 action 绑定排在后：覆盖组件同名方法，同名情况已在上面登记并告警。
    // 生产期非法映射已从 declaredActionsMapping 剔除，不会在这里生成幽灵方法
    enhancedConfig.methods = {
      ...componentConfig.methods,
      ...declaredBoundMethods,
    }

    return enhancedConfig as unknown as ComponentConfig<S, A, G, O, ComponentOwnMethods<C>> &
      Omit<C, 'data' | 'methods'> & { data: (C extends { data: infer D } ? D : object) & ExtractPageData<S, O, G> }
  }
}
