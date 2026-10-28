/**
 * 不可序列化值探测（统一 helper）。
 *
 * 三种口径：
 * - `state`：只报「硬不可序列化」——函数 / BigInt / Symbol / 循环引用 / DOM 节点；Map/Set/Date/
 *   类实例允许存在于状态（ 明确 Map/Set 可存在），不递归其内部，避免误杀；
 * - `mapping`：报函数 / BigInt / Symbol / Map / Set / 类实例 / 循环引用；Date / RegExp / undefined
 *   放行（undefined 映射为 null），普通对象与数组递归；
 * - `persistence`：报函数 / BigInt / Symbol / undefined / Map / Set / 类实例 / RegExp / 循环引用；
 *   Date 放行（落盘为 ISO 字符串），普通对象与数组递归。
 *
 * 返回违规路径数组（空数组 = 合法）：`user.profile.phone`、`items[0].token`；
 * 根值本身不可序列化时为 `<root>`；符号键路径形如 `[Symbol(desc)]`。
 * 循环引用报「首次回边所在路径」（`{ self: self }` → `['self']`），祖先栈检测、纯 DAG 共享引用不误报。
 */

import { ownEnumerableKeys } from './clone.js'

export type SerializationMode = 'state' | 'mapping' | 'persistence'

const ROOT_PATH = '<root>'

/** 带符号键的可枚举自有键路径片段 */
function symbolKeyPath(base: string, key: symbol): string {
  return base + '[Symbol(' + (key.description ?? '') + ')]'
}

/** 键路径拼接：对象键用 .，数组下标用 [i]，符号键用 [Symbol(desc)] */
function appendChildPath(base: string, key: string | symbol): string {
  if (typeof key === 'symbol') {
    return symbolKeyPath(base, key)
  }
  return base === '' ? key : base + '.' + key
}

/** 根路径的空串显示成可读标签 */
function displayPath(path: string): string {
  return path === '' ? ROOT_PATH : path
}

/** DOM 节点判定：真浏览器环境用 instanceof，小程序/Node 测试用鸭子类型（nodeType + nodeName） */
function isDomNode(value: object): boolean {
  const NodeCtor = (globalThis as { Node?: { new (): object } }).Node
  if (NodeCtor !== undefined && value instanceof NodeCtor) {
    return true
  }
  const candidate = value as { nodeType?: unknown; nodeName?: unknown }
  return typeof candidate.nodeType === 'number' && typeof candidate.nodeName === 'string'
}

/** 纯对象（含 Object.create(null)）与数组才继续递归；其余对象按模式单独判定 */
function isPlainObjectLike(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** 安全读取可枚举自有键的值：throwing getter / Proxy 陷阱按该路径不可序列化处理 */
function readChild(record: Record<PropertyKey, unknown>, key: string | symbol): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: record[key] }
  } catch {
    return { ok: false }
  }
}

/**
 * 找出 `value` 中所有不符合指定序列化口径的路径。
 * @param value 任意待检查值（状态树 / 映射值 / 落盘载荷）
 * @param mode  `state`（构造期硬值）/ `mapping`（setData 载荷）/ `persistence`（落盘载荷）
 */
export function findUnserializablePaths(value: unknown, mode: SerializationMode): string[] {
  const hits: string[] = []
  // 祖先栈：只把「当前递归路径上」的对象计入，真正的环才会命中；DAG 共享引用不会误报
  const ancestors = new WeakSet<object>()

  const visit = (current: unknown, path: string): void => {
    if (typeof current === 'function' || typeof current === 'bigint' || typeof current === 'symbol') {
      hits.push(displayPath(path))
      return
    }
    if (mode === 'state') {
      // 状态口径：undefined/null/原始值放行；Map/Set/Date/RegExp/类实例允许存在且不递归内部
      if (current === undefined || current === null || typeof current !== 'object') {
        return
      }
      if (isDomNode(current)) {
        hits.push(displayPath(path))
        return
      }
      if (!Array.isArray(current) && !isPlainObjectLike(current)) {
        return
      }
      if (ancestors.has(current)) {
        hits.push(displayPath(path))
        return
      }
      ancestors.add(current)
      try {
        visitChildren(current as object, path)
      } finally {
        ancestors.delete(current)
      }
      return
    }

    // mapping / persistence 共用：先处理「整体不可序列化」的类型
    if (current === undefined) {
      if (mode === 'persistence') {
        hits.push(displayPath(path))
      }
      return
    }
    if (current === null || typeof current !== 'object') {
      return
    }
    if (current instanceof Map || current instanceof Set) {
      hits.push(displayPath(path))
      return
    }
    if (isDomNode(current)) {
      hits.push(displayPath(path))
      return
    }
    if (current instanceof Date) {
      return
    }
    if (current instanceof RegExp) {
      if (mode === 'persistence') {
        hits.push(displayPath(path))
      }
      return
    }
    // 类实例等非纯对象：mapping/persistence 都无法安全序列化
    if (!Array.isArray(current) && !isPlainObjectLike(current)) {
      hits.push(displayPath(path))
      return
    }
    if (ancestors.has(current)) {
      hits.push(displayPath(path))
      return
    }
    ancestors.add(current)
    try {
      visitChildren(current as object, path)
    } finally {
      ancestors.delete(current)
    }
  }

  const visitChildren = (current: object, path: string): void => {
    if (Array.isArray(current)) {
      // 稀疏数组按自有索引键遍历（与 clone/通知口径一致，不按 length）
      for (const key of Object.keys(current)) {
        const child = readChild(current as unknown as Record<PropertyKey, unknown>, key)
        if (!child.ok) {
          hits.push(path + '[' + key + ']')
          continue
        }
        visit(child.value, path + '[' + key + ']')
      }
      return
    }
    for (const key of ownEnumerableKeys(current)) {
      const childPath = appendChildPath(path, key)
      const child = readChild(current as Record<PropertyKey, unknown>, key)
      if (!child.ok) {
        hits.push(childPath)
        continue
      }
      visit(child.value, childPath)
    }
  }

  visit(value, '')
  return hits
}
