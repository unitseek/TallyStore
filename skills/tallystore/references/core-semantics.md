# 核心语义与易误用点

> [`../SKILL.md`](../SKILL.md) 的长尾参考（主入口）。只写「会改变你怎么写代码」的边界；用法见
> `docs/GUIDE.md`，入口与默认值见 `docs/API.md`，签名悬停包内 `.d.ts`。

## 本文内容

- [1. 写入路径与状态保护](#1-写入路径与状态保护)
- [2. 订阅与通知](#2-订阅与通知)
- [3. Getter](#3-getter)
- [4. 运行环境与生产模式](#4-运行环境与生产模式)
- [5. 小程序集成细节](#5-小程序集成细节)
- [6. 插件与持久化](#6-插件与持久化)

## 1. 写入路径与状态保护

合法写入口：action 内 `this.state.xxx` / `this.setState` / `this.$patch` / `this.$replaceState`，
或 store 侧 `setState` / `$patch` / `$replaceState` / `$restore`。禁止 `store.state.xxx = value`。

- `stateProtection` 默认 `{ enabled: true, deep: true, productionHandler: 'warn' }`
- 开发期非法直写**直接抛错**；生产期由 `productionHandler` 决定：`'warn'` 告警后放行、
  `'silent'` 静默放行、`'error'` 抛错；绕过写入口的修改**不触发通知**、也不标脏
- **冻结 / 不可写属性是明确豁免**：既不可配置也不可写的自有数据属性（`Object.freeze` 子树、
  `defineProperty(writable:false, configurable:false)` 的节点）拿到**裸引用**（Proxy 的 `[[Get]]`
  不变量要求原样返回），读得到但不受保护、不标脏、不通知。要追踪生效：把状态放可配置 / 可写的
  属性上，或整体替换
- **Map / Set 的变异同样受保护**：`store.state.map.set(...)`、`set.add(...)`、`delete`、`clear`
  与属性写入同一口径（开发期抛错，生产按 `productionHandler` 处理）；深保护下 `get` / 迭代器 /
  `forEach` 返回的成员对象也会被包装，浅保护只保护集合本身。集合上的自定义数据属性仍按普通属性
  受保护
- **Map / Set 的身份与序列化**：`store.state.map` 是代理，与原 Map 不是同一引用；深保护下成员对象
  也是代理。集合不可序列化，注入 `setData` 前必须派生普通数组 / 对象
- **非普通实例的方法绑定原始接收者**：类实例、类型化数组的成员方法在读取时绑定原对象，方法体内
  写入不经过代理陷阱；属性 / 元素写入仍会标脏
- **原型链敏感键**：`__proto__` / `constructor` / `prototype` 走 DefineOwnProperty，只落成自有数据
  属性，原型不动。读回自己写的 `__proto__` 用 `Object.getOwnPropertyDescriptor`（点访问仍命中原型
  访问器）；值不是对象时该次写入什么都没改（不计数、不标脏、不通知）
- **`$patch` 的等值短路**：空补丁、或补丁值与当前状态逐键 `Object.is` 相等时，不计数、不标脏、
  不调度通知；深合并中途抛错也按已写键记账后重抛。`notify.onlyOnChange` 的判据正是变更计数，因此
  这条短路直接影响「是否通知」

## 2. 订阅与通知

**引用计数**：同一函数注册 N 次就通知 N 次，每个退订句柄只抵消自己那一次。**监听器签名**只有
`(state) => void`，没有 `prevState`。

**额度与驱逐**：`maxSubscribers`（默认 50）对每一次注册都生效，重复注册同样占额度。达限时按
`subscription.onLimit` 处置：`'evict-oldest'`（默认）驱逐一份最早注册并向 `onError` 发一条事件；
`'throw'` 直接抛错。

> ⚠️ 被驱逐的往往不是组件而是插件：插件通常最先安装。`persistencePlugin` 的订阅被牺牲后**写盘
> 静默停止**，唯一线索是 `onError` 的 `'subscribe'` 源。长列表页请改单一页面级订阅，或调大额度。

**回调抛错被逐个隔离**：不影响其余监听器；开发期打印，生产经 `onError` 上报。

**通知载荷按订阅者构成决定**（`notify.clone`）：未配置 / `false` 时全部只读则零拷贝、存在可写订阅者
时本轮拷贝；`true` 强制拷贝。可写注册各拿一份独立深拷贝、只读注册共用一份。**「不写状态的订阅」要
老实标 `readOnly: true`**，这是大状态下最主要的通知开销开关。

**默认同步通知**：每次有效写入立即通知。`notify.async: true` 时同一 tick 内的多次通知合并为一次
微任务（`destroy()` 会取消待发通知）。

**同步 action**：dispatch 期间抑制通知，收尾补发一次。**批量**：`batch(fn)` / `startBatch()` /
`endBatch()` 支持嵌套，仅最外层收尾时通知一次；批保护只覆盖同步段，`await` 之后的变更逐条通知
（开发期有告警）。

**异步 action 的通知次数不固定**：返回 thenable 时，同步段结束补发一次（覆盖第一个 `await` 之前的
写入）；`await` 之后的每次写入各自立即通知；settle 再补发一次。因此可能是 2 次或更多，**不要断言
次数**。`notify.onlyOnChange` 只按变更计数去重同步段/结算的补发，不会阻止 `await` 后写入的即时通知。

**脏键**：action 内对对象 / 数组与 Map / Set 的写入会标记顶层脏键；在同步订阅回调内读
`isStateKeyDirty(key)`（`string | symbol`），通知结束后清空。`$replaceState` 会把被这次替换删掉的
旧键与新键一并标脏。同一对象经多条路径可达（别名）时，写入保守标记全部**相关顶层键**。`getState()` 裸
引用与 Date / RegExp / WeakMap 的内部变异**不受追踪**，请显式替换值。

## 3. Getter

- getter 是纯函数 `(state) => value`，**只接收 state**，不接受额外参数；**没有任何结果缓存**：
  每次 `store.getter(name)` 都重新执行，不纯 getter 的副作用每次读取都真的发生；它拿到的是受保护
  的 state，不能借 getter 写状态
- 找不到 getter 抛 `TallyStoreError`（`GETTER_NOT_FOUND`），getter 执行抛错包成
  `GETTER_EXECUTION_ERROR`；Store 销毁后 `getter()` 抛错

## 4. 运行环境与生产模式

`isProduction()` 决定两套行为：非法直写是抛错还是 `warn` / `silent`、是否打印日志、是否开启严格
校验。判定按顺序取第一个有信号的档，首次判定后缓存：

1. `process.env.NODE_ENV`：构建期注入，最可靠
2. `__DEV__`：构建期标志，或运行时挂到 `globalThis`
3. `wx.getAccountInfoSync().miniProgram.envVersion`：`release` / `trial` → 生产，`develop` → 开发
4. 兜底：**开发模式**（保护优先）

**`trial` 也判生产**：体验版跑的就是待发布的那份产物，「仅限内部可见」不等于「可以崩」。要在体验版
复现严格行为请显式设 `__DEV__ = true`。

**沙箱 `typeof`**：AppService 全局是沙箱代理，读**未声明**标识符连 `typeof` 都抛 `ReferenceError`。
库内统一用 `globalThis.xxx` + `try/catch`；宿主代码探测全局也要按同一口径写，不要写
`typeof someGlobal === 'undefined'`。

硬要求与降级：组件生命周期必须写在 `lifetimes` / `pageLifetimes`（基础库 ≥ 3.15.0），否则退订
不发生；`Proxy` / `WeakMap` 等是硬依赖（无降级）；`wx` 同步存储缺失时持久化降级内存存储——开发期告警，
生产期不刷控制台但发 `onError` 的 `'persistence'` 源事件；`queueMicrotask` 缺失时降级到 Promise 微任务。

## 5. 小程序集成细节

签名是 `(store, options)` **两参数**，返回宿主配置包装器：
`withPageStore(store, { mapState: ['count'] })({ onLoad() {} })`。
写成单对象 `withPageStore({ store, mapState: ['count'] })` **不报错**，但 `store` 被当成未知选项丢掉、
映射为空、零订阅且没有告警：症状是 `this.data` 恒为初始值、映射的 `this.xxxAction` 为 `undefined`。

- 映射只有 `mapState` / `mapGetters` / `mapActions`；数组形式键名不变，对象形式是「本地名 → store
  名 / action 名」
- Page 在 `onLoad` 建立映射与订阅、`onUnload` 退订；Component 在 `lifetimes.attached` 建立、
  `lifetimes.detached` 退订
- 同一实例重复 `onLoad` / `attached` / `onLaunch` 会先清理旧绑定再建立，不会叠加订阅
- `mapState` / `mapGetters` 只在值变化时 `setData`（脏键过滤）；`mapGetters` 每次通知重算（无缓存）。
  App 把映射写进 `globalData`，订阅贯穿运行期（不随 `onHide` 清理）；写进 `data` 的值必须可序列化，
  Map / Set 先派生普通数组 / 对象
- `mapActions` 遮蔽组件同名方法时 action 优先、开发期告警，`detached` 后恢复用户原方法
- 集成**不注入 Store 实例**，也**没有** `onShow` / `pageLifetimes.show` 重注入
- **Skyline**：`schedule` 默认 `'auto'`——实例 `renderer === 'skyline'` 时同一 tick 的多次映射写入合并为
  一次 `setData`，其它宿主逐次同步；`'sync'` 强制逐次、`'microtask'` 强制合并。初始映射始终同步交付，
  `onLoad` / `attached` 内可立即读到；卸载、重入、`detached` 会丢弃未交付的合并写入。配置与限制见
  [COMPATIBILITY](../../../docs/COMPATIBILITY.md)，示例见 [RECIPES](../../../docs/RECIPES.md)。

## 6. 插件与持久化

**插件契约**：`{ name, install(store) => (() => void) | void }`；`install` 的返回值就是卸载函数。
`store.use(plugin)` 返回等效的卸载函数；同实例重复 `use()` 不重复安装，开发期告警并返回一个
同样有效的卸载句柄；安装抛错会回滚入列。

**钩子**：`store.hooks.on(name, handler)` 返回退订函数；处理器抛错不影响其余处理器，随后转投 `onError`。

**持久化后端契约**：`storage` 必须**同步且三方法齐备**（`{ getItem, setItem, removeItem }`）；显式
传入的后端缺方法会在安装期抛错，不会静默改用其他后端。不传时默认用 `WxStorageBackend`；`wx` 同步
存储不可用时降级内存存储——开发期告警，生产期不刷控制台但发 `onError` 的 `'persistence'` 源事件。

- 默认键是 `tallystore_${store.name}`，可传字符串或 `(storeName) => string`；两个 store 同名会互相
  覆盖，需要隔离就显式传 `key`
- 恢复值必须是纯对象；坏 JSON、`validate` 失败、后端抛错都会跳过恢复并
  `emit('onError', …, 'persistence')`
- `debounce` 默认 `0`（变更即写），大于 0 按毫秒防抖；卸载时清定时器，非 `clearOnUninstall` 时补写
  待写与最终状态，`clearOnUninstall` 时删除存储键
- `loggerPlugin` 生产环境整体静默；`sink` 默认 `console`，形如 `{ log, error }`

## 相关文档

- [`../SKILL.md`](../SKILL.md)
- [`../../../docs/GUIDE.md`](../../../docs/GUIDE.md)
- [`../../../docs/API.md`](../../../docs/API.md)
