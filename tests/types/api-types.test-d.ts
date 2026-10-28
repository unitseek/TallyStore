/**
 *  类型测试：锁定公开 API 的类型推导，防类型退化（CI 经 typecheck:tests 阻断）。
 *
 * 承载方式：本文件参与 `pnpm run typecheck:tests`（tsc --noEmit）。
 * - 正向断言：把推导结果赋给精确类型的变量，推导退化则编译失败
 * - 负向断言：`@ts-expect-error` 标注的行当前必须报错；若类型退化到「不再报错」，
 *   tsc 会因 Unused '@ts-expect-error' directive 而失败，CI 阻断
 *
 * 已知限制（ 跟进）：action 的返回表达式引用 this（如 `return this.getState().x`）时，
 * actions 表的类型推断整体退化为宽类型（参数/返回值不再校验）。见文末「退化绊线」：
 *  修复推导后绊线行会编译失败，届时把它改写为下方的严格负向断言。
 */

import type { InferActionArgs, InferActionReturn, InferGetterReturn } from '../../src/index.js'
import { createStore } from '../../src/index.js'
import type { ActionContext, ConfigState, Getters } from '../../src/types/store.js'
import type { AppThis, ExtractMappedActions, ExtractPageData, HookArgsMap, HookName } from '../../src/types/plugin.js'
import type { PersistenceOptions } from '../../src/types/plugins.js'
import { withPageStore } from '../../src/integrations/with-store.js'
import { withAppStore } from '../../src/integrations/with-app-store.js'

// ==================== action 参数/返回推导（严格区） ====================

// 注：此 store 的 action 不在返回值里引用 this——那是当前类型系统推导完好性的边界
const typeStore = createStore({
  name: 'type-contract',
  state: () => ({ count: 0, label: 'a' }),
  actions: {
    inc(step: number) {
      this.setState('count', this.getState().count + step)
      return step * 2
    },
    rename(label: string) {
      this.setState('label', label)
    },
  },
  getters: {
    doubled: (state) => state.count * 2,
  },
})

type TypeActions = typeof typeStore.actions

// 正向：参数元组与返回值按声明推导
const stepArg: InferActionArgs<TypeActions, 'inc'> = [3]
const incReturn: InferActionReturn<TypeActions, 'inc'> = 1
const labelArg: InferActionArgs<TypeActions, 'rename'> = ['x']
const renameReturn: InferActionReturn<TypeActions, 'rename'> = undefined
void stepArg
void incReturn
void labelArg
void renameReturn

// 精确类型断言：上面的正向赋值无法发现 Infer* 退化为 any——any 可赋给任何目标类型，
// 赋值恒通过。Equal 比较类型身份，退化为 any / 宽类型时 CI 直接编译失败。
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false
const incReturnExact: Equal<InferActionReturn<TypeActions, 'inc'>, number> = true
const incArgsExact: Equal<InferActionArgs<TypeActions, 'inc'>, [step: number]> = true
const renameReturnExact: Equal<InferActionReturn<TypeActions, 'rename'>, void> = true
void incReturnExact
void incArgsExact
void renameReturnExact

// 负向：错误实参类型必须被拒绝
// @ts-expect-error inc 的参数必须是 number
typeStore.actions.inc('wrong')
// @ts-expect-error 直接调用缺少必填参数
typeStore.actions.inc()
// 设计口径：dispatch 的字符串名重载（dispatch(name: string, ...args: unknown[])）按名路由、
// 实参不做字面量校验——宽松仅限「名字/实参」维度；类型安全由 keyof 重载提供。
// 先正向锁定宽松重载存在（合法调用），再锁定 keyof 重载的**返回类型**：
// 删除/破坏 typed overload 后，dispatch 只剩返回 unknown 的字符串重载，下面赋值会编译失败
typeStore.dispatch('rename', 42)
const renameDispatchReturn: void = typeStore.dispatch('rename', 'ok')
const incDispatchReturn: number = typeStore.dispatch('inc', 3)
void renameDispatchReturn
void incDispatchReturn

// ==================== getter 返回推导 ====================

// 说明：TypeGetters 是手写类型夹具，仅用于隔离测试 InferGetterReturn 工具类型；
// 真实 getter 工厂的推导锁定在下方 typeStore.getter('doubled') 的赋值断言，不要只依赖本夹具。
type TypeGetters = { doubled: (state: { count: number }) => number }
const doubledReturn: InferGetterReturn<TypeGetters, 'doubled'> = 2
void doubledReturn
// 精确类型断言：getter 返回推导退化为 any 时此处编译失败
const doubledReturnExact: Equal<InferGetterReturn<TypeGetters, 'doubled'>, number> = true
void doubledReturnExact

const doubled = typeStore.getter('doubled')
const asNumber: number = doubled
void asNumber
// @ts-expect-error getter('doubled') 返回 number，不能赋给 string
const asString: string = typeStore.getter('doubled')
void asString

// ==================== state 键与值类型 ====================

// @ts-expect-error count 声明为 number，不能写 string
typeStore.setState('count', 'not-a-number')
// @ts-expect-error 未知 state 键被拒绝
typeStore.setState('unknown', 1)
// @ts-expect-error getState() 的 count 是 number，不能赋给 string
const stateCountAsString: string = typeStore.getState().count
void stateCountAsString

// ==================== 映射类型（ExtractPageData） ====================

const page = withPageStore(typeStore, { mapState: ['count'], mapGetters: ['doubled'] })
type PageData = ReturnType<typeof page> extends { data: infer D } ? D : never
// 直接字面量赋值（不用 as 断言）：类型错误才会暴露
const pageData: PageData = { count: 1, doubled: 2 }
void pageData
// 设计口径：PageData 含 Partial<S>，未映射的 state 键（label）是合法可选属性——页面可自带这些字段
const withUnmappedKey: PageData = { count: 1, doubled: 2, label: 'x' }
void withUnmappedKey
// @ts-expect-error data 的 count 必须是 number
const badCount: PageData = { count: 'x', doubled: 2 }
void badCount

// ==================== AppThis globalData 类型合并 ====================

type AppState = { count: number; label: string }
type AppExtra = { globalData: { userInfo: { name: string }; count: 'declared' }; trace(): void }
type AppThisFixture = AppThis<AppState, TypeActions, Getters<AppState>, { mapState: ['count'] }, AppExtra>
type AppGlobalData = AppThisFixture['globalData']

// 映射键以 store 类型为准（旧实现 Extra & { globalData } 交叉会把 count 变成 never）
const appCount: number = (undefined as unknown as AppGlobalData).count
void appCount
// 用户声明但未被映射的 globalData 成员保留
const appUserName: string = (undefined as unknown as AppGlobalData).userInfo.name
void appUserName
// @ts-expect-error count 的实例类型来自 store 映射（number），不是用户声明的 'declared'
const appDeclaredCount: 'declared' = (undefined as unknown as AppGlobalData).count
void appDeclaredCount
// Extra 的其它成员（App 配置自定义字段）保留
const appTrace: AppThisFixture['trace'] = () => {}
void appTrace
// 未映射 state 键只是可选字段（Partial<S> 形态，与 Page data 同口径）
// @ts-expect-error label 未映射，是可选属性，不能当必填 string
const appLabel: string = (undefined as unknown as AppGlobalData).label
void appLabel

// 声明成员与「未被映射的 state 键」同名时保留声明类型——运行时 store 只写映射键，
// 不会覆盖该值；只有与映射键同名才以 store 类型为准
type AppExtraUnmappedCollision = { globalData: { label: { custom: number } } }
type AppThisUnmappedCollision = AppThis<AppState, TypeActions, Getters<AppState>, { mapState: ['count'] }, AppExtraUnmappedCollision>
type UnmappedCollisionGlobalData = AppThisUnmappedCollision['globalData']
const declaredLabel: { custom: number } = (undefined as unknown as UnmappedCollisionGlobalData).label
void declaredLabel
// @ts-expect-error label 未被映射：声明类型 { custom: number } 不应被替换成 state 的 string
const declaredLabelAsString: string = (undefined as unknown as UnmappedCollisionGlobalData).label
void declaredLabelAsString

//  / 映射 getter 与映射 state 同名时，App globalData 与 ExtractPageData 同口径
//（getter 胜出，不塌成 never）；此前 MappedAppGlobalData 直接交叉两类映射会得到 number & string
type AppCollisionGetters = { count: (state: AppState) => string }
type AppThisGetterCollision = AppThis<AppState, TypeActions, AppCollisionGetters, { mapState: ['count']; mapGetters: ['count'] }, object>
const appGetterCollision: string = (undefined as unknown as AppThisGetterCollision['globalData']).count
void appGetterCollision
// @ts-expect-error getter 胜出：同名映射键不应是 state 的 number 类型（更不应塌成 never）
const appGetterCollisionAsNumber: number = (undefined as unknown as AppThisGetterCollision['globalData']).count
void appGetterCollisionAsNumber

// 真实 withAppStore 装饰器路径：this.globalData 同时含映射键（number）与用户声明成员
const appConfig = withAppStore(typeStore, { mapState: ['count'] })({
  globalData: { userInfo: { name: 'n' }, count: 'declared' as const },
  trace() {
    const count: number = this.globalData.count
    const userName: string = this.globalData.userInfo.name
    // @ts-expect-error 映射键类型来自 store（number），不接受用户声明的 'declared'
    const staleCount: 'declared' = this.globalData.count
    void count
    void userName
    void staleCount
  },
})
void appConfig

// ==================== 类型契约回归（low backlog 批：/239/240/241/262/266） ====================

// HookName 由 HookArgsMap 键集派生，13 个钩子名与实参元组一一对应
//
const hookNames = [
  'beforeSetState',
  'afterSetState',
  'beforePatch',
  'afterPatch',
  'beforeDispatch',
  'afterDispatch',
  'beforeReplaceState',
  'afterReplaceState',
  'beforeReset',
  'afterReset',
  'onError',
  'onNotify',
  'onHostWrite',
] as const satisfies readonly HookName[]
// 数组赋值只能发现「HookName 变窄/改名」，无法发现 HookName 被手工重新声明后变宽；
// 用 Equal 锁定「HookName 与数组元素类型完全相等」，新增钩子必须同步数组，回归即编译失败
const hookNamesExact: Equal<HookName, (typeof hookNames)[number]> = true
void hookNames
void hookNamesExact
const notifyArgs: HookArgsMap['onNotify'] = [{ listeners: 1 }]
const hostWriteArgs: HookArgsMap['onHostWrite'] = [{ bytes: 1, host: 'page' }]
void notifyArgs
void hostWriteArgs

//  / 三种映射提取共用同一套「条目表 → 值类型」规则
type MappingState = { count: number; label: string }
type RenamedMapping = { mapState: { total: 'count' }; mapGetters: { labelUpper: 'labelUpper' } }
type RenamedData = ExtractPageData<MappingState, RenamedMapping, { labelUpper: (state: MappingState) => string }>
const renamedData: RenamedData = { total: 1, labelUpper: 'X' }
// 未映射 state 键仍是合法可选属性（ 文档口径）
const renamedWithUnmapped: RenamedData = { total: 1, labelUpper: 'X', label: 'still-allowed' }
// @ts-expect-error 重命名映射的值类型仍按源 state 键推导（total 必须是 number）
const renamedBad: RenamedData = { total: 'x', labelUpper: 'X' }
void renamedData
void renamedWithUnmapped
void renamedBad

// getter 与映射 state 同名时 getter 胜出（显式契约）
type CollisionData = ExtractPageData<MappingState, { mapState: ['count']; mapGetters: ['count'] }, { count: (state: MappingState) => string }>
const collisionData: CollisionData = { count: 'from-getter' }
// @ts-expect-error getter 胜出后 count 是 string，不再是 state 的 number
const collisionBad: CollisionData = { count: 1 }
void collisionData
void collisionBad

type ActionsFixture = { inc(step: number): number; reset(): void }
const mappedActionsArray: ExtractMappedActions<ActionsFixture, { mapActions: ['inc'] }> = { inc: (step: number) => step }
const mappedActionsRecord: ExtractMappedActions<ActionsFixture, { mapActions: { bump: 'inc' } }> = { bump: (step: number) => step }
// @ts-expect-error record 重命名后签名仍按源 action（inc）推导
const mappedActionsBad: ExtractMappedActions<ActionsFixture, { mapActions: { bump: 'inc' } }> = { bump: (x: string) => 1 }
void mappedActionsArray
void mappedActionsRecord
void mappedActionsBad

// A 未声明 dispatch 时内置 dispatcher（typed + 动态字符串重载）可用
declare const normalActionContext: ActionContext<{ count: number }, { inc(step: number): number }>
const normalIncReturn: number = normalActionContext.dispatch('inc', 2)
const dynamicDispatchReturn: unknown = normalActionContext.dispatch('runtime-name', { any: 1 })
void normalIncReturn
void dynamicDispatchReturn

// A 显式声明 dispatch action 时，运行时用户 action 会遮蔽内置 dispatcher，
// 类型按用户签名呈现（不再交叉内置 dispatch）
declare const collisionActionContext: ActionContext<{ count: number }, { dispatch(flag: boolean): string }>
const userDispatchReturn: string = collisionActionContext.dispatch(true)
// @ts-expect-error 用户 action 的 dispatch 只接受 boolean
collisionActionContext.dispatch('inc')
void userDispatchReturn

// 非法 S 的 ConfigState 与 ResolvedState 同口径归一到 State(object)
const configStateExact: Equal<ConfigState<number>, object> = true
void configStateExact

// validate 是普通 boolean 返回（不再谎报 state is S）；用户仍可写类型谓词实现（放宽而非收紧）
type ValidateFn = NonNullable<PersistenceOptions<{ count: number }>['validate']>
const validateBoolean: ValidateFn = () => true
const validatePredicate: ValidateFn = (value: unknown): value is { count: number } => typeof value === 'object' && value !== null
void validateBoolean
void validatePredicate

// ==================== 退化绊线（：修复后此区必须改写为严格断言） ====================

const returningStore = createStore({
  name: 'type-return-degrade',
  state: () => ({ count: 0 }),
  actions: {
    inc(step: number) {
      this.setState('count', this.getState().count + step)
      return this.getState().count
    },
  },
})
// 当前行为：返回表达式引用 this 时 actions 推断退化为宽类型，返回值当 any 用不报错。
//  修复推导后此行会编译失败（number 不能赋给 string）——届时把本区替换为：
//   // @ts-expect-error …参数必须是 number
//   returningStore.actions.inc('wrong')
const degradedReturn: string = returningStore.actions.inc(1)
void degradedReturn

export {}
