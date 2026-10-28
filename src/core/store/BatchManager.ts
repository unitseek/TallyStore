/** BatchManager - 批量更新管理器 */

import type { BatchManagerInterface } from './types.js'
import { isProduction } from './utils.js'

/** 批量更新管理器：嵌套 start/end，深度归零时触发一次收尾回调 */
export class BatchManager implements BatchManagerInterface {
  private _depth = 0
  private readonly _onEnd: () => void
  /** 收尾回调失败的宿主上报通道（Store 接到 onError('notify')），未提供时退回 console.error */
  private readonly _onEndError?: (error: unknown) => void

  /**
   * @param onEnd 批量更新结束时（深度归零）的回调，用于触发一次通知
   * @param onEndError 收尾回调失败的上报通道；缺省时 console.error 兜底
   * @throws {TypeError} onEnd 不是函数时当场抛错，不拖到最外层 end() 才暴露误用
   */
  constructor(onEnd: () => void, onEndError?: (error: unknown) => void) {
    if (typeof onEnd !== 'function') {
      throw new TypeError('[TallyStore] BatchManager requires an onEnd callback function')
    }
    this._onEnd = onEnd
    this._onEndError = onEndError
  }

  /** 是否在批量更新中 */
  get isInBatch(): boolean {
    return this._depth > 0
  }

  /** 开始批量更新 */
  start(): void {
    this._depth++
  }

  /** 结束批量更新 */
  end(): void {
    // 精确判 0：没有任何路径能把它带成负数，负数分支是不可达死分支
    if (this._depth === 0) {
      // 失配的 end()/start() 会永久改变批量语义，故只告警不抛错：抛错会让无害误用变成业务崩溃点
      if (!isProduction()) {
        console.warn('[TallyStore] BatchManager.end() called without matching start()')
      }
      return
    }
    this._depth--
    if (this._depth === 0) {
      // 收尾回调链（通知 → 载荷构建 → 监听器）可能抛错；此时 end() 已把深度归零，
      // 让异常逃逸会顶掉 Store.batch() 回调返回值/原始错误并跳过外层 finally 清理
      try {
        this._onEnd()
      } catch (error) {
        // 优先经宿主上报通道（插件/logger/metrics 可见）；没有上报器时才退回 console
        if (this._onEndError) {
          this._onEndError(error)
        } else {
          console.error('[TallyStore] Error in BatchManager onEnd callback:', error)
        }
      }
    }
  }

  /** 重置批量更新状态（仅限 teardown 使用） */
  reset(): void {
    if (!isProduction() && this._depth > 0) {
      console.warn('[TallyStore] BatchManager.reset() called during an active batch; suppressed notifications of this batch are dropped')
    }
    this._depth = 0
  }
}
