import { ErrorCode, TallyStoreError, isTallyStoreError } from '../../../src/core/errors/TallyStoreError.js'

describe('TallyStoreError · 错误码', () => {
  it('暴露 8 个稳定错误码（4 核心 + 配置/映射/持久化/宿主写入）', () => {
    expect(ErrorCode).toEqual({
      ACTION_NOT_FOUND: 'ACTION_NOT_FOUND',
      ACTION_EXECUTION_ERROR: 'ACTION_EXECUTION_ERROR',
      GETTER_NOT_FOUND: 'GETTER_NOT_FOUND',
      GETTER_EXECUTION_ERROR: 'GETTER_EXECUTION_ERROR',
      INVALID_CONFIG: 'INVALID_CONFIG',
      INVALID_MAPPING: 'INVALID_MAPPING',
      PERSISTENCE_ERROR: 'PERSISTENCE_ERROR',
      HOST_WRITE_ERROR: 'HOST_WRITE_ERROR',
    })
  })
})

describe('TallyStoreError · 构造契约', () => {
  it('是 Error 实例且 name 恒为 TallyStoreError', () => {
    const error = new TallyStoreError(ErrorCode.ACTION_NOT_FOUND, 'boom')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(TallyStoreError)
    expect(error.name).toBe('TallyStoreError')
    expect(error.message).toBe('boom')
    expect(error.code).toBe('ACTION_NOT_FOUND')
    expect(error.context).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false)
  })

  it('接受任意字符串 code（未在本库抛出的调用方自定义码）', () => {
    const error = new TallyStoreError('CUSTOM_CODE', 'custom')
    expect(error.code).toBe('CUSTOM_CODE')
  })

  it('context 是构造时的浅拷贝：调用方之后修改原对象不影响错误现场', () => {
    const context: Record<string, unknown> = { storeName: 'user', detail: { deep: 1 } }
    const error = new TallyStoreError(ErrorCode.ACTION_EXECUTION_ERROR, 'x', context)
    context.storeName = 'changed'
    context.added = true
    expect(error.context).toEqual({ storeName: 'user', detail: { deep: 1 } })
    // 嵌套值仍共享（契约写明只做浅拷贝）
    expect(error.context?.detail).toBe(context.detail)
  })

  it('cause 仅在构造时提供才成为自有属性，undefined 不挂载', () => {
    const wrapped = new TallyStoreError(ErrorCode.ACTION_EXECUTION_ERROR, 'wrapped', undefined, new Error('inner'))
    expect(Object.prototype.hasOwnProperty.call(wrapped, 'cause')).toBe(true)
    expect((wrapped.cause as Error).message).toBe('inner')

    const plain = new TallyStoreError(ErrorCode.ACTION_EXECUTION_ERROR, 'plain', undefined, undefined)
    expect(Object.prototype.hasOwnProperty.call(plain, 'cause')).toBe(false)
  })
})

describe('TallyStoreError · toJSON', () => {
  it('固定形状为 name/message/code/context/stack，无 cause 时不出现 cause 键', () => {
    const error = new TallyStoreError(ErrorCode.GETTER_NOT_FOUND, 'no getter', { getterName: 'x' })
    const json = error.toJSON()
    expect(Object.keys(json)).toEqual(['name', 'message', 'code', 'context', 'stack'])
    expect(json.name).toBe('TallyStoreError')
    expect(json.message).toBe('no getter')
    expect(json.code).toBe('GETTER_NOT_FOUND')
    expect(json.context).toEqual({ getterName: 'x' })
    expect(typeof json.stack).toBe('string')
    expect('cause' in json).toBe(false)
  })

  it('Error 型 cause 归一成 name/message/stack，便于日志序列化', () => {
    const cause = new TypeError('inner')
    const error = new TallyStoreError(ErrorCode.ACTION_EXECUTION_ERROR, 'outer', undefined, cause)
    const json = error.toJSON()
    expect(json.cause).toEqual({ name: 'TypeError', message: 'inner', stack: cause.stack })
  })

  it('非 Error 型 cause 原样保留', () => {
    const error = new TallyStoreError(ErrorCode.ACTION_EXECUTION_ERROR, 'outer', undefined, { code: 500 })
    expect(error.toJSON().cause).toEqual({ code: 500 })
  })
})

describe('TallyStoreError · isTallyStoreError', () => {
  it('只认本类实例', () => {
    expect(isTallyStoreError(new TallyStoreError(ErrorCode.ACTION_NOT_FOUND, 'x'))).toBe(true)
    expect(isTallyStoreError(new Error('x'))).toBe(false)
    expect(isTallyStoreError({ code: 'ACTION_NOT_FOUND' })).toBe(false)
    expect(isTallyStoreError(null)).toBe(false)
    expect(isTallyStoreError('error')).toBe(false)
  })
})

describe('TallyStoreError · cause 可枚举性与序列化', () => {
  it('cause 与原生 Error 对齐为非枚举自有属性，不混入展开/Object.keys', () => {
    const cause = new Error('inner')
    const error = new TallyStoreError(ErrorCode.ACTION_EXECUTION_ERROR, 'outer', undefined, cause)
    expect(Object.keys(error)).not.toContain('cause')
    expect(Object.prototype.propertyIsEnumerable.call(error, 'cause')).toBe(false)
    expect((error as { cause?: unknown }).cause).toBe(cause)
    expect({ ...error }).not.toHaveProperty('cause')
  })

  it('本库错误 cause 递归 toJSON，保留 code/context 与更深 cause 链', () => {
    const root = new TallyStoreError(ErrorCode.PERSISTENCE_ERROR, 'root', { phase: 'save' })
    const middle = new TallyStoreError(ErrorCode.ACTION_EXECUTION_ERROR, 'middle', { actionName: 'x' }, root)
    const outer = new TallyStoreError(ErrorCode.HOST_WRITE_ERROR, 'outer', undefined, middle)
    const json = outer.toJSON() as {
      cause: { code: string; context: { actionName: string }; cause: { code: string; context: { phase: string } } }
    }
    expect(json.cause.code).toBe('ACTION_EXECUTION_ERROR')
    expect(json.cause.context).toEqual({ actionName: 'x' })
    expect(json.cause.cause.code).toBe('PERSISTENCE_ERROR')
    expect(json.cause.cause.context).toEqual({ phase: 'save' })
    expect(() => JSON.stringify(outer)).not.toThrow()
  })
})

describe('TallyStoreError · cause 循环引用序列化', () => {
  it('自引用 cause 输出占位符，不无限递归', () => {
    const error = new TallyStoreError(ErrorCode.ACTION_EXECUTION_ERROR, 'self')
    ;(error as { cause?: unknown }).cause = error
    const json = error.toJSON() as { cause: unknown }
    expect(json.cause).toBe('[Circular cause]')
    expect(() => JSON.stringify(error)).not.toThrow()
  })

  it('两个错误互指时在环处截断', () => {
    const a = new TallyStoreError(ErrorCode.PERSISTENCE_ERROR, 'a')
    const b = new TallyStoreError(ErrorCode.ACTION_EXECUTION_ERROR, 'b', undefined, a)
    ;(a as { cause?: unknown }).cause = b
    const json = a.toJSON() as { cause: { message: string; cause: unknown } }
    expect(json.cause.message).toBe('b')
    expect(json.cause.cause).toBe('[Circular cause]')
    expect(() => JSON.stringify(a)).not.toThrow()
  })
})
