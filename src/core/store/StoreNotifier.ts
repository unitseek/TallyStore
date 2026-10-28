/** StoreNotifier - 订阅注册 + 脏键记账 + 通知调度的唯一实现 */

import type { State, StateListener, SubscriberLimitPolicy } from '../../types/store.js'
import { deepCloneState, isProduction } from './utils.js'

/** 订阅者被驱逐时交给宿主的信息 */
export interface SubscriberEvictionInfo<S extends State = State> {
  listener: StateListener<S>
  maxSubscribers: number
  size: number
}

export interface StoreNotifierOptions<S extends State = State> {
  storeName: string
  maxSubscribers?: number
  onLimit?: SubscriberLimitPolicy
  /** notify.clone：无条件深拷贝载荷 */
  notifyClone: boolean
  /** notify.async：同一 tick 合并为一次微任务通知 */
  notifyAsync: boolean
  /** notify.onlyOnChange：无变更时不通知 */
  notifyOnlyOnChange: boolean
  /** 构造通知载荷：needsClone 为 true 时可直接返回活状态；逐注册隔离由 _dispatch 深拷贝保证 */
  buildPayload: (needsClone: boolean) => S
  onListenerError?: (error: unknown) => void
  onSubscriberEvicted?: (info: SubscriberEvictionInfo<S>) => void
  /** 异步通知链路自身抛错（监听器异常除外） */
  onAsyncNotifyError?: (error: unknown) => void
  /** 一轮通知分发完成（指标钩子；无监听者时零开销） */
  onNotified?: (listeners: number) => void
}

/**
 * 通知中枢。
 *
 * 不变量：
 * - 同一函数注册 N 次通知 N 次，任一份退订只减一。
 * - 本轮通知的监听器集合是进入 notify 时的快照；回调内退订不影响本轮。
 * - 单个监听器抛错不中断其余监听器，异常交宿主上报通道。
 * - 通知后清空脏键；通知期间重入写入的脏键留给下一轮。
 */
export class StoreNotifier<S extends State = State> {
  /** 缺省订阅者上限（maxSubscribers 非有限值时的回落值） */
  static readonly DEFAULT_MAX_SUBSCRIBERS = 50

  private readonly _storeName: string
  private readonly _maxSubscribers: number
  private readonly _onLimit: SubscriberLimitPolicy
  private readonly _notifyClone: boolean
  private readonly _notifyAsync: boolean
  private readonly _notifyOnlyOnChange: boolean
  private readonly _buildPayload: (needsClone: boolean) => S
  private readonly _onListenerError?: (error: unknown) => void
  private readonly _onSubscriberEvicted?: (info: SubscriberEvictionInfo<S>) => void
  private readonly _onAsyncNotifyError?: (error: unknown) => void
  private readonly _onNotified?: (listeners: number) => void

  /** 监听器 → 每份注册的 readOnly 标记 */
  private readonly _listeners: Map<StateListener<S>, { registrations: Map<object, boolean> }> = new Map()
  private _writableCount = 0
  private _totalCount = 0

  private _mutationCount = 0
  private _lastNotifiedMutationCount = 0
  private _batchBaseline = 0
  private _dirtyKeys = new Set<keyof S>()
  /** 通知期间新产生的脏键：不能随本轮收尾清空，否则下一轮会被当成「未变化」跳过 */
  private _deferredDirtyKeys = new Set<keyof S>()
  private _notifying = false
  private _asyncPending = false
  private _destroyed = false

  constructor(options: StoreNotifierOptions<S>) {
    this._storeName = options.storeName
    const requested = options.maxSubscribers ?? StoreNotifier.DEFAULT_MAX_SUBSCRIBERS
    if (!Number.isFinite(requested)) {
      if (!isProduction()) {
        console.warn(
          '[TallyStore][' +
            this._storeName +
            '] maxSubscribers=' +
            String(requested) +
            ' 不是有效的订阅者上限（需为有限数），已回退默认 ' +
            StoreNotifier.DEFAULT_MAX_SUBSCRIBERS,
        )
      }
      this._maxSubscribers = StoreNotifier.DEFAULT_MAX_SUBSCRIBERS
    } else {
      // <=0 的上限会让每次 subscribe 都触发驱逐/抛错；有效上限至少为 1
      this._maxSubscribers = Math.max(1, Math.floor(requested))
    }
    this._onLimit = options.onLimit ?? 'evict-oldest'
    this._notifyClone = options.notifyClone
    this._notifyAsync = options.notifyAsync
    this._notifyOnlyOnChange = options.notifyOnlyOnChange
    this._buildPayload = options.buildPayload
    this._onListenerError = options.onListenerError
    this._onSubscriberEvicted = options.onSubscriberEvicted
    this._onAsyncNotifyError = options.onAsyncNotifyError
    this._onNotified = options.onNotified
  }

  // ==================== 订阅 ====================

  get size(): number {
    return this._totalCount
  }

  hasWritableListeners(): boolean {
    return this._writableCount > 0
  }

  /** 注册监听器，返回幂等的退订函数 */
  subscribe(listener: StateListener<S>, options?: { readOnly?: boolean }): () => void {
    const registration = this.add(listener, options)
    let consumed = false
    return () => {
      if (consumed) return
      consumed = true
      this.delete(listener, registration)
    }
  }

  private add(listener: StateListener<S>, options?: { readOnly?: boolean }): object {
    if (this._destroyed) {
      throw new Error('[TallyStore] Cannot call subscribe on a destroyed Store')
    }
    const registration = {}
    const readOnly = options?.readOnly === true
    if (this._totalCount >= this._maxSubscribers) {
      this._enforceLimit(listener)
    }
    const existing = this._listeners.get(listener)
    if (existing !== undefined) {
      existing.registrations.set(registration, readOnly)
    } else {
      this._listeners.set(listener, { registrations: new Map([[registration, readOnly]]) })
    }
    this._totalCount += 1
    if (!readOnly) this._writableCount += 1
    return registration
  }

  private delete(listener: StateListener<S>, registration?: object): boolean {
    const entry = this._listeners.get(listener)
    if (entry === undefined) return false
    const token = registration ?? entry.registrations.keys().next().value
    if (token === undefined || !entry.registrations.has(token)) return false
    const readOnly = entry.registrations.get(token) === true
    entry.registrations.delete(token)
    this._totalCount -= 1
    if (!readOnly) this._writableCount -= 1
    if (entry.registrations.size === 0) this._listeners.delete(listener)
    return true
  }

  private _enforceLimit(listener: StateListener<S>): void {
    if (this._onLimit === 'throw') {
      throw new Error(
        '[TallyStore][' +
          this._storeName +
          '] Subscriber limit reached (' +
          this._maxSubscribers +
          '). Unsubscribe unused listeners or increase maxSubscribers.',
      )
    }
    const selfDuplicated = this._listeners.has(listener)
    // 调用前提：totalCount >= maxSubscribers 且 maxSubscribers >= 1（构造期已收敛），监听器表必然非空
    const evicted = (selfDuplicated ? listener : this._listeners.keys().next().value) as StateListener<S>
    if (!isProduction()) {
      // 嵌套 ternary 拆平：告警文案分支多，平铺更易读
      const detail = selfDuplicated
        ? '，本次重复订阅改由该监听器自己最早的一份注册让位'
        : '，已驱逐最早的监听器 ' + (evicted.name || '(匿名函数)') + ' 的一份注册'
      console.warn('[TallyStore][' + this._storeName + '] 订阅者数量已达到上限(' + this._maxSubscribers + ')' + detail)
    }
    this.delete(evicted)
    this._reportEviction(evicted)
  }

  private _reportEviction(listener: StateListener<S>): void {
    const reporter = this._onSubscriberEvicted
    if (!reporter) return
    try {
      reporter({ listener, maxSubscribers: this._maxSubscribers, size: this._totalCount })
    } catch (reportError) {
      if (!isProduction()) console.error('[TallyStore] Error in subscriber eviction reporter:', reportError)
    }
  }

  // ==================== 变更记账 ====================

  get mutationCount(): number {
    return this._mutationCount
  }

  get lastNotifiedMutationCount(): number {
    return this._lastNotifiedMutationCount
  }

  bumpMutation(): number {
    this._mutationCount += 1
    return this._mutationCount
  }

  markDirty(keys: Iterable<string | number | symbol>): void {
    for (const key of keys) {
      this._dirtyKeys.add(this._normalizeKey(key))
      if (this._notifying) this._deferredDirtyKeys.add(this._normalizeKey(key))
    }
  }

  isDirty(key: string | symbol): boolean {
    return this._dirtyKeys.has(this._normalizeKey(key))
  }

  private _normalizeKey(key: string | symbol | number): keyof S {
    return (typeof key === 'number' ? String(key) : key) as keyof S
  }

  // ==================== 批 / 通知 ====================

  noteBatchBaseline(): void {
    this._batchBaseline = this._mutationCount
  }

  shouldNotifyAfterBatch(): boolean {
    return !(this._notifyOnlyOnChange && this._mutationCount <= this._batchBaseline)
  }

  /** 请求一次通知：同步模式立即通知，异步模式同一 tick 合并 */
  requestNotify(): void {
    if (!this._notifyAsync) {
      this.notifyNow()
      return
    }
    if (this._asyncPending) return
    this._asyncPending = true
    Promise.resolve().then(() => {
      this._asyncPending = false
      if (this._destroyed) return
      try {
        this.notifyNow()
      } catch (error) {
        // 无上报通道时不能静默；上报通道自身抛错也不能变成 unhandled rejection
        try {
          if (this._onAsyncNotifyError) {
            this._onAsyncNotifyError(error)
          } else {
            console.error('[TallyStore] Error in async notify:', error)
          }
        } catch (reportError) {
          console.error('[TallyStore] Error in async notify error reporter:', reportError)
        }
      }
    })
  }

  /** 立即通知全部监听器 */
  notifyNow(): void {
    if (this._destroyed) return
    const needsClone = this._notifyClone || this.hasWritableListeners()
    const payload = this._buildPayload(needsClone)
    const reentrant = this._notifying
    if (reentrant) {
      for (const key of this._deferredDirtyKeys) this._dirtyKeys.add(key)
      this._deferredDirtyKeys.clear()
    }
    this._notifying = true
    try {
      this._dispatch(payload, needsClone)
    } finally {
      this._notifying = reentrant
    }
    this._lastNotifiedMutationCount = this._mutationCount
    if (!reentrant) {
      this._dirtyKeys = this._deferredDirtyKeys
      this._deferredDirtyKeys = new Set()
    }
    // 指标：一轮通知完成（最外层）。无订阅者时 listeners 为 0 也计入（有效写入信号）
    if (!reentrant) {
      this._onNotified?.(this._totalCount)
    }
  }

  /** 按注册次数展开并发通知；可写注册各拿一份独立深拷贝，只读注册共享一份 */
  private _dispatch(state: S, cloneOnNotify: boolean): void {
    if (this._listeners.size === 0) return
    const hasReadOnlyRegistration = this._writableCount < this._totalCount
    const sharedPayload: S = cloneOnNotify && hasReadOnlyRegistration ? deepCloneState(state) : state
    const listeners: Array<StateListener<S>> = []
    const payloads: S[] = []
    this._listeners.forEach((entry, listener) => {
      for (const readOnly of entry.registrations.values()) {
        listeners.push(listener)
        payloads.push(cloneOnNotify && !readOnly ? deepCloneState(state) : sharedPayload)
      }
    })
    for (let i = 0; i < listeners.length; i++) {
      try {
        listeners[i](payloads[i])
      } catch (error) {
        if (!isProduction()) console.error('[TallyStore] Error in state listener:', error)
        this._reportListenerError(error)
      }
    }
  }

  private _reportListenerError(error: unknown): void {
    const reporter = this._onListenerError
    if (!reporter) return
    try {
      reporter(error)
    } catch (reportError) {
      if (!isProduction()) console.error('[TallyStore] Error in listener error reporter:', reportError)
    }
  }

  /** 清空监听器与待发通知（Store.destroy 调用） */
  destroy(): void {
    this._listeners.clear()
    this._writableCount = 0
    this._totalCount = 0
    this._destroyed = true
    this._asyncPending = false
    this._dirtyKeys.clear()
    this._deferredDirtyKeys.clear()
  }
}
