# 插件语义与易误用点

> [`../SKILL.md`](../SKILL.md) 的长尾参考。插件入口是 `@unitseek/tallystore/plugins`
> （另有 `.../persistence`、`.../logger` 两个子入口；指标插件从 `.../plugins` 导入）。用法见 `docs/GUIDE.md`，
> 选项与默认值见 `docs/API.md`。

## 1. 持久化

```ts
import { persistencePlugin } from '@unitseek/tallystore/plugins'
store.use(persistencePlugin({ key: 'cart', filter: (state) => ({ cart: state.cart }), debounce: 200 }))
```

**选项与默认值**：

- `key`：默认 `tallystore_${store.name}`，可传字符串或 `(storeName) => string`。两个 store 同名会
  互相覆盖，需要隔离就显式传 `key`
- `storage`：默认 `WxStorageBackend`；`wx` 同步存储不可用时降级内存存储（开发期告警；生产期
  不刷控制台，但发 `onError` 的 `'persistence'` 源事件）
- 显式传 `storage` 时必须同时提供 `getItem` / `setItem` / `removeItem` 三个同步方法；缺方法在
  安装期抛错，不会静默改用其他后端
- `filter` **必须显式声明**：`(state) => Partial<S>` 白名单，或 `false` 关闭持久化；缺省或非法值
  开发期抛 `INVALID_CONFIG`，生产期经 `onError(..., 'persistence')` 上报后禁用（零存储调用）
- `validate` 可选；`restore` 默认 `true`；`debounce` 默认 `0`（毫秒，大于 0 防抖）；
  `clearOnUninstall` 默认 `false`
- `schemaVersion` + `migrations`：落盘为版本信封并按链迁移；恢复失败/版本过高回退默认值
- 落盘前按持久化语义做可序列化校验；命中敏感键审计时拒绝整次落盘

**恢复**（安装时，`restore` 不为 `false`）：

- 恢复值必须是**纯对象**；坏 JSON、`validate` 返回 `false`、后端抛错都会跳过恢复并
  `emit('onError', …, 'persistence')`

**落盘与卸载**：

- 每次状态变化写入整份（或 `filter` 后的）状态；`debounce` 为 `0` 时变更即写
- 卸载时清定时器；非 `clearOnUninstall` 时补写待写与最终状态，`clearOnUninstall` 时删除存储键
- `WxStorageBackend` 封装 `wx.getStorageSync` / `setStorageSync` / `removeStorageSync`；
  后端必须同步

## 2. 日志

```ts
import { loggerPlugin } from '@unitseek/tallystore/plugins'
store.use(loggerPlugin({ sink: console }))
```

- `sink` 默认 `console`，形如 `{ log, error }`
- 生产环境整体静默；三个内置插件在生产模式都不输出 console；logger 会记录 reset 审计与宿主写入归因

## 3. 指标

```ts
import { metricsPlugin } from '@unitseek/tallystore/plugins'
store.use(metricsPlugin({ sink: { report: (event) => monitor.send(event) }, sampleRate: 0.1 }))
```

- 事件白名单字段：通知/宿主写入/action/错误/订阅计数，最近/最大单次载荷、`lastHost`、
  `lastActionName`；不含状态值与个人信息
- `sink.report` 可替换（库不内置厂商 SDK）；事件上报前做运行时 schema 校验，非法事件不调用 sink
- `sampleRate` 0-1（默认 0 只计数不上报）；卸载时做一次关账全量上报
- `collector.snapshot()` 供测试/诊断读计数

## 相关文档

- [`../SKILL.md`](../SKILL.md)
- [`../../../docs/GUIDE.md`](../../../docs/GUIDE.md)
- [`../../../docs/API.md`](../../../docs/API.md)
- [`../../../docs/PERFORMANCE.md`](../../../docs/PERFORMANCE.md)
