/** 状态代理的共享底层：内建对象判定、代理缓存、子值包装、方法绑定、Proxy 不变量 */

import type { ProxyCache } from './types.js'

/** 需要拦截的数组变异方法（模块级 Set：get 陷阱 O(1) 命中） */
export const ARRAY_MUTATING_METHODS: ReadonlySet<string> = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'])

/**
 * 内建对象判定：这些对象经 Proxy 包装后内部槽位语义被破坏——
 * Map/Set 的写操作走内部槽位、不触发 set 陷阱；Proxy 也无法被序列化机制克隆。
 * 原生小程序是单 realm 宿主，instanceof 即完整判据。
 */
export function isBuiltinObject(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet ||
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) ||
    value instanceof DataView
  )
}

/** Map 判定（供类型收窄用） */
export function isMapLike(value: object): value is Map<unknown, unknown> {
  return value instanceof Map
}

/** Set 判定（供类型收窄用） */
export function isSetLike(value: object): value is Set<unknown> {
  return value instanceof Set
}

/** 创建 Proxy 缓存实例 */
export function createProxyCache(): ProxyCache {
  const weakMap = new WeakMap<object, object>()
  return {
    get: (target: object) => weakMap.get(target),
    set: (target: object, proxy: object) => {
      weakMap.set(target, proxy)
    },
    delete: (target: object) => weakMap.delete(target),
  }
}

/** Proxy 不变量：不可配置且不可写的自有数据属性必须原样返回，不能包装 */
export function lockedOwnValue(target: object, key: PropertyKey): { locked: boolean; value?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  if (descriptor && !descriptor.configurable && 'value' in descriptor && !descriptor.writable) {
    return { locked: true, value: descriptor.value }
  }
  return { locked: false }
}

/** 方法绑定缓存：按 (owner, key, 当前底层函数) 复用 */
export type BoundMethodCache = WeakMap<object, Map<string | symbol, { raw: unknown; bound: unknown }>>

export function createBoundMethodCache(): BoundMethodCache {
  return new WeakMap()
}

/**
 * 非普通实例（类实例、类型化数组）的方法绑定到原始接收者：
 * 代理接收者会让 #private 字段与内部槽位取不到值。
 */
export function bindMethodToOwner(cache: BoundMethodCache, owner: object, key: string | symbol, raw: unknown): unknown {
  let byKey = cache.get(owner)
  if (!byKey) {
    byKey = new Map()
    cache.set(owner, byKey)
  }
  const cached = byKey.get(key)
  // 只在底层函数没换时复用：内部访问可以把方法整个换掉
  if (cached !== undefined && cached.raw === raw) {
    return cached.bound
  }
  const bound = (raw as (...args: unknown[]) => unknown).bind(owner)
  byKey.set(key, { raw, bound })
  return bound
}
