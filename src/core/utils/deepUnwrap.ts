/**
 * 容器内代理递归解包：把赋值目标容器（数组/纯对象/Map/Set）里夹带的
 * 本层代理原地替换为裸对象。脏跟踪与状态保护两层共用同一实现，只有「代理 → 原始对象」的
 * 反查方式不同（cache.targets vs _proxyTargets），避免两份遍历逻辑再次漂移。
 *
 * - lookupProxy：代理 → 原始对象；返回 undefined 表示不是本层的代理；
 * - 值本身是代理时先解包成裸对象再继续遍历（裸状态可能已被 setState/$patch 直写夹带代理）；
 * - 原地替换、不含代理时零改动（保持调用方对象身份）；循环引用用 WeakSet 防重入。
 */
export function deepUnwrapContainers(value: unknown, lookupProxy: (value: object) => object | undefined, seen?: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }
  const target = lookupProxy(value) ?? value
  const visited = seen ?? new WeakSet<object>()
  if (visited.has(target)) {
    return target
  }
  visited.add(target)
  if (Array.isArray(target)) {
    // 单遍按自有键遍历：稀疏数组的 length 可达 2^32-1，按 length 循环是 O(距离)；
    // 数组附加的非下标自有键（含符号键，如 arr.meta）同样可能夹带代理
    for (const key of Reflect.ownKeys(target)) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key) as PropertyDescriptor
      if (!('value' in descriptor)) continue
      const nextValue = deepUnwrapContainers(descriptor.value, lookupProxy, visited)
      // 不可写/不可配置属性上 Reflect.defineProperty 返回 false（不抛错）：冻结容器保持原状
      if (nextValue !== descriptor.value) Reflect.defineProperty(target, key, { ...descriptor, value: nextValue })
    }
    return target
  }
  if (target instanceof Map) {
    // 快照迭代：原地修复键/值不会让 for...of 看到重复条目
    for (const [entryKey, entryValue] of [...target]) {
      const nextKey = deepUnwrapContainers(entryKey, lookupProxy, visited)
      const nextValue = deepUnwrapContainers(entryValue, lookupProxy, visited)
      if (nextKey !== entryKey) target.delete(entryKey)
      if (nextKey !== entryKey || nextValue !== entryValue) target.set(nextKey, nextValue)
    }
    return target
  }
  if (target instanceof Set) {
    const members = [...target]
    const nextMembers = members.map((member) => deepUnwrapContainers(member, lookupProxy, visited))
    if (nextMembers.some((member, index) => member !== members[index])) {
      target.clear()
      for (const member of nextMembers) target.add(member)
    }
    return target
  }
  const prototype = Object.getPrototypeOf(target)
  // 非纯对象（Date/RegExp/类实例/类型化数组等）无法安全遍历/替换内部字段，保留原引用
  if (prototype !== Object.prototype && prototype !== null) {
    return target
  }
  for (const key of Reflect.ownKeys(target)) {
    // ownKeys 产出的键必然有描述符：断言避免不可达的 undefined 分支
    const descriptor = Object.getOwnPropertyDescriptor(target, key) as PropertyDescriptor
    if (!('value' in descriptor)) continue
    const nextValue = deepUnwrapContainers(descriptor.value, lookupProxy, visited)
    if (nextValue !== descriptor.value) Reflect.defineProperty(target, key, { ...descriptor, value: nextValue })
  }
  return target
}
