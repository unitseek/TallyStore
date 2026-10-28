---
name: tallystore
description: 原生微信小程序状态管理库 TallyStore（@unitseek/tallystore，v0.1.0）的使用指南。当需要编写、修改或审查使用 TallyStore 的代码——创建 Store、定义 actions/getters、接入小程序 Page/Component/App、使用持久化、日志或指标插件，处理异步竞态或状态重置——时使用。触发条件：代码里已出现 createStore/withPageStore/persistencePlugin 等调用，或用户点名要用 TallyStore。
---

# TallyStore 使用指南

## Overview

TallyStore 是原生微信小程序的状态管理库：Store + 三端集成 + 持久化/日志/指标插件。两条硬性事实决定
绝大多数误用：**仅原生微信小程序**（发布产物只有 `dist-weapp/` 的 CJS 与 `types/` 声明）；
**微信「构建 npm」整目录拷贝 `dist-weapp/`**，不 tree-shaking，所以入口分层只降低运行时
`require` 量，只有删代码才能减少上传体积。本文件是检索层：规则给结论与坑，边界语义指向
`references/`。

## 本文内容

- [Overview](#overview)
- [使用规则](#使用规则)
- [快速上手](#快速上手)
- [常见任务](#常见任务)
- [常见错误排查](#常见错误排查)
- [Resources](#resources)

## 使用规则

1. **写代码前先查签名**：入口、签名与默认值看 `docs/API.md`；精确签名（含重载）在包内
   `types/**/*.d.ts` 上悬停。语义陷阱见本文件与两份 references。
2. **导入路径只有四个**，不要深链叶模块：
   - `@unitseek/tallystore`：`createStore` / `Store` / 三个 `with*` 集成函数 / 钩子 / 错误类型
   - `@unitseek/tallystore/plugins`：`persistencePlugin` / `WxStorageBackend` / `loggerPlugin` / `metricsPlugin`
   - `.../plugins/persistence`：只带持久化；`.../plugins/logger`：只带日志

   `exports` 只声明类型；微信侧按 `package.json` 的 `miniprogram` 字段解析运行时。

   ⚠️ **别用 Node 验证 `dist-weapp/`**：目录内没有 `package.json`，Node 会按根包
   `"type": "module"` 把它的 `.js` 判成 ESM，加载报 `require is not defined`。那是 Node 的
   解析规则，不是产物缺陷；它的 CJS 语义只对微信的加载器成立。

3. **环境**：宿主只需微信开发者工具；Node ≥ 22 与 TypeScript ≥ 5.4 只影响开发、构建与类型检查
   （公开签名用了 `NoInfer`），运行时零依赖。组件生命周期要求基础库 ≥ 3.15.0。
4. **状态只能经写入口修改**：`store.state.xxx = value` 在开发期直接抛错，且绕过写入口的修改不
   触发通知。合法写法：action 内 `this.state.xxx` / `this.setState` / `this.$patch` /
   `this.$replaceState`，或 store 侧 `setState` / `$patch` / `$replaceState` / `$restore`。
   `stateProtection` **默认开启**；生产期非法直写按 `productionHandler`（默认 `warn`）处理。
   冻结 / 不可写属性是明确豁免：拿到裸引用，不受保护、不标脏、不通知。
   **Map / Set 的 `set` / `add` / `delete` / `clear` 与属性写入同口径**；深保护下读到的成员也是
   代理。`store.state.map` 是代理而非原 Map，且集合不可序列化——注入 `setData` 前先派生普通数据。
   同一对象被多个顶层键引用（别名）时，写它保守标脏全部相关顶层键 →
   [`§1`](./references/core-semantics.md#1-写入路径与状态保护)
5. **异步 dispatch 的通知次数不固定**：同步段结束补发一次，`await` 之后的每次写入各自立即通知，
   settle 再补发一次——可能 2 次或更多，**不要按次数断言**。`notify.onlyOnChange` 只去重同步段与结算的
   补发，不会挡住 `await` 后的即时通知；要合并同一 tick 的多次通知开 `notify.async` →
   [`§2`](./references/core-semantics.md#2-订阅与通知)
6. **getter 没有结果缓存，且只接受一个参数**：每次 `store.getter(name)` 都按当前状态重算，
   额外参数被忽略。要「依赖未变则复用」请在业务侧比较状态后自行缓存 →
   [`§3`](./references/core-semantics.md#3-getter)
7. **订阅是引用计数，`maxSubscribers` 是硬上界**：同一函数注册 N 次就通知 N 次；默认上限 50。
   ⚠️ 触顶时 `evict-oldest` 驱逐最早注册的那一份，而插件通常最先安装——`persistencePlugin` 被
   驱逐后**写盘静默停止且没有报错**。长列表改单一页面级订阅，并把 `onError` 接进监控 →
   [`§2`](./references/core-semantics.md#2-订阅与通知)
8. **体积**：入口分层不改上传字节；不引入的入口只是不执行。主包额度紧张时只能把
   `miniprogram_npm` 输出位置挪进分包（`packNpmManually` + `miniprogramNpmDistDir`），挪的是
   额度不是字节。见仓库 `README.md` 的「体积模型」。
9. **生产判定四档**：`process.env.NODE_ENV` → `__DEV__` → `wx.getAccountInfoSync().miniProgram.envVersion`
   → 兜底开发。`release` 与 `trial` 都判生产。小程序沙箱里读未声明标识符连 `typeof` 都抛
   `ReferenceError`，探测全局一律 `globalThis.xxx` + `try/catch` →
   [`§4`](./references/core-semantics.md#4-运行环境与生产模式)
10. **三端集成是 `(store, options)` 两参数**：`withPageStore(store, { mapState: [...] })({...})`。
    写成单对象 `withPageStore({ store, ... })` **不报错**，但映射为空、零订阅。只有
    `mapState` / `mapGetters` / `mapActions` 三个映射：不会把 Store 挂到 `this`，也不会在
    `onShow` 时自动重放状态。重复 `onLoad` / `attached` / `onLaunch` 会先清旧绑定再建；组件生命周期
    必须写在 `lifetimes` / `pageLifetimes` 内，写在顶层的 `attached` / `detached` 不会执行 →
    [`§5`](./references/core-semantics.md#5-小程序集成细节)

    **Skyline**：集成选项 `schedule` 默认 `'auto'`——实例 `renderer === 'skyline'` 时把同一 tick 的多次
    映射写入合并为一次 `setData`，其它宿主逐次同步；`'sync'` 强制逐次、`'microtask'` 强制合并。初始
    映射始终同步交付；卸载 / 重入 / `detached` 丢弃未交付的写入。配置与限制见
    [COMPATIBILITY](../../docs/COMPATIBILITY.md)，示例见 [RECIPES](../../docs/RECIPES.md)。

11. **持久化后端必须同步且三方法齐备**：`{ getItem, setItem, removeItem }`；显式传入的后端缺方法
    会在安装期抛错，永不静默改用其他后端。不传时默认用 `WxStorageBackend`；`wx` 同步存储不可用时
    降级内存存储——开发期告警，生产期不刷控制台但发 `onError` 的 `'persistence'` 源事件 →
    [`§6`](./references/core-semantics.md#6-插件与持久化)

## 快速上手

```ts
import { createStore, withPageStore } from '@unitseek/tallystore'

export const counter = createStore({
  name: 'counter',
  state: () => ({ count: 0 }), // 工厂写法：多实例不共享引用
  actions: {
    add(n: number) {
      this.setState('count', this.getState().count + n)
    },
  },
  getters: { doubled: (state) => state.count * 2 },
})

Page(
  withPageStore(counter, { mapState: ['count'], mapGetters: ['doubled'], mapActions: ['add'] })({
    onLoad() {
      this.add(1)
      console.log(this.data.count)
    },
  }),
)
```

- 配置对象里的方法 `this` 类型已自动注入，**不要手写 `this` 标注**，否则会覆盖集成层类型
- Page 的 `onUnload`、Component 的 `lifetimes.detached` 先执行用户钩子，再在 `finally` 清理绑定
- App 集成把映射写进 `globalData`，订阅贯穿运行期（不随 `onHide` 清理）

## 常见任务

### 订阅与批量

观察者标 `readOnly: true` 省掉通知前的整树深拷贝；多字段一起改用 `batch()` 只通知一次（仅覆盖同步段）。

```ts
const off = store.subscribe((state) => render(state), { readOnly: true })
store.batch(() => {
  store.setState('a', 1)
  store.setState('b', 2)
})
off()
```

### 插件

`store.use(plugin)` 返回卸载函数；`persistence` 越早装恢复越早。

```ts
import { loggerPlugin, metricsPlugin, persistencePlugin, WxStorageBackend } from '@unitseek/tallystore/plugins'

store.use(persistencePlugin({ key: 'cart', storage: new WxStorageBackend(), filter: (state) => ({ cart: state.cart }), debounce: 200 }))
store.use(loggerPlugin())
store.use(metricsPlugin({ sampleRate: 0.1, sink: { report: (event) => monitor.send(event) } }))
```

- `filter` **必须显式声明**：白名单函数，或 `false` 关闭持久化；缺省/非法值开发期抛 `INVALID_CONFIG`，生产期经 `onError(..., 'persistence')` 上报后禁用
- `debounce` 默认 `0`（变更即写）；高频写入建议显式配 100~500
- 恢复值须为纯对象；`validate` 拒绝、JSON 解析失败、后端抛错都会跳过恢复并
  `emit('onError', …, 'persistence')`
- `loggerPlugin` 生产环境整体静默；`sink` 默认 `console`，需实现 `{ log, error }`；会记录 reset 审计与宿主写入归因
- `metricsPlugin` 采集通知/宿主写入/action/错误/订阅指标；`sink.report(event)` 可接监控，`sampleRate` 0-1 控制上报，事件经白名单校验

### 重置与竞态

```ts
import { createRaceGuard } from '@unitseek/tallystore'

store.$reset() // 重置为初始状态；beforeReset/afterReset 审计钩子，订阅保持有效
// defineStores 聚合表：stores.resetAll() 以 reason='resetAll' 重置全部已实例化模块

const guard = createRaceGuard()
const seq = guard.begin()
const result = await fetchList(keyword)
if (!guard.isCurrent(seq)) return // 旧结果晚到：丢弃，不写 Store
guard.cancel() // 取消全部在途序号（结果级取消，不等于网络级中断）
```

### 错误

dispatch / getter 的「找不到 / 执行失败」抛 `TallyStoreError`（按 `error.code` 分类）；
订阅者、插件与通知链上的失败走 `onError` 钩子：
`store.hooks.on('onError', (error, source) => report(error, source))`，用 `isTallyStoreError(error)`
判断是否本库错误。

## 常见错误排查

- **`Cannot find module` / 子路径找不到**：子路径只有四个（见规则 2），深链不可用
- **`require is not defined`**：用 Node 加载了 `dist-weapp/`，或配置按 ESM 解析了 CJS 产物
- **页面 `this.data` 恒为初始值、映射的 `this.xxx` 是 `undefined`**：集成写成了单对象
  `{ store, ... }`，改成 `(store, options)` 两参数（规则 10）
- **直接改 state 不生效或被警告**：必须经写入口；开发期抛错、生产期按 `productionHandler` 处理
- **异步 dispatch 的通知次数变多**：默认就是多次（同步段补发 + `await` 后逐次 + settle 补发），
  不要按次数断言；`notify.async` 只合并同一 tick，`onlyOnChange` 只去重补发（规则 5）
- **`store.state.map` 直接 `setData` 报错或被拒**：Map/Set 不可序列化，且读到的是代理；先转成普通
  对象 / 数组再 `setData`（规则 4）
- **订阅触发次数不符 / 退订后仍触发**：同一函数按引用计数通知 N 次，每个句柄只减一份
- **状态改得动但不再落盘且无报错**：订阅额度触顶，最早安装的持久化插件被驱逐；查 `onError`
  的 `'subscribe'` 源
- **持久化恢复失败**：恢复值须为纯对象；`validate` 不通过会跳过；自定义 `storage` 必须同步
- **组件生命周期不执行**：必须写在 `lifetimes` / `pageLifetimes` 内（基础库 ≥ 3.15.0）
- **生产环境没有日志 / 非法直写不抛错**：预期：生产模式整体静默，写保护由 `productionHandler`
  （默认 `warn`）决定

## Resources

- **本 skill 自带**：[`core-semantics.md`](./references/core-semantics.md)（写入与保护、订阅、getter、
  运行环境、集成、插件）与 [`plugins-semantics.md`](./references/plugins-semantics.md)（持久化、日志与指标边界）。
- **仓库内**：`docs/API.md`（入口与默认值）、`docs/GUIDE.md`（用法）。
- **只装了 npm 包时**：`types/**/*.d.ts`、包根 `README.md`、`package.json` 的 `exports` / `miniprogram` 字段。
