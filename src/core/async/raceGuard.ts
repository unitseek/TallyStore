/**
 * 异步竞态辅助：为「快速连续触发异步操作、只允许最新结果落地」提供
 * 请求序号 + 过期判定 + 取消句柄。与 Action 完全解耦——Action 选择性使用，不强制改造写法。
 *
 * 口径（文档同步 API.md）：
 * - **结果级取消 ≠ 网络级中断**：`cancel()` / `isCurrent()` 只承诺「结果不落地」，
 *   底层请求是否真正中断取决于请求库自身能力；
 * - 旧结果晚到（`isCurrent` 为 false）由调用方丢弃；过期判定次数可查（`staleCount`），
 *   供日志/指标消费。口径是「isCurrent 返回 false 的累计次数」：cancel 后判定、
 *   同一序号重复判定都会计入，因此不能当作「丢弃的结果数」；
 * - 取消后没有库侧产生的未处理 rejection：guard 不包装 Promise，调用方原有
 *   try/catch / await 语义不变。
 */

/** 竞态守卫：请求序号发生器 + 过期判定 + 取消 */
export interface RaceGuard {
  /** 发起请求前取号；每次调用自增 */
  begin(): number
  /** 结果落地前判定该序号是否仍是最新的（已取消或已有更新的序号则过期） */
  isCurrent(seq: number): boolean
  /** 取消全部在途序号：此后所有 isCurrent 为 false（结果不落地），新的 begin 重新有效 */
  cancel(): void
  /** 过期判定计数：isCurrent 返回 false 的累计次数（含 cancel 失效与同一序号重复判定），非「丢弃结果数」 */
  staleCount(): number
}

/** 创建竞态守卫：默认不做采样，全部生效 */
export function createRaceGuard(): RaceGuard {
  let current = 0
  let stale = 0
  let cancelled = false
  return {
    begin(): number {
      // 新请求发起：旧序号自然过期（isCurrent 严格比较），取消状态对新请求失效
      cancelled = false
      return ++current
    },
    isCurrent(seq: number): boolean {
      // seq > 0 显式表达「尚未 begin 的序号一律过期」；cancel 后的在途序号由 cancelled 拦住。
      // 旧实现用 cancelledAt 表达初始态，二者等价但隐晦
      const live = !cancelled && seq > 0 && seq === current
      if (!live) {
        stale += 1
      }
      return live
    },
    cancel(): void {
      cancelled = true
    },
    staleCount(): number {
      return stale
    },
  }
}
