/** 测试共用的宿主 mock 与记录器 */

/** 安装一个内存版 wx.storage，返回底层 Map 便于断言 */
export function installWxStorage(initial: Record<string, string> = {}): Map<string, string> {
  const memory = new Map(Object.entries(initial))
  ;(globalThis as { wx?: unknown }).wx = {
    getStorageSync(key: string) {
      return memory.has(key) ? memory.get(key) : ''
    },
    setStorageSync(key: string, value: string) {
      memory.set(key, value)
    },
    removeStorageSync(key: string) {
      memory.delete(key)
    },
    getAccountInfoSync() {
      return { miniProgram: { envVersion: 'develop' } }
    },
  }
  return memory
}

/** 移除 wx 全局（与 installWxStorage 成对；宿主 mock 的安装/清理都收敛在本文件） */
export function uninstallWxStorage(): void {
  delete (globalThis as { wx?: unknown }).wx
}

/** 清空 Store 全局注册表（测试隔离用；与 src/core/store/registry.ts 的 Symbol.for 键保持一致） */
export function clearStoreRegistry(): void {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('tallystore.storeRegistry')]
}

/** 可记录 setData 的页面/组件实例壳 */
export function createHost(extra: Record<string, unknown> = {}) {
  const setDataCalls: Array<Record<string, unknown>> = []
  const host: Record<string, unknown> = {
    data: {},
    setData(patch: Record<string, unknown>) {
      setDataCalls.push(patch)
      Object.assign(host.data as Record<string, unknown>, patch)
    },
    ...extra,
  }
  return { host, setDataCalls }
}

/** trackSubscriptions 的统计结果与还原句柄 */
export interface SubscriptionTracker {
  /** 累计调用 subscribe 的次数 */
  registered: number
  /** 当前仍在册的订阅数 */
  active: number
  /** 还原被包装的 subscribe（幂等；重复调用无副作用） */
  uninstall: () => void
}

/** 同一 store 的 tracker：避免重复包装导致计数翻倍 */
const subscriptionTrackers = new WeakMap<object, SubscriptionTracker>()

/**
 * 包装 store.subscribe 记录注册/在册订阅数（含统计字段与还原句柄）。
 * 对同一 store 重复调用返回同一个 tracker（不双重包装）；uninstall 后可再次包装。
 */
export function trackSubscriptions<T extends { subscribe: (...args: never[]) => () => void }>(store: T): SubscriptionTracker {
  const target = store as unknown as object
  const existing = subscriptionTrackers.get(target)
  if (existing !== undefined) {
    return existing
  }
  // restore 用原始函数引用（不能存 bind 后的副本，否则 uninstall 无法精确还原）
  const original = store.subscribe
  const invoke = original.bind(store) as unknown as (...args: unknown[]) => () => void
  /** 本 tracker 安装的包装函数（uninstall 只在它仍是当前 subscribe 时还原） */
  const wrapper = (...args: unknown[]): (() => void) => {
    // 先调用原实现再记账——subscribe 抛错时计数不能虚增
    const unsubscribe = invoke(...args)
    stats.registered += 1
    stats.active += 1
    let done = false
    return () => {
      if (done) return
      done = true
      stats.active -= 1
      unsubscribe()
    }
  }
  // uninstall 直接内联在初始化里即可（闭包引用 stats 自身是合法的），
  // 只有当前 subscribe 仍是本包装时才还原 original——若之后被别的 wrapper 包了一层，
  // 无条件还原会把后来者静默丢掉，使 helper 无法组合。
  const stats: SubscriptionTracker = {
    registered: 0,
    active: 0,
    uninstall: () => {
      if (subscriptionTrackers.get(target) !== stats) return
      subscriptionTrackers.delete(target)
      if ((store as unknown as { subscribe: unknown }).subscribe === wrapper) {
        ;(store as unknown as { subscribe: unknown }).subscribe = original
      }
    },
  }
  subscriptionTrackers.set(target, stats)
  ;(store as unknown as { subscribe: (...args: unknown[]) => () => void }).subscribe = wrapper
  return stats
}
