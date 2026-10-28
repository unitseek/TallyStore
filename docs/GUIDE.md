# 使用指南

概念与用法。签名与默认值看 [API.md](./API.md)，分层与取舍看 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 本文内容

- [心智模型](#心智模型)
- [创建 Store](#创建-store)
- [读与写](#读与写)
- [订阅与通知](#订阅与通知)
- [Action](#action)
- [Getter](#getter)
- [异步竞态与取消辅助](#异步竞态与取消辅助)
- [页面、组件与 App 集成](#页面组件与-app-集成)
- [插件](#插件)
- [错误处理](#错误处理)
- [开销与体积](#开销与体积)
- [常见问题](#常见问题)
- [相关文档](#相关文档)

## 心智模型

状态沿一条线流动：**写入口 → 状态 → getter / 订阅者**，action 负责把业务操作接到写入口上。

- 状态只能经 Store 的写入口修改（直接改 `getState()` 的返回值不会通知任何人）；action 里用
  `this.setState` / `this.$patch` / `this.dispatch`；getter 只读状态、每次重算

## 创建 Store

```ts
import { createStore } from '@unitseek/tallystore'

export const user = createStore({
  name: 'user', // 日志前缀与持久化默认键的来源
  state: () => ({ name: '', age: 0 }), // 工厂写法：每次创建新对象
  actions: {
    rename(name: string) {
      this.setState('name', name)
    },
  },
  getters: { label: (state) => state.name || '未命名' },
})
```

选项：`name` / `state` / `actions` / `getters` / `stateProtection` / `subscription` / `notify`，
默认值见 [API](./API.md)。初始状态会被深拷贝进 Store，之后改 `options.state` 的引用
不影响 Store；多实例与热重载场景用工厂写法，避免共享引用。

## 读与写

```ts
store.getState() // 当前状态（原始引用）
store.state // 受保护代理：开发期非法写入（含 Map/Set 变异）抛错
store.setState('count', 1) // 单个键
store.$patch({ count: 1, name: 'a' }) // 递归合并多个键
store.$replaceState({ count: 0 }) // 整体替换；也接受 () => nextState
```

- `setState` 与 `$patch` 用 `Object.is` 判断值是否变化；没变化就不写入、不通知；空补丁同样不通知
- `$patch` 对对象值做**深合并**；合并后本次涉及的顶层键全部标脏（保守超集）；合并中途抛错也按
  已写键记账后重抛
- `$replaceState` 深拷贝新状态后整树替换；新旧键都标脏
- `$reset()` 把本模块恢复到初始状态：订阅保持有效、实例不销毁；重置前后 emit `beforeReset` /
  `afterReset` 审计事件（直接调用 reason=`'direct'`，`resetAll` 为 `'resetAll'`），loggerPlugin 会输出
  store/reason/timestamp/ok 脱敏日志，便于排查「状态被谁清空」
- `$snapshot()` 返回深克隆副本，纯对象与原生数组递归冻结；类实例等不可克隆值保留原引用
  （不冻结、可能与活状态共享）。`$restore(snap)` 经 `$replaceState` 恢复
- **快照不是持久化**：只覆盖撤销/草稿/检查点；跨进程/跨会话恢复必须走 `persistencePlugin` 的
  `schemaVersion` + `migrations`。库**不会自动全量快照**，也**不得把快照当 Diff 基线**（增量更新按
  写时路径追踪，不建状态镜像）；快照不承诺跨版本兼容
- 对 `__proto__` / `constructor` / `prototype` 这类敏感键，写入落成**自有数据属性**，不改原型
- **Map / Set 的变异同样被拦截**：`set` / `add` / `delete` / `clear` 与属性写入同口径；深保护下
  `get` / 迭代器 / `forEach` 返回的成员对象也是代理。集合不是可序列化数据，注入 `setData` 前
  先派生普通数据
- **身份会变**：`store.state.map` 是代理，与原 Map 不是同一个引用；需要原对象时用 `getState()`
- 同一对象被多个顶层键引用（别名）时，写它会保守标脏**全部相关顶层键**

## 订阅与通知

```ts
const off = store.subscribe((state) => console.log(state.count))
const off2 = store.subscribe(onChange, { readOnly: true })
off() // 退订

store.batch(() => {
  store.setState('a', 1)
  store.setState('b', 2) // 只通知一次
}) // 也可用 startBatch() / endBatch() 手动配对
```

- **只观察的订阅一定标 `readOnly`**：可写订阅会让 Store 在通知前深拷贝整棵状态树
- 监听器签名只有 `(state) => void`，没有 `prevState`；需要前后对比时在闭包里自己保存
- 同一函数注册 N 次就通知 N 次；每个退订句柄只抵消自己那一次。订阅有上限（默认值见
  [API](./API.md)），长列表页请用一个页面级订阅 + `setData` 分发
- **默认同步通知**：每次有效写入立即通知。只有 `notify.async: true` 才把同一 tick 内的多次通知
  合并成一次微任务（`destroy()` 会取消待发通知）
- `batch()` 只在最外层收尾时通知一次，且只覆盖同步段；`await` 之后的写入逐条通知
- 同步 action 在 dispatch 期间抑制通知、收尾补发一次；**异步 action 的通知次数不固定**：同步段结束
  补发一次，`await` 之后的每次写入各自立即通知，settle 再补发一次（可能 2 次或更多，不要按次数断言）
- `notify.onlyOnChange` 只去重同步段与结算时的补发，不会挡住 `await` 之后写入的即时通知

## Action

```ts
const cart = createStore({
  name: 'cart',
  state: () => ({ items: [] as string[] }),
  actions: {
    add(id: string) {
      this.$patch({ items: [...this.getState().items, id] })
    },
  },
})

cart.actions.add('sku-1') // 直接调用
cart.dispatch('add', 'sku-1') // 按名调用，类型安全
```

`dispatch` 与直接调用等价，区别是按名字路由。两种方式共享同一事务语义：action 执行
期间通知被抑制、结束统一补发；抛错时包装为 `TallyStoreError`（`cause` 保留原始错误）
并经 `onError` 上报，抛错前的写入不丢失。action 内也可以直接写 `this.state.count++`
（`this.state` 是脏跟踪代理）；返回 Promise 的 action，调用方拿到的就是那个 Promise。

## Getter

getter 只接收状态：`getters: { total: (state) => state.price * state.count }`，
用 `store.getter('total')` 读取。

- `store.getter(name)` **只接受一个参数**；getter 函数也不接受额外参数
- **没有任何结果缓存**：每次 `getter()` 都按当前状态重算；读到的是受保护的 state，不能借 getter 写状态。
  需要「依赖未变就复用」时在业务侧用 `lastState` / `lastValue` 比较

## 异步竞态与取消辅助

`createRaceGuard()` 是**与 Action 解耦**的最小竞态辅助：取号 → 结果落地前判定 → 丢弃旧结果。

```ts
import { createRaceGuard } from '@unitseek/tallystore'

const guard = createRaceGuard()

async function search(keyword: string) {
  const seq = guard.begin()
  const result = await fetchList(keyword)
  if (!guard.isCurrent(seq)) return // 旧结果晚到：丢弃，不写 Store
  store.setState('list', result)
}

search('a')
search('b')
search('c') // 只有最后一次结果落库
guard.cancel() // 取消在途结果；guard.staleCount() 可观测过期判定次数
```

**结果级取消 ≠ 网络级中断**：`cancel()` 只是让结果不落地，是否真正中断底层请求取决于请求库能力；
guard 不包装 Promise，取消后不会产生库侧未处理 rejection。完整签名与 5 连发示例见 [API](./API.md#createraceguard)。

## 页面、组件与 App 集成

```ts
import { withAppStore, withComponentStore, withPageStore } from '@unitseek/tallystore'

Page(
  withPageStore(store, {
    mapState: ['count'], // 数组：字段名不变
    mapGetters: { total: 'total' }, // 对象：本地名 → store 名
    mapActions: { addOne: 'increment' }, // 对象：本地名 → action 名
  })({
    onLoad() {
      this.addOne()
      console.log(this.data.count)
    },
  }),
)
```

签名是 **`(store, options)` 两参数**；调用后返回宿主配置包装器，再传给 `Page` / `Component` / `App`。

- Page 在 `onLoad` 建立映射与订阅，`onUnload` 自动退订
- 同一实例重复 `onLoad` / `attached` / `onLaunch` 会先清理旧绑定再建立，不会叠加订阅
- Component 写法相同：`withComponentStore(store, options)`，生命周期必须写在 `lifetimes` /
  `pageLifetimes` 内；action 方法自动并入 `methods`，`detached` 时清理订阅、恢复被遮蔽的原方法
- App 写法相同：`withAppStore(store, options)`，`mapState` / `mapGetters` 写进 `globalData`，
  订阅贯穿运行期（不随 `onHide` 清理）
- `mapState` / `mapGetters` 只在值变化时 `setData`；getter 每次通知都会重算（无缓存）
- **Skyline**：集成不依赖渲染器。默认 `schedule: 'auto'`，Skyline 页面 / 组件会把同一 tick 的多次
  映射写入合并为一次 `setData`，WebView 仍逐次同步；需要每次写入立即反映到 `data` 时传
  `schedule: 'sync'`。Skyline 的配置要求与限制见 [COMPATIBILITY](./COMPATIBILITY.md)，调度取舍见
  [PERFORMANCE](./PERFORMANCE.md)
- 集成**不会**把 Store 实例挂到 `this`，也不会在 `onShow` 时自动重放状态；需要 Store 时直接 import

## 插件

```ts
import { loggerPlugin, persistencePlugin } from '@unitseek/tallystore/plugins'
store.use(
  persistencePlugin({
    key: 'cart',
    debounce: 100,
    // 必填：白名单（默认不落盘任何字段，禁止自动全量持久化）
    filter: (state) => ({ items: state.items }),
  }),
)
store.use(loggerPlugin({ sink: console }))
```

- 插件契约是 `{ name, install(store) => void | (() => void) }`，返回值即卸载函数
- `persistence` 越早装恢复越早；同一插件实例重复 `use()` 不会重复安装，开发期告警并返回一个
  等效的卸载函数
- **持久化必须显式声明 `filter`**：`filter: (state) => ({ ... })` 是落盘白名单；
  `filter: false` 显式关闭（不读 storage、不恢复、不订阅、不写盘/清理）。不传 filter 会在
  开发期抛 `INVALID_CONFIG`，生产期经 `onError(INVALID_CONFIG, 'persistence')` 上报后禁用；
  默认不落盘任何字段，禁止自动全量持久化。升级到新版本时按 [MIGRATION](./MIGRATION.md) 补 filter。
- 插件通过 `store.hooks` 接入 13 个钩子（含 `beforeReset` / `afterReset`，见 [API](./API.md)）；三个内置插件在生产环境都不输出 console

## 错误处理

用 `store.hooks.on('onError', (error, source) => report(error, source))` 接错误；`isTallyStoreError(error)`
判断是否本库错误。

- dispatch 未声明的 action、getter 未声明的名字会抛 `TallyStoreError`，按 `error.code` 分类
- 订阅者、插件、持久化与通知链上的失败不会顶替原始失败，也不会被静默吞掉：生产环境经 `onError` 上报
- `source` 指出出错环节（完整枚举见 [API](./API.md)），错误对象可直接 `JSON.stringify`

### 校验门控与生产降级

开发期强校验抛错；生产期的降级策略按「运行时可变的校验降级、确定性配置错误两期一致」划分：

| 校验项                                                                     | 开发期                                    | 生产期（source）                                                                           |
| -------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| 重复 Store `name`                                                          | 构造抛 `INVALID_CONFIG`（带冲突双方来源） | 放行，`console.error` + 上报（`register`）                                                 |
| `defineStores` 循环依赖 / 依赖缺失                                         | 注册期抛 `INVALID_CONFIG`（带依赖链）     | 同左（配置错误，两期一致）                                                                 |
| 映射字段不存在                                                             | 装饰期抛 `INVALID_MAPPING`                | 剔除该键 + 上报（`mapping`），页面不阻断                                                   |
| 多 Store 同一本地键 / 宿主 `data` 同名                                     | 绑定期抛 `INVALID_MAPPING`                | 剔除该键 + 上报（`mapping`）                                                               |
| 不可序列化值直接映射（函数/类实例/Map/Set）                                | 初始映射抛 `INVALID_MAPPING`              | 上报（`mapping`）后放行交付链路兜底                                                        |
| 直接改 State（含 Map/Set 变异）                                            | 抛错                                      | 按 `productionHandler` 三档处理，**均上报**（`stateProtection`）                           |
| App `globalData` 同键冲突                                                  | `console.warn` + 上报                     | 上报（`mapping`），不刷控制台                                                              |
| 宿主写入失败（setData 抛错）                                               | 抛出（包装 `HOST_WRITE_ERROR`）           | 上报（`notify` / 入口名），失败批次 3 次微任务内自动重试；仍失败则等下一次映射写入合并重试 |
| 解绑后订阅计数未下降                                                       | `console.warn` + 上报                     | 上报（`unbind`）                                                                           |
| 语义性配置取值非法（`schedule` / `maxPayloadBytes` / `productionHandler`） | 抛 `INVALID_CONFIG`（装饰期/构造期）      | 同左（确定性错误在开发期就会暴露，两期一致不会白屏）                                       |
| 结构性 JS 误用（`null` / 非对象 / symbol 键）                              | 抛 `TypeError`                            | 同左（不占用库错误码）                                                                     |

校验开销不进入生产热路径：装饰期校验仅开发期执行；绑定期的剔除+上报是生产路径本身（O(键数)）。

## 开销与体积

- **只读订阅标 `readOnly`**：省掉每次通知的整棵状态树深拷贝
- **多字段一起改用 `$patch` 或 `batch()`**；getter 不做重活，它没有缓存，每次读取都会执行
- **入口分层不减少上传体积**：微信「构建 npm」整目录拷贝 `dist-weapp/`；不引入的入口只是不执行，
  字节照旧在包里。只有删代码才减包

## 常见问题

**改了 `store.getState()` 为什么不生效？** 状态变更必须走写入口；直接改返回值不触发通知。

**页面 `this.data` 不更新？** 确认 `withPageStore` 是 `(store, options)` 两参数写法，且字段写进了
`mapState` / `mapGetters`。

**Skyline 下 `data` 更新变慢，或者想批量更新？** 默认 `schedule: 'auto'` 已经在 Skyline 下合并同一
tick 的多次映射写入；确认没有误传 `schedule: 'sync'`。反过来，如果紧接着写入就要读宿主侧结果、
需要逐次同步，才显式传 `'sync'`。合并只改变写入时机，映射字段与脏键过滤不变。

**为什么订阅会超限？** 默认上限见 API，插件也占额度；触顶时最早注册的那份被驱逐，插件可能因此
静默停止工作，请给 `onError` 挂上报。

**生产环境为什么没有调试输出？** 生产模式（四档判定见 [README](../README.md)）下日志插件与内部
告警整体静默。

**能在 Taro / uni-app / Node 里用吗？** 不能。本库只面向原生微信小程序，发布产物只有微信用的 CJS
与类型声明。

## 相关文档

- [API](./API.md)：入口、签名与默认值
- [ARCHITECTURE](./ARCHITECTURE.md)：分层与设计取舍
- [COMPATIBILITY](./COMPATIBILITY.md)：支持矩阵与环境前提
- [PERFORMANCE](./PERFORMANCE.md)：成本模型与开关
- [RECIPES](./RECIPES.md)：可复制配方
- [文档索引](./README.md)：全部文档
