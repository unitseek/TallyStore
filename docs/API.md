# API 参考

按入口组织。签名以包内 `types/**/*.d.ts` 为准；这里给入口、签名与默认值。用法见
[GUIDE](./GUIDE.md)，分层与取舍见 [ARCHITECTURE](./ARCHITECTURE.md)，易误用边界见
[skills/tallystore](../skills/tallystore/SKILL.md)。

## 本文内容

- [入口一览](#入口一览)
- [类型导出](#类型导出)
- [createStore](#createstore)
- [defineStores](#definestores)
- [createRaceGuard](#createraceguard)
- [Store](#store)
- [敏感键与脱敏](#敏感键与脱敏)
- [钩子](#钩子)
- [错误](#错误)
- [api-稳定性分级](#api-稳定性分级)
- [小程序集成](#小程序集成)
- [plugins](#plugins)
- [相关文档](#相关文档)

## 入口一览

- `@unitseek/tallystore`：`createStore`、`defineStores`、`Store`、`TallyStoreError`、`isTallyStoreError`、
  `HookSystem`、`withPageStore`、`withComponentStore`、`withAppStore`、`unbindStore`、
  `isSensitiveKey`、`addSensitiveKeyPatterns`、`resetSensitiveKeyPatterns`、`maskSensitiveValue`、`maskForLog`、
  `DEFAULT_SENSITIVE_KEY_PATTERNS`、`createRaceGuard`
- `@unitseek/tallystore/plugins`：`persistencePlugin`、`WxStorageBackend`、`loggerPlugin`、`metricsPlugin`
- `@unitseek/tallystore/plugins/persistence`：`persistencePlugin`、`WxStorageBackend`
- `@unitseek/tallystore/plugins/logger`：`loggerPlugin`

只有这四个运行时入口。`package.json` 的 `exports` 只声明类型；微信「构建 npm」按
`miniprogram` 字段解析 `dist-weapp/` 的运行时。

## 类型导出

- Store：`StoreOptions`、`State`、`Actions`、`Getters`、`StateListener`、`InferActionArgs`、
  `InferActionReturn`、`InferGetterReturn`、`ActionNames`
- 聚合：`StoreModuleDeclaration`、`StoreModuleRegistry`、`TypedModuleRegistry`、`StoreModuleDeclarations`、`InferStoreMap`
- 配置：`StateProtectionOptions`、`SubscriptionOptions`、`NotifyOptions`
- 集成：`ConnectOptions`、`PageConfig`、`ComponentConfig`、`AppOptions`、`PageThis`、
  `ComponentThis`、`AppThis`、`ExtractPageData`、`WithPageThis`、`PageOwnMethods`、
  `ComponentOwnMethods`、`PageReservedKeys`
- 插件：`Plugin`、`PluginHook`、`HookName`、`HookHandler`、`IHookSystem`、`ResetInfo`（ 重置审计事件实参）
- 错误：`ErrorCode`（const 对象 + 联合类型，共 8 个码）
- `@unitseek/tallystore/plugins`：`PersistenceOptions`、`StorageBackend`、
  `LoggerPluginOptions`、`LogSink`、`MetricsPluginOptions`、`MetricsSink`、`MetricsEvent`、`MetricsCollector`

## createStore

```ts
const store = createStore({
  name: 'counter',
  state: () => ({ count: 0 }),
  actions: {
    increment(n = 1) {
      this.setState('count', this.getState().count + n)
    },
  },
  getters: { doubled: (state) => state.count * 2 },
})
```

`state` 接受对象字面量或工厂函数 `() => S`，可省略（默认 `{}`）；初始状态会被深拷贝，
多实例场景用工厂写法避免共享引用。`actions` 的 `this` 是当前 Store 的 action 上下文。
`getters` 的函数只接收 state，没有结果缓存。

选项与默认值：

| 选项                                | 默认               | 说明                                                            |
| ----------------------------------- | ------------------ | --------------------------------------------------------------- |
| `name`                              | 自动生成 `store-N` | 日志前缀与持久化默认键来源                                      |
| `state`                             | `{}`               | 初始状态，深拷贝进 Store                                        |
| `actions`                           | `{}`               | 业务方法，`this` 已注入                                         |
| `getters`                           | `{}`               | `(state) => value`，无缓存，不接受额外参数                      |
| `stateProtection.enabled`           | `true`             | `store.state` 是否返回只读保护代理                              |
| `stateProtection.deep`              | `true`             | 是否递归保护嵌套对象与集合成员                                  |
| `stateProtection.productionHandler` | `'warn'`           | 生产期非法直写：`'error' \| 'warn' \| 'silent'`；开发期始终抛错 |
| `subscription.maxSubscribers`       | `50`               | 订阅者上限；非有限值回退 50，`≤0` 归一为 1                      |
| `subscription.onLimit`              | `'evict-oldest'`   | 触顶策略：`'evict-oldest' \| 'throw'`                           |
| `notify.clone`                      | `false`            | 是否强制深拷贝通知载荷                                          |
| `notify.onlyOnChange`               | `false`            | 仅状态实际变化时通知                                            |
| `notify.async`                      | `false`            | 微任务合并同一 tick 的多次通知                                  |
| `snapshot.maxBytes`                 | `min(1MB, 状态×2)` | 单次快照体积上限（字节，需为 ≥1 的整数），超限 `$snapshot` 拒绝 |

**name 唯一性**：显式命名的 Store 在全局注册表登记；同一应用（含多份库副本）
内重名在**开发期抛 `INVALID_CONFIG`** 并给出冲突双方创建现场，**生产期经
`onError(error, 'register')` + `console.error` 上报后放行**。`destroy()` 释放名字供复用；
自动生成名（`store-N`）不登记（跨 bundle 副本各自计数，登记只会误报）。

## defineStores

```ts
const stores = defineStores({
  user: {
    factory: () => createStore({ name: 'user', state: () => ({ id: '' }) }),
  },
  cart: {
    dependsOn: ['user'],
    factory: () => createStore({ name: 'cart', state: () => ({ items: [] as string[] }) }),
  },
})

stores.get('cart') // 首次调用才实例化（工厂只执行一次），后续返回同一实例
stores.has('cart') // 登记即真，不触发实例化
stores.names() // ['user', 'cart']
stores.instantiated('cart') // 是否已实例化
stores.reset() // 测试用：销毁全部已创建实例并清空登记
stores.resetAll() // 全部已实例化模块 $reset('resetAll')，订阅保持、实例不销毁
```

- **只登记工厂**：注册不产生任何构造开销，模块定义与注册不依赖页面加载顺序
- **循环依赖**：注册期对声明的 `dependsOn` 图做静态检测（DFS），发现环抛
  `INVALID_CONFIG` 并携带完整依赖链（如 `a → b → c → a`）；引用不存在的模块名同样注册期报错
- **未知模块**：`get` 未登记的名字抛 `INVALID_CONFIG`（`context.registered` 给出可用列表）
- **resetAll**：对全部已实例化模块执行 `$reset('resetAll')`；单项失败不中断其余模块，收尾聚合为
  `TallyStoreError`（`context.operation='resetAll'` / `failedModules`）；审计钩子 reason 为 `'resetAll'`
- 类型：`TypedModuleRegistry` 按 `factory` 返回类型逐键推导 `get` 的返回值

## createRaceGuard

`createRaceGuard(): RaceGuard` 提供一个与 Action **完全解耦**的异步竞态辅助：请求序号 + 最新判定 + 取消句柄。
Action 可选择使用，不强制改造写法；库不内建请求库，也不包装 Promise。

| 成员           | 签名                       | 说明                                                                                                             |
| -------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `begin()`      | `() => number`             | 发起请求前取号；每次调用自增，旧序号自然过期（取消状态对新请求失效）                                             |
| `isCurrent()`  | `(seq: number) => boolean` | 结果落地前判定该序号是否仍是最新；已取消或已有更新序号时返回 `false`（旧结果晚到应丢弃，不写 Store）             |
| `cancel()`     | `() => void`               | 取消全部在途序号：此后 `isCurrent` 均为 `false`（结果不落地）；之后新的 `begin()` 重新有效                       |
| `staleCount()` | `() => number`             | `isCurrent` 返回 `false` 的累计次数（含 cancel 后判定与同一序号重复判定），可接日志/指标；**不是「丢弃结果数」** |

**口径：结果级取消 ≠ 网络级中断**。`cancel()` / `isCurrent()` 只承诺「过期结果不写入 Store」，
底层请求是否真正中断取决于请求库自身能力；guard 不包装 Promise，取消后不会产生库侧未处理
rejection，调用方原有的 `await` / `try/catch` 语义不变。

```ts
import { createRaceGuard } from '@unitseek/tallystore'

const guard = createRaceGuard()

async function search(keyword: string) {
  const seq = guard.begin()
  const result = await fetchList(keyword) // 底层请求可自行 abort，guard 不依赖它
  if (!guard.isCurrent(seq)) return // 旧结果晚到：丢弃，不写 Store
  store.setState('list', result)
}

// 快速连发 5 次：只有最后一次的结果会写入 Store
for (const kw of ['a', 'b', 'c', 'd', 'e']) void search(kw)

// 离开页面 / 切换租户：取消在途结果
guard.cancel()
guard.staleCount() // 过期判定累计次数，可交给 logger / metrics
```

- 验收口径：连续触发 5 次异步操作仅最后一次结果写入 Store；旧结果晚到可判定/可计数；取消后无未处理异常（见 `tests/unit/async/raceGuard.test.ts`）
- 与 的关系：`dispatch` 只负责调用 action，是否使用竞态辅助由业务在 action 内决定，两者互不依赖

## Store

属性：`name`、`state`（只读保护代理，含 Map/Set 变异拦截）、`actions`、`hooks`、`destroyed`。

### state 与状态保护

合法写入口是 `setState` / `$patch` / `$replaceState` / `$restore`；action 内的
`this.state` 是脏跟踪代理，可直接写。直接写 `store.state` 在开发期抛错，生产期按
`stateProtection.productionHandler` 处理。**三档均不静默**：`error` / `warn` / `silent`
在生产期都会经 `onError(error, 'stateProtection')` 上报，`silent` 只是关闭控制台输出，
不会关闭上报。

- **Map / Set**：`Map` 的 `set` / `delete` / `clear`、`Set` 的 `add` / `delete` / `clear`
  与属性写入同口径；深保护下 `get` / 迭代器 / `forEach` 返回的成员对象也被包装，
  浅保护只保护集合本身。
- **身份**：`store.state.map` 是保护代理，不等于 Store 内部的原始 Map；对象值经 `get`
  读回也是代理。Map/Set 不是可序列化数据，注入 `setData` 前应派生普通对象或数组。
- **豁免**：既不可配置又不可写的自有数据属性拿到的是裸引用（不受保护、不标脏、不通知）；
  Date / RegExp / WeakMap / WeakSet 的内部变异不追踪。
- **敏感键**：`__proto__` / `constructor` / `prototype` 写成自有数据属性、不改原型；
  这类键的值不是对象时，该次写入不生效。

方法：

- `getState(): S`：当前状态的原始引用
- `setState(key, value): void`：写单个键；没有有效变更时不通知
- `$patch(partial): void`：深合并多个键；要求当前状态根为纯对象（数组/类实例等非纯对象根抛 `TypeError`，不再静默跳过合并）；空 patch 不通知；本次涉及的顶层键全部标脏，
  `deepMerge` 中途抛错时按已写入的键记账后原样重抛
- `$replaceState(state | (() => S)): void`：深拷贝后整树替换；旧键与新键都标脏
- `$snapshot(): Readonly<S>`：深克隆出只读快照，纯对象与原生数组递归冻结；类实例等不可克隆值
  保留原引用（不冻结、可能仍与活状态共享）
- `$restore(snapshot): void`：从快照恢复，内部走 `$replaceState`
- `$reset(reason?: 'direct' | 'resetAll'): void`：重置为**初始状态**：语义 = 以构造时初始状态执行 `$replaceState`；订阅关系保持有效（无需重绑）；持久化插件经订阅把默认值写回存储（敏感草稿随之清理）。重置前后 emit `beforeReset` / `afterReset`（info = `ResetInfo`，只含 storeName / reason / timestamp，失败时 `afterReset.ok=false` 后 rethrow），loggerPlugin 默认输出审计日志。`defineStores` 聚合表另有 `resetAll()`（以 reason=`'resetAll'` 重置全部已实例化模块，实例不销毁）
- **快照不是持久化**：`$snapshot()` 仅用于撤销、草稿与检查点，产物是内存对象，不跨页面重载、不跨进程/会话；**跨进程/跨会话恢复必须走 `persistencePlugin` + `schemaVersion`/`migrations`**，不要自己序列化快照写 storage。库**不会自动全量快照**（每次变更不克隆整棵树），也**不得把快照当 Diff 基线**——增量更新走 的写时路径追踪，不建状态镜像；快照不承诺跨版本兼容
- `dispatch(name, ...args): R`：按名调用 action；未知 action 抛 `TallyStoreError`
- `getter(name): R`：调用 getter，只接受一个参数；未知名字或执行失败抛 `TallyStoreError`
- `getterNames(): string[]`：已声明的 getter 名列表（ 映射校验用）
- `subscribe(listener, { readOnly? }): () => void`：订阅，返回退订函数
- `getSubscriptionCount(): number`：当前在册订阅数（含同一监听器的多份注册； 压测与诊断）
- `use(plugin): () => void`：安装插件并返回卸载函数；同一插件实例重复 `use()` 不重复安装，
  开发期告警；生产期经 `onError(INVALID_CONFIG, 'plugin')` 上报（不静默），仍返回等效卸载函数；
  开发期告警并返回一个等效的卸载函数
- `batch(fn): T` / `startBatch()` / `endBatch()`：批量写入，仅最外层收尾时通知
- `isStateKeyDirty(key): boolean`：该键自上次通知以来是否变更
- `isStateProtectionEnabled(): boolean` / `setStateProtection(enabled): void` /
  `getStateProtectionConfig(): Readonly<StateProtectionOptions>`：状态保护开关与配置
- `destroy(): void`：卸载插件与订阅；幂等，重复调用无副作用

### 通知与脏键

- **默认同步**：每次有效写入立即通知。
- **batch**：仅最外层收尾通知一次；只覆盖同步段，`await` 之后的写入逐条通知（开发期有告警）。
- **dispatch 同步 action**：action 期间抑制通知，收尾补发一次。
- **异步 action**（返回 thenable）：同步段结束补发一次；`await` 之后的写入各自立即通知；
  settle 再补发一次。因此默认可能是 2 次或更多，不要断言恰好次数。`notify.onlyOnChange`
  会按变更计数去重同步段/结算的补发，但不阻止 `await` 之后写入的即时通知。
- **`notify.async=true`**：同一 tick 内多次通知合并为一次微任务；`destroy` 取消待发通知。
- **`notify.clone`**：默认 `false`——全部订阅者只读时零拷贝（载荷是只读保护代理）；存在可写订阅者时
  这次通知的拷贝，只读注册共用一份、可写注册各一份。`true` 时强制深拷贝，规则同上。
- **订阅**：同一函数注册 N 次就通知 N 次，每个退订句柄只抵消自己那份；默认上限 50，触顶
  `evict-oldest` 驱逐最早注册并向 `onError` 发 `'subscribe'` 源事件，`throw` 则直接抛错。
- **监听器**：签名 `(state) => void`，没有 `prevState`；单个监听器抛错被逐个隔离，开发期
  `console.error`，生产期经 `onError` 上报。
- **脏键**：`isStateKeyDirty(key)` 在同步监听器内读取有效，通知结束清空；同一对象经多条路径
  可达（别名）时保守标脏全部顶层键；`$replaceState` 把被替换掉的旧键一并标脏。

## 钩子

`store.hooks` 是 `IHookSystem`：`on(name, handler): () => void`、`emit(name, ...args)`、
`clear(name?)`、`size(name?)`、`listenerCount(name)`。十三个钩子及其实参：

| 钩子                                       | 实参                                                   |
| ------------------------------------------ | ------------------------------------------------------ |
| `beforeSetState` / `afterSetState`         | `key`、`value`                                         |
| `beforePatch` / `afterPatch`               | `partialState`                                         |
| `beforeReplaceState` / `afterReplaceState` | `newState`                                             |
| `beforeReset` / `afterReset`               | `{ storeName, reason, timestamp }`；afterReset 含 `ok` |
| `beforeDispatch`                           | `actionName`、`args`                                   |
| `afterDispatch`                            | `actionName`、`args`、`result`                         |
| `onError`                                  | `error`、`source?`                                     |
| `onNotify`                                 | `{ listeners }`（指标）                                |
| `onHostWrite`                              | `{ bytes, host }`（指标）                              |

## 错误

`TallyStoreError` 构造签名 `(code: ErrorCode | string, message: string, context?: Record<string, unknown>, cause?: unknown)`，
公开成员 `code` / `message` / `context?` / `cause?` / `toJSON()`，`name` 恒为 `'TallyStoreError'`。
`cause` 是不可枚举自有属性（对齐原生 `Error` 的 `cause`，不会混进 `Object.keys` / 展开）；
`toJSON()` 递归序列化本库 `cause` 并保留其 `code` / `context`，原生 `Error` 归一为
`name` / `message` / `stack`。
`isTallyStoreError(value)` 是类型守卫。错误码是**稳定契约**：新增码记入 CHANGELOG，删除或改语义走主版本。
`context` 只含标识类字段（Store 名、键名、阶段），不携带状态值等敏感明文。

### 错误码表

| 错误码                   | 含义            | 触发条件                                                                                      | 恢复建议                                                                                    |
| ------------------------ | --------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `ACTION_NOT_FOUND`       | 未知 action     | `dispatch` / 直接调用未声明的 action 名                                                       | 检查拼写与 Store 定义；`context.availableActions` 给出可用列表                              |
| `ACTION_EXECUTION_ERROR` | action 执行失败 | action 体或 `beforeDispatch` 钩子抛错；嵌套 dispatch 的 execute 层错误原样上抛、不重复包装    | 看 `cause` 定位业务错误；抛错前的写入已补发，状态不回滚                                     |
| `GETTER_NOT_FOUND`       | 未知 getter     | `getter()` 传未声明的名字                                                                     | 检查拼写；`context.availableGetters` 给出可用列表                                           |
| `GETTER_EXECUTION_ERROR` | getter 执行失败 | getter 函数抛错                                                                               | 看 `cause`；getter 应保持廉价、只读                                                         |
| `INVALID_CONFIG`         | 配置取值非法    | `schedule` / `maxPayloadBytes` / `stateProtection.productionHandler` 等取值不在合法枚举或范围 | 按 `context.option` 修正配置值                                                              |
| `INVALID_MAPPING`        | 映射非法        | action 本地名与宿主保留成员同名、宿主成员不可重定义等绑定被跳过（经 `onError`）               | 换本地名或调整宿主成员属性；`context.localName` / `actionName` 定位                         |
| `PERSISTENCE_ERROR`      | 持久化失败      | 恢复 / 落盘 / 卸载补写 / 清理各阶段失败（经 `onError`）                                       | 看 `context.phase`（init/restore/save/uninstall）与 `cause`；配额满时收缩 `filter`          |
| `HOST_WRITE_ERROR`       | 宿主写入失败    | `setData` / `globalData` 写入抛错（经 `onError`，`cause` 保留原始错误）                       | 检查字段是否含不可序列化值；失败批次 3 次微任务内自动重试，仍失败则等下一次映射写入合并重试 |

结构性 JS 误用（传 `null` / 非对象、symbol 映射键等）仍抛普通 `TypeError`，不占用库错误码。

### `onError(error, source)` 的 source 枚举

| source                                                        | 环节                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| `'register'`                                                  | 生产期重复 Store `name`                                  |
| `'dispatch'`                                                  | action 执行收尾链路自身抛错                              |
| `'notify'`                                                    | 同步模式下订阅者（含映射更新器）抛错                     |
| `'stateProtection'`                                           | 生产期非法直写（三档降级均上报）                         |
| `'payload'`                                                   | 映射写入载荷超过 `maxPayloadBytes`                       |
| `'mapping'`                                                   | 非法映射（字段不存在 / 本地键冲突 / 运行期不可序列化值） |
| `'plugin'`                                                    | 生产期重复安装同一插件实例                               |
| `'unbind'`                                                    | 解绑后订阅计数未下降（退订失效泄漏）                     |
| `'bindActions'`                                               | action 绑定被跳过（保留成员 / 不可重定义）               |
| `'persistence'`                                               | 持久化插件各阶段失败                                     |
| `'withPageStore'` / `'withComponentStore'` / `'withAppStore'` | 微任务调度模式下该入口的宿主写入失败                     |

dispatch 未知 action、getter 未知名字、getter 执行失败都抛 `TallyStoreError`；内部误用抛普通
`Error` / `TypeError`。

## API 稳定性分级

三档分级：`stable`（可依赖，破坏性变更只走主版本；0.x 阶段的破坏性变更会显式标注并提供
迁移说明）、`experimental`（语义可能随小版本演进，不出现在推荐用法中）、`deprecated`
（已废弃：`@deprecated` 标注 + 文档给出替代 + 开发期运行告警，保留至少一个 minor 后移除）。

| 分级           | 条目                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stable`       | `createStore` / `Store` 全部方法 / `defineStores` / `createRaceGuard` / `dispatch` 体系 / 三类宿主集成 / `unbindStore` / `ErrorCode` 体系 / `persistencePlugin` / `loggerPlugin` / `metricsPlugin` / `WxStorageBackend` / `isSensitiveKey` / `maskSensitiveValue` / `DEFAULT_SENSITIVE_KEY_PATTERNS` / 全部类型导出 |
| `experimental` | `addSensitiveKeyPatterns` / `resetSensitiveKeyPatterns` / `maskForLog`（随指标上报与持久化演进，观察一个 minor）                                                                                                                                                                                                    |
| `deprecated`   | （暂无；通道就绪，见 CHANGELOG 的废弃策略）                                                                                                                                                                                                                                                                         |

**API 表面门禁**：`pnpm run api:report -- --check` 与提交的快照
（`scripts/api-snapshot.json`）比对——导出增删必须在 PR 里同步更新快照并
在 CHANGELOG 记录分级；签名级变化由类型测试（`tests/types`）与 `typecheck` 承载。

## 敏感键与脱敏

```ts
import { isSensitiveKey, addSensitiveKeyPatterns, maskSensitiveValue } from '@unitseek/tallystore'

isSensitiveKey('userPhone') // true（内置清单：手机号/证件号/token/密码/完整地址/银行卡）
maskSensitiveValue('13812345678') // '1***78'（11~15 位保留首 1 + 尾 2；≤10 位全遮 '***'）
maskSensitiveValue('tk-abcdef1234567890') // 'tk-***7890'（≥16 位保留首 3 + 尾 4）
addSensitiveKeyPatterns(['employeeno']) // 扩展业务敏感键（需走评审，见 SECURITY.md）
```

- 清单扩展：字符串按**字面量**注册（`(`、`.` 等元字符转义，不再被当成正则/通配）；
  `RegExp` 重建为大小写不敏感并去掉 `g`/`y`（避免 `lastIndex` 推进导致同一键判定抖动）；
  空字符串 / 非 string / 非 RegExp 显式抛 `TypeError`，且整批校验通过后才生效
- 脱敏策略：长度 ≤10 的字符串全遮 `***`；11~15 位保留首 1 + 尾 2；≥16 位
  保留首 3 + 尾 4；非字符串一律 `***`（长值仍可辨识、不可还原）
- 持久化：**递归**扫描落盘载荷（纯对象/数组，含数组下标路径，如
  `profile.phone`、`orders[0].token`）；类实例按自有可枚举字段展开（与 `JSON.stringify` 落盘
  口径一致），带 `toJSON()` 的对象按其返回值继续审计；Map/Set/Date/RegExp 不展开。命中任一
  敏感键即**拒绝本次落盘**（开发期
  `console.error` + `onError`，生产期仅 `onError(PERSISTENCE_ERROR, 'persistence')`），
  不写任何含敏感字段的载荷；请用 `filter` 收缩落盘范围，或先派生脱敏值
- 日志：`loggerPlugin` 的 state / setState 输出自动按键脱敏（非敏感键也会对值
  做深度脱敏）；深度上限 4 层，**超过上限的子树输出 `'[MaxDepth]'` 占位**而非原文（fail-closed）；
  dispatch 的参数数组整体脱敏。已知限制：位置参数是不带键名的原始值，无法按键判定、不做脱敏
  ——敏感实参请传对象并命名敏感键
- 完整清单与合规四项评审清单（字段/存储/日志/上报）见 [SECURITY](../SECURITY.md)

## 小程序集成

三者签名一致：`(store, options?) => (hostConfig) => 增强后的 hostConfig`。只有三类映射：

- `mapState`（`readonly (keyof S)[] | Record<string, keyof S>`）：数组不改名，对象可重命名
- `mapGetters`（`readonly (keyof G)[] | Record<string, keyof G>`）：同上
- `mapActions`（`readonly (keyof A)[] | Record<string, keyof A>`）：对象的值必须是 action 名
- `backgroundUpdates`（默认 `true`）：前后台更新策略。页面进入后台（`onHide` /
  组件 `pageLifetimes.hide`）后映射写入不下发（合并缓存），回前台按**最新状态**一次性
  对齐，不重放中间态；可见性信号缺失（宿主未走生命周期）时自动回退立即更新。
  `false` 关闭策略（后台也立即更新，供需要后台实时数据的页面）
- `schedule`（`'auto' | 'sync' | 'microtask'`，默认 `'auto'`）：映射写入宿主的时机。
  Skyline 实例（`this.renderer === 'skyline'`）合并同一 tick 的多次 `setData`，其余宿主逐次同步；
  `'sync'` 强制逐次、`'microtask'` 强制合并。初始映射始终同步交付，卸载/重入时丢弃挂起写入；
  异步写入失败会保留该批次，并在后续 3 次微任务内有界自动重试（成功即停）；仍失败则保留到
  下一次映射写入时合并重试，并通过 `onError` 上报（持续失败只上报一次，避免刷屏）
- `maxPayloadBytes`（默认 `1048576`）：单次映射写入的载荷预算（字节，JSON 序列化估算口径）。
  超过预算时经 `onError(error, 'payload')` 告警，消息含最大字段与估算字节数、拆分建议；
  **数据仍照常下发**（告警不阻断）。`0` 关闭守卫。字节估算按 UTF-8 折算（含中文与 emoji），
  不可序列化载荷（循环引用 / BigInt）跳过守卫不误报

映射约束：

- 本地键必须是不含 `.` / `[` / `]` 的普通字段名（setData 支持路径写法，库不接受这种歧义）；
  `__proto__` / `constructor` / `prototype` 与 symbol 键一律在装饰期抛 `TypeError`
- **映射字段必须存在**：`mapState` / `mapGetters` / `mapActions` 的键不在 Store
  声明中时，开发期在装饰期抛 `INVALID_MAPPING`（消息含 Store 名、字段名与可用字段列表）；
  生产期剔除该键（跳过映射）并经 `onError(error, 'mapping')` 上报，不阻塞页面渲染
- **本地键冲突**：同一宿主上多个 Store 映射同一本地键、同一 Store 内
  `mapState` 与 `mapGetters` 共用同一本地键、或本地键与宿主**自有** `data` 键同名
  （含 Component 的 properties 拷贝），开发期绑定时报 `INVALID_MAPPING`；生产期剔除该键
  并上报。`mapActions` 绑定在实例成员/组件 methods，与 data 载荷命名空间不同，允许与
  data 映射同名。宿主自有键快照只在首次绑定时采集——重复 `onLoad` 时映射自己写入的键
  不会被误判；解绑后本地键占用释放，其它 Store 可复用
- **不可序列化值不得直接映射**：函数 / 类实例 / `Map` / `Set` 作为初始
  映射值时，开发期绑定时报 `INVALID_MAPPING` 并指出字段；生产期上报。运行期映射值变为
  这些类型（或 BigInt / Symbol / 循环引用）时，该本地键被剔除、不进入 `setData`，并经
  `onError(INVALID_MAPPING, 'mapping')` 上报路径；合法兄弟键照常下发。`Map` / `Set` 允许
  存在于状态，但须在 action 内派生普通数据后再映射（`Date` / `RegExp` 放行）
- 映射值变为 `undefined` 时下发 `null`（微信 setData 不接受 undefined），用于清除宿主旧值
- `mapActions` 的本地名不得与宿主生命周期/框架成员同名（如 `onLoad` / `onShow` / `setData` /
  `data`），Page 与 Component 同口径：冲突时跳过并经 `onError(error, 'bindActions')` 上报

Page 在 `onLoad` 建立映射与订阅、`onUnload` 退订；Component 在 `lifetimes.attached` /
`lifetimes.detached` 同理。若实例提供 `methods` 命名空间（测试/自定义宿主），映射 action
并入 `methods` 并在 `detached` 恢复被遮蔽成员；原生微信组件不暴露 `this.methods`，action
绑定在实例顶层方法，`detached` 按原描述符回放配置级被遮蔽的用户方法。

**手动解绑与泄漏告警**：`unbindStore(host, store)` 在生命周期之外提前解绑某
Store 在宿主实例上的全部映射/action 绑定（幂等）。解绑时先做同步快速检查：本绑定持有过
映射订阅而 `store.getSubscriptionCount()` 未下降即开发期 `console.warn` + `onError('unbind')`。
随后再延迟一个 tick 复核**实例级订阅计数**（扣除复核窗口内新建的合法订阅）；仍残留才上报，
每次解绑最多一次。正常解绑不产生告警，重复 `unbindStore` 幂等。
App 把 `mapState` / `mapGetters` 写进 `globalData`，订阅贯穿运行期，不随 `onHide` 清理。
App 侧 `mapState` 与 `mapGetters` 同本地键时与 Page 同口径：getter 胜出（类型层先 Omit 同名
state 键再合并 getter，不会塌成 `never`）。
`withAppStore` 会包装 `onHide` / `onShow` 以驱动 `backgroundUpdates` 门控（仍调用用户
原始生命周期回调）；配置对象复制保留原型，原型上的 `onLaunch` 不会丢失。
`globalData` 必须是非数组对象：开发期在 `onLaunch` 抛 `TypeError`；生产期经
`onError(error, 'mapping')` 上报后以 `{}` 兜底继续启动，用户 `onLaunch` 仍会执行。
映射值变化时才 `setData`（脏键过滤），getter 每次通知重算。重复的 `onLoad` / `onLaunch` /
`attached` 会先清旧绑定再建新绑定。集成不注入 Store 实例，也不会在 `onShow` 时重放状态。

## plugins

插件契约：`{ name: string, install(store): void | (() => void) }`；`store.use(plugin)` 返回卸载
函数，重复 `use()` 不重复安装，开发期告警并返回一个等效的卸载函数。

```ts
import { loggerPlugin, persistencePlugin, WxStorageBackend } from '@unitseek/tallystore/plugins'

store.use(
  persistencePlugin({
    key: 'cart',
    debounce: 100,
    // 必填：只落盘白名单字段（默认不落盘任何字段）
    filter: (state) => ({ items: state.items }),
  }),
)
store.use(loggerPlugin({ sink: console }))
```

### metricsPlugin

```ts
import { metricsPlugin } from '@unitseek/tallystore/plugins'

const plugin = metricsPlugin({ sink: { report: (event) => myMonitor.send(event) }, sampleRate: 0.1 })
store.use(plugin)
```

采集**通知次数 / 宿主写入次数与估算字节 / action 次数与同步段耗时 / 错误数 / 订阅数**
（`onNotify` / `onHostWrite` / dispatch 钩子 / `onError` / `getSubscriptionCount`）；字节
估算复用载荷守卫的计算（热路径零额外序列化；`maxPayloadBytes: 0` 关闭守卫时不计字节）。
事件白名单 schema（`MetricsEvent`）：全部为计数 / 耗时 / 字节 / 名称类字段，**不含状态值
与个人信息**；除累计字段外，事件还包含最近一次写入 / 历史最大写入 / 最近宿主 / 最近 action，
用于「Action → 宿主更新」归因：

| 字段                 | 类型           | 含义                                                  |
| -------------------- | -------------- | ----------------------------------------------------- |
| `hostWriteBytes`     | number         | 自安装以来累计宿主写入估算字节                        |
| `lastHostWriteBytes` | number         | 最近一次宿主写入载荷估算字节（未写入为 0）            |
| `maxHostWriteBytes`  | number         | 历史最大单次宿主写入载荷（未写入为 0）                |
| `lastHost`           | string \| null | 最近写入的宿主标签（入口名，如 `withPageStore`）      |
| `lastActionName`     | string \| null | 最近一次 dispatch 的 action 名（未 dispatch 为 null） |

`lastActionName` 在 `beforeDispatch` 更新、`afterDispatch` 确认；action 内触发的宿主写入
在事件中携带该名字，实现日志/指标层「哪个 Action 导致哪个宿主更新」的归因。sink 上报前
按白名单字段与类型做运行时校验（数值有限且非负）；出现白名单外字段、缺字段或类型非法时
**不调用 sink**——开发期 `console.error` + `onError(INVALID_CONFIG, 'metrics')`，生产期仅
`onError`，不影响计数与业务。`sampleRate` 0-1（默认 0 只计数不上报），卸载时不受采样抑制
做一次关账全量上报；sink 可注入可替换（库不内置厂商 SDK），sink 抛错被隔离不影响业务；
`collector.snapshot()` 供测试与诊断读计数。生产默认不安装。action 耗时为**同步执行段**
口径（异步 action 不含 `await` 段）。

### persistencePlugin

`persistencePlugin(options?: PersistenceOptions<S>): Plugin<S>`。请用**工厂形式**并显式传
`filter`；直接 `use(persistencePlugin)`（Plugin 对象形态）没有 options，会因缺少 `filter` 按
下面的缺省规则报错/禁用。选项与默认值：

| 选项               | 默认                       | 说明                                                              |
| ------------------ | -------------------------- | ----------------------------------------------------------------- |
| `key`              | `tallystore_${store.name}` | 存储键，可写字符串或 `(storeName) => string`                      |
| `storage`          | 内置 wx 后端               | `StorageBackend`；显式传入时必须同步且三方法齐备                  |
| `filter`           | **必须显式声明**           | `((state: S) => Partial<S>) \| false`：白名单；`false` = 显式关闭 |
| `validate`         | —                          | `(state: unknown) => boolean`，恢复前校验（返回 false 跳过恢复）  |
| `restore`          | `true`                     | 安装时是否恢复                                                    |
| `debounce`         | `0`                        | 落盘防抖毫秒；0 = 变更即落盘                                      |
| `clearOnUninstall` | `false`                    | 卸载时是否删除存储数据                                            |
| `schemaVersion`    | —                          | 数据 schema 版本：提供时落盘为信封 `{ $tallyV, $tallyD }`         |
| `migrations`       | —                          | 迁移钩子：键为目标版本，恢复时按 savedV+1 → 当前版本顺序执行      |

- **必须显式声明 `filter`**：默认**不落盘任何字段**，禁止自动全量持久化。
  - `filter: (state) => ({ ... })`：白名单，只落盘返回的键（建议只挑非敏感、可 JSON 往返的字段；
    返回空对象 `{}` 即只落盘空对象）；
  - `filter: false`：显式关闭持久化——不读 storage、不恢复、不订阅保存、不写盘/清理，安装返回
    幂等 no-op uninstall，不报错；
  - **缺省（或非函数/非 false 的非法值）**：开发期抛 `INVALID_CONFIG`（消息指出必须显式提供
    filter 或 `filter: false`）；生产期经 `onError(INVALID_CONFIG, 'persistence')` 上报后禁用
    持久化，且 `getItem` / `setItem` / `removeItem` 零调用。
- **默认后端**：不传 `storage` 时使用内置 `WxStorageBackend`；wx 同步存储 API 不可用时降级为
  内存存储（开发期告警；生产期不刷控制台，但通过 `onError` 通道发 `'persistence'` 源事件）。
- **显式 `storage`**：安装期校验三个同步方法，缺方法直接抛 `TypeError`，不会静默改用 wx 或内存。
- 恢复值必须是纯对象；坏 JSON、`validate` 返回 false、后端抛错都会跳过恢复并
  `emit('onError', ..., 'persistence')`。
- **版本迁移**：配置 `schemaVersion` 后落盘为信封；恢复时若存储版本低于
  当前，按 `migrations` 链逐版迁升；**迁移抛错、缺步或存储版本高于当前（降级安装）都回退
  默认值（跳过恢复）并上报**，不把坏数据注入 Store。未配置版本化的存量数据（裸对象）照常
  恢复，不做迁移。示例：

  ```ts
  store.use(
    persistencePlugin({
      key: 'cart',
      filter: (state) => ({ items: state.items, currency: state.currency }),
      schemaVersion: 2,
      migrations: { 2: (data) => ({ ...data, currency: data.currency ?? 'CNY' }) },
    }),
  )
  ```

- **配额告警**：落盘载荷按 UTF-8 字节估算 ≥900KB（微信单 key 上限 1MB）时经
  `onError(PERSISTENCE_ERROR, 'persistence')` 告警一次并附收缩建议；写满抛错走既有失败兜底。
- **升级写回**：仅当恢复发生迁移或补版本信封（`pendingUpgrade`）时，
  恢复后的首个通知会立即按当前 schema 升级写回一次（不依赖下一次真实变更或卸载）；若只是
  默认键/filter 归一造成的文本差异，不再强制重写，避免共享 key 的陈旧覆盖。
- **未知选项**：拼错的选项名（如 `schemaVerion`）不再静默忽略——开发期 `console.warn` +
  两期 `onError(INVALID_CONFIG, 'persistence')` 上报。
- **恢复时机**：`restore: false` 完全关闭（安装时零存储读取）；**延迟恢复由安装时机承载**——
  在首屏 `setData` 之后再 `use(persistencePlugin(...))` 即可把同步读移出启动关键路径。
- **落盘载荷必须可序列化**：开发期与生产期都会在 `JSON.stringify` 前扫描
  `filter` 结果；命中函数 / BigInt / Symbol / `undefined` / `Map` / `Set` / 类实例 / `RegExp` /
  循环引用即**拒绝整次落盘**（不写后端、不推进 `lastSaved`），经 `onError(PERSISTENCE_ERROR,
'persistence')` 上报路径；生产期同样 fail-closed，不静默丢数据。`Date` 放行并按 ISO 字符串落盘。
- `filter` 必须返回对象（否则拒绝写入并上报 onError）；非纯对象/序列化失败同样上报；返回
  空对象 `{}` 表示只落盘空对象（默认不落盘任何字段）。`filter` 本身必填，缺失按上文
  「必须显式声明 filter」的规则报错/禁用。
- 卸载时清除待触发的定时器；未开 `clearOnUninstall` 时补写待写状态与最终状态，开启时删除
  存储键。三个内置插件在生产模式都不输出 console。

### WxStorageBackend

封装 `wx.getStorageSync` / `wx.setStorageSync` / `wx.removeStorageSync`。三方法必须同步返回；
缺失键归一为 `null`；方法缺失或返回值不是同步结果时抛错。`setItem` 的 value 必须是
字符串：开发期对非字符串载荷告警，运行时非字符串直接 fail-fast（避免把 `[object Object]`
写进存储）。

`StorageBackend`：`getItem(key): string | null`、`setItem(key, value): void`、
`removeItem(key): void`，三者都必须同步返回。

### loggerPlugin

`loggerPlugin(options?: LoggerPluginOptions): Plugin`，也可作为 Plugin 对象直接 `use`。
`LoggerPluginOptions.sink?: LogSink`（默认 `console`）；`LogSink` 为 `{ log, error }`。

- **重置审计**：订阅 `beforeReset` / `afterReset`，输出 `[TallyStore] Resetting store:` /
  `[TallyStore] Store reset:`（storeName / reason / timestamp / ok）；只含标识与时间，不含任何状态值，
  卸载时一并解绑
- **宿主写入归因**：订阅 `onHostWrite`，输出 `[TallyStore] Host write:`
  （host / bytes + 最近一次 `beforeDispatch` 的 action 名），回答「哪个 Action 导致哪个宿主更新」

类型导出：`PersistenceOptions`、`StorageBackend`、`LoggerPluginOptions`、`LogSink`。

## 相关文档

- [GUIDE](./GUIDE.md)：概念与用法
- [ARCHITECTURE](./ARCHITECTURE.md)：分层与设计取舍
- [COMPATIBILITY](./COMPATIBILITY.md)：支持矩阵与环境前提
- [PERFORMANCE](./PERFORMANCE.md)：成本模型与开关
- [RECIPES](./RECIPES.md)：可复制配方
- [文档索引](./README.md)：全部文档
