/** Store 内部工具函数 */

import { deepCloneState, isIndexKey, ownEnumerableKeys } from '../utils/clone.js'

/** 缓存的生产环境检测结果 */
let cachedProductionState: boolean | undefined

/** 微信小程序宿主上报运行环境的那部分形状（只声明用到的字段） */
interface WxAccountInfoHost {
  getAccountInfoSync?: () => { miniProgram?: { envVersion?: unknown } }
}

/** wx.getAccountInfoSync().miniProgram.envVersion 的三种取值（微信官方枚举） */
type MiniProgramEnvVersion = 'develop' | 'trial' | 'release'

/** 读取小程序宿主宣告的运行环境版本，读不到返回 undefined（不是「非生产」）。 */
function readMiniProgramEnvVersion(): MiniProgramEnvVersion | undefined {
  try {
    const wxGlobal = (globalThis as { wx?: WxAccountInfoHost }).wx
    if (!wxGlobal || typeof wxGlobal.getAccountInfoSync !== 'function') {
      return undefined
    }
    const info = wxGlobal.getAccountInfoSync()
    const version = info?.miniProgram?.envVersion
    if (version === 'develop' || version === 'trial' || version === 'release') {
      return version
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 检测当前运行环境是否为生产模式。
 *
 * 判定顺序：NODE_ENV → 构建期 __DEV__ → 小程序 envVersion（release/trial 均算生产）→ 兜底开发模式。
 * 首次判定后结果在当前模块实例内永久缓存：构建产物中的常量运行时不会变化。
 */
export function isProduction(): boolean {
  if (cachedProductionState !== undefined) {
    return cachedProductionState
  }

  // 1. 标准 Node.js 环境变量
  try {
    const nodeEnv = process.env.NODE_ENV
    if (nodeEnv) {
      cachedProductionState = nodeEnv === 'production'
      return cachedProductionState
    }
  } catch {
    // 受限环境忽略
  }

  // 2. 构建期 __DEV__ 全局标志。必须是裸标识符：打包器做文本替换，写成 globalThis.__DEV__ 会失效
  try {
    if (typeof __DEV__ !== 'undefined') {
      cachedProductionState = !__DEV__
      return cachedProductionState
    }
  } catch {
    // 小程序 AppService 全局是沙箱代理：未声明标识符连 typeof 都会抛 ReferenceError，
    // 不吞掉的话 isProduction() 在小程序里第一句就崩。此处继续走下一档
  }

  // 3. 小程序宿主宣告的运行环境：原生小程序唯一无需接入方注入的自动判据
  const envVersion = readMiniProgramEnvVersion()
  if (envVersion !== undefined) {
    cachedProductionState = envVersion !== 'develop'
    return cachedProductionState
  }

  // 4. 兜底按开发模式处理，确保状态保护默认开启
  cachedProductionState = false
  return cachedProductionState
}

/** 递归冻结状态（用于 $snapshot 等对外暴露的只读副本）。 */
export function deepFreezeState<T>(value: T, seen?: WeakSet<object>): T {
  if (value === null || typeof value !== 'object') {
    return value
  }

  const visited = seen ?? new WeakSet<object>()
  if (visited.has(value as object)) {
    return value
  }
  visited.add(value as object)

  // Array 子类实例在 deepCloneState 中走「保留原引用」降级路径（与活状态共享），
  // 必须同样排除，否则会递归冻结活状态的数组及其元素
  if (Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype) {
    const arr = value as unknown[]
    // 单趟枚举自有字符串键：一份 getOwnPropertyNames 同时覆盖下标/非下标与隐藏下标
    // （clone 会按描述符复制隐藏下标）；非下标键只冻结可枚举的（与 clone 口径一致）
    for (const key of Object.getOwnPropertyNames(arr)) {
      if (key === 'length') continue
      if (!isIndexKey(key) && !Object.prototype.propertyIsEnumerable.call(arr, key)) continue
      deepFreezeState((arr as unknown as Record<PropertyKey, unknown>)[key], visited)
    }
    // 符号键没有下标语义，与克隆口径一致：只冻结可枚举的
    for (const symbol of Object.getOwnPropertySymbols(arr)) {
      if (Object.prototype.propertyIsEnumerable.call(arr, symbol)) {
        deepFreezeState((arr as unknown as Record<PropertyKey, unknown>)[symbol], visited)
      }
    }
    try {
      Object.freeze(value)
    } catch {
      // 非可扩展对象冻结会抛错：跳过，不影响其余枝
    }
    return value
  }

  const proto = Object.getPrototypeOf(value as object)
  const isPlain = proto === Object.prototype || proto === null
  // 非纯对象整体跳过：
  // 1) class 实例等与活状态共享同一实例，冻结它等于经共享引用冻结活状态；
  // 2) Date/RegExp/Map/Set 的 mutator 不走 [[Set]] 陷阱，冻结只是装饰
  if (!isPlain) {
    return value
  }

  const record = value as Record<PropertyKey, unknown>
  // 键集必须与 deepCloneState 一致（含可枚举符号键），否则符号键下的嵌套对象在快照里仍可变
  for (const key of ownEnumerableKeys(value as object)) {
    deepFreezeState(record[key], visited)
  }
  try {
    Object.freeze(value)
  } catch {
    // 同上：冻结失败时保留可变引用，不拖垮快照
  }
  return value
}

/** 创建状态直接变异的错误消息（生产 warn/silent 依赖它不抛错） */
export function createMutationErrorMessage(path: string, value: unknown, operation: string): string {
  // BigInt / 循环引用等会让 stringify 抛 TypeError，掩盖真正的保护错误
  // 错误消息会进 console/onError 上报：非法写入的值可能是整棵状态树，序列化必须截断
  const MAX_SERIALIZED_LENGTH = 512
  let raw: string
  try {
    const json = JSON.stringify(value) as string | undefined
    raw = json === undefined ? String(value) : json
  } catch {
    // String() 会走 Symbol.toPrimitive / toString，这些钩子自身可以抛，故最后只用 typeof 拼串
    try {
      raw = String(value)
    } catch {
      raw = '<unserializable ' + typeof value + '>'
    }
  }
  // JSON 与 String 回退两条路径统一截断：toString 返回巨大字符串也不得把错误消息撑爆
  const serialized = raw.length > MAX_SERIALIZED_LENGTH ? raw.slice(0, MAX_SERIALIZED_LENGTH) + '…' : raw
  return (
    '[TallyStore] Direct mutation of state "' +
    path +
    '" is prohibited. Use setState() or $patch() methods instead.\n' +
    'Operation: ' +
    operation +
    '\n' +
    'Attempted value: ' +
    serialized
  )
}

/** 深拷贝状态 */
export { deepCloneState }
