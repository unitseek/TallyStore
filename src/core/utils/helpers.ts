/** 库内工具函数（不对外导出） */

import { isProduction } from '../store/utils.js'
import { deepCloneState, ownEnumerableKeys } from './clone.js'

/** 判断是否是对象（排除数组 / Map / Set） */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Map) && !(value instanceof Set)
}

/** 判断是否是纯对象（plain object） */
export function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

/**
 * 原型链敏感键：作为普通自有属性覆盖写入，禁止递归合并进原型对象，
 * 防止 JSON.parse('{"__proto__": {...}}') 之类的输入污染 Object.prototype。
 */
export const PROTO_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** 以 DefineOwnProperty 语义写入自有属性。 */
export function defineOwnProperty(target: object, key: string | symbol, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

/** 深度合并对象 */
export function deepMerge<T extends Record<string, unknown>>(target: T, ...sources: Partial<T>[]): T {
  // 循环引用防护：同一对 (source, target) 只递归合并一次，source 自引用/互引用时不会无限递归
  const seenPairs = new WeakMap<object, Set<object>>()

  const mergeInto = (dst: Record<PropertyKey, unknown>, src: Record<PropertyKey, unknown>): void => {
    let dsts = seenPairs.get(src)
    if (!dsts) {
      dsts = new Set()
      seenPairs.set(src, dsts)
    } else if (dsts.has(dst)) {
      return
    }
    dsts.add(dst)

    for (const key of ownEnumerableKeys(src)) {
      const sourceVal = src[key]

      if (typeof key === 'string' && PROTO_SENSITIVE_KEYS.has(key)) {
        // 原型链敏感键：深拷贝后作为普通自有属性覆盖，绝不递归合并
        defineOwnProperty(dst, key, deepCloneState(sourceVal))
        continue
      }

      const existing = Object.prototype.hasOwnProperty.call(dst, key) ? dst[key] : undefined
      if (isPlainObject(sourceVal)) {
        if (isPlainObject(existing)) {
          mergeInto(existing as Record<PropertyKey, unknown>, sourceVal as Record<PropertyKey, unknown>)
        } else {
          // 目标位置为非纯对象：类型冲突时整体替换为深拷贝，避免递归合并被静默跳过
          defineOwnProperty(dst, key, deepCloneState(sourceVal))
        }
      } else if (typeof sourceVal === 'object' && sourceVal !== null) {
        // 非纯对象源值（数组/Map/Set/Date/RegExp/类实例等）一律整体替换为克隆副本，不递归合并
        defineOwnProperty(dst, key, deepCloneState(sourceVal))
      } else {
        defineOwnProperty(dst, key, sourceVal)
      }
    }
  }

  for (const source of sources) {
    if (!source) continue
    // 与告警文案/函数契约一致：非纯对象（Date/RegExp/类实例等）不参与合并
    if (isPlainObject(target) && isPlainObject(source)) {
      mergeInto(target as Record<string, unknown>, source as Record<string, unknown>)
    } else if (!isProduction()) {
      // target/source 非纯对象时静默跳过会让调用方误以为合并成功，开发期告警
      console.warn(
        '[TallyStore] deepMerge skipped: target or source is not a plain object (target: ' +
          (Array.isArray(target) ? 'array' : target === null ? 'null' : typeof target) +
          ', source: ' +
          (Array.isArray(source) ? 'array' : typeof source) +
          ')',
      )
    }
  }

  return target
}

/**
 * 估算 JSON 序列化后的 UTF-8 字节数（ 载荷守卫 /  配额告警共用）。
 * 小程序 AppService 没有 Buffer / TextEncoder：按 UTF-8 码点口径折算——
 * ASCII 1 字节、两字节区 2 字节、其余 BMP 3 字节、BMP 外（代理对，如 emoji）4 字节。
 *
 * 不可估算的统一返回 -1：循环引用 / BigInt 会让 JSON.stringify 抛错；而顶层
 * undefined / 函数 / Symbol（以及 toJSON() 返回 undefined 的对象）不抛错、返回
 * undefined。后者若直接当字符串取 length 会抛 TypeError，与调用方
 * 只判 `< 0` 的契约不符，并会中断 setData / $snapshot 流程。
 */
export function estimateJsonBytes(value: unknown): number {
  let json: string | undefined
  try {
    json = JSON.stringify(value) as string | undefined
  } catch {
    return -1
  }
  if (typeof json !== 'string') {
    return -1
  }
  let bytes = 0
  // 按索引取码点：for...of 对每个码点会分配迭代器步骤与单字符字符串，而本函数在
  // 映射写入/$snapshot 热路径上；代理对整体跳过低位码元，按真实 UTF-8 计 4 字节
  for (let i = 0; i < json.length; i++) {
    const code = json.codePointAt(i) as number
    if (code > 0xffff) {
      i += 1
    }
    if (code < 0x80) {
      bytes += 1 // ASCII
    } else if (code < 0x800) {
      bytes += 2 // 两字节区（含大部分标点与拉丁扩展）
    } else if (code < 0x10000) {
      bytes += 3 // 其余 BMP
    } else {
      bytes += 4 // BMP 外（emoji 等）
    }
  }
  return bytes
}
