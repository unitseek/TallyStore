/**
 * 敏感键清单与脱敏：库内置常见敏感键模式，命中即视为敏感字段。
 *
 * 口径：
 * - 命中规则是大小写不敏感的子串匹配（`userPhone` / `accessToken` / `id_card_no` 均命中）；
 * - 清单可扩展（`addSensitiveKeyPatterns`）并影响持久化落盘审计与开发期日志脱敏；
 * - 这是**最低限度的护栏**：防误用、降低泄漏面，不承诺安全隔离（见 SECURITY.md 威胁模型）；
 * - `maskSensitiveValue` 露出位数随长度收紧：≤10 位全遮，11~15 位保留首 1 + 尾 2，
 *   ≥16 位保留首 3 + 尾 4（可辨识、不可还原）；
 * - 日志脱敏遍历深度上限 4 层：超层子树以 `'[MaxDepth]'` 占位（fail-closed，不原样放行）；
 */

/** 内置敏感键模式（小写子串命中；命中即视为敏感字段，不落盘、日志脱敏） */
export const DEFAULT_SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  // 手机号 / 电话
  /phone|mobile|telephone/,
  // 凭证类：token / 密钥 / 会话凭证
  /token|secret|credential|apikey|api_key|sessionkey|session_key|privatekey/,
  // 密码
  /password|passwd|pwd/,
  // 证件号 / 身份
  /idcard|id_card|idnumber|id_number|idno|id_no|certno|cert_no|identity/,
  // 完整地址
  /address/,
  // 银行卡 / 账号
  /bankcard|bank_card|cardno|card_no|cardnumber|card_number|bankaccount/,
]

/** 日志脱敏遍历深度上限：第 5 层起不再展开（超层截断为 `[MaxDepth]`；落盘审计不设上限，见 findSensitiveKeysDeep） */
const MAX_TRAVERSAL_DEPTH = 4

/** 超过深度上限的占位串（日志中不输出原文） */
const MAX_DEPTH_PLACEHOLDER = '[MaxDepth]'

/** 当前生效的敏感键模式（模块级注册表；默认为内置清单） */
let activePatterns: RegExp[] = [...DEFAULT_SENSITIVE_KEY_PATTERNS]

/** 键名判定缓存：日志热路径逐键调用，正则×模式数是主要成本 */
const sensitiveKeyCache = new Map<string, boolean>()

/**
 * 缓存容量上限：缓存键来自任意日志/持久化载荷的字段名，可能是高基数
 * 或攻击者可控制的字符串；无界 Map 会在长生命周期的小程序 / 进程里持续增长。
 * 到顶后整体清空重建——缓存只是性能优化，清空的代价仅是按需重算，命中语义不变。
 */
export const SENSITIVE_KEY_CACHE_MAX_ENTRIES = 500

/** 超长键不缓存：键越长越可能是业务数据而非字段名，缓存收益下降而内存占用上升 */
export const SENSITIVE_KEY_CACHE_MAX_KEY_LENGTH = 64

/** 当前缓存条目数（测试 / 诊断用；模块级缓存在进程内共享） */
export function sensitiveKeyCacheSize(): number {
  return sensitiveKeyCache.size
}

/** 判断键名是否命中敏感键清单（键名做小写归一后子串匹配；结果按键名记忆化） */
export function isSensitiveKey(key: string): boolean {
  const cached = sensitiveKeyCache.get(key)
  if (cached !== undefined) {
    return cached
  }
  const normalized = key.toLowerCase()
  let hit = false
  for (const pattern of activePatterns) {
    if (pattern.test(normalized)) {
      hit = true
      break
    }
  }
  // 有界缓存：超长键直接绕过（不占内存）；到上限时整体清空重建
  if (key.length <= SENSITIVE_KEY_CACHE_MAX_KEY_LENGTH) {
    if (sensitiveKeyCache.size >= SENSITIVE_KEY_CACHE_MAX_ENTRIES) {
      sensitiveKeyCache.clear()
    }
    sensitiveKeyCache.set(key, hit)
  }
  return hit
}

/** 正则元字符转义：字符串模式按「字面量子串」注册（`employee(` / `a.b` 不再当正则/通配） */
function escapeRegExpLiteral(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 校验并归一化注册模式：
 * - 字符串按字面量子串处理（转义元字符），大小写不敏感；
 * - RegExp 去掉 `g`/`y`（否则 `test()` 推进 lastIndex，同一键反复判定结果抖动），并补 `i`
 *   与「键名先小写归一」口径对齐；
 * - 非法输入（空字符串 / 非 string / 非 RegExp）显式抛 `TypeError`。
 */
function normalizeSensitivePattern(pattern: unknown): RegExp {
  if (typeof pattern === 'string') {
    if (pattern.length === 0) {
      throw new TypeError('[TallyStore] addSensitiveKeyPatterns 不接受空字符串模式：空模式会命中全部键')
    }
    return new RegExp(escapeRegExpLiteral(pattern), 'i')
  }
  if (pattern instanceof RegExp) {
    // g/y 是有状态匹配标志：test() 会推进 lastIndex，缓存击穿后同一键可能漏检
    const flags = pattern.flags.replace(/[gy]/g, '')
    // 键名判定前统一 toLowerCase()：调用方的 /[A-Z]+/ 之类模式不加 i 永远无法命中
    return new RegExp(pattern.source, flags.includes('i') ? flags : flags + 'i')
  }
  throw new TypeError('[TallyStore] addSensitiveKeyPatterns 只接受 string 或 RegExp，收到 ' + typeof pattern)
}

/** 扩展敏感键清单（追加，不替换内置项）。扩展模式需同步 SECURITY.md 合规清单并走评审 */
export function addSensitiveKeyPatterns(patterns: readonly (RegExp | string)[]): void {
  // 先整体校验再一次性追加：非法项不得留下「部分生效」的半套清单
  const normalized = patterns.map((pattern) => normalizeSensitivePattern(pattern))
  activePatterns.push(...normalized)
  sensitiveKeyCache.clear()
}

/** 恢复内置敏感键清单（测试用；业务运行期不应调用） */
export function resetSensitiveKeyPatterns(): void {
  activePatterns = [...DEFAULT_SENSITIVE_KEY_PATTERNS]
  // 清单变化后缓存失效
  sensitiveKeyCache.clear()
}

/**
 * 脱敏单个值：长字符串保留可辨识前缀 + 末位，短值全遮。
 * - 长度 ≤10：`***`（短口令/短信码露出任何一位都可能致命，全遮）；
 * - 长度 11~15：首 1 + `***` + 尾 2；
 * - 长度 ≥16：首 3 + `***` + 尾 4；
 * - 非字符串：`***`。
 */
export function maskSensitiveValue(value: unknown): string {
  if (typeof value !== 'string') {
    return '***'
  }
  const length = value.length
  if (length <= 10) {
    return '***'
  }
  if (length >= 16) {
    return value.slice(0, 3) + '***' + value.slice(-4)
  }
  return value.slice(0, 1) + '***' + value.slice(-2)
}

/** 是否纯对象/数组（可安全遍历/复制的形态） */
const isTraversable = (value: object): boolean => {
  if (Array.isArray(value)) return true
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** 键名 → 敏感判定用的字符串（symbol 键按 `Symbol(desc)` 形态参与子串匹配） */
function sensitiveKeyNameOf(key: string | symbol): string {
  return typeof key === 'symbol' ? String(key) : key
}

/** 遍历自有可枚举符号键（不预分配合并数组：） */
function forEachOwnEnumerableSymbol(value: object, visit: (symbol: symbol) => boolean): void {
  const symbols = Object.getOwnPropertySymbols(value)
  for (const symbol of symbols) {
    if (!Object.prototype.propertyIsEnumerable.call(value, symbol)) continue
    if (visit(symbol)) return
  }
}

/**
 * 深度脱敏日志载荷：命中敏感键的值替换为脱敏串，其余原样保留。
 * 只走纯对象 / 数组（类实例、Map/Set 等原样传递——它们本就不该直接进日志），
 * 深度上限 4 层：到达上限的子树返回 `'[MaxDepth]'`（fail-closed，绝不原样输出深层敏感值）。
 *
 * 性能：先做低分配探测（containsSensitiveKey），无敏感键时**原样返回零拷贝**——
 * 日志热路径的常态是干净状态，脱敏克隆只在确有敏感键时发生。探测按自有键分两段
 * 遍历（Object.keys 后按需读符号键），不再为符号键合并数组；但为支持符号键，每个节点仍会
 * 调用一次 Object.getOwnPropertySymbols（返回空数组也是分配），注释不再宣称「无分配」。
 */
export function maskForLog(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || !isTraversable(value)) {
    return value
  }
  if (!containsSensitiveKey(value, depth)) {
    return value
  }
  return maskTraversed(value, depth)
}

/**
 * 无分配探测：子树内（含自身键名）是否存在敏感键；深度与 maskForLog 同口径。
 * 按自有可枚举键遍历（数组不再用 for...of）——数组自身的非下标键与符号键
 * 同样要按键名判定/递归，否则 logger 会把 `Object.assign([], { token })` 的值原样打印。
 */
function containsSensitiveKey(value: object, depth: number): boolean {
  // 到达深度上限：无法继续确认子树「干净」，按可能存在敏感键处理，
  // 让 maskTraversed 把该子树截断为 [MaxDepth]（fail-closed）
  if (depth >= MAX_TRAVERSAL_DEPTH) return true
  // 两段遍历：普通键直接走 Object.keys，符号键单独扫描，不为合并数组分配
  const stringKeys = Object.keys(value as Record<string, unknown>)
  for (const key of stringKeys) {
    if (isSensitiveKey(key)) {
      return true
    }
    const child = (value as Record<string, unknown>)[key]
    if (child !== null && typeof child === 'object' && isTraversable(child) && containsSensitiveKey(child, depth + 1)) {
      return true
    }
  }
  let symbolHit = false
  forEachOwnEnumerableSymbol(value, (symbol) => {
    if (isSensitiveKey(sensitiveKeyNameOf(symbol))) {
      symbolHit = true
      return true
    }
    const child = (value as Record<symbol, unknown>)[symbol]
    if (child !== null && typeof child === 'object' && isTraversable(child) && containsSensitiveKey(child, depth + 1)) {
      symbolHit = true
      return true
    }
    return false
  })
  return symbolHit
}

/**
 * 已确认含敏感键的子树：构建脱敏克隆。
 * 数组不再用 `map`（只走下标）——改为按自有可枚举键重建，数组自身挂的
 * 非下标键与符号键（console 会显示）也会被按键脱敏/递归脱敏，数组结构保持为数组。
 */
function maskTraversed(value: object, depth: number): unknown {
  if (depth >= MAX_TRAVERSAL_DEPTH) {
    return MAX_DEPTH_PLACEHOLDER
  }
  const isArray = Array.isArray(value)
  const masked: Record<string | symbol, unknown> = isArray ? (new Array((value as unknown[]).length) as unknown as Record<string | symbol, unknown>) : {}
  // 与探测同口径的两段遍历；defineProperty 写自有属性：
  // 键名为 "__proto__" 时普通赋值会走原型 setter，该条被静默丢弃且克隆对象的原型被载荷替换
  const defineMasked = (key: string | symbol): void => {
    const raw = (value as Record<string | symbol, unknown>)[key]
    Object.defineProperty(masked, key, {
      value: isSensitiveKey(sensitiveKeyNameOf(key)) ? maskSensitiveValue(raw) : maskForLog(raw, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    defineMasked(key)
  }
  forEachOwnEnumerableSymbol(value, (symbol) => {
    defineMasked(symbol)
    return false
  })
  return masked
}

/**
 * 落盘审计的展开谓词：镜像 JSON.stringify 实际会写出的结构（toJSON 在 collectSensitivePaths 处理）——
 * 数组 / 纯对象 / **类实例**都按自有可枚举键展开；Date/RegExp 序列化为原始值/{}，
 * Map/Set/WeakMap/WeakSet 序列化为 {}，都不展开（其内容本就不会以明文落盘）。
 * 与日志脱敏的 isTraversable（只走纯对象）刻意不同：审计必须覆盖「会被写进存储的明文」。
 */
function isAuditSerializableContainer(value: object): boolean {
  if (Array.isArray(value)) return true
  if (value instanceof Date || value instanceof RegExp) return false
  const tag = Object.prototype.toString.call(value)
  if (tag === '[object Map]' || tag === '[object Set]' || tag === '[object WeakMap]' || tag === '[object WeakSet]') return false
  // 其余对象（类实例 / null 原型 / 其他容器）都按自有可枚举键展开，与 JSON.stringify 一致；
  // 函数值不会出现在 JSON 输出里，由 typeof 检查排除
  return true
}

/** 审计路径的父链节点：按需格式化命中路径，避免为每个节点复制整段路径 */
interface AuditPathNode {
  parent: AuditPathNode | null
  segment: string | number
}

/** 父链 → 可读路径：`profile.phone`、`orders[0].cardNo` */
function formatSensitivePath(node: AuditPathNode): string {
  const segments: Array<string | number> = []
  let cursor: AuditPathNode | null = node
  while (cursor !== null) {
    segments.push(cursor.segment)
    cursor = cursor.parent
  }
  let path = ''
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i]
    if (typeof segment === 'number') {
      path += '[' + segment + ']'
    } else {
      path += path === '' ? segment : '.' + segment
    }
  }
  return path
}

/**
 * 迭代收集敏感键路径：显式工作栈替代递归——深层嵌套（长链/深数组）不再有
 * 调用栈溢出风险；路径用父链表示，单节点 O(1) 分配。
 *
 * 遍历顺序与递归先序一致（sibling 顺序稳定，命中路径输出顺序可断言）。
 */
function collectSensitivePaths(root: unknown, hits: string[]): void {
  type AuditTask = { kind: 'visit'; value: unknown; path: AuditPathNode | null } | { kind: 'hit'; path: AuditPathNode }
  const seen = new WeakSet<object>()
  const stack: AuditTask[] = [{ kind: 'visit', value: root, path: null }]
  while (stack.length > 0) {
    const task = stack.pop() as AuditTask
    if (task.kind === 'hit') {
      hits.push(formatSensitivePath(task.path))
      continue
    }
    const { value, path } = task
    if (value === null || typeof value !== 'object' || !isAuditSerializableContainer(value)) {
      continue
    }
    if (seen.has(value)) {
      continue
    }
    seen.add(value)
    // JSON.stringify 对有 toJSON() 的对象序列化其**返回值**（自有键被忽略）。
    // 审计必须镜像同一口径，否则带自定义序列化的类实例/信封对象会把敏感字段明文写入存储而漏检。
    // toJSON 自身抛错时不吞：由 persistence 侧错误边界 fail-closed 处理。
    const toJson = (value as { toJSON?: unknown }).toJSON
    if (typeof toJson === 'function') {
      stack.push({ kind: 'visit', value: (toJson as () => unknown).call(value), path })
      continue
    }
    // 按自有键遍历而不是按 length：稀疏数组 length 可达 2^32-1，按距离扫描会挂死审计。
    // 数组分支与对象分支共用「键名判定 + 递归」——非下标自有键（如
    // Object.assign([], { token })）同样按键名命中；符号键不遍历（JSON.stringify 不序列化
    // symbol 属性，落盘审计不应对「不会写出的数据」误报；日志脱敏侧另行覆盖符号键）
    const keys = Object.keys(value as object)
    // 逆序入栈，使弹出顺序等于正序（递归先序）：命中项作为独立任务保留其相对位置
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      const key = keys[i]
      const childPath: AuditPathNode = { parent: path, segment: Array.isArray(value) ? toAuditIndex(key) : key }
      if (isSensitiveKey(key)) {
        stack.push({ kind: 'hit', path: childPath })
        continue
      }
      stack.push({ kind: 'visit', value: (value as Record<string, unknown>)[key], path: childPath })
    }
  }
}

/** 数组自有键 → 数字下标（非数字自有键按字符串参与路径） */
function toAuditIndex(key: string): string | number {
  return /^(?:0|[1-9]\d*)$/.test(key) ? Number(key) : key
}

/**
 * 扫描待落盘载荷，返回命中敏感清单的**路径**（`profile.phone`、`orders[0].token`）。
 * 供持久化落盘审计复用：只返回路径、不做删除，由调用方决定拒绝/剔除策略。
 *
 * - 展开口径镜像 JSON.stringify：纯对象/数组/类实例按自有可枚举键遍历，
 *   Map/Set/Date/RegExp 等不展开；
 * - 循环引用只访问一次；不设深度上限——审计的职责就是把深层敏感字段也找出来；
 * - 迭代实现：显式工作栈，深嵌套载荷不会栈溢出；读取抛错（throwing getter /
 *   代理陷阱）会原样上抛，由调用方 fail-closed 处理（persistence 侧不再让异常逃逸）。
 * - 根是原始值时返回空数组。
 */
export function findSensitiveKeysDeep(value: unknown): string[] {
  const hits: string[] = []
  collectSensitivePaths(value, hits)
  return hits
}

/**
 * 兼容入口（对象形态）：语义与 `findSensitiveKeysDeep` 完全一致，保留既有调用方/类型签名。
 * @deprecated 新代码请直接用 `findSensitiveKeysDeep(value)`（接受任意形态载荷）。
 */
export function findSensitiveKeys(target: Record<string, unknown>): string[] {
  return findSensitiveKeysDeep(target)
}
