/** ActionManager - Action / Getter 执行器 */

import { type State, type Actions, type InferActionArgs, type InferActionReturn, type ActionContextBase } from '../../types/store.js'
import { TallyStoreError, ErrorCode } from '../errors/TallyStoreError.js'
import type { IHookSystem } from '../../types/plugin.js'

/** Action 执行器配置 */
export interface ActionManagerOptions {
  storeName: string
  withInternalAccess: <T>(fn: () => T) => T
  setDispatching: (value: boolean) => void
  notifyListeners: () => void
  hooks: IHookSystem
  /** 仅在状态实际变化时通知（默认 false） */
  notifyOnlyOnChange?: boolean
  /** 状态变更计数读取器（onlyOnChange 必填；其余场景用于异步段补发判定） */
  getMutationCount?: () => number
  /** 最近一次通知已覆盖的变更计数（异步 settle 补发去重用） */
  getLastNotifiedMutationCount?: () => number
  /** 是否处于批量更新中（批收尾统一通知） */
  isInBatch?: () => boolean
}

/** Action 执行器 */
export class ActionManager<S extends State = State, A extends Actions = Actions> {
  private readonly _storeName: string
  private readonly _withInternalAccess: <T>(fn: () => T) => T
  private readonly _setDispatching: (value: boolean) => void
  private readonly _notifyListeners: () => void
  private _hooks: IHookSystem
  private _actions: A | null = null
  /** 绑定后的 action 表用空原型：__proto__ 等键名不会命中原型 setter */
  private _boundActions: Record<string, (...args: unknown[]) => unknown> = Object.create(null) as Record<string, (...args: unknown[]) => unknown>
  /** 未经包装的原始 action 函数表：execute 直接调用，避免经过 boundActions 再进 execute 造成递归 */
  private _rawActions: Record<string, (...args: unknown[]) => unknown> = Object.create(null) as Record<string, (...args: unknown[]) => unknown>
  /** 嵌套 dispatch 深度：内层结束不得复位外层的 dispatching 状态 */
  private _dispatchDepth = 0
  /** action 调用上下文代理（initialize 时创建；execute 与直接调用共用同一实例） */
  private _actionContext: object | undefined
  /** 「仅在状态实际变化时通知」的判据源 */
  private readonly _mutationGate?: () => number
  private readonly _getMutationCount?: () => number
  private readonly _getLastNotifiedMutationCount?: () => number
  private readonly _isInBatch?: () => boolean
  /** 由 execute 层产生的本库错误（ACTION_NOT_FOUND / 包装后的 ACTION_EXECUTION_ERROR）：嵌套层原样上抛 */
  private readonly _dispatchErrors = new WeakSet<object>()
  /** 已上报过的错误：嵌套 dispatch 只上报一次，避免逐层重复 */
  private readonly _reportedErrors = new WeakSet<object>()

  constructor(options: ActionManagerOptions) {
    this._storeName = options.storeName
    this._withInternalAccess = options.withInternalAccess
    this._setDispatching = options.setDispatching
    this._notifyListeners = options.notifyListeners
    this._hooks = options.hooks
    // 早失败：计数恒 0 的兜底会让每次 dispatch 的通知被静默丢弃，症状远离误用点
    if (options.notifyOnlyOnChange && options.getMutationCount === undefined) {
      throw new TypeError('[TallyStore] ActionManager: getMutationCount is required when notifyOnlyOnChange is enabled')
    }
    // settle 侧去重依赖 lastNotified 计数；缺失时基线回落 -1 会使每次异步 action 重复通知
    if (options.notifyOnlyOnChange && options.getLastNotifiedMutationCount === undefined) {
      throw new TypeError('[TallyStore] ActionManager: getLastNotifiedMutationCount is required when notifyOnlyOnChange is enabled')
    }
    this._mutationGate = options.notifyOnlyOnChange ? options.getMutationCount : undefined
    this._getMutationCount = options.getMutationCount
    this._getLastNotifiedMutationCount = options.getLastNotifiedMutationCount
    this._isInBatch = options.isInBatch
  }

  /** 当前 dispatch 嵌套深度（Store 批收尾守卫使用） */
  get dispatchDepth(): number {
    return this._dispatchDepth
  }

  /** Actions 对象；initialize() 之前返回空对象 */
  get actions(): A {
    return this._actions ?? ({} as A)
  }

  /** 初始化 Actions */
  initialize(actions: A | undefined, contextBase: ActionContextBase<S>): void {
    const actionObj = (actions || {}) as Record<string, (...args: unknown[]) => unknown>
    // 重复 initialize 时旧 raw 表整体丢弃：stale 键虽被 _boundActions 的存在性守卫挡住，
    // 但残留引用会让旧 action 函数与其闭包状态永不可回收
    const rawActions: Record<string, (...args: unknown[]) => unknown> = Object.create(null) as Record<string, (...args: unknown[]) => unknown>
    const boundActions: Record<string, (...args: unknown[]) => unknown> = Object.create(null) as Record<string, (...args: unknown[]) => unknown>

    // this.actionName() 与 'actionName' in this 都必须命中绑定表；
    // symbol 一律透传，保证 Symbol.toStringTag / iterator 等协议在 action 体内可用
    const actionContext = new Proxy(contextBase as unknown as Record<string, unknown>, {
      get(target: Record<string, unknown>, prop: string | symbol) {
        if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(boundActions, prop)) {
          return boundActions[prop]
        }
        return (target as Record<string | symbol, unknown>)[prop]
      },
      has(target: Record<string, unknown>, prop: string | symbol) {
        if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(boundActions, prop)) {
          return true
        }
        return prop in target
      },
    })

    Object.keys(actionObj).forEach((key) => {
      const originalAction = actionObj[key]
      rawActions[key] = originalAction
      // 绑定表（对外暴露的 store.actions）走 execute：直接调用与 dispatch 共享同一事务语义
      // （通知抑制/收尾补发、错误包装与上报、钩子）， 要求两种调用方式行为一致
      boundActions[key] = (...args: unknown[]) => this.execute(key, ...args)
    })

    this._actionContext = actionContext
    this._rawActions = rawActions
    this._boundActions = boundActions
    this._actions = boundActions as unknown as A
  }

  /** 执行 Action */
  execute<K extends keyof A>(actionName: K, ...args: InferActionArgs<A, K>): InferActionReturn<A, K>
  execute(actionName: string, ...args: unknown[]): unknown
  execute(actionName: string | keyof A, ...args: unknown[]): unknown {
    const name = actionName as string
    // own property 判定：in 会命中原型链，dispatch('toString') 会调用到继承方法
    if (!Object.prototype.hasOwnProperty.call(this._boundActions, name)) {
      const notFound = new TallyStoreError(ErrorCode.ACTION_NOT_FOUND, 'Action "' + name + '" not found in store "' + this._storeName + '"', {
        storeName: this._storeName,
        actionName: name,
        availableActions: Object.keys(this._boundActions),
      })
      // 标记「由 dispatch 层产生」：外层嵌套捕获时原样上抛，而不是再包一层 ACTION_EXECUTION_ERROR
      this._markDispatchError(notFound)
      throw notFound
    }

    // 基线必须在进入 dispatch 之前采集：dispatch 期间通知被抑制，beforeDispatch 钩子里的
    // 写入同属本次事务，基线晚采会把钩子写入当成「无变化」而永久丢通知
    let mutationsBefore = 0
    try {
      mutationsBefore = this._getMutationCount ? this._getMutationCount() : 0
    } catch (error) {
      this._reportSettledFailure(error)
    }

    this._enterDispatch()
    let result: unknown
    try {
      // 钩子与 action 同属 dispatch 事务：emit 在 try 外时钩子抛错会让 depth 永不递减，
      // 此后该 Store 的所有通知都被守卫吞掉
      this._hooks.emit('beforeDispatch', name, args)
      result = this._withInternalAccess(() => this._rawActions[name].call(this._actionContext, ...args))
    } catch (error) {
      this._exitDispatch()
      // 嵌套 dispatch 产生的错误已由内层上报过：外层不重复上报；
      // 用户 action / beforeDispatch 钩子抛出的首见错误照常上报一次
      if (!this._isReportedError(error)) {
        this._reportSettledFailure(error, 'dispatch')
        this._markReportedError(error)
      }
      // action 抛错前的写入同样要补发，否则「先置 loading 再失败」的中间态永久不可见
      this._settleAfterDispatch(mutationsBefore)
      // 只有「由 execute 层产生的本库错误」（嵌套 ACTION_NOT_FOUND / 内层包装产物）才原样上抛；
      // 用户代码抛出的 TallyStoreError 仍按稳定契约包装为 ACTION_EXECUTION_ERROR
      if (error instanceof TallyStoreError && this._isDispatchError(error)) {
        throw error
      }
      const wrapped = new TallyStoreError(
        ErrorCode.ACTION_EXECUTION_ERROR,
        'Action "' + name + '" execution failed',
        { storeName: this._storeName, actionName: name, args },
        error,
      )
      // 包装产物视为 dispatch 层错误且已上报：外层嵌套不再重复包装/上报
      this._markDispatchError(wrapped)
      this._markReportedError(wrapped)
      throw wrapped
    }

    // action 已成功返回：此后收尾失败不得再走一遍 _exitDispatch（嵌套下会多减一层）
    this._exitDispatch()
    try {
      this._hooks.emit('afterDispatch', name, args, result)
    } catch (error) {
      this._reportSettledFailure(error)
    }

    // 异步 action 在两个时点补发通知：同步段结束时（promise 可能永不 settle）与 settle 时
    // （覆盖 await 之后的续段写入；裸写不可计数，默认模式宁多勿漏，onlyOnChange 按计数去重）
    const onSettled = (): void => {
      this._settleAfterDispatch(this._lastNotifiedBaseline(-1))
    }
    // 鸭子类型判定 thenable：instanceof Promise 对另一份 realm / bundle 的 Promise 会判假。
    // then 的读取与调用都可能同步抛错（getter / 恶意 thenable），必须归一到 onError + settle 补发，
    // 不能让原始异常在 _exitDispatch/afterDispatch 之后裸逃逸
    let thenFn: unknown
    if (result !== null && typeof result === 'object') {
      try {
        thenFn = (result as { then?: unknown }).then
      } catch (error) {
        this._reportSettledFailure(error, 'dispatch')
        this._settleAfterDispatch(mutationsBefore)
        return result
      }
    }
    if (typeof thenFn === 'function') {
      this._flushAfterSyncSegment(mutationsBefore)
      // 拒绝分支两步都不抛错：onError 处理器抛错时通知照常补发，且一次失败只报一次。
      // 恶意 thenable 可能先同步调用回调再抛错：settleOnce 保证 settle 补发只发生一次
      let settleCalled = false
      const settleOnce = (): void => {
        if (settleCalled) return
        settleCalled = true
        onSettled()
      }
      let settled: PromiseLike<unknown>
      try {
        settled = (thenFn as (onFulfilled: () => void, onRejected: (error: unknown) => void) => PromiseLike<unknown>).call(
          result,
          settleOnce,
          (error: unknown) => {
            this._reportSettledFailure(error)
            settleOnce()
          },
        )
      } catch (error) {
        this._reportSettledFailure(error, 'dispatch')
        settleOnce()
        return result
      }
      // 终端闸门：自定义 thenable 可能返回已 rejected 的 promise，不接就是 unhandledRejection
      Promise.resolve(settled).catch((error) => {
        this._reportSettledFailure(error)
      })
      return result
    }

    try {
      if (this._shouldNotifyNow(mutationsBefore)) {
        this._notifyListeners()
      }
    } catch (error) {
      this._reportSettledFailure(error)
    }
    return result
  }

  /** 本次 dispatch 收尾是否应补发通知（各收尾点共用同一判据） */
  private _shouldNotifyNow(baseline: number): boolean {
    return this._dispatchDepth === 0 && !this._isInBatch?.() && (!this._mutationGate || this._mutationGate() > baseline)
  }

  /** 读取「最近一次通知已覆盖的计数」作为收尾基线 */
  private _lastNotifiedBaseline(fallback: number): number {
    try {
      return this._getLastNotifiedMutationCount?.() ?? fallback
    } catch (error) {
      this._reportSettledFailure(error)
      return fallback
    }
  }

  /** 异步 action 同步段的兜底补发：promise 永不 settle 时同步段写入也要可见 */
  private _flushAfterSyncSegment(mutationsBefore: number): void {
    if (!this._mutationGate && !this._getMutationCount) {
      // 非 Store 消费方两个计数源都不传：其宿主没有 dispatch 抑制，同步段写入当场已通知
      return
    }
    try {
      const baseline = this._mutationGate ? this._lastNotifiedBaseline(mutationsBefore) : mutationsBefore
      if (!this._mutationGate && this._getMutationCount && this._getMutationCount() <= mutationsBefore) {
        return
      }
      if (!this._shouldNotifyNow(baseline)) {
        return
      }
      this._notifyListeners()
    } catch (error) {
      this._reportSettledFailure(error)
    }
  }

  /** dispatch 收尾：按需补发一次通知 */
  private _settleAfterDispatch(baseline: number): void {
    try {
      if (this._shouldNotifyNow(baseline)) {
        this._notifyListeners()
      }
    } catch (error) {
      this._reportSettledFailure(error)
    }
  }

  // 调用点保证传入的一定是 TallyStoreError 对象（ACTION_NOT_FOUND / 包装产物），无需再做类型分支
  private _markDispatchError(error: object): void {
    this._dispatchErrors.add(error)
  }

  private _isDispatchError(error: object): boolean {
    return this._dispatchErrors.has(error)
  }

  private _markReportedError(error: unknown): void {
    if (typeof error === 'object' && error !== null) {
      this._reportedErrors.add(error)
    }
  }

  private _isReportedError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && this._reportedErrors.has(error)
  }

  /** 收尾链路自身抛错的兜底上报：先走 onError 钩子，钩子也失败退回 console.error */
  private _reportSettledFailure(error: unknown, source?: string): void {
    try {
      if (source === undefined) {
        this._hooks.emit('onError', error)
      } else {
        this._hooks.emit('onError', error, source)
      }
    } catch {
      console.error('[TallyStore] Error while reporting action settle failure:', error)
    }
  }

  /** 进入 dispatch：深度加一，共享 dispatching 状态 */
  private _enterDispatch(): void {
    this._dispatchDepth++
    this._setDispatching(true)
  }

  /** 退出 dispatch：深度减一，仅最外层结束时复位 dispatching 状态 */
  private _exitDispatch(): void {
    if (this._dispatchDepth > 0) {
      this._dispatchDepth--
    }
    this._setDispatching(this._dispatchDepth > 0)
  }
}

/** Getter 执行器 */
export class GetterManager<S extends State = State, G extends Record<string, (state: S) => unknown> = Record<string, (state: S) => unknown>> {
  private readonly _storeName: string
  private readonly _getState: () => S
  private _getters: G | null = null

  constructor(storeName: string, getState: () => S) {
    this._storeName = storeName
    this._getState = getState
  }

  /** 初始化 Getters */
  initialize(getters: G | undefined): void {
    this._getters = (getters || {}) as G
  }

  /** 已声明的 getter 名列表（映射校验用） */
  names(): string[] {
    return this._getters ? Object.keys(this._getters) : []
  }

  /** 执行 Getter */
  execute<K extends keyof G>(getterName: K): G[K] extends (state: S) => infer R ? R : unknown
  execute(getterName: string): unknown
  execute(getterName: string | keyof G): unknown {
    const name = getterName as string
    // own property 判定：in 会命中原型链，getter('toString') 会静默调用继承方法
    if (!this._getters || !Object.prototype.hasOwnProperty.call(this._getters, name)) {
      throw new TallyStoreError(ErrorCode.GETTER_NOT_FOUND, 'Getter "' + name + '" not found in store "' + this._storeName + '"', {
        storeName: this._storeName,
        getterName: name,
        availableGetters: this._getters ? Object.keys(this._getters) : [],
      })
    }

    try {
      // getter 拿到的是 Store 传入的状态代理（只读保护），不在内部访问模式下执行
      return (this._getters as Record<string, (state: S) => unknown>)[name](this._getState())
    } catch (error) {
      throw new TallyStoreError(
        ErrorCode.GETTER_EXECUTION_ERROR,
        'Getter "' + name + '" execution failed',
        { storeName: this._storeName, getterName: name },
        error,
      )
    }
  }
}
