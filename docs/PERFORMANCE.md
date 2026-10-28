# 性能与开销

本文只讲**使用侧的成本模型与开关**，不写实测数字。需要数据时用仓库的基准套件测当前构建产物：
见 [bench/README.md](../bench/README.md) 与 [如何获得数据](#如何获得数据)。

## 本文内容

- [成本从哪里来](#成本从哪里来)
- [开关与选择](#开关与选择)
- [如何获得数据](#如何获得数据)
- [基准回归门禁与归档](#基准回归门禁与归档)
- [体积预算与门禁](#体积预算与门禁)
- [检查清单](#检查清单)
- [相关文档](#相关文档)

## 成本从哪里来

| 成本来源       | 什么时候发生                                 | 主要开关                                                      |
| -------------- | -------------------------------------------- | ------------------------------------------------------------- |
| 通知载荷拷贝   | 存在可写订阅者时，每轮通知深拷贝状态树       | `subscribe(..., { readOnly: true })`、`notify.clone`          |
| 通知次数       | 默认每次有效写入通知一次                     | `$patch` / `batch()` / `notify.async` / `notify.onlyOnChange` |
| 映射更新       | 映射字段的值变化时调用 `setData`             | 只映射需要的字段；脏键过滤；`schedule`（Skyline 合并）        |
| `setData` 载荷 | 每次映射更新传给宿主的对象大小               | 拆分字段、派生普通数据、避免整棵大对象                        |
| getter 重算    | 每次 `getter()` 调用、每次通知重算映射       | getter 保持廉价；业务侧按状态引用缓存                         |
| 持久化落盘     | 状态变化后序列化 + 同步写存储                | `debounce`、`filter`、`clearOnUninstall`                      |
| `$snapshot`    | 调用时深克隆 + 冻结                          | 按需使用，不要放进渲染热路径                                  |
| 订阅数量       | 注册越多，每轮通知的调用与拷贝越多           | 控制在 `maxSubscribers` 内；长列表用单一页面级订阅            |
| Map / Set      | 集合成员变化后需要派生普通数据才能 `setData` | 在 action 内派生一次并写入普通字段                            |

## 开关与选择

### 只读订阅

只观察、不修改载荷的订阅一律标 `readOnly: true`：全部订阅者只读时本轮通知零拷贝；出现可写订阅者
时才会拷贝（只读注册共用一份、可写注册各一份）。这是大状态下最主要的开销开关。

### 合并写入与通知

- 多个字段一起改时用一次 `$patch`，或包在 `batch()` 里；`batch` 只在最外层收尾通知一次。
- `batch` **只覆盖同步段**：`await` 之后的写入逐条通知，异步流程不要指望 `batch` 合并。
- 同一 tick 的多次通知可用 `notify.async: true` 合并为一次微任务；`destroy()` 会取消待发通知。
- 异步 action 的通知次数不固定（同步段补发一次、`await` 后逐次、settle 再补发一次），不要按次数
  估算渲染开销；需要「有变化才通知」时用 `notify.onlyOnChange`，它只去重同步段/结算的补发。

### 集成映射

- **只映射页面真正要用的字段**：`mapState` 越少，`setData` 的字段越少；对象形式可以重命名。
- 集成只对**脏键**对应的映射字段调用 `setData`；未映射键的变化不会触发页面更新。
- `mapGetters` 每次通知都会重算 getter（getter 无缓存），getter 里不要做重活或大对象拷贝。
- 长列表不要给每个列表项组件各建一条订阅：用一个页面级订阅 + 手动 `setData` 分发。

### Skyline 下的 setData 调度

集成默认 `schedule: 'auto'`：宿主实例的 `renderer === 'skyline'` 时，同一 tick 内的多次映射写入
合并为一次 `setData`；WebView 仍逐次同步。合并只影响写入时机，不改变映射字段、脏键过滤与值。

- **初始映射始终同步交付**：`onLoad` / `attached` 里可立即读到映射后的 `data`。
- **何时显式 `schedule: 'sync'`**：每次写入后必须立即反映到视图时使用，例如紧接着读取宿主侧渲染
  结果、与 `setData` 回调或测量逻辑同步、在动画帧内逐步更新。
- **何时显式 `schedule: 'microtask'`**：在 WebView 等非 Skyline 宿主上也想要合并时使用；App 集成
  写 `globalData` 默认同步，显式传 `'microtask'` 才会合并。
- 卸载 / 重入 / `detached` 会丢弃尚未交付的合并写入；写入失败开发期打印，生产期经 `onError` 上报
  （`source` 为对应的 `withPageStore` / `withComponentStore` / `withAppStore`）。失败批次会保留，
  并在后续 3 次微任务内有界自动重试（成功即停、不刷屏）；仍失败则保留到下一次映射写入时合并重试，
  避免一次瞬时 `setData` 失败让视图永久落后。
- 合并减少的是 `setData` 次数，不是单次载荷大小：仍建议只读订阅（避免通知载荷拷贝）并尽量少映射
  字段。配置与渲染器限制见 [COMPATIBILITY](./COMPATIBILITY.md)，用法见 [GUIDE](./GUIDE.md)。

### 大对象与 setData

`setData` 的成本随载荷增长。映射到 `data` 的值尽量是**浅、小、可序列化**的普通对象/数组：

- 只把视图需要的切片放进 `state` 的映射字段，不要把整棵业务状态挂到 `data`。
- Map / Set **不可序列化**，且 `store.state.map` 是保护代理、不是内部原 Map；在 action 里派生普通
  数组/对象后写入普通字段，再映射该字段（见 [RECIPES](./RECIPES.md)）。
- 类实例等不可克隆值在 `$snapshot` / 通知载荷里可能保留引用，不要把它们当作可序列化数据传给宿主。

### getter

getter 没有结果缓存，每次读取都会重新执行。让它保持廉价；需要「依赖未变则复用」时在业务侧保存
上一次状态引用并自行缓存结果。

### 持久化

- `debounce` 默认 `0`：每次状态变化都会序列化并同步写存储。高频写入场景显式设 100~500ms。
- 用 `filter` 只落盘需要的字段，减少序列化体积；用 `validate` 在恢复前挡住坏数据。
- 持久化按 JSON 往返：`Date` / `Map` / `Set` 恢复后类型会变，需要类型时先用 `filter` 派生普通数据。
- 持久化的订阅是只读的，不会触发通知载荷的可写拷贝；恢复发生在插件安装时，越早安装越早恢复。
- 卸载时补写待写与最终状态；`clearOnUninstall: true` 时改为删除存储键。

### $snapshot

`$snapshot()` 会深克隆并递归冻结纯对象与原生数组；类实例等不可克隆值保留原引用。它适合做撤销、
草稿或调试检查点，不适合放在每次渲染/每次通知的热路径里。

### 订阅上限与驱逐

`maxSubscribers` 默认 `50`，每次注册都占用额度。触顶时 `evict-oldest` 驱逐最早注册的一份并向
`onError` 发 `'subscribe'` 源事件；插件通常最先安装，被驱逐后可能静默停止工作。长列表页请改为
单一页面级订阅，或调大额度并把 `onError` 接进监控。

## 如何获得数据

仓库不在文档里写实测体积/性能数字（数字会漂移）。需要判断时：

```bash
pnpm run build # 基准测的是 dist-weapp 构建产物，改完 src 必须先构建
pnpm run bench # 全部 suite
pnpm run bench:quick # 快速模式
pnpm run bench:save # 保存本机基线
pnpm run bench:compare # 与基线比较（默认容差 25%）
```

- 基准只测 **`dist-weapp` 发布产物**，是仓库内部工具，不随 npm 包发布、不进 CI。
- 结果是**同机、同构建下的相对比较**；Node 的 V8 与小程序运行时不同，绝对数字不能跨宿主搬运。
- 方法论、suite 覆盖与新增 case 方式见 [bench/README.md](../bench/README.md)。
- 包体积看微信「构建 npm」整目录拷贝的 `dist-weapp/`，当前值用 `pnpm run size`；体积模型见
  [README](../README.md)。

## 基准回归门禁与归档

发布前的性能回退检查在**固定硬件**上按 [bench/RUNBOOK.md](../bench/RUNBOOK.md) 执行（不是 CI）：

1. `pnpm run build` 生成 `dist-weapp`；
2. `node scripts/bench-report.mjs --compare bench/baseline.json --tolerance=25` → 写出可归档的
   `bench/report.json`（含环境 / commit / 命令 / 时间、cases、regressions），并保留 bench 退出码；
3. 出现回退先复测（工具内部已对回退 case 自动复测最多 2 轮），**复测仍超差才阻断发布**；
4. `bench/report.json` 与体积（`pnpm run size --json`）、覆盖率一起归档为 release artifact。

容差默认 **25%**；`added` / `missing` 只表示基线未覆盖（新增 / 重命名 case），需要参考机重锚
`bench/baseline.json`，不是回退。**不要手改基线数值**，也不要把共享 CI / 开发机抖动当成发布结论：
Node 基准数字不是微信真机数字，只用于同机、同构建下的相对比较。suite 覆盖（含 Skyline 同 tick
合并写入 case）、方法论与新增 case 规则见 [bench/README.md](../bench/README.md)。

## 体积预算与门禁

- **体积模型**：微信「构建 npm」把 `dist-weapp/` **整目录按 raw 字节**拷进包里——入口分层
  不减少上传体积，不引入的入口只是不执行，字节照旧；**只有删代码才减包**。
- **主口径 raw 硬预算 120KB**：当前实测约 114.6KB，余量约 8.1KB。预算与基线以
  `scripts/size-baseline.json` 为准；每版本增长 ≤ +2KB 或 ≤ +3%，超出需架构评审并在发布说明记录。
  发布后回补目标 92KB（优先错误消息表压缩与后续能力体积控制）。CI `size:gate` 阻断。
- **增长容差**：每版本相对基线（`scripts/size-baseline.json`）≤ +2KB 或 ≤ +3%，两项
  **同时**超出才阻断；超出容差需架构评审并在发布说明记录，预期增长请先更新基线。
- **辅口径 gzip** 与**核心入口闭包**（index.js 的 require 可达图，当前 raw 93.3KB /
  gzip 38.5KB）只报告不阻断：gzip 衡量传输/解析成本，raw 才是包预算。

## 检查清单

- 观察型订阅是否都标了 `readOnly`？
- 多字段更新是否合并成 `$patch` / `batch()`，而不是连续多次 `setState`？
- 页面是否只映射了真正要用的字段？getter 是否足够廉价？
- Skyline 页面是否保持默认 `schedule: 'auto'`；确有逐次同步需求时才传 `schedule: 'sync'`？
- 是否有大对象、Map/Set 或类实例被直接塞进 `data`？
- 持久化是否设置了 `debounce` / `filter`？是否在启动时尽早安装？
- 长列表是否退化成「每项一条订阅」？

## 相关文档

- [GUIDE](./GUIDE.md)：概念与用法
- [API](./API.md)：入口、签名与默认值
- [COMPATIBILITY](./COMPATIBILITY.md)：支持矩阵、Skyline 配置与限制
- [RECIPES](./RECIPES.md)：可复制配方
- [bench/README.md](../bench/README.md)：基准套件说明
- [bench/RUNBOOK.md](../bench/RUNBOOK.md)：固定硬件 / 受控发布任务的执行与归档手册
- [文档索引](./README.md)：全部文档
