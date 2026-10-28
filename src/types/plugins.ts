/** TallyStore - 内置插件契约 */

import type { State } from './store.js'

/** 存储后端接口：三个方法都必须同步返回，失败抛错 */
export interface StorageBackend {
  /** 键不存在返回 null */
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 持久化选项：默认 key 为 `tallystore_<storeName>`，restore 默认 true，debounce 默认 0，clearOnUninstall 默认 false */
export interface PersistenceOptions<S extends State = State> {
  /**
   * 存储键（默认 `tallystore_<storeName>`）。默认值刻意不加随机后缀：键必须跨会话稳定，
   * 否则 restore 永远落空；代价是共享同一 key 的多个 Store 会互相覆盖（未命名 Store 的默认名
   * 来自模块级计数器，多份 bundle 各有一份计数器时尤甚）。需要隔离就显式传入 key
   * （或传入函数按 storeName 派生）；这是默认键稳定与唯一不可兼得的取舍。
   */
  key?: string | ((storeName: string) => string)
  storage?: StorageBackend
  /**
   * 落盘白名单：只落盘 filter 返回的键；传 `false` 表示
   * 显式关闭持久化（不读 storage、不恢复、不订阅保存、不写盘/清理）。
   * - 缺省不传：开发期抛 `INVALID_CONFIG`；生产期经 `onError(INVALID_CONFIG, 'persistence')`
   *   上报后禁用持久化（不读/不写/不恢复）——**默认不落盘任何字段，禁止自动全量持久化**。
   * - 恢复语义：持久化载荷按 `$patch` **合并**回 Store——被 filter 排除的键保留默认值，
   *   不会因恢复被整体替换/清空；据此设计白名单，不要把「排除」当作「重置」。
   * - 恢复路径的入参不是完整状态：实现会以「已持久化的子集」调用 filter，
   *   因此 `state` 不保证包含 S 的全部字段，实现不得解引用未持久化字段。
   */
  filter?: ((state: S) => Partial<S>) | false
  /**
   * 恢复前校验，返回 false 则拒绝恢复。
   * 入参是**已持久化的子集**（可能是 filter 后的 Partial<S>），不保证包含 S 的全部字段，
   * 实现不得解引用未持久化字段；返回值刻意是普通 boolean 而非 `state is S`——用类型谓词
   * 把子集不可靠地收窄成完整 S 是不健全的。
   */
  validate?: (state: unknown) => boolean
  restore?: boolean
  debounce?: number
  clearOnUninstall?: boolean
  /**
   * 数据 schema 版本：提供时落盘为带版本信封 `{ $tallyV, $tallyD }`，
   * 恢复时按 migrations 链逐版迁升到当前版本。迁移失败或存储版本高于当前时回退
   * 默认值（跳过恢复）并经 onError 上报，不把坏数据注入 Store。
   * 恢复延迟由安装时机承载（首屏后再 use 插件），关闭用 `restore: false`。
   */
  schemaVersion?: number
  /**
   * 迁移钩子：键为目标版本，按 savedV+1 → schemaVersion 顺序执行。
   * 每步接收上一版数据、返回下一版数据；抛错即中止并回退默认值。
   * 仅对带 `{ $tallyV, $tallyD }` 版本信封的载荷生效：无信封的历史裸数据按原样恢复、
   * **不执行任何迁移**（下次落盘时才会被标记为当前 schemaVersion），不要依赖迁移处理遗留数据。
   */
  migrations?: Record<number, (data: Record<string, unknown>) => Record<string, unknown>>
}

export interface LogSink {
  log: (message: string, ...data: unknown[]) => void
  error: (message: string, ...data: unknown[]) => void
}


/** loggerPlugin 的选项：sink 缺省 console */
export interface LoggerPluginOptions {
  sink?: LogSink
}
