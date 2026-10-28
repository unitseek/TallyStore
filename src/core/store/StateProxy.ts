/** StateProxy - 状态保护代理 */

import type { State } from '../../types/store.js'
import type { InternalStateProtectionConfig, ProxyCache } from './types.js'
import { isProduction, createMutationErrorMessage } from './utils.js'
import { TallyStoreError, ErrorCode } from '../errors/TallyStoreError.js'
import { isIndexKey } from '../utils/clone.js'
import { deepUnwrapContainers } from '../utils/deepUnwrap.js'
import {
  ARRAY_MUTATING_METHODS,
  bindMethodToOwner,
  createBoundMethodCache,
  isBuiltinObject,
  isMapLike,
  isSetLike,
  lockedOwnValue,
  type BoundMethodCache,
} from './proxyCore.js'

/** 根状态在错误消息里的可读名称：空路径无法定位「哪个对象被改」 */
const ROOT_PATH_LABEL = '<root>'

function displayPath(path: string): string {
  return path === '' ? ROOT_PATH_LABEL : path
}

/** Map/Set 的联合形状（两者的白名单方法名有交集，按集合种类分派） */
type CollectionTarget = Map<unknown, unknown> | Set<unknown>

/** StateProxy 配置选项（库内类型，不对外导出） */
interface StateProxyOptions {
  protection: InternalStateProtectionConfig
  proxyCache: ProxyCache
  isInternalAccess: () => boolean
  /**
   * 非法直写的上报通道：生产期无论降级档位（error/warn/silent）都必须经此上报，
   * silent 只关闭控制台输出、不得关闭上报。开发期直接抛错，无需上报。
   */
  onIllegalMutation?: (error: unknown, path: string) => void
}

/** StateProxy 管理器 */
export class StateProxyManager<S extends State = State> {
  private readonly _protection: InternalStateProtectionConfig
  private readonly _proxyCache: ProxyCache
  private readonly _isInternalAccess: () => boolean
  private readonly _onIllegalMutation?: (error: unknown, path: string) => void
  /** 已绑定到原始接收者的方法缓存（按 owner/key/底层函数复用） */
  private readonly _boundMethods: BoundMethodCache = createBoundMethodCache()
  /**
   * 代理 → 原始对象。Map/Set 的 has / get / delete / set / add 可能收到本管理器产出的
   * 代理（如把 get 出来的值当 key），方法实现前必须先反查原始对象，否则内部槽位比较失败。
   */
  private readonly _proxyTargets: WeakMap<object, object> = new WeakMap()
  /**
   * set 陷阱透传 receiver 时，引擎的 OrdinarySet 还会对 receiver 再走一次 [[DefineOwnProperty]]，
   * 即本管理器的 defineProperty 陷阱。这里记录正在执行的反射写入，避免同一次非法写重复上报。
   */
  private readonly _forwardedSets: Array<{ target: object; key: string | symbol }> = []

  constructor(options: StateProxyOptions) {
    this._protection = options.protection
    this._proxyCache = options.proxyCache
    this._isInternalAccess = options.isInternalAccess
    this._onIllegalMutation = options.onIllegalMutation
    // 处理器取值就地校验：配置可来自未类型化的 JS 调用方，落到默认分支会被静默升级为最严格模式
    const handler = options.protection.productionHandler
    if (handler !== 'error' && handler !== 'warn' && handler !== 'silent') {
      throw new TallyStoreError(
        ErrorCode.INVALID_CONFIG,
        '[TallyStore] StateProxyManager: productionHandler must be error | warn | silent, got ' + String(handler),
        { option: 'stateProtection.productionHandler', value: String(handler) },
      )
    }
  }

  /** 创建状态 Proxy（顶层入口） */
  createStateProxy(target: S, path: string): S {
    if (typeof target !== 'object' || target === null) {
      return target
    }

    const cached = this._proxyCache.get(target)
    if (cached) {
      return cached as S
    }

    // Map/Set 的写操作走内部槽位、不触发 [[Set]]，必须显式代理其变异方法；
    // 深/浅保护都保护集合本身（浅保护只是不再递归包装集合内部的值）
    if (isMapLike(target) || isSetLike(target)) {
      const proxy = this._createCollectionProxy(target as unknown as object, path)
      this._proxyCache.set(target, proxy)
      return proxy as S
    }

    // 其余内建对象不代理（见 isBuiltinObject）
    if (isBuiltinObject(target)) {
      return target
    }

    // 根数组也走数组代理：交给 _createDeepProxy 会让同一棵树出现两套数组行为。
    // 浅保护模式不改道：它的契约就是「只保护顶层」
    const proxy =
      Array.isArray(target) && this._protection.deep ? this._createArrayProxy(target as unknown as unknown[], path) : this._createDeepProxy(target, path)
    this._proxyCache.set(target, proxy)
    return proxy as S
  }

  /** 生成一组写保护陷阱（set / deleteProperty / defineProperty）。 */
  private _makeWriteTraps<T extends object>(formatPath: (key: string | symbol) => string): Pick<ProxyHandler<T>, 'set' | 'deleteProperty' | 'defineProperty'> {
    const self = this
    return {
      set(obj: T, key: string | symbol, value: unknown, receiver: object): boolean {
        if (!self._isInternalAccess()) {
          // 拒绝路径总是抛错；生产 warn/silent 处理后交给底层去写
          self._handleIllegalMutation(formatPath(key), value)
        }
        // 解包：本管理器产出的代理值不得写进裸状态（否则后续读取会二次包装、破坏对象身份与集合查找）；
        // receiver 必须透传：原型 setter 的 this 保持为代理，setter 内部的写入同样受陷阱保护
        self._forwardedSets.push({ target: obj, key })
        try {
          // Reflect.set 而非裸赋值：写陷阱必须如实报告底层是否写成功（目标被冻结/不可写时）
          // 降级写入前递归解包容器内夹带的代理
          return Reflect.set(obj, key, self._deepUnwrap(value), receiver)
        } finally {
          self._forwardedSets.pop()
        }
      },
      deleteProperty(obj: T, key: string | symbol): boolean {
        if (!self._isInternalAccess()) {
          self._handleIllegalMutation(formatPath(key), undefined, 'delete')
        }
        // 不可配置属性上 delete 会失败，恒返回 true 违反 Proxy 不变量
        return Reflect.deleteProperty(obj, key)
      },
      defineProperty(obj: T, key: string | symbol, descriptor: PropertyDescriptor): boolean {
        // set 陷阱透传 receiver 后，OrdinarySet 会再触发一次 defineProperty：那是同一次写入的
        // 反射步骤，不得重复上报（否则生产 warn/silent 一次非法写入会产生两条告警）
        const forwarded = self._isForwardedSet(obj, key)
        if (!self._isInternalAccess() && !forwarded) {
          // 访问器描述符没有 value 字段，按描述符种类给出可辨识的占位说明
          const attempted =
            'value' in descriptor
              ? descriptor.value
              : '[accessor descriptor: get=' + String(typeof descriptor.get === 'function') + ', set=' + String(typeof descriptor.set === 'function') + ']'
          self._handleIllegalMutation(formatPath(key), attempted, 'defineProperty')
        }
        // 降级写入同样可能携带嵌套代理；receiver 反射步骤的值已由 set 陷阱解包，
        // 这里跳过二次全树遍历
        const normalized = 'value' in descriptor && !forwarded ? { ...descriptor, value: self._deepUnwrap(descriptor.value) } : descriptor
        return Reflect.defineProperty(obj, key, normalized)
      },
    }
  }

  /** 创建深层 Proxy（递归保护嵌套对象） */
  private _createDeepProxy<T extends object>(target: T, path: string): T {
    if (!this._protection.deep) {
      return this._createShallowProxy(target, path)
    }

    const self = this

    const proxy = new Proxy(target, {
      /** 读取拦截：对象子值统一交 _readChild，函数按需要绑定原始接收者 */
      get(obj: T, key: string | symbol): unknown {
        const value = (obj as Record<string | symbol, unknown>)[key]

        // 非对象或 null：函数可能是非普通实例的方法，需绑定原始接收者后返回
        if (typeof value !== 'object' || value === null) {
          if (typeof value === 'function') {
            const descriptor = Object.getOwnPropertyDescriptor(obj, key)
            if (descriptor && !descriptor.configurable && 'value' in descriptor && !descriptor.writable) {
              return descriptor.value
            }
          }
          return self._bindMethod(obj, key, value)
        }

        return self._readChild(obj, key, value, path, false)
      },

      ...self._makeWriteTraps<T>((key) => self._joinChildPath(path, key, false)),
    })

    this._rememberProxy(proxy, target)
    return proxy
  }

  /** 拼接保护代理的子路径：bracket 决定数组口径（path[key]）还是对象口径（path.key）。 */
  private _joinChildPath(path: string, key: unknown, bracket: boolean): string {
    const name = String(key)
    if (bracket) {
      return path + '[' + name + ']'
    }
    return path === '' ? name : path + '.' + name
  }

  /**
   * 子值包装的唯一入口：原始值与内建对象原样返回 → 缓存复用 → 数组/对象/集合分流。
   * 路径拼接只在真正新建子代理（缓存 miss）时发生：读取热路径命中缓存时零字符串分配。
   */
  private _wrapChild(value: unknown, path: string, key: string | symbol, bracket: boolean): unknown {
    if (value === null || typeof value !== 'object') {
      return value
    }
    // 值已是本管理器的代理（生产降级写入后遗留）：直接返回自身，不能再包一层，
    // 否则代理套代理会破坏身份/集合查找并让路径与拦截重复
    if (this._proxyTargets.has(value)) {
      return value
    }
    const cached = this._proxyCache.get(value)
    if (cached !== undefined) {
      return cached
    }
    // Map/Set 必须交给集合代理；其它内建对象原样返回（不做代理，也无需拼路径）
    if (!isMapLike(value) && !isSetLike(value) && isBuiltinObject(value)) {
      return value
    }
    const childPath = this._joinChildPath(path, key, bracket)
    const proxy = this._createChildProxy(value, childPath)
    this._proxyCache.set(value, proxy)
    return proxy
  }

  /** 按值的实际类型创建子代理（集合 / 数组 / 普通对象）。 */
  private _createChildProxy(value: object, path: string): object {
    if (isMapLike(value) || isSetLike(value)) {
      return this._createCollectionProxy(value, path)
    }
    if (Array.isArray(value)) {
      return this._createArrayProxy(value as unknown[], path)
    }
    return this._createDeepProxy(value, path)
  }

  /** 读陷阱的统一入口：先兑现 Proxy 的 [[Get]] 不变量，再交 _wrapChild 包装。 */
  private _readChild(target: object, key: string | symbol, value: unknown, path: string, bracket: boolean): unknown {
    const locked = lockedOwnValue(target, key)
    if (locked.locked) {
      return locked.value
    }
    return this._wrapChild(value, path, key, bracket)
  }

  /** 非普通实例（类实例、类型化数组等）的方法绑定到原始接收者。 */
  private _bindMethod(owner: object | null, key: string | symbol, value: unknown): unknown {
    if (typeof value !== 'function' || owner === null) {
      return value
    }
    // 数组永远走 _createArrayProxy，不会以数组为 owner 进到这里
    const prototype = Object.getPrototypeOf(owner)
    if (prototype === Object.prototype || prototype === null) {
      return value
    }
    return bindMethodToOwner(this._boundMethods, owner, key, value)
  }

  /** 创建浅层 Proxy（仅保护顶层属性；可达的 Map/Set 仍保护其变异方法）。 */
  private _createShallowProxy<T extends object>(target: T, path: string): T {
    const self = this

    const proxy = new Proxy(target, {
      get(obj: T, key: string | symbol): unknown {
        const value = (obj as Record<string | symbol, unknown>)[key]
        // 集合的变异绕过属性陷阱，浅保护也必须返回集合代理（内部值不递归包装）
        if (value !== null && typeof value === 'object' && (isMapLike(value) || isSetLike(value))) {
          // 先兑现 [[Get]] 不变量：不可配置且不可写的自有数据属性必须原样返回，
          // 否则冻结状态上的 Map/Set 读取会抛 TypeError（深保护走 _readChild，已做同样检查）
          const locked = lockedOwnValue(obj as object, key)
          if (locked.locked) {
            return locked.value
          }
          return self._wrapChild(value, path, key, Array.isArray(target))
        }
        return value
      },
      // 浅保护包装的若是数组，索引路径与深保护保持同一口径（[0] 而不是 0）
      ...self._makeWriteTraps<T>((key) => self._joinChildPath(path, key, Array.isArray(target))),
    })

    this._rememberProxy(proxy, target)
    return proxy
  }

  /** 创建数组 Proxy */
  private _createArrayProxy<T extends unknown[]>(target: T, path: string): T {
    const self = this
    // 方法拦截闭包按 (数组, 方法名, 当前底层函数) 复用：
    // 每次读取都新建闭包会让 state.list.push === state.list.push 为 false
    const methodCache = new Map<string, { source: unknown; interceptor: (...args: unknown[]) => unknown }>()

    const proxy = new Proxy(target, {
      get(arr: T, key: string | symbol): unknown {
        // Symbol 键：函数值原样返回（Symbol.iterator 等需要原始 this 语义），对象值仍要包装
        if (typeof key === 'symbol') {
          return self._readChild(arr, key, (arr as Record<string | symbol, unknown>)[key], path, true)
        }

        // 严格规范十进制整数字符串判断（不允许前导零）：Number(key) 会把 ''/'1e2'/'0x10' 误当索引
        if (typeof key === 'string' && isIndexKey(key)) {
          return self._readChild(arr, key, arr[Number(key)], path, true)
        }

        if (key === 'length') {
          return arr.length
        }

        // 数组可以合法携带 list.sort = 'name-asc' 这类同名元数据，必须先判自有属性
        if (typeof key === 'string' && ARRAY_MUTATING_METHODS.has(key) && !Object.prototype.hasOwnProperty.call(arr, key)) {
          const source = (arr as unknown as Record<string, (...args: unknown[]) => unknown>)[key]
          const cached = methodCache.get(key)
          if (cached !== undefined && cached.source === source) {
            return cached.interceptor
          }
          const interceptor = function (...args: unknown[]) {
            if (!self._isInternalAccess()) {
              self._handleIllegalMutation(path, args, key)
            }
            // 生产 warn/silent 降级下参数原样进入裸数组会把保护代理写进状态：写入前解包；
            // 容器参数内的嵌套代理同样要递归解包
            return source.apply(
              arr,
              args.map((arg) => self._deepUnwrap(arg)),
            )
          }
          methodCache.set(key, { source, interceptor })
          return interceptor
        }

        // 其他属性（非索引/length/变异方法）：对象值同样需要包装保护
        return self._readChild(arr, key, (arr as Record<string | symbol, unknown>)[key], path, false)
      },

      ...self._makeWriteTraps<T>((key) => self._joinChildPath(path, key, true)),
    })

    this._rememberProxy(proxy, target)
    return proxy
  }

  /**
   * 创建 Map/Set 保护代理：
   * - 变异方法（Map.set/delete/clear、Set.add/delete/clear）走与属性写入相同的拦截路径；
   * - 读取路径包装对象值，保证经 get/forEach/迭代器取出的对象写入也被拦截；
   * - 其余方法以原始集合为接收者绑定返回，不包装、不拦截。
   */
  private _createCollectionProxy<T extends object>(target: T, path: string): T {
    const self = this
    const isMap = isMapLike(target)
    const methodCache = new Map<string | symbol, { source: unknown; method: unknown }>()

    const proxy = new Proxy(target, {
      get(obj: T, key: string | symbol): unknown {
        const raw = Reflect.get(obj as object, key, obj as object)
        // 自有属性（含运行期新增/覆盖的同名方法）优先：不能假设 get/set/... 一定是集合内建方法
        if (Object.prototype.hasOwnProperty.call(obj, key) || typeof raw !== 'function') {
          return self._readChild(obj as object, key, raw, path, false)
        }
        if (key === 'constructor') {
          return raw
        }
        // 缓存按「解析出的底层函数」失效：方法在运行期被替换时必须重建拦截器
        const cached = methodCache.get(key)
        if (cached !== undefined && cached.source === raw) {
          return cached.method
        }
        const method = self._createCollectionMethod(obj as unknown as CollectionTarget, key, isMap, path, proxy)
        if (method !== undefined) {
          methodCache.set(key, { source: raw, method })
          return method
        }
        // 白名单外的方法（含 ES2025 的 union 等）：绑定原始集合，不包装、不拦截
        const bound = raw.bind(obj as object)
        methodCache.set(key, { source: raw, method: bound })
        return bound
      },
      ...self._makeWriteTraps<T>((key) => self._joinChildPath(path, key, false)),
    })

    this._rememberProxy(proxy, target as object)
    return proxy
  }

  /** 集合实例方法的拦截/包装实现；返回 undefined 表示白名单外方法。 */
  private _createCollectionMethod(
    collection: CollectionTarget,
    key: string | symbol,
    isMap: boolean,
    path: string,
    proxy: object,
  ): ((...args: unknown[]) => unknown) | undefined {
    const self = this
    const map = collection as Map<unknown, unknown>
    const set = collection as Set<unknown>
    const guarded = (value: unknown, operation: string): void => {
      if (!self._isInternalAccess()) {
        self._handleIllegalMutation(path, value, operation)
      }
    }

    if (key === 'set' && isMap) {
      return (...args: unknown[]) => {
        const entryKey = self._deepUnwrap(args[0])
        const value = self._deepUnwrap(args[1])
        guarded(value, 'set')
        map.set(entryKey, value)
        return proxy
      }
    }
    if (key === 'add' && !isMap) {
      return (...args: unknown[]) => {
        const value = self._deepUnwrap(args[0])
        guarded(value, 'add')
        set.add(value)
        return proxy
      }
    }
    if (key === 'delete') {
      return (...args: unknown[]) => {
        guarded(undefined, 'delete')
        const entryKey = self._unwrap(args[0])
        return isMap ? map.delete(entryKey) : set.delete(entryKey)
      }
    }
    if (key === 'clear') {
      return () => {
        guarded(undefined, 'clear')
        if (isMap) {
          map.clear()
        } else {
          set.clear()
        }
      }
    }
    if (key === 'has') {
      return (...args: unknown[]) => {
        const entryKey = self._unwrap(args[0])
        return isMap ? map.has(entryKey) : set.has(entryKey)
      }
    }
    if (key === 'get' && isMap) {
      return (...args: unknown[]) => {
        const entryKey = self._unwrap(args[0])
        return self._wrapCollectionValue(map.get(entryKey), path, entryKey)
      }
    }
    if (key === 'forEach') {
      return (...args: unknown[]) => {
        const callback = args[0] as (value: unknown, entryKey: unknown, source: object) => void
        const thisArg = args[1]
        if (isMap) {
          map.forEach((entryValue, entryKey) => {
            // 深保护下对象键与对象值同口径包装：keys()/forEach 拿到的视图必须一致，写入才受保护
            callback.call(thisArg, self._wrapCollectionValue(entryValue, path, entryKey), self._wrapCollectionValue(entryKey, path, entryKey), proxy)
          })
        } else {
          let index = 0
          set.forEach((member) => {
            const wrapped = self._wrapCollectionValue(member, path, index++)
            callback.call(thisArg, wrapped, wrapped, proxy)
          })
        }
      }
    }
    if (key === 'values') {
      if (isMap) {
        return function* (): Generator<unknown, void, unknown> {
          for (const [entryKey, entryValue] of map) {
            yield self._wrapCollectionValue(entryValue, path, entryKey)
          }
        }
      }
      return function* (): Generator<unknown, void, unknown> {
        let index = 0
        for (const member of set) {
          yield self._wrapCollectionValue(member, path, index++)
        }
      }
    }
    if (key === 'keys') {
      if (isMap) {
        // 对象键与 values 同口径包装：keys() 拿到的原始对象写入会绕过保护
        return function* (): Generator<unknown, void, unknown> {
          for (const entryKey of map.keys()) {
            yield self._wrapCollectionValue(entryKey, path, entryKey)
          }
        }
      }
      // Set.keys 与 Set.values 同义
      return function* (): Generator<unknown, void, unknown> {
        let index = 0
        for (const member of set) {
          yield self._wrapCollectionValue(member, path, index++)
        }
      }
    }
    if (key === 'entries') {
      if (isMap) {
        return function* (): Generator<[unknown, unknown], void, unknown> {
          for (const [entryKey, entryValue] of map) {
            yield [self._wrapCollectionValue(entryKey, path, entryKey), self._wrapCollectionValue(entryValue, path, entryKey)]
          }
        }
      }
      return function* (): Generator<[unknown, unknown], void, unknown> {
        let index = 0
        for (const member of set) {
          const wrapped = self._wrapCollectionValue(member, path, index++)
          yield [wrapped, wrapped]
        }
      }
    }
    if (key === Symbol.iterator) {
      if (isMap) {
        return function* (): Generator<[unknown, unknown], void, unknown> {
          for (const [entryKey, entryValue] of map) {
            yield [self._wrapCollectionValue(entryKey, path, entryKey), self._wrapCollectionValue(entryValue, path, entryKey)]
          }
        }
      }
      // Set 的 Symbol.iterator 与 values 同义：逐个产出成员（entries 才产出二元组）
      return function* (): Generator<unknown, void, unknown> {
        let index = 0
        for (const member of set) {
          yield self._wrapCollectionValue(member, path, index++)
        }
      }
    }
    return undefined
  }

  /** 集合内部对象值的包装：浅保护不递归包装；深保护委托 _wrapChild，保证缓存/内建过滤/代理透传只有一份实现 */
  private _wrapCollectionValue(value: unknown, basePath: string, key: unknown): unknown {
    if (!this._protection.deep) {
      return value
    }
    return this._wrapChild(value, basePath, key as string | symbol, true)
  }

  /** 当前 defineProperty 调用是否只是 set 陷阱透传 receiver 产生的反射步骤。 */
  private _isForwardedSet(target: object, key: string | symbol): boolean {
    const last = this._forwardedSets[this._forwardedSets.length - 1]
    return last !== undefined && last.target === target && last.key === key
  }

  /** 代理参数反查原始对象：集合的 has/get/delete 必须按原始身份比较。 */
  private _unwrap(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
      return value
    }
    return this._proxyTargets.get(value) ?? value
  }

  /**
   * 递归解包容器内夹带的代理：生产 warn/silent 降级会放行写入，若值里嵌套着本管理器
   * 产出的代理（如 `state.box = { nested: state.child }`），直接落库会让后续读取二次包装、
   * 破坏身份/集合查找。遍历与脏跟踪层共用 deepUnwrapContainers。
   */
  private _deepUnwrap(value: unknown, seen?: WeakSet<object>): unknown {
    return deepUnwrapContainers(value, (entry) => this._proxyTargets.get(entry), seen)
  }

  /** 登记「代理 → 原始对象」，供 _unwrap 反查。 */
  private _rememberProxy(proxy: object, target: object): void {
    this._proxyTargets.set(proxy, target)
  }

  /** 处理非法状态修改 */
  private _handleIllegalMutation(path: string, value: unknown, operation: string = 'set'): void {
    const message = createMutationErrorMessage(displayPath(path), value, operation)

    if (isProduction()) {
      // 降级不静默——error/warn/silent 三档全部经 onError 上报；
      // silent 只关闭控制台输出，不得关闭上报
      this._reportIllegalMutation(message, path)
      switch (this._protection.productionHandler) {
        case 'error':
          throw new Error(message)
        case 'warn':
          console.warn(message)
          return // 允许操作继续，避免保护层自己抛
        case 'silent':
          return // 静默忽略（仅控制台），上报已在上面完成
      }
    }
    // 开发模式总是抛出错误
    throw new Error(message)
  }

  /** 生产期非法直写上报：上报通道自身抛错不得影响宿主流程 */
  private _reportIllegalMutation(message: string, path: string): void {
    const reporter = this._onIllegalMutation
    if (!reporter) return
    try {
      reporter(new Error(message), path)
    } catch {
      // 上报处理器异常时静默：降级路径的护栏自身不能再制造崩溃
    }
  }
}
