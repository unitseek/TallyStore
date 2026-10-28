/**
 * Store 注册与聚合：全局唯一名登记 + 工厂式聚合注册 + 依赖图循环检测。
 *
 * 设计要点：
 * - 全局注册表挂在 `Symbol.for` 键上：同一页面加载多份本库副本（分包构建的常态）时
 *   仍能发现跨副本的重名，而不是各自为政。
 * - 重复 name 只在开发期阻断；生产期经 onError 上报后放行（降级口径：
 *   正确性风险让位于可用性，但绝不静默）。注册动作本身轻量（一次 Map 查找 + 数组 push）。
 * - `defineStores` 只登记工厂：实例在 `get()` 首次调用时创建（惰性），未使用的模块
 *   不产生任何构造开销——「模块定义与注册不得依赖页面加载顺序」由此保证。
 * - 循环依赖在注册期对**声明的**依赖图做静态检测（DFS 三色标记），输出完整依赖链；
 *   不需要实例化任何 Store。
 */

import type { Store, State, Actions, Getters } from '../../types/store.js'
import { isProduction } from './utils.js'
import { TallyStoreError, ErrorCode } from '../errors/TallyStoreError.js'

/** 全局注册表在 globalThis 上的挂载键：跨库副本共享 */
const REGISTRY_KEY = Symbol.for('tallystore.storeRegistry')

interface RegistryEntry {
  store: object
  /** 创建现场（重复 name 报错时给出冲突双方来源） */
  origin: string
}

/**
 * 每个 name 维护存活条目：生产放行路径允许同名共存。存储形态兼容旧版本副本
 * （旧版为单条目 RegistryEntry，新版为数组）：单条目时仍写旧形状，多条目才写数组。
 */
type RegistryValue = RegistryEntry | RegistryEntry[]
type GlobalRegistry = Map<string, RegistryValue>

function globalRegistry(): GlobalRegistry {
  const holder = globalThis as { [REGISTRY_KEY]?: GlobalRegistry }
  if (holder[REGISTRY_KEY] === undefined) {
    holder[REGISTRY_KEY] = new Map<string, RegistryValue>()
  }
  return holder[REGISTRY_KEY]
}

/** 读取侧归一：兼容旧副本写入的单条目形状 */
function registryEntries(value: RegistryValue | undefined): RegistryEntry[] | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value : [value]
}

/** 写入侧：单条目保持旧副本可读的形状，多条目才用数组；空列表删除 name */
function writeRegistryEntries(registry: GlobalRegistry, name: string, entries: RegistryEntry[]): void {
  if (entries.length === 0) {
    registry.delete(name)
    return
  }
  registry.set(name, entries.length === 1 ? entries[0] : entries)
}

/** 粗提创建现场：构造栈的第一段非本库帧。完整栈在长链路下太吵，取前 3 行足够定位文件。 */
function captureOrigin(): string {
  const stack = new Error('origin').stack ?? ''
  const lines = stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at ') && !line.includes('/src/core/') && !line.includes('\\src\\core\\'))
    .slice(0, 3)
  return lines.length > 0 ? lines.join(' <- ') : '(unknown origin)'
}

/**
 * 登记 Store（Store 构造函数调用）。
 * 开发期重名抛 TallyStoreError(INVALID_CONFIG) 并带冲突双方来源；生产期经 onError 放行。
 * 返回注销函数（destroy 时调用）。
 */
export function registerStoreInstance(name: string, store: object, report: (error: TallyStoreError) => void): () => void {
  const registry = globalRegistry()
  // 创建现场只捕获一次：冲突报错与条目共用，避免同名冲突时二次解析调用栈
  const origin = captureOrigin()
  const entries = registryEntries(registry.get(name))
  // 冲突检测基于**存活条目**：同一实例重复登记不算冲突，只有另一个仍存活的实例才冲突
  const conflicting = entries?.find((entry) => entry.store !== store)
  if (conflicting !== undefined) {
    const error = new TallyStoreError(
      ErrorCode.INVALID_CONFIG,
      '[TallyStore] Store name "' +
        name +
        '" 已被另一个实例占用（重复 name 在同一应用内必须唯一；持久化默认键与日志前缀都由 name 派生，重名会互相覆盖）。\n' +
        '  已占用方创建于：' +
        conflicting.origin +
        '\n' +
        '  本次创建于：' +
        origin,
      { storeName: name, conflictOrigin: conflicting.origin },
    )
    if (isProduction()) {
      //  降级口径：生产期不阻断启动，但必须可观测
      report(error)
    } else {
      throw error
    }
  }
  const entry: RegistryEntry = { store, origin }
  writeRegistryEntries(registry, name, entries === undefined ? [entry] : [...entries, entry])
  let unregistered = false
  return () => {
    if (unregistered) return
    unregistered = true
    // 只注销自己这条：后创建的同名实例（生产放行路径）销毁时不得顶掉仍存活的先创建者
    const live = registryEntries(registry.get(name))
    if (live === undefined) return
    const index = live.indexOf(entry)
    if (index !== -1) live.splice(index, 1)
    writeRegistryEntries(registry, name, live)
  }
}

// ==================== 聚合注册（工厂登记 + 依赖图） ====================

/** 聚合模块声明：工厂 + 可选依赖（依赖的是其它模块名） */
export interface StoreModuleDeclaration<S extends State = State, A extends Actions = Actions, G extends Getters<S> = Getters<S>> {
  /** 创建 Store 实例的工厂；首次 get 时调用一次并记忆结果 */
  factory: () => Store<S, A, G>
  /** 依赖的其它模块名（用于循环依赖静态检测与实例化顺序参考） */
  dependsOn?: readonly string[]
}

/** 聚合注册表实例（不带模块表泛型的运行时契约） */
export interface StoreModuleRegistry {
  /** 取模块对应的 Store（首次调用时实例化并记忆）；未知名字抛 INVALID_CONFIG */
  get(name: string): unknown
  /** 是否登记了该模块（不触发实例化） */
  has(name: string): boolean
  /** 已登记的模块名列表（不触发实例化） */
  names(): string[]
  /** 模块是否已实例化（不触发实例化） */
  instantiated(name: string): boolean
  /** 重置聚合表（测试用）：销毁全部已创建实例并清空登记 */
  reset(): void
  /** 状态重置（resetAll）：全部已实例化模块 $reset 为初始状态；订阅保持有效、实例不销毁 */
  resetAll(): void
}

/** 声明的模块表形态（键 = 模块名） */
export type StoreModuleDeclarations = Record<string, StoreModuleDeclaration<never, never, never> | StoreModuleDeclaration>

/** 从声明表提取 get 的返回类型映射（工厂返回类型逐键推导） */
export type InferStoreMap<M> = { [K in keyof M]: M[K] extends StoreModuleDeclaration<infer S, infer A, infer G> ? Store<S, A, G> : never }

/** 带类型的聚合注册表 */
export interface TypedModuleRegistry<M> extends Omit<StoreModuleRegistry, 'get'> {
  get<K extends keyof M & string>(name: K): InferStoreMap<M>[K]
}

/**
 * 聚合注册 Store 模块（ 推荐 organization 方式）。
 *
 * 只登记工厂：`get` 首次调用才实例化（可断言工厂调用次数为 0）。注册期对声明的
 * `dependsOn` 图做循环依赖检测，发现环抛 TallyStoreError(INVALID_CONFIG) 并给出
 * 完整依赖链（开发期与生产期都阻断：环是配置错误，放行只会把死锁推迟到运行期）。
 */
export function defineStores<M extends StoreModuleDeclarations>(modules: M): TypedModuleRegistry<M> {
  const names = Object.keys(modules)

  // 依赖声明的静态校验：引用不存在的模块名 = 配置错误，注册期即报
  for (const name of names) {
    const deps = modules[name]?.dependsOn ?? []
    for (const dep of deps) {
      if (!Object.prototype.hasOwnProperty.call(modules, dep)) {
        throw new TallyStoreError(ErrorCode.INVALID_CONFIG, '[TallyStore] defineStores: 模块 "' + name + '" 声明依赖 "' + dep + '"，但聚合表中不存在该模块', {
          moduleName: name,
          missingDependency: dep,
          registered: names,
        })
      }
    }
  }

  // DFS 三色标记检测环，WHITE/GRAY/BLACK
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>(names.map((name) => [name, WHITE]))
  const path: string[] = []

  const visit = (name: string): void => {
    const state = color.get(name)
    if (state === BLACK) return
    if (state === GRAY) {
      const cycleStart = path.indexOf(name)
      const chain = [...path.slice(cycleStart), name].join(' → ')
      throw new TallyStoreError(
        ErrorCode.INVALID_CONFIG,
        '[TallyStore] defineStores: 模块依赖形成循环：' + chain + '。循环依赖会使初始化顺序不可判定，请把共享状态抽到环外模块',
        { cycle: chain },
      )
    }
    color.set(name, GRAY)
    path.push(name)
    for (const dep of modules[name]?.dependsOn ?? []) {
      visit(dep)
    }
    path.pop()
    color.set(name, BLACK)
  }
  for (const name of names) {
    visit(name)
  }

  const instances = new Map<string, Store<State, Actions, Getters<State>>>()

  /** 正在构造中的模块：工厂内（直接或间接）递归 get 时给出受控错误，而不是栈溢出 */
  const building = new Set<string>()

  /**
   * 批量销毁/复位：单项失败不中断其余项，收尾后汇总上报（TallyStoreError 携带全部失败原因）。
   * reset 只摘除本轮真正清扫过的实例——失败项已收集，残留表项会让后续 get 返回半销毁实例。
   */
  const sweep = (operation: 'reset' | 'resetAll', action: (instance: Store<State, Actions, Getters<State>>) => void): void => {
    const failures: Array<{ moduleName: string; error: unknown }> = []
    // 快照遍历：teardown 期间重入 get() 新建的实例不参与本轮清扫
    const swept = [...instances]
    for (const [moduleName, instance] of swept) {
      try {
        action(instance)
      } catch (error) {
        failures.push({ moduleName, error })
      }
    }
    if (operation === 'reset') {
      // 只摘除本轮真正清扫的实例：teardown 重入 get() 新建的实例保留登记与存活，
      // 否则它既没被销毁又丢失登记，下一次 get() 会重建第二份实例并撞全局重名
      for (const [moduleName, instance] of swept) {
        if (instances.get(moduleName) === instance) {
          instances.delete(moduleName)
        }
      }
    }
    if (failures.length === 0) {
      return
    }
    const detail = failures.map(({ moduleName, error }) => moduleName + '（' + (error instanceof Error ? error.message : String(error)) + '）').join('；')
    throw new TallyStoreError(
      ErrorCode.INVALID_CONFIG,
      '[TallyStore] defineStores.' + operation + ' 完成遍历，但有 ' + failures.length + ' 个模块失败：' + detail,
      {
        operation,
        failedModules: failures.map((failure) => failure.moduleName),
        failures: failures.map((failure) => failure.error),
      },
      failures[0].error,
    )
  }

  const registry = {
    get(name: string): unknown {
      const declaration = Object.prototype.hasOwnProperty.call(modules, name) ? modules[name] : undefined
      if (declaration === undefined) {
        throw new TallyStoreError(ErrorCode.INVALID_CONFIG, '[TallyStore] defineStores: 未登记的模块 "' + name + '"', { moduleName: name, registered: names })
      }
      let instance = instances.get(name)
      if (instance === undefined) {
        if (building.has(name)) {
          // 未声明的循环依赖：静态 dependsOn 检测看不到这条边，只能运行期守卫
          const chain = [...building, name].join(' → ')
          throw new TallyStoreError(
            ErrorCode.INVALID_CONFIG,
            '[TallyStore] defineStores: 模块 "' +
              name +
              '" 的工厂在构造完成前递归调用了 get("' +
              name +
              '")（未声明的循环依赖：' +
              chain +
              '）。请用 dependsOn 声明依赖，或把共享状态抽到环外模块',
            { moduleName: name, cycle: chain },
          )
        }
        building.add(name)
        try {
          instance = declaration.factory() as Store<State, Actions, Getters<State>>
          instances.set(name, instance)
        } finally {
          // 工厂抛错（含检测到环）也要清理标记：修复配置后可重新 get，而不是永久判定为构造中
          building.delete(name)
        }
      }
      return instance
    },
    has: (name: string) => Object.prototype.hasOwnProperty.call(modules, name),
    names: () => [...names],
    instantiated: (name: string) => instances.has(name),
    reset: () => {
      sweep('reset', (instance) => instance.destroy())
    },
    resetAll: () => {
      // Store 公开接口类型的 $reset() 无入参（types/store.ts 保持不变），实现已支持可选 reason；
      // 这里按实现签名传 'resetAll'，让 beforeReset/afterReset 审计事件能区分批量重置来源
      sweep('resetAll', (instance) => (instance.$reset as (reason?: 'direct' | 'resetAll') => void)('resetAll'))
    },
  }
  return registry as TypedModuleRegistry<M>
}
