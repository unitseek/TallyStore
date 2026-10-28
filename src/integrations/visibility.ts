/**
 * 前后台更新策略：页面进入后台后映射写入不下发宿主，只累积脏键；
 * 回前台按**最新状态**一次性对齐（不重放历史中间态）。
 *
 * 设计要点：
 * - 可见性状态按宿主实例存储（WeakMap，见 visibilityOf）：同一 Page 配置可有多个实例，实例级互不干扰；
 *   多个 Store 绑定同一实例时共享同一标志（页面的可见性是宿主属性，不是绑定属性）。
 * - 「信号可靠才生效」：只有宿主真正调用了包装后的 onHide / onShow 才会切换标志——
 *   信号缺失（宿主未走生命周期）时标志恒为可见，行为回退为立即更新，不丢更新。
 * - 后台期间 writer 的写入转入 pendingBackground 合并（最新值覆盖旧值）；
 *   onShow 时优先重跑映射求值（拿最新状态，等价于全量对齐），pending 仅作兜底。
 * - 可关闭：ConnectOptions.backgroundUpdates = false 时跳过整个门控（立即更新）。
 */

/** 宿主实例上的可见性标志与已注册的对齐回调列表（多 Store 各注册一份） */
export interface HostVisibilityState {
  hidden: boolean
  /** 回前台对齐回调：每个绑定注册一个，onShow 时逐个调用 */
  revealCallbacks: Array<() => void>
}

/**
 * 宿主实例 → 可见性状态。用 WeakMap 而不是在宿主上挂 `__tallyVisibility` 属性——
 * 不依赖宿主可扩展（冻结/seal 实例不抛错）、不与业务同名属性冲突，状态随宿主一起回收；
 * 多 Store 绑定同一实例时共享同一 WeakMap 条目（页面的可见性是宿主属性，不是绑定属性）。
 */
const hostVisibilityStates = new WeakMap<object, HostVisibilityState>()

/** 读取（或初始化）宿主的可见性状态 */
export function visibilityOf(host: object): HostVisibilityState {
  let state = hostVisibilityStates.get(host)
  if (state === undefined) {
    state = { hidden: false, revealCallbacks: [] }
    hostVisibilityStates.set(host, state)
  }
  return state
}

/**
 * 把宿主配置上的 hide/show 生命周期包装成「用户回调 + 可见性标志」的唯一实现：
 * - hide：先跑用户回调（finally 中切后台标志——用户 onHide 期间的最后一批写入仍直通）；
 * - show：先切可见（其内写入直通并对齐最新状态），再跑用户回调。
 * Page（onHide/onShow）、Component（pageLifetimes.hide/show）、App（onHide/onShow）三入口共用。
 * 注意：会就地改写 config 上的这两个字段；调用方应先拷贝配置对象（copyConfigPreservingPrototype）。
 */
export function wrapVisibilityLifecycles(config: object, hideKey: string, showKey: string): void {
  const target = config as Record<string, unknown>
  const originalHide = target[hideKey] as ((this: object) => void) | undefined
  target[hideKey] = function (this: object): void {
    try {
      originalHide?.call(this)
    } finally {
      markHostHidden(this, true)
    }
  }
  const originalShow = target[showKey] as ((this: object, ...args: unknown[]) => void) | undefined
  target[showKey] = function (this: object, ...args: unknown[]): void {
    markHostHidden(this, false)
    originalShow?.call(this, ...args)
  }
}

/** 宿主进入后台：切换标志即可，写入路径按标志自行分流 */
export function markHostHidden(host: object, hidden: boolean): void {
  const state = visibilityOf(host)
  const was = state.hidden
  state.hidden = hidden
  if (was && !hidden) {
    // 后台 → 前台：逐个触发对齐（快照遍历，回调内注册/注销不影响本轮）
    for (const reveal of [...state.revealCallbacks]) {
      try {
        reveal()
      } catch {
        // 单个绑定的对齐失败不拖垮其它绑定；onReveal 已把 realign/写入失败经 reportError 上报，
        // 这里只兜底「上报通道自身也抛错」的极端情况
      }
    }
  }
}

/** 按键 overlay（source 覆盖 target 同键；写自有属性，避免 '__proto__' 命中原型 setter） */
function overlayUpdates(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    Object.defineProperty(target, key, { value: source[key], writable: true, enumerable: true, configurable: true })
  }
}

/**
 * 创建后台写入门控：包装 writer.write——后台期间合并进 pendingBackground 不下发，
 * registerRealign 登记该绑定的对齐函数（onShow 时优先重跑映射求值，pending 兜底）。
 * @param reportError 回前台对齐时缓存写入失败的上报通道（此前异常被 markHostHidden 吞掉）
 */
export function createBackgroundGate(
  host: object,
  write: (updates: Record<string, unknown>) => void,
  reportError?: (error: unknown) => void,
): { gatedWrite: (updates: Record<string, unknown>) => void; registerRealign: (realign: () => void) => void; dispose: () => void } {
  const state = visibilityOf(host)
  let pendingBackground: Record<string, unknown> | undefined
  let realign: (() => void) | undefined
  let registered = false

  const onReveal = (): void => {
    // 对齐优先走重新求值（拿到的是最新状态，天然丢弃中间态）；求值自身会触发
    // gatedWrite——但此刻 hidden 已复位，写入直通宿主
    if (realign !== undefined) {
      try {
        realign()
      } catch (error) {
        // realign 抛错（如 getter 异常）此前被空 catch 丢弃、后台对齐失败完全不可观测；
        // 现在经 reportError 上报（connectHost 转为 onError），仍不外溢并在下方用缓存兜底保住更新
        try {
          reportError?.(error)
        } catch {
          // 上报通道自身失败时放弃本次异常
        }
      }
    }
    const batch = pendingBackground
    if (batch === undefined) return
    // 对齐期间宿主可能再次进入后台（如 realign 内同步触发 onHide）：
    // 保持缓存不下发，等下一次 reveal，避免后台写入绕过  门控
    if (state.hidden) return
    // 真正写入成功前不清空 pending——写入失败时整批放回（与失败期间的新写入
    // 按键合并、后值覆盖），等下一次 reveal 重试，避免回前台对齐的数据静默丢失
    pendingBackground = undefined
    try {
      write(batch)
    } catch (error) {
      const retry = batch
      const merged = pendingBackground
      if (merged !== undefined) {
        overlayUpdates(retry, merged)
      }
      pendingBackground = retry
      try {
        reportError?.(error)
      } catch {
        // 上报通道自身失败时放弃本次异常，缓存已恢复、下一次 reveal 可重试
      }
    }
  }

  return {
    // （契约说明）：缓存只做按键 overlay，没有删除语义——调用方每次必须传「该批键的完整
    // 最新值」（createMapper 的每轮写入即为此形态）；键不再出现不会产生删除，属有意取舍
    gatedWrite(updates) {
      if (!state.hidden) {
        const retained = pendingBackground
        pendingBackground = undefined
        if (retained === undefined) {
          write(updates)
          return
        }
        // 上一次回前台写入失败时保留的批次不能因「下一次可见写入」而丢弃——
        // 下一次可见写入通常只是脏键子集（createMapper 只发变化键），直接覆盖会永久丢失
        // 缓存里未被本次 updates 覆盖的键。先把本次新值 overlay 到保留批次上再整体交付。
        overlayUpdates(retained, updates)
        try {
          write(retained)
        } catch (error) {
          // 本次仍失败：与失败期间的重入写入按键合并（新值覆盖旧值，与 onReveal 同口径），
          // 否则失败期间宿主重入后台缓存的新键会被这里的整体赋值丢弃
          const merged = pendingBackground
          if (merged !== undefined) {
            overlayUpdates(retained, merged)
          }
          pendingBackground = retained
          throw error
        }
        return
      }
      // 后台：合并缓存（后值覆盖前值），不下发。
      // 复用 overlayUpdates，避免与 onReveal / 保留批路径各自复制同一段循环后漂移
      const merged = pendingBackground ?? {}
      pendingBackground = merged
      overlayUpdates(merged, updates)
    },
    registerRealign(fn) {
      realign = fn
      if (!registered) {
        registered = true
        state.revealCallbacks.push(onReveal)
      }
      // 注册时已在后台：先跑一次 realign 让 pending 建立在最新状态上（hidden 分流，不写宿主）
      if (state.hidden) {
        try {
          fn()
        } catch {
          // 注册期对齐失败不阻断绑定建立
        }
      }
    },
    dispose() {
      const index = state.revealCallbacks.indexOf(onReveal)
      if (index !== -1) {
        state.revealCallbacks.splice(index, 1)
      }
      registered = false
      pendingBackground = undefined
    },
  }
}
