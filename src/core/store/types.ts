/** Store 内部类型定义 */

import type { StateProtectionOptions } from '../../types/store.js'

/** 状态保护配置（内部使用，包含所有默认值） */
export type InternalStateProtectionConfig = Required<StateProtectionOptions>

/** Proxy 缓存接口：target（原始对象）→ proxy（保护代理），值类型收敛为 object */
export interface ProxyCache {
  get(target: object): object | undefined
  set(target: object, proxy: object): void
  delete(target: object): boolean
}

/**
 * 批量更新管理器接口。
 * - start/end 支持嵌套重入，深度归零时统一收尾；未配对的 end() 不抛错（仅开发期告警）。
 * - 批中途异常中断时，teardown 阶段需调用 reset() 复位深度，避免 isInBatch 永久为 true。
 */
export interface BatchManagerInterface {
  start(): void
  end(): void
  reset(): void
  readonly isInBatch: boolean
}
