/** HookSystem - 钩子系统实现 */

import type { HookName, HookHandler, HookHandlerFor, HookArgsMap, IHookSystem } from '../../types/plugin.js'
import { isProduction } from '../store/utils.js'

/**
 * 每次 on() 产出一条注册记录。用对象身份而非 handler 本身作为 Set 成员，
 * 使同一 handler 的多次注册互相独立——clear() 后旧句柄 delete 的是已不存在的记录，
 * 不会误删重新建立的新注册
 */
interface HookRegistration {
  handler: HookHandler
}

/**
 * 钩子系统实现类，每个 Store 实例独立拥有一个 HookSystem 实例。
 *
 * 公开方法签名必须与 IHookSystem 保持一致：Store.hooks 声明为具体类
 * （不是 IHookSystem），若这里退化成 `HookName + unknown[]`，所有 in-repo 调用点
 * 都会丢失 HookArgsMap 的实参元组检查（如 afterDispatch 少传 result 也能编译）。
 */
export class HookSystem implements IHookSystem {
  private hooks: Map<HookName, Set<HookRegistration>> = new Map()
  // onError 重入守卫：防止 onError 处理器间接触发新的 onError 导致无限递归栈溢出
  // （直接递归由 hookName !== 'onError' 拦截，间接递归——如 onError 处理器 emit 另一个钩子、
  // 那个钩子的处理器又抛错——需要这面额外的旗帜）
  private isEmittingOnError = false

  on<K extends HookName>(hookName: K, handler: HookHandlerFor<K>): () => void {
    let handlers = this.hooks.get(hookName)
    if (!handlers) {
      handlers = new Set()
      this.hooks.set(hookName, handlers)
    }
    // 存储层按统一的 (...args: unknown[]) => void 保存：不同 hook 的元组在这里擦除，
    // 实参检查由上面的泛型签名在调用点完成（HookHandlerFor<K> 与 HookHandler 不能直接互赋）
    const registration: HookRegistration = { handler: handler as unknown as HookHandler }
    handlers.add(registration)

    // 句柄持有注册记录的对象引用。delete 按身份匹配，只移除自己那次注册：
    // clear() 后记录已从 Set 中消失，旧句柄的 delete 是 no-op，
    // 同一 handler 重新注册产出的新记录不受影响
    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true
      const current = this.hooks.get(hookName)
      if (!current) return
      current.delete(registration)
      if (current.size === 0) {
        this.hooks.delete(hookName)
      }
    }
  }

  emit<K extends HookName>(hookName: K, ...args: HookArgsMap[K]): void {
    const handlers = this.hooks.get(hookName)
    if (!handlers || handlers.size === 0) return

    // 读热路径优化：绝大多数钩子只有 1 个处理器，避免每次 emit 都物化快照数组；
    // 错误处理抽到私有方法，避免每次 emit 都新建闭包
    if (handlers.size === 1) {
      const only = handlers.values().next().value as HookRegistration
      try {
        only.handler(...args)
      } catch (error) {
        this._handleHookError(hookName, error)
      }
      return
    }
    // 多处理器走快照：本轮内增删注册不影响本次分发
    for (const reg of [...handlers]) {
      try {
        reg.handler(...args)
      } catch (error) {
        this._handleHookError(hookName, error)
      }
    }
  }

  /**
   * 钩子处理器异常的统一处理：与 StoreNotifier 的监听器异常同口径——开发期打印定位来源，
   * 生产期控制台静默、只走 onError 转投。钩子挂在 setState / dispatch 的写路径热线上，
   * 一个持续抛错的处理器（典型：监控 onError 处理器自身有 bug）不能每次写入都打印一遍。
   */
  private _handleHookError(hookName: HookName, error: unknown): void {
    if (!isProduction()) {
      console.error(`[TallyStore] Error in hook ${hookName}:`, error)
    }
    // 直接递归（onError 处理器自身抛错）与间接递归（onError 处理器触发的其他钩子抛错）
    // 都要拦截：isEmittingOnError 旗帜覆盖整个 onError 分发链
    if (hookName !== 'onError' && !this.isEmittingOnError) {
      this.isEmittingOnError = true
      try {
        this.emit('onError', error, hookName)
      } finally {
        this.isEmittingOnError = false
      }
    }
  }

  clear(hookName?: HookName): void {
    if (hookName) {
      this.hooks.delete(hookName)
    } else {
      this.hooks.clear()
    }
  }

  /** 获取钩子数量 */
  size(hookName?: HookName): number {
    if (hookName) {
      return this.hooks.get(hookName)?.size || 0
    }
    return this.hooks.size
  }

  /** 获取指定钩子的监听器数量 */
  listenerCount(hookName: HookName): number {
    return this.size(hookName)
  }
}
