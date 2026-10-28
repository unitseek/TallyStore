/**
 * 可写追踪代理：把任意写入归因到「第一个到达该对象的顶层状态键」。
 *
 * 归属规则（取代旧的对象归属图 + 版本号索引）：
 * - 根的直接子对象归属该子键；更深层对象继承祖先的顶层键。
 * - 同一对象经两条路径可达时标记为 ambiguous，其写入保守上报全部顶层键（宁多报，不漏报）。
 * - 访问器取出的对象无法确定归属，同样走全量兜底。
 * - 类实例的方法体无法细粒度归因，调用时按所属顶层键上报；访问器取出的对象仍走全量兜底。
 */
import { isBuiltinObject, isMapLike, isSetLike, lockedOwnValue } from './proxyCore.js'
import { isIndexKey } from '../utils/clone.js'
import { deepUnwrapContainers } from '../utils/deepUnwrap.js'

export interface DirtyTrackingCache {
  proxies: WeakMap<object, object>
  targets: WeakMap<object, object>
  /** 原始对象 → 归属标记（顶层键 / 根 / 多路径可达） */
  owners: WeakMap<object, OwnerMark>
}

const ROOT_MARK = Symbol('tallystore.root')
const AMBIGUOUS = Symbol('tallystore.ambiguous')
type OwnerKey = string | symbol
type OwnerMark = OwnerKey | typeof ROOT_MARK | typeof AMBIGUOUS

export function createDirtyTrackingCache(): DirtyTrackingCache {
  return { proxies: new WeakMap(), targets: new WeakMap(), owners: new WeakMap() }
}

/** 复用同一对象的代理；写入时通过 onMutate 上报受影响的顶层键。 */
export function createDirtyTrackingProxy(root: object, cache: DirtyTrackingCache, onMutate: (rootKeys: Iterable<PropertyKey>) => void): object {
  const cachedRoot = cache.proxies.get(root)
  if (cachedRoot) return cachedRoot

  const isObject = (value: unknown): value is object => value !== null && typeof value === 'object'
  const unwrap = (value: unknown): unknown => (isObject(value) ? (cache.targets.get(value) ?? value) : value)
  /**
   * 递归解包容器内的代理：赋值目标容器（数组/纯对象/Map/Set）里可能夹带本缓存的
   * 代理（如 `proxy.list = [childProxy]`），直接写进裸状态会让序列化/原生桥接/=== 身份比较
   * 看到代理。遍历实现与状态保护层共用 deepUnwrapContainers，只有代理反查方式不同。
   */
  const deepUnwrap = (value: unknown, seen?: WeakSet<object>): unknown => deepUnwrapContainers(value, (entry) => cache.targets.get(entry), seen)
  const allKeys = (): PropertyKey[] => Reflect.ownKeys(root)

  const markOwner = (target: object, owner: OwnerMark | undefined): void => {
    if (owner === undefined) return
    const existing = cache.owners.get(target)
    if (existing === undefined) {
      cache.owners.set(target, owner)
      return
    }
    if (existing !== owner) cache.owners.set(target, AMBIGUOUS)
  }

  const ownerOf = (target: object): OwnerMark | undefined => cache.owners.get(target)

  const report = (target: object, key?: OwnerKey): PropertyKey[] => {
    const mark = ownerOf(target)
    let keys: PropertyKey[]
    if (mark === ROOT_MARK) {
      keys = key === undefined ? allKeys() : [key]
    } else if (mark !== undefined && mark !== AMBIGUOUS) {
      keys = [mark]
    } else {
      keys = allKeys()
    }
    onMutate(keys)
    return keys
  }

  /**
   * 子值归属：只有自有数据属性才继承/确立顶层键。
   * 访问器取出的对象无法证明属于状态树，返回 undefined → 写入时全量兜底。
   */
  const childOwner = (holder: object, key: PropertyKey): OwnerMark | undefined => {
    const descriptor = Object.getOwnPropertyDescriptor(holder, key)
    if (!descriptor || !('value' in descriptor)) return undefined
    if (holder === root) return key as OwnerKey
    // holder 为 root 已在上面处理；非根对象的归属不可能是 ROOT_MARK
    return ownerOf(holder)
  }

  /**
   * 建图时做一次归属扫描：发现初始状态里的别名（同一对象挂多个顶层键）与根自引用。
   * 之后新增的对象在首次被读取/写入时按路径登记，不再全量扫描。
   */
  const indexInitialOwners = (): void => {
    const seen = new WeakSet<object>()
    const queue: Array<[object, OwnerMark]> = []
    const pushChild = (value: unknown, owner: OwnerMark): void => {
      if (isObject(value)) queue.push([value, owner])
    }
    for (const key of Reflect.ownKeys(root)) {
      const descriptor = Object.getOwnPropertyDescriptor(root, key)
      if (descriptor && 'value' in descriptor) pushChild(descriptor.value, key as OwnerKey)
    }
    while (queue.length > 0) {
      const [target, owner] = queue.pop() as [object, OwnerMark]
      markOwner(target, owner)
      if (seen.has(target)) continue
      seen.add(target)
      // 根被其他键引用（state.self = state）：标记根为 ambiguous 即可，不再把根的子键扩散给兄弟节点
      if (target === root) continue
      if (isMapLike(target)) {
        for (const [entryKey, entryValue] of target) {
          pushChild(entryKey, owner)
          pushChild(entryValue, owner)
        }
        continue
      }
      if (isSetLike(target)) {
        for (const member of target) pushChild(member, owner)
        continue
      }
      if (isBuiltinObject(target)) continue
      const typedArray = ArrayBuffer.isView(target)
      for (const key of Reflect.ownKeys(target)) {
        if (typedArray && typeof key === 'string' && isIndexKey(key)) continue
        const descriptor = Object.getOwnPropertyDescriptor(target, key)
        if (descriptor && 'value' in descriptor) pushChild(descriptor.value, owner)
      }
    }
  }

  const wrap = (value: unknown, owner: OwnerMark | undefined): unknown => {
    value = unwrap(value)
    if (!isObject(value)) return value
    const target = value
    const collection = isMapLike(target) || isSetLike(target)
    if (!collection && isBuiltinObject(target)) return target
    markOwner(target, owner)
    const cached = cache.proxies.get(target)
    if (cached) return cached
    const proxy = collection ? createCollectionProxy(target as Map<unknown, unknown> | Set<unknown>) : createObjectProxy(target)
    cache.proxies.set(target, proxy)
    cache.targets.set(proxy, target)
    return proxy
  }

  const createObjectProxy = (target: object): object => {
    const array = Array.isArray(target)
    const prototype = Object.getPrototypeOf(target)
    // 非普通实例（类实例、类型化数组）：方法必须绑定原始接收者，否则 #private / 内部槽位取不到
    const bindMethods = !array && prototype !== Object.prototype && prototype !== null
    const methods = new Map<PropertyKey, { raw: unknown; invoke: unknown }>()

    return new Proxy(target, {
      get(obj, key) {
        // Proxy 不变量：不可配置且不可写的自有数据属性必须原样返回（有意的追踪空洞）
        const locked = lockedOwnValue(obj, key)
        if (locked.locked) return locked.value
        const raw = Reflect.get(obj, key, obj)
        if (typeof raw === 'function') {
          if (!bindMethods || key === 'constructor') return raw
          const cached = methods.get(key)
          if (cached !== undefined && cached.raw === raw) return cached.invoke
          const invoke = (...args: unknown[]): unknown => {
            report(obj)
            const result = Reflect.apply(
              raw,
              obj,
              args.map((arg) => deepUnwrap(arg)),
            )
            // builder 方法常返回 this / 新容器：返回裸对象会让链式调用绕过追踪。
            // 但只包装可能属于状态树的值（this/数组/纯对象/Map/Set）：Promise 等 thenable 必须原样返回，
            // 否则 await 会重新进入 get 陷阱、mutation 计数重复，且 Promise 身份被破坏
            if (result === obj) return wrap(result, ownerOf(obj))
            if (result === null || typeof result !== 'object') return result
            if (Array.isArray(result) || isMapLike(result) || isSetLike(result)) return wrap(result, ownerOf(obj))
            const prototype = Object.getPrototypeOf(result)
            if (prototype === Object.prototype || prototype === null) return wrap(result, ownerOf(obj))
            return result
          }
          methods.set(key, { raw, invoke })
          return invoke
        }
        if (!isObject(raw)) return raw
        return wrap(raw, childOwner(obj, key))
      },
      set(obj, key, next) {
        const value = deepUnwrap(next)
        const success = Reflect.set(obj, key, value)
        if (success) {
          // 任意层级的赋值都可能引入新别名：根级用本次键，嵌套层级用持有者的归属键。
          // 与既有归属冲突时标记 ambiguous，之后经共享对象的写入保守上报全部顶层键（宁多报，不漏报）
          if (isObject(value)) {
            markOwner(value, obj === root ? (key as OwnerKey) : ownerOf(obj))
          }
          report(obj, key)
        }
        return success
      },
      deleteProperty(obj, key) {
        const success = Reflect.deleteProperty(obj, key)
        if (success) report(obj, key)
        return success
      },
      defineProperty(obj, key, descriptor) {
        const normalized = 'value' in descriptor ? { ...descriptor, value: deepUnwrap(descriptor.value) } : descriptor
        const success = Reflect.defineProperty(obj, key, normalized)
        if (success) report(obj, key)
        return success
      },
    })
  }

  const createCollectionProxy = (target: Map<unknown, unknown> | Set<unknown>) => {
    const methods = new Map<PropertyKey, { raw?: unknown; fn: unknown }>()
    /** 集合所属的顶层键；根集合（ROOT_MARK）没有归属，其子对象写入走全量兜底 */
    const collectionOwner = (holder: object): OwnerMark | undefined => {
      const owner = ownerOf(holder)
      return owner === ROOT_MARK ? undefined : owner
    }
    /** 集合上新增/替换的容器值登记归属（与对象代理 set 陷阱同口径） */
    const markAssigned = (holder: object, value: unknown): void => {
      if (isObject(value)) markOwner(value, collectionOwner(holder))
    }
    const proxy: object = new Proxy(target, {
      get(obj, key) {
        // Proxy 不变量：不可配置且不可写的自有数据属性必须原样返回
        const locked = lockedOwnValue(obj, key)
        if (locked.locked) return locked.value
        const raw = Reflect.get(obj, key, obj)
        // 集合自定义自有属性：对象值包装后再读走脏跟踪，函数/原始值原样返回（不绑定）
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          if (typeof raw === 'function' || !isObject(raw)) return raw
          return wrap(raw, collectionOwner(obj))
        }
        const cached = methods.get(key)
        if (cached !== undefined && (cached.raw === undefined || cached.raw === raw)) return cached.fn

        if (key === 'size' || key === 'constructor') return raw
        if (typeof raw !== 'function') return raw

        // 归属键必须在每次调用时重算：owner 可能在方法闭包缓存后变成 AMBIGUOUS
        const childMark = (): OwnerMark | undefined => collectionOwner(obj)

        if (key === 'set' && isMapLike(obj)) {
          const fn = (entryKey: unknown, value: unknown) => {
            // 容器内嵌代理递归解包
            const rawKey = deepUnwrap(entryKey)
            const rawValue = deepUnwrap(value)
            markAssigned(obj, rawKey)
            markAssigned(obj, rawValue)
            obj.set(rawKey, rawValue)
            report(obj)
            return proxy
          }
          methods.set(key, { fn })
          return fn
        }
        if (key === 'add' && isSetLike(obj)) {
          const fn = (value: unknown) => {
            const rawValue = deepUnwrap(value)
            markAssigned(obj, rawValue)
            obj.add(rawValue)
            report(obj)
            return proxy
          }
          methods.set(key, { fn })
          return fn
        }
        if (key === 'delete') {
          const fn = (value: unknown) => {
            const deleted = obj.delete(unwrap(value))
            if (deleted) report(obj)
            return deleted
          }
          methods.set(key, { fn })
          return fn
        }
        if (key === 'clear') {
          const fn = () => {
            const changed = obj.size > 0
            obj.clear()
            if (changed) report(obj)
          }
          methods.set(key, { fn })
          return fn
        }
        if (key === 'has') {
          // has 此前走白名单外兜底绑定、参数不解包：get 用代理键命中而 has 不命中
          const fn = (entryKey: unknown) => obj.has(unwrap(entryKey))
          methods.set(key, { fn })
          return fn
        }
        if (key === 'get' && isMapLike(obj)) {
          const fn = (entryKey: unknown) => wrap(obj.get(unwrap(entryKey)), childMark())
          methods.set(key, { fn })
          return fn
        }
        if (key === 'forEach') {
          const fn = (callback: (value: unknown, key: unknown, collection: object) => void, thisArg?: unknown) => {
            obj.forEach((value: unknown, entryKey: unknown) =>
              // 键/成员与值同口径包装：Map 对象键、Set 成员都可能被当作写入入口
              callback.call(thisArg, wrap(value, childMark()), wrap(entryKey, childMark()), proxy),
            )
          }
          methods.set(key, { fn })
          return fn
        }
        if (key === Symbol.iterator || key === 'entries' || key === 'keys' || key === 'values') {
          const entries = key === 'entries' || (key === Symbol.iterator && isMapLike(obj))
          const fn = function* () {
            let iterator: Iterable<unknown>
            if (entries) iterator = obj.entries()
            else if (key === 'keys') iterator = obj.keys()
            else iterator = obj.values()
            for (const item of iterator) {
              if (entries) {
                if (isMapLike(obj)) {
                  // Map 条目的对象键与值同口径包装
                  yield [wrap((item as unknown[])[0], childMark()), wrap((item as unknown[])[1], childMark())]
                } else {
                  const wrapped = wrap((item as unknown[])[0], childMark())
                  yield [wrapped, wrapped]
                }
              } else {
                // keys/members 与 values 同口径包装
                yield wrap(item, childMark())
              }
            }
          }
          methods.set(key, { fn })
          return fn
        }

        // 白名单外方法以原始集合为接收者绑定（子类自定义方法 / ES2025 方法）
        const bound = raw.bind(obj)
        methods.set(key, { raw, fn: bound })
        return bound
      },
      set(obj, key, next) {
        // 集合自定义属性写入此前完全逃逸脏跟踪：值递归解包后落库并上报
        const value = deepUnwrap(next)
        const success = Reflect.set(obj, key, value)
        if (success) {
          markAssigned(obj, value)
          report(obj, key)
        }
        return success
      },
      deleteProperty(obj, key) {
        const success = Reflect.deleteProperty(obj, key)
        if (success) report(obj, key)
        return success
      },
      defineProperty(obj, key, descriptor) {
        const normalized = 'value' in descriptor ? { ...descriptor, value: deepUnwrap(descriptor.value) } : descriptor
        const success = Reflect.defineProperty(obj, key, normalized)
        if (success) report(obj, key)
        return success
      },
    })
    return proxy
  }

  cache.owners.set(root, ROOT_MARK)
  indexInitialOwners()
  const rootProxy = wrap(root, ROOT_MARK)
  return rootProxy as object
}
