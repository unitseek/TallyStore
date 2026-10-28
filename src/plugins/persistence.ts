/** TallyStore - 持久化插件 */

import type { Store, State } from '../types/store.js'
import type { Plugin } from '../types/plugin.js'
import type { PersistenceOptions, StorageBackend } from '../types/plugins.js'
import { isPlainObject } from '../core/utils/helpers.js'
import { isProduction } from '../core/store/utils.js'
import { TallyStoreError, ErrorCode } from '../core/errors/TallyStoreError.js'
import { findSensitiveKeysDeep } from '../core/security/sensitiveKeys.js'
import { findUnserializablePaths } from '../core/utils/serializable.js'
import { assertSyncStorageResult, isWxStorageSyncAvailable, WxStorageBackend } from './WxStorageBackend.js'

// 子路径 @unitseek/tallystore/plugins/persistence 直接指向本模块：把默认后端一并暴露
export { WxStorageBackend }

/** setTimeout 上限（2^31-1 ms ≈ 24.8 天）：更大值会被宿主静默钳制为 ~1ms */
const MAX_TIMER_DELAY = 2 ** 31 - 1

/** 持久化写入防抖的默认值（毫秒）：0 = 变更即落盘。 */
const DEFAULT_PERSIST_DEBOUNCE_MS = 0

/** 配额告警阈值：微信单 key 上限 1MB，接近（≈88%）即告警 */
const PERSIST_QUOTA_WARN_BYTES = 900 * 1000

/** 版本信封的键名：值形态 { $tallyV: number, $tallyD: object } */
const ENVELOPE_VERSION_KEY = '$tallyV'
const ENVELOPE_DATA_KEY = '$tallyD'

/**
 * 已序列化 JSON 文本的 UTF-8 字节折算：直接对现成字符串计数而不是再次
 * JSON.stringify——quota 告警在每次保存的热路径上。
 *
 * 按码点遍历（for...of 会把代理对合成一个码点），与 helpers.estimateJsonBytes
 * 的编码口径一致：BMP 外字符（emoji 等）计 4 字节，而不是按两个码元各计 3 字节的 50% 高估。
 * （抽取共享 helper 需改 core/utils/helpers.ts，不在本批 write scope，见  备注）
 */
function utf8BytesOf(json: string): number {
  let bytes = 0
  for (const char of json) {
    const code = char.codePointAt(0) as number
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code < 0x10000) {
      bytes += 3
    } else {
      bytes += 4
    }
  }
  return bytes
}

/** 恢复入口的载荷准入判定。 */
function isRestorablePayload(value: unknown): boolean {
  return isPlainObject(value) && !Object.prototype.hasOwnProperty.call(value, '__proto__')
}

/**
 * 构造落盘载荷：未配置 schemaVersion 时保持裸状态，否则包成 { $tallyV, $tallyD } 信封。
 * 恢复侧种子化 lastSaved 与 saveState 必须共用本函数，否则两处序列化口径一旦漂移，
 * 卸载 flush 去重会再次静默失效（即卸载 flush 去重的回归面）。
 */
function buildPayload(schemaVersion: number | undefined, data: Record<string, unknown>): Record<string, unknown> {
  return schemaVersion === undefined ? data : { [ENVELOPE_VERSION_KEY]: schemaVersion, [ENVELOPE_DATA_KEY]: data }
}

/** 持久化插件。 */
// 使用工厂函数创建"可调用 + 可安装"的插件：
// - 作为函数调用时：persistencePlugin(options) 返回新的带配置 Plugin
// - 作为 Plugin 对象使用时：具有 name / install 属性（使用默认选项）
// 返回类型保留 S：若声明为 Plugin（即 Plugin<State>），显式传入的状态类型会被抹掉，
// 结果既无法赋给 store.use（其参数为 Plugin<自身状态类型>），也丢掉了 filter/validate
// 回调与状态类型的关联
const _persistencePluginFactory = <S extends State = State>(options?: PersistenceOptions<S>): Plugin<S> => ({
  name: 'persistence',
  install: (store) => installPersistence(store as unknown as Store<S>, options),
})

// 附加 Plugin 属性（使用 defineProperty 避免 name 属性只读限制）
Object.defineProperty(_persistencePluginFactory, 'name', {
  value: 'persistence',
  writable: true,
  configurable: true,
})
;(_persistencePluginFactory as unknown as Plugin).install = <S extends State>(store: Store<S>, pluginOptions?: PersistenceOptions<S>) =>
  installPersistence(store, pluginOptions)

/** 持久化插件（可作工厂直接调用） */
export const persistencePlugin: Plugin & {
  <S extends State = State>(options?: PersistenceOptions<S>): Plugin<S>
} = _persistencePluginFactory as Plugin & {
  <S extends State = State>(options?: PersistenceOptions<S>): Plugin<S>
}

/**
 * 持久化插件的安装实现。
 * 抽出为独立函数，便于工厂模式与直接安装模式复用同一份逻辑。
 */
function installPersistence<S extends State>(store: Store<S>, rawOptions?: PersistenceOptions<S> | null): () => void {
  const options: PersistenceOptions<S> = rawOptions ?? {}

  // 默认键只由 store.name 派生，**刻意不加随机后缀**：持久化的意义就是下次启动读回
  // 同一份数据，键必须在跨会话、跨进程重启后保持稳定，随机后缀会让 restore 永远落空。
  // 代价是两个 store 共享同一键时会互相覆盖：未命名 store 的名字来自模块级计数器
  // （`store-0`、`store-1`…），多份 bundle 各有一份计数器，而微信构建里重复打包本包是常态
  // （core 的 TALLYSTORE_BRAND / stateVersion 的 STATE_VERSION 都用 Symbol.for 跨副本兜底）。
  // 稳定与唯一在默认键这个层面不可兼得，故把选择权交回调用方：需要隔离就显式传 key，
  // 见 PersistenceOptions.key 的说明
  const {
    key = `tallystore_${store.name}`,
    filter,
    validate,
    restore: shouldRestore = true,
    // 命名常量的意义是把「为什么默认 0」留在代码里（见常量注释），而不是让 0 看起来像漏配
    debounce: debounceMs = DEFAULT_PERSIST_DEBOUNCE_MS,
    clearOnUninstall = false,
    schemaVersion,
    migrations,
  } = options
  const storageKey = typeof key === 'function' ? key(store.name) : key

  //  /：持久化必须显式声明 filter 白名单。
  // - filter === false：显式关闭——不解析 storage、不恢复、不订阅、不写盘/清理，
  //   返回幂等 no-op uninstall（不报错）；
  // - filter 缺省（或非函数/非 false 的非法值）：开发期抛 INVALID_CONFIG；生产期经
  //   onError(INVALID_CONFIG, 'persistence') 上报后按「禁用持久化」处理。
  // 两种禁用路径都必须在解析 storage 之前返回：保证 getItem/setItem/removeItem 零调用。
  if (filter === false) {
    if (!isProduction()) {
      console.log('[TallyStore][persistence] filter: false，已显式关闭持久化（store "' + store.name + '"）')
    }
    return () => {}
  }
  if (typeof filter !== 'function') {
    const message =
      '[TallyStore][persistence] 必须显式提供 filter 白名单（((state) => Partial<state>)），或传 filter: false 显式关闭持久化；' +
      '默认不落盘任何字段，禁止自动全量持久化。store: "' +
      store.name +
      '"'
    const error = new TallyStoreError(ErrorCode.INVALID_CONFIG, message, { storeName: store.name, key: storageKey })
    if (!isProduction()) {
      throw error
    }
    store.hooks.emit('onError', error, 'persistence')
    return () => {}
  }
  const filterFn = filter
  if (!isProduction()) {
    console.log(`[TallyStore] Plugin "persistence" installed`)
  }

  //  未知选项告警：拼错的选项名此前被静默忽略（如把 schemaVersion 写成
  // schemaVerion），配置完全失效且无从发现。开发期 console + 两期 onError 上报
  const KNOWN_OPTION_KEYS = new Set(['key', 'storage', 'filter', 'validate', 'restore', 'debounce', 'clearOnUninstall', 'schemaVersion', 'migrations'])
  for (const optionKey of Object.keys(options)) {
    if (KNOWN_OPTION_KEYS.has(optionKey)) continue
    const message = '[TallyStore][persistence] 未识别的选项 "' + optionKey + '"（key: ' + storageKey + '）：将被忽略；请检查拼写，可用选项见 PersistenceOptions'
    if (!isProduction()) {
      console.warn(message)
    }
    store.hooks.emit('onError', new TallyStoreError(ErrorCode.INVALID_CONFIG, message, { key: storageKey, option: optionKey }), 'persistence')
  }
  //  配额告警（单 key ≤ 1MB）：接近上限只告警一次，超限写入交给后端抛错的既有兜底
  let quotaWarned = false
  const warnQuotaOnce = (bytes: number): void => {
    if (quotaWarned || bytes < PERSIST_QUOTA_WARN_BYTES) return
    quotaWarned = true
    const message = '[TallyStore][persistence] 落盘约 ' + bytes + 'B 接近单 key 上限 1MB（' + storageKey + '）：写满将抛错，请收缩 filter 或拆分大字段'
    if (!isProduction()) {
      console.warn(message)
    }
    reportPersistenceError('save', message)
  }

  /**
   * 统一上报出口：持久化各阶段失败都带 `PERSISTENCE_ERROR` 码与阶段上下文，
   * cause 保留原始错误。message 保留原始错误文本，调用方按消息/cause 排障的口径不变。
   */
  function reportPersistenceError(phase: 'init' | 'restore' | 'save' | 'uninstall', message: string, cause?: unknown): void {
    store.hooks.emit(
      'onError',
      new TallyStoreError(ErrorCode.PERSISTENCE_ERROR, message, { storeName: store.name, key: storageKey, phase }, cause),
      'persistence',
    )
  }

  // 解析存储后端：传入 storage 时必须完整实现三个同步方法（缺一即在安装期抛错），
  // 否则使用微信小程序的 wx.getStorageSync / setStorageSync / removeStorageSync；
  // 非微信环境（如测试/Node）wx 不存在，降级为内存存储避免 ReferenceError
  //
  // 默认后端就是同目录的 `WxStorageBackend`（与显式传 `storage: new WxStorageBackend()`
  // 同一个实现）：不要再写内联适配器把「wx 缺失键返回 ''」和「返回值是 Promise」
  // 两件事各判一遍口径，与类里的实现随时会漂移
  const userStorage = options.storage
  let storageAdapter: StorageBackend
  if (userStorage !== undefined && userStorage !== null) {
    // 安装期一次性校验三个方法形状：只检查 getItem 时，缺 setItem / removeItem 的后端
    // （只读适配器、键名拼错的对象）会把错误推迟到首次落盘，抛出的
    // `backend.setItem is not a function` 又被 saveState 的 try/catch 吞成一条日志，
    // 卸载时的 removeItem 更是静默失败——调用方始终不知道用错了后端。
    // 也不能「校验不通过就悄悄改用 wx / 内存」：那会把数据写到另一个后端，
    // 比立刻报错更难排查，故此处直接抛错（与 assertSyncStorageResult 同一严格口径）
    const requiredMethods = ['getItem', 'setItem', 'removeItem'] as const
    const candidate = userStorage as Partial<StorageBackend>
    const missing = requiredMethods.filter((method) => typeof candidate[method] !== 'function')
    if (missing.length > 0) {
      throw new TypeError(
        `[TallyStore][persistence] storage 选项必须同时提供 ${requiredMethods.join(' / ')} 三个同步方法，` +
          `当前缺少或不是函数：${missing.join(' / ')}。` +
          `接入微信小程序存储请传 new WxStorageBackend()；不传 storage 时本插件会自动使用 wx 同步 API（无 wx 则降级为内存存储）。`,
      )
    }
    // 形状校验通过后按 StorageBackend 契约调用；再包一层用于拦截异步返回值，
    // 避免恢复/保存被静默丢弃。
    // 异步检测只在实际调用点进行、不在安装期预判 Promise 返回值：后端可以合法地
    // 「同步 getItem + 异步 setItem」（Promise 包装的 localStorage），安装期只探 getItem
    // 会把这种混合后端误判为同步；且后端可在运行期被换实现
    const backend = userStorage
    storageAdapter = {
      getItem: (k: string) => {
        const value = backend.getItem(k)
        assertSyncStorageResult(value, 'storage.getItem')
        return value
      },
      setItem: (k: string, v: string) => {
        const result = backend.setItem(k, v)
        assertSyncStorageResult(result, 'storage.setItem')
      },
      removeItem: (k: string) => {
        const result = backend.removeItem(k)
        assertSyncStorageResult(result, 'storage.removeItem')
      },
    }
  } else if (isWxStorageSyncAvailable()) {
    // 微信小程序 wx 为全局变量，读取与「可用性判定」都在 `WxStorageBackend.ts` 单点完成
    // （isWxStorageSyncAvailable 要求三个方法齐备，与本函数上方对用户后端的形状校验同口径）。
    // 本类自带两道防护，与旧内联适配器一致：异步返回值报错（wx.setStorageSync 等
    // 由兼容层 polyfill 成 Promise 时不再留下无人处理的 rejection 并静默丢数据）、
    // 缺失键的 `''` 与非字符串载荷归一为 null
    storageAdapter = new WxStorageBackend()
  } else {
    // 降级：进程内存存储（重启即失，仅保证不抛错）
    const degradeMessage =
      '[TallyStore][persistence] 未检测到可用的 storage 后端（非微信环境、wx 同步 API 不齐备，且未传入 storage），降级为内存存储，持久化不生效'
    if (!isProduction()) {
      console.warn(degradeMessage)
    } else {
      // 生产环境不刷控制台，但必须留一个可编程感知的信号：否则持久化彻底静默失效
      // （恢复读不到数据、保存成功写进下面的 Map 并随进程消失），H5/SSR 与「被摇树
      // 丢掉 storage 配置」的场景调用方完全无从发现
      reportPersistenceError('init', degradeMessage)
    }
    const memoryMap = new Map<string, string>()
    // 内存后端无需 assertSyncStorageResult：三个方法的返回值都由本闭包产出
    // （`?? null` / `void` 归一为 undefined），外部实现不可能在这里返回 Promise，
    // 包一层只是永不命中的死分支
    storageAdapter = {
      getItem: (k: string) => memoryMap.get(k) ?? null,
      setItem: (k: string, v: string) => void memoryMap.set(k, v),
      removeItem: (k: string) => void memoryMap.delete(k),
    }
  }

  // 恢复后「待吸收」的序列化载荷：notify.async 下 $patch 的合并通知是微任务，
  // 会打到下方安装后才注册的订阅上。该通知只承载「恢复本身」的内容，不应触发回写——
  // 否则安装后立即覆写同一 tick 内其他实例写入的新数据，且每次启动都重写磁盘
  // （lastSaved 去重被绕过）。仅在首次通知且内容与恢复结果一致时吸收一次
  let absorbedSerialized: string | null = null
  // lastSaved 提前到恢复块之前：恢复成功后需要用它种子化，让卸载 flush 的去重覆盖恢复载荷
  let lastSaved: string | null = null

  /** 「恢复被主动跳过」的出口：控制台留痕 + 转投 `onError`。 */
  function skipRestore(reason: string): void {
    if (!isProduction()) {
      console.error(reason)
    }
    reportPersistenceError('restore', reason)
  }

  /**
   *  版本信封解包与迁移：
   * - 信封形态 { $tallyV, $tallyD }：按 migrations 链从 savedV+1 逐版迁升到当前版本；
   * - 存储版本高于当前（降级安装）或缺步/抛错：上报后返回 null（回退默认值，不注入坏数据）；
   * - 裸对象（未配置版本化的历史数据）：原样返回，不迁移。
   *
   * 额外返回 `pendingUpgrade`：恢复载荷是否需要「升级写回」——迁移链执行过，
   * 或裸对象遇到已配置 schemaVersion（需要补信封）。此类恢复不能种子化 lastSaved，
   * 否则卸载 flush 去重会跳过升级写入，存储永远停在旧 $tallyV、每次启动重跑迁移。
   */
  interface UnwrappedEnvelope {
    data: Record<string, unknown>
    pendingUpgrade: boolean
  }
  const unwrapEnvelope = (parsed: Record<string, unknown>): UnwrappedEnvelope | null => {
    const hasVersion = Object.prototype.hasOwnProperty.call(parsed, ENVELOPE_VERSION_KEY) && typeof parsed[ENVELOPE_VERSION_KEY] === 'number'
    if (!hasVersion) {
      // 有数据字段却没有合法版本号：信封已损坏（写坏 / 被外部改写过，或未来换了版本字段类型）。
      // 不能当裸对象原样 $patch 进状态——那会把 { $tallyV, $tallyD } 的坏结构当业务字段注入；
      // 与其它迁移失败同口径：上报后跳过恢复、保持默认值
      if (Object.prototype.hasOwnProperty.call(parsed, ENVELOPE_DATA_KEY)) {
        skipRestore('[TallyStore][persistence] 版本信封损坏（$tallyV 缺失或非数字，key: ' + storageKey + '）：跳过恢复（保持默认值）')
        return null
      }
      // 裸对象：未配置 schemaVersion 就原样恢复；配置了则恢复后还需补信封（升级写回）
      return { data: parsed, pendingUpgrade: schemaVersion !== undefined }
    }
    const savedV = parsed[ENVELOPE_VERSION_KEY] as number
    const data = parsed[ENVELOPE_DATA_KEY]
    if (!isRestorablePayload(data)) {
      skipRestore('[TallyStore] Versioned payload data is not a plain object, skipping restore')
      return null
    }
    let current = data as Record<string, unknown>
    const targetV = schemaVersion ?? savedV
    if (savedV > targetV) {
      skipRestore(
        '[TallyStore][persistence] 存储数据版本 v' +
          savedV +
          ' 高于当前 schemaVersion v' +
          targetV +
          '（key: ' +
          storageKey +
          '）：不支持降级恢复，本次跳过（保持默认值）',
      )
      return null
    }
    for (let v = savedV + 1; v <= targetV; v++) {
      const step = migrations?.[v]
      if (typeof step !== 'function') {
        skipRestore(
          '[TallyStore][persistence] 缺少 v' +
            v +
            ' 的迁移函数（schemaVersion v' +
            targetV +
            '，key: ' +
            storageKey +
            '）：迁移链不完整，本次跳过（保持默认值）',
        )
        return null
      }
      try {
        const migrated = step({ ...current })
        if (!isRestorablePayload(migrated)) {
          throw new TypeError('migration v' + v + ' returned non-plain object')
        }
        current = migrated
      } catch (error) {
        skipRestore(
          '[TallyStore][persistence] 迁移到 v' +
            v +
            ' 失败（key: ' +
            storageKey +
            '）：回退默认值，不注入坏数据 — ' +
            (error instanceof Error ? error.message : String(error)),
        )
        return null
      }
    }
    // 迁移链执行过（savedV < targetV）则恢复后必须把升级后的信封写回存储
    return { data: current, pendingUpgrade: savedV < targetV }
  }

  /**
   * 应用恢复载荷：$patch 合并 + 记录恢复自身的吸收序列化与 lastSaved 去重基线。
   * 调用前必须保证载荷是纯对象（非纯对象由恢复路径在调用前拒绝）。
   *
   * @param pendingUpgrade 存储载荷是否需要升级写回（迁移链执行过 / 裸对象补信封）
   */
  function applyRestoredState(filteredState: Partial<S>, pendingUpgrade: boolean): void {
    // 恢复时使用 $patch 合并语义：filter 可能只持久化了部分键，
    // 若用 $replaceState 整体替换会丢失未持久化的运行时键（如 UI 态/临时态）
    store.$patch(filteredState)
    // 记下恢复后的序列化内容，供订阅回调吸收恢复自身的延迟通知。
    // 用序列化比较而非状态版本：克隆/只读代理等载荷形态下版本号不可见
    try {
      // 复用同一份 filter 结果：吸收比较用裸状态序列化，lastSaved 用与 saveState 一致的
      // 比较口径（配置 schemaVersion 时是 { $tallyV, $tallyD } 信封）
      const restoredPayload = filterFn(store.getState()) as Record<string, unknown>
      // 升级写回待办时不能吸收恢复自身的延迟通知——否则该通知直接 return，
      // 升级信封只能等下一次真实变更或 destroy 才落盘（进程被杀就永远停在旧 $tallyV）。
      // 不吸收后，恢复后的首个通知会真正调用一次 saveState 完成升级写回。
      absorbedSerialized = pendingUpgrade ? null : JSON.stringify(restoredPayload)
      // 种子化 lastSaved 必须与 saveState 使用同一信封构造（buildPayload）；
      // 迁移链/裸对象补信封后必须写回，故 pendingUpgrade 时置 null（下一次落盘升级）。
      // 不再要求恢复状态与磁盘文本逐字节一致——filter 非幂等/旧编码器会造成无谓重写，
      // 并放大  要防的「共享 key 时卸载 flush 覆盖较新数据」风险；版本升级由 pendingUpgrade 判定。
      lastSaved = pendingUpgrade ? null : JSON.stringify(buildPayload(schemaVersion, restoredPayload))
    } catch {
      // 序列化失败（循环引用等）：放弃吸收，维持「通知即落盘」的原有行为
      absorbedSerialized = null
      lastSaved = null
    }
    if (!isProduction()) {
      console.log('[TallyStore][persistence] State restored from storage:', storageKey)
    }
  }

  if (shouldRestore) {
    try {
      const savedState = storageAdapter.getItem(storageKey)
      if (savedState) {
        const parsedState = JSON.parse(savedState)
        // 入口准入：确保解析结果是「可信的纯对象」，挡掉非纯对象与自带 `__proto__`
        // 自有数据属性的载荷（判据见 isRestorablePayload）
        // 解包/迁移只执行一次：迁移链可能有副作用，且失败时已在此上报并返回 null
        const unwrapped = isRestorablePayload(parsedState) ? unwrapEnvelope(parsedState) : null
        const restoredData = unwrapped === null ? null : unwrapped.data
        if (!isRestorablePayload(parsedState)) {
          skipRestore('[TallyStore] Restored state is not a plain object, skipping restore')
        } else if (unwrapped === null) {
          // 信封解包/迁移已上报并决定跳过（保持默认值）
        } else if (validate && !validate(restoredData)) {
          // 数据验证：如果提供了 validate 函数，校验通过后才恢复
          skipRestore('[TallyStore] Restored state failed validation, skipping restore')
        } else {
          const filteredState = filterFn(restoredData as S)
          // filter 返回值来自未类型化的 JS 调用方。$patch 只检查 typeof === 'object'：数组会被
          // 按数字键合并进 state、Date/Map 则只开发期 warn 后静默 no-op——恢复「看起来成功」
          // 但状态没变。与 saveState 的落盘校验同口径，恢复侧也拒绝并上报。
          if (!isPlainObject(filteredState)) {
            skipRestore('[TallyStore][persistence] 恢复载荷经 filter 处理后不是纯对象，跳过恢复（保持默认值）')
          } else {
            applyRestoredState(filteredState, unwrapped.pendingUpgrade)
          }
        }
      }
    } catch (error) {
      if (!isProduction()) {
        console.error('[TallyStore] Failed to restore state:', error)
      }
      // 抛出的失败（后端读取出错、JSON 语法错误、$patch 被核心拒绝）同样要转投 onError：
      // 这条路径连「跳过」的日志都没有，静默后果与 skipRestore 描述一致
      reportPersistenceError('restore', error instanceof Error ? error.message : String(error), error)
    }
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let isUninstalled = false // 标记是否已卸载，防止卸载后定时器回调仍执行
  // 防抖窗口内最近一次待写入的状态：卸载时用于同步补写，避免最后一次变更丢失
  let pendingState: Partial<S> | null = null
  // 最近一次成功落盘的序列化结果：卸载补写时据此跳过无变化的重复写入
  //（声明位置提前到恢复块之前的理由见上面 lastSaved 一行）

  // 只读订阅：仅序列化后落盘，不修改载荷，避免为持久化引入整树深拷贝
  const unsubscribe = store.subscribe(
    (state) => {
      const stateToSave = filterFn(state)

      // 吸收恢复自身的延迟通知（仅首次通知生效，避免陈旧载荷误吞后续真实变更）：
      // 通知内容与恢复结果一致说明状态自恢复以来未变化，不产生任何写入
      if (absorbedSerialized !== null) {
        const restoredPayload = absorbedSerialized
        absorbedSerialized = null
        try {
          if (JSON.stringify(stateToSave) === restoredPayload) {
            return
          }
        } catch {
          // 序列化失败：继续走正常落盘路径，由 saveState 内部兜底
        }
      }

      if (debounceMs > 0) {
        if (debounceTimer) {
          clearTimeout(debounceTimer)
        }
        pendingState = stateToSave
        debounceTimer = setTimeout(
          () => {
            // 先复位句柄再判卸载：定时器已经触发，`debounceTimer` 就必须回到 null，
            // 否则后面的 `if (debounceTimer)` 不再表示「确有落盘待触发」
            debounceTimer = null
            pendingState = null
            saveState(stateToSave)
            // 钳到 setTimeout 上限：配置值越界（如把 300 写成 3e9）会被宿主静默夹成 ~1ms，
            // 「落盘防抖」退化成下一次宏任务立刻写——高频变更场景下等于每帧一次
            // JSON.stringify(整棵状态树) + 同步 wx.setStorageSync（小程序里是阻塞 I/O）
          },
          Math.min(debounceMs, MAX_TIMER_DELAY),
        )
      } else {
        saveState(stateToSave)
      }
    },
    { readOnly: true },
  )

  function saveState(rawState: Partial<S>): void {
    // 卸载后不再执行保存操作
    if (isUninstalled) return
    // filter 返回值来自未类型化的 JS 调用方：非纯对象无法保证 JSON 往返，直接上报而不是写坏存储
    if (!isPlainObject(rawState)) {
      const message = '[TallyStore][persistence] state to persist must be a plain object (check filter return value)'
      if (!isProduction()) {
        console.error(message)
      }
      reportPersistenceError('save', message)
      return
    }
    //  落盘审计：深层扫描载荷，命中任一敏感键（含嵌套路径，如 profile.phone）
    // 即**拒绝本次落盘**——开发期 console.error + onError，生产期仅 onError。
    // 不做「剔除命中字段后写其余」：wx 存储为明文，深层剔除漏删一次就是明文泄漏，
    // 且路径可能指向数组/深层对象，安全优先选择整包拒绝（调用方从 filter 收缩或派生脱敏值）
    const state = rawState as Record<string, unknown>
    // 审计会读取每个嵌套值（throwing getter / 代理陷阱可能抛错），必须包在错误边界内。
    // 审计失败按 fail-closed 处理：拒绝本次落盘并上报，既不让异常从防抖定时器/卸载 flush 逃逸，
    // 也不把「未审计过的载荷」写进明文存储。
    let sensitiveHits: string[]
    try {
      sensitiveHits = findSensitiveKeysDeep(state)
    } catch (error) {
      const message = '[TallyStore][persistence] 敏感键落盘审计失败，已拒绝本次写入（fail-closed）：' + (error instanceof Error ? error.message : String(error))
      if (!isProduction()) {
        console.error(message, error)
      }
      reportPersistenceError('save', message, error)
      return
    }
    if (sensitiveHits.length > 0) {
      const message =
        '[TallyStore][persistence] 敏感字段进入持久化白名单：' +
        sensitiveHits.join(', ') +
        '。wx 存储为明文，敏感数据默认不落盘；请从 filter 白名单移除这些字段，或先派生脱敏值（见 SECURITY.md）'
      if (!isProduction()) {
        console.error(message)
      }
      reportPersistenceError('save', message)
      return
    }
    // /：persistence 口径校验（在 JSON.stringify 前）——嵌套 Map/Set/undefined/函数/
    // RegExp/类实例/循环引用都会被 JSON 静默降级或丢字段；生产期 fail-closed 拒绝整次落盘，绝不写坏存储
    let invalidPaths: string[]
    try {
      invalidPaths = findUnserializablePaths(state, 'persistence')
    } catch (error) {
      const message =
        '[TallyStore][persistence] 落盘载荷序列化校验失败，已拒绝本次写入（fail-closed）：' + (error instanceof Error ? error.message : String(error))
      if (!isProduction()) {
        console.error(message, error)
      }
      reportPersistenceError('save', message, error)
      return
    }
    if (invalidPaths.length > 0) {
      const message =
        '[TallyStore][persistence] 落盘载荷含不可序列化值：' +
        invalidPaths.join(', ') +
        '。已拒绝本次落盘（Date 会落为 ISO 字符串；Map/Set/undefined/函数/RegExp/类实例不允许，请用 filter 派生普通字段）'
      if (!isProduction()) {
        console.error(message)
      }
      reportPersistenceError('save', message)
      return
    }
    try {
      //  版本信封：配置 schemaVersion 时写入 { $tallyV, $tallyD }，未配置保持裸状态（向后兼容）。
      // 与恢复侧种子化共用 buildPayload：两处序列化口径不允许各自维护
      const payload = buildPayload(schemaVersion, state)
      const serialized = JSON.stringify(payload)
      if (typeof serialized !== 'string') {
        throw new TypeError('[TallyStore][persistence] JSON.stringify(state) did not produce a string (toJSON returning undefined?)')
      }
      if (serialized === lastSaved) {
        return
      }
      // 配额阈值与提示文案都按 UTF-8 字节表述，serialized 是即将写出的 JSON 文本。
      // 直接折算 UTF-8 字节，不再 estimateJsonBytes(payload) 二次 JSON.stringify。
      // 每个 UTF-16 码元最多折算 3 字节（代理对 4 字节/2 码元），码元数×3 是严格上界——
      // 低于阈值时无需逐字符扫描（debounce 默认 0，每次状态变更都会走到这里）。
      if (serialized.length * 3 >= PERSIST_QUOTA_WARN_BYTES) {
        warnQuotaOnce(utf8BytesOf(serialized))
      }
      storageAdapter.setItem(storageKey, serialized)
      lastSaved = serialized
    } catch (error) {
      if (!isProduction()) {
        console.error('[TallyStore] Failed to persist state:', error)
      }
      reportPersistenceError('save', error instanceof Error ? error.message : String(error), error)
    }
  }

  return () => {
    // 待触发的定时器与 clearOnUninstall 无关，一律摘掉：它会拽住安装闭包和
    // stateToSave/pendingState 快照直到 debounceMs 之后（小程序运行时里一个活定时器
    // 足以让逻辑层无法释放）。只有「补写」才依赖 clearOnUninstall——开启清理时这份
    // 数据本来就要连磁盘条目一起删掉
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    if (!clearOnUninstall) {
      // 防抖窗口内卸载：pendingState 尚未落盘，先同步补写最后一次变更
      if (pendingState !== null) {
        saveState(pendingState)
      }
      // 最终补写：notify.async 下最后一次写入可能尚未触发订阅回调（pendingState 为空），
      // 而 destroy 会取消待发通知，窗口期内的变更会既不通知也不落盘。
      // 直接读取当前状态落盘（与 lastSaved 比较，无变化时不产生写入）
      try {
        saveState(filterFn(store.getState()))
      } catch (error) {
        // 只 console 不够：监控口径只认 onError（见本文件 :276-278 与 docs/ARCHITECTURE.md），
        // 而这里正是「销毁前最后一次落盘」——`filter` / `getState` 抛错时 saveState 根本没进入，
        // 它内部那条 emit onError 的 catch 不会触发；外层 Store.destroy 的 uninstall catch
        // 同样只 console。缺了这一条，末次状态变更在生产里静默丢失且无从归因。
        // 卸载发生在 _hooks.clear() 之前，故此刻 emit 仍可用（与下面 clearOnUninstall 同口径）
        if (!isProduction()) {
          console.error('[TallyStore] Failed to persist state on uninstall:', error)
        }
        reportPersistenceError('uninstall', error instanceof Error ? error.message : String(error), error)
      }
    }
    pendingState = null
    isUninstalled = true
    unsubscribe()
    // 仅在配置了 clearOnUninstall 时才清除存储数据
    if (clearOnUninstall) {
      try {
        storageAdapter.removeItem(storageKey)
      } catch (error) {
        // 清理失败不得静默：磁盘上残留的旧数据会在下次启动恢复出「已卸载」的状态
        // （已清除却复活）。与 saveState 同口径上报，调用方才有机会介入
        if (!isProduction()) {
          console.error('[TallyStore] Failed to clear persisted state:', error)
        }
        reportPersistenceError('uninstall', error instanceof Error ? error.message : String(error), error)
      }
    }
  }
}

export type { PersistenceOptions } from '../types/plugins.js'
