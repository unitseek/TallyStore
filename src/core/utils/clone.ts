/** 状态克隆工具 */

/**
 * 深拷贝状态。
 *
 * 覆盖范围：纯对象（保留原型）/ 数组（含非下标自有键与空洞）/ Date / RegExp / Map / Set
 * 按类型重建且循环引用安全；非纯对象（class 实例、WeakMap、Promise 等）保留原引用——
 * 无法安全克隆，共享比伪造副本更诚实。
 */
export function deepCloneState<T>(state: T): T {
  return fallbackClone(state)
}

/** 数组的规范下标键（'0'、'1'…）：这类键由下标循环负责，附加属性循环需跳过 */
export function isIndexKey(key: string): boolean {
  const index = Number(key)
  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key
}

/** 对象自有可枚举键（字符串键 + 符号键） */
export function ownEnumerableKeys(target: object): Array<string | symbol> {
  // Object.keys 只给自有可枚举字符串键，符号键另取再过滤；不用 Reflect.ownKeys 是因为
  // 它把不可枚举键也一并物化，而这里的调用方在热路径上
  const symbols = Object.getOwnPropertySymbols(target)
  if (symbols.length === 0) {
    return Object.keys(target)
  }
  return [...Object.keys(target), ...symbols.filter((symbol) => Object.prototype.propertyIsEnumerable.call(target, symbol))]
}

/**
 * 以「自有数据属性」语义写入键。必须用 defineProperty 而不是裸赋值：
 * 裸赋值走 [[Set]]，会命中原型上的无 setter 访问器（如 Map/Set.prototype.size，
 * 源对象带同名自有可枚举属性时）或继承的 setter，在严格模式下直接抛错；
 * `__proto__` 同样必须走 defineProperty，否则会改原型。
 */
function assignOwn(target: object, key: string | symbol, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
}

/** 复制内建克隆上的自有可枚举属性：与数组/纯对象分支保持对称，深等式比较才成立 */
function copyOwnEnumerableProps(source: object, target: object, visited: WeakMap<object, unknown>): void {
  for (const key of ownEnumerableKeys(source)) {
    assignOwn(target, key, fallbackClone((source as Record<PropertyKey, unknown>)[key], visited))
  }
}

/** 带循环引用守卫的递归克隆 */
function fallbackClone<T>(value: T, seen?: WeakMap<object, unknown>): T {
  if (value === null || typeof value !== 'object') {
    // 函数等不可克隆值保留原引用（函数无内部状态，共享无副作用）
    return value
  }

  const visited = seen ?? new WeakMap<object, unknown>()
  const cached = visited.get(value as object)
  if (cached !== undefined) {
    return cached as T
  }

  // 只重建「恰好是该内建类型本身」的实例：子类实例走保留原引用的降级路径
  if (value instanceof Date) {
    if (Object.getPrototypeOf(value) !== Date.prototype) return value
    // 通过原型方法做 brand 校验：Object.create(Date.prototype) 或自有 getTime 覆盖会抛错，
    // 此时按「不可安全克隆」保留原引用，而不是崩溃或执行注入方法
    let time: number
    try {
      time = Date.prototype.getTime.call(value)
    } catch {
      return value
    }
    const date = new Date(time)
    // 注册进 visited：同一 Date 的重复引用在副本里保持同一性
    visited.set(value as object, date)
    copyOwnEnumerableProps(value, date, visited)
    return date as T
  }

  if (value instanceof RegExp) {
    if (Object.getPrototypeOf(value) !== RegExp.prototype) return value
    let clone: RegExp
    try {
      // getter 查询与调用都必须在 try 内：环境异常（descriptor 缺失）或伪 RegExp
      // 都应落到「不可安全克隆 → 保留原引用」，而不是突破函数契约抛 TypeError
      const sourceGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')!.get!
      const flagsGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags')!.get!
      clone = new RegExp(sourceGetter.call(value), flagsGetter.call(value))
    } catch {
      return value
    }
    clone.lastIndex = value.lastIndex
    visited.set(value as object, clone)
    copyOwnEnumerableProps(value, clone, visited)
    return clone as T
  }

  if (value instanceof Map) {
    if (Object.getPrototypeOf(value) !== Map.prototype) return value
    // brand 校验：伪 Map 的 forEach 会抛 TypeError；has 调用代价 O(1)
    try {
      Map.prototype.has.call(value, undefined)
    } catch {
      return value
    }
    const map = new Map()
    visited.set(value as object, map)
    Map.prototype.forEach.call(value, (mapValue: unknown, mapKey: unknown) => {
      map.set(fallbackClone(mapKey, visited), fallbackClone(mapValue, visited))
    })
    copyOwnEnumerableProps(value, map, visited)
    return map as unknown as T
  }

  if (value instanceof Set) {
    if (Object.getPrototypeOf(value) !== Set.prototype) return value
    try {
      Set.prototype.has.call(value, undefined)
    } catch {
      return value
    }
    const set = new Set()
    visited.set(value as object, set)
    Set.prototype.forEach.call(value, (setValue: unknown) => {
      set.add(fallbackClone(setValue, visited))
    })
    copyOwnEnumerableProps(value, set, visited)
    return set as unknown as T
  }

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return value
    // 预置 length 而非逐位 push：push 会把空洞补成值为 undefined 的实槽位
    const arr: unknown[] = new Array(value.length)
    visited.set(value as object, arr)
    // 单遍枚举自有字符串键：getOwnPropertyNames 只物化一次，且覆盖非枚举下标；
    // 下标键按源描述符复制：隐藏下标在副本里仍是隐藏的，clone 不再是「隐藏变可枚举」的失真副本
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === 'length') continue
      if (isIndexKey(key)) {
        const index = Number(key)
        const descriptor = Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor
        Object.defineProperty(arr, index, {
          ...descriptor,
          value: fallbackClone((value as unknown as Record<number, unknown>)[index], visited),
        })
      } else if (Object.prototype.propertyIsEnumerable.call(value, key)) {
        // 非下标键只复制可枚举的（与纯对象分支 ownEnumerableKeys 口径一致）
        assignOwn(arr, key, fallbackClone((value as Record<PropertyKey, unknown>)[key], visited))
      }
    }
    // 符号键没有下标语义，同样只复制可枚举的（与纯对象分支口径一致）
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
        assignOwn(arr, symbol, fallbackClone((value as Record<PropertyKey, unknown>)[symbol], visited))
      }
    }
    return arr as unknown as T
  }

  // 非纯对象无法安全克隆，保留原引用
  const proto = Object.getPrototypeOf(value as object)
  if (proto !== Object.prototype && proto !== null) {
    return value
  }

  // 克隆进同类原型：Object.create(null) 的状态映射若克隆成 {}，副本会白得一份 Object.prototype
  const obj = Object.create(proto) as Record<PropertyKey, unknown>
  visited.set(value as object, obj)
  // 键集含符号键：通知载荷与可写订阅者的深拷贝都走这里
  const keys = ownEnumerableKeys(value as object)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    assignOwn(obj, key, fallbackClone((value as Record<PropertyKey, unknown>)[key], visited))
  }
  return obj as T
}
