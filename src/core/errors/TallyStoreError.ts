/** TallyStore - 错误类型 */

/**
 * 错误码：调用方据此判别失败来源，属于对外稳定契约。
 * 新增码必须同步 docs/API.md 错误码表（含义/触发条件/恢复建议）；
 * 删除或改语义必须走主版本。结构性的 JS 误用（传 null / 非对象）仍抛 TypeError，
 * 不占用库错误码。
 */
export const ErrorCode = {
  ACTION_NOT_FOUND: 'ACTION_NOT_FOUND',
  ACTION_EXECUTION_ERROR: 'ACTION_EXECUTION_ERROR',
  GETTER_NOT_FOUND: 'GETTER_NOT_FOUND',
  GETTER_EXECUTION_ERROR: 'GETTER_EXECUTION_ERROR',
  /** 配置取值非法（枚举值、数值范围等语义错误） */
  INVALID_CONFIG: 'INVALID_CONFIG',
  /** 映射非法（本地键冲突、不可绑定成员等） */
  INVALID_MAPPING: 'INVALID_MAPPING',
  /** 持久化失败（恢复/落盘/清理各阶段经 onError 上报） */
  PERSISTENCE_ERROR: 'PERSISTENCE_ERROR',
  /** 宿主写入失败（setData 抛错，cause 保留原始错误） */
  HOST_WRITE_ERROR: 'HOST_WRITE_ERROR',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

/**
 * 库统一错误类型。
 *
 * 不变量：
 * - `name` 恒为 'TallyStoreError'（不再有子类）。
 * - `context` 是构造时的**浅**拷贝：顶层键与调用方对象解耦，但嵌套值仍共享引用
 *   （深拷贝需处理循环/不可克隆值，成本与收益不匹配，故仅承诺顶层）。
 * - `cause` 仅在构造时提供才存在自有属性，用来区分「未包装」与「包装了 undefined」。
 * - `toJSON()` 是日志/上报的序列化入口，形状固定为 name/message/code/context/stack
 *   （可选 cause 归一成 name/message/stack，避免原生 Error 的可枚举键为空）。
 */
/**
 * 递归序列化 cause 链：循环引用（error.cause = error / 两个错误互指）输出占位符，
 * 避免「记录错误」的过程本身因无限递归抛 RangeError。
 * 注意 seen 只能走内部参数——toJSON 由 JSON.stringify 以字符串 key 调用，不能把 seen 当作可选参数。
 */
function serializeCause(cause: unknown, seen: WeakSet<object>): unknown {
  if (cause instanceof TallyStoreError) {
    if (seen.has(cause)) {
      return '[Circular cause]'
    }
    return serializeError(cause, seen)
  }
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message, stack: cause.stack }
  }
  return cause
}

/** toJSON 的统一实现（供顶层与 cause 递归共用） */
function serializeError(error: TallyStoreError, seen: WeakSet<object>): Record<string, unknown> {
  seen.add(error)
  const result: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    code: error.code,
    context: error.context,
    stack: error.stack,
  }
  if (error.cause !== undefined) {
    result.cause = serializeCause(error.cause, seen)
  }
  return result
}

export class TallyStoreError extends Error {
  readonly code: ErrorCode | string
  readonly context?: Record<string, unknown>
  readonly cause?: unknown

  constructor(code: ErrorCode | string, message: string, context?: Record<string, unknown>, cause?: unknown) {
    super(message)
    this.name = 'TallyStoreError'
    this.code = code
    this.context = context ? { ...context } : undefined
    if (cause !== undefined) {
      // 与原生 Error(message, { cause }) 对齐：cause 是不可枚举自有属性，
      // 不会混进 Object.keys / 展开 / for...in，只经显式读取或 toJSON() 暴露
      Object.defineProperty(this, 'cause', {
        value: cause,
        enumerable: false,
        writable: true,
        configurable: true,
      })
    }
  }

  toJSON(): Record<string, unknown> {
    // 本库错误递归序列化：保留 code/context/更深的 cause 链（日志排障最有用的字段）；
    // 其他错误保持 name/message/stack（原生 Error 可枚举键为空，原样输出会丢信息）
    return serializeError(this, new WeakSet<object>())
  }
}

/** 识别本库错误；单副本（原生小程序宿主）下 instanceof 即完整判据。 */
export function isTallyStoreError(error: unknown): error is TallyStoreError {
  return error instanceof TallyStoreError
}
