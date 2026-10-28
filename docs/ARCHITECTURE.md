# 架构设计

分层、依赖方向、数据流与质量策略。行为语义见 [GUIDE](./GUIDE.md)，逐 API 的签名与默认值见
[API](./API.md)，本地开发、门禁与发布见 [CONTRIBUTING](../CONTRIBUTING.md)。

## 本文内容

- [设计目标](#设计目标)
- [分层与依赖方向](#分层与依赖方向)
- [目录与职责](#目录与职责)
- [写入到通知的数据流](#写入到通知的数据流)
- [关键取舍](#关键取舍)
- [产物体积](#产物体积)
- [质量策略](#质量策略)
- [演进约束](#演进约束)
- [相关文档](#相关文档)

## 设计目标

1. **小**：主入口只放「创建 store、改状态、订阅、接到小程序宿主」所需的东西
2. **可预测**：状态只能经写入口变更，所有变更过同一条通知链，失败有确定出口
3. **零依赖**：不引第三方运行时，也不用 `tslib`

非目标：Node / 浏览器 / Taro / uni-app 宿主，跨标签页同步，时间旅行调试，React / Vue 适配层。

## 分层与依赖方向

```text
宿主：小程序 Page / Component / App
        │  宿主配置包装器
integrations   withPageStore / withComponentStore / withAppStore
        │
      core     Store / 钩子 / 错误 / 内部工具
        │
      types    纯类型契约（无运行时代码）

可选插件：plugins.js（聚合入口）→ plugins/*（持久化 / 存储后端 / 日志 / 指标实现）→ core
```

发布面分两种形态：

- **聚合入口** `src/index.ts` / `src/plugins.ts` 只做转发与策展：前者再导出 `core/index.ts`（后者装配
  `integrations/`），后者聚合四个公开符号（三个插件 + `WxStorageBackend`）
- **子路径入口** `plugins/persistence`、`plugins/logger` 直接指向实现模块，避免为同一份导出多留一层
  转发文件（微信按 dist 文件路径解析子路径，多一层就是多一个文件）

依赖方向严格向下：`types ← core ← {integrations, plugins}`。内部模块不反向 import，唯一例外是
聚合入口的装配性导出。`types` 只放类型，转译后是空模块，不进入 `dist-weapp`。

## 目录与职责

```text
src/
  index.ts        主入口装配：再导出 core/index
  core/
    index.ts      核心入口装配：Store、工厂、错误、钩子、集成再导出
    store/        Store 门面与协作者
    hooks/        实例级钩子系统
    errors/       TallyStoreError 与 ErrorCode
    utils/        深拷贝、合并、判定等库内私有工具
  integrations/   小程序宿主绑定与生命周期清理
  plugins.ts      内置插件聚合入口（只转发）
  plugins/        持久化、微信同步存储后端、日志与指标实现（同时是子路径入口）
  types/          纯类型契约：store、插件、集成
```

### Store 门面的协作者

`core/store/Store.ts` 是门面，语义拆在同目录：

- `ActionManager.ts`：action 注册、`this` 上下文注入、`dispatch` 路由、getter 执行
- `StoreNotifier.ts`：订阅登记与上限、脏键记账、通知调度与载荷策略
- `BatchManager.ts`：批量写入的嵌套计数与收尾通知
- `StateProxy.ts`：`stateProtection` 的只读代理（对象、数组与 Map/Set 变异拦截）
- `dirtyTracking.ts`：action 写入的顶层键归属追踪
- `proxyCore.ts`：两类代理共用的纯函数（内建对象判定、不变量、子值包装、方法绑定）
- `pluginSupport.ts`：插件安装、去重与卸载
- `factory.ts`：`createStore` 与配置校验
- `types.ts`：`stateProtection` 的内部配置形状
- `utils.ts`：生产判定等门面级工具

## 写入到通知的数据流

1. **写入口**：`setState` / `$patch` / `$replaceState` / `$restore`，或 action 内的
   `this.state`（脏跟踪代理）。直接写 `store.state` 由状态保护代理拦截。
2. **钩子**：写入口触发 `before*` 与 `after*` 钩子（13 个钩子，含 `beforeReset` / `afterReset`；实参见 [API](./API.md#钩子)）。
3. **写入与归属**：属性写入落进当前状态；action 内的对象 / 数组 / Map / Set 写入由脏跟踪代理
   记录其顶层键归属。
4. **记账**：变更计数递增，脏键累积——`$patch` 把本次涉及的顶层键全部标脏，同一对象经别名
   可达时保守标脏全部相关顶层键，`$replaceState` 把新旧键都标脏。
5. **调度**：同步写入直接通知；`batch` 只在最外层收尾通知；`dispatch` 在 action 期间抑制、
   收尾补发；`notify.async` 合并同一 tick 的通知为一次微任务。
6. **载荷**：按订阅者构成决定拷贝策略——全只读时零拷贝（只读保护代理），存在可写订阅者时
   这次通知的拷贝；只读注册共用一份、可写注册各一份。规则见 [API](./API.md#通知与脏键)。
7. **投递与出口**：监听器逐个投递并隔离异常，开发期 `console.error`、生产期经 `onError`
   上报；通知结束后清空脏键。

## 关键取舍

**为什么写状态只有四个入口？** `setState` / `$patch` / `$replaceState` / `$restore` 覆盖
「改一个键」「改几个键」「整体换一份」「从快照恢复」四种意图；更多入口只会让钩子语义更难
收敛。所有插件、日志与集成都挂在这条链上。

**为什么订阅分只读与可写？** 可写订阅者可能改状态，Store 必须在通知前给出独立载荷（整树
深拷贝）。只读订阅只观察，没必要付这份成本；因此 `readOnly` 是显式选项而不是推断。

**为什么 getter 不做结果缓存？** getter 每次读取都按当前状态重算，语义简单且不会产生失效
竞态；需要「依赖未变就复用」时，在业务侧比较状态引用自行缓存。

**为什么快照不是持久化、也不做自动快照？** 快照只服务撤销、草稿与检查点：产物是内存对象，
不跨页面重载、不跨进程/会话；跨进程/跨会话恢复必须走 `persistencePlugin` 的 `schemaVersion`

- `migrations`。快照由调用方显式触发，库**不会自动全量快照**（每次变更不克隆整棵树），
  也**不得把快照当 Diff 基线**——增量更新走 的写时路径追踪，不建状态镜像；快照不承诺跨版本兼容。

**为什么 `$patch` 保守标脏？** 合并可能就地改写嵌套对象，也可能被其他顶层键引用；统一把
本次涉及的顶层键全部标脏是保守超集——多几次 `setData` 换取不会漏更新，比在合并后反推
别名图更简单可靠。

**为什么脏键归因用「路径携带顶层键」而不是对象归属图？** action 内的写入需要回答「这个对象
属于哪几个顶层键」。对象图方案要维护索引、增量边与版本标记，复杂度高，且任一次整树替换都要
重建；路径方案在包装子对象时记下第一个到达它的顶层键，写入时 O(1) 直接上报。同一对象经多条
路径可达时保守上报全部顶层键——只在别名场景下多几次 `setData`，换取更简单的不变量。

**为什么错误收敛成一个类？** 调用方需要的是「是不是本库错误」与「哪个环节失败」，不是一棵
异常继承树。`TallyStoreError` 用 `code` 区分 action / getter 的「找不到」与「执行失败」，
其余误用直接 `throw new Error` / `TypeError`。

**为什么插件实现放在 `plugins/`、入口放在 `plugins/`？** 发布面按入口策展，实现按能力归位：
入口只决定「哪些符号从哪个子路径出去」，实现可被多个入口复用；core 只保留钩子契约，不承担
持久化与日志的体积。

**为什么主入口含小程序集成？** 本库只服务原生小程序宿主，集成就是这门库的「落地方式」；把它
拆成可选入口只会让最常见的用法多一次导入，并不减少上传字节。

**为什么 `dist-weapp` 是逐模块 CJS 而不是 bundle？** 多入口 bundle 会把 core 内联进每个入口，
并让不同入口各持一份模块实例（同一运行里出现两套状态）。逐模块保留相对 `require` 文件更多，
但实例唯一。

## 产物体积

- `dist-weapp/`：微信「构建 npm」按 `miniprogram` 字段**整目录**拷贝，不做 tree-shaking
- 主入口闭包：运行时从主入口 `require` 到的模块图；只影响加载量，不影响包体积
- `types/`：发布面里的类型声明，不进入小程序运行

由此得到唯一结论：**只有删代码才能减上传体积**；入口分层只降低运行时 `require` 量。当前
体积用 `pnpm run size` 查看，文档不写实测字节数。

## 质量策略

- **单元测试**：`tests/unit/`（用例数以 `pnpm test` 输出为准，不在文档固化易漂移数字）；覆盖率阈值 98%（核心模块实测 100%：lines / statements / functions /
  branches），CI 阈值 98%。测试约定见 [tests/CONVENTIONS.md](../tests/CONVENTIONS.md)。
- **文档一致性**：`tests/unit/docs.test.ts` 随 `test:ci` 执行，检查相对链接与锚点、已删除能力、
  Store 公开成员与运行时导出是否都在 `docs/API.md` 登记、代码围栏是否成对。
- **宿主模拟 e2e**：`examples/miniprogram/e2e/host-smoke.mjs` 在临时目录加载 `dist-weapp`，
  伪造 wx 与 App / Page / Component，走通集成与持久化往返；CI 在构建后执行 `pnpm run e2e`。
  需要微信开发者工具的 automator 用例只作发版前人工验证，见
  [e2e 说明](../examples/miniprogram/e2e/README.md)。
- **内部性能基准**：`bench/` 只做同机、同构建下的相对比较，不发布 npm、不进 CI，见
  [bench 说明](../bench/README.md)。
- **CI 流水线**：类型检查（src / tests）→ 格式检查 → 构建 → 测试与覆盖率（含契约测试）→
  宿主模拟 e2e → 发布面断言 → 体积门禁（raw 预算 + 增长容差）→ 隐私接口白名单 → 依赖
  audit → 可复现构建 → API 表面门禁 → SBOM 归档。见
  [ci.yml](../.github/workflows/ci.yml)。

## 演进约束

- **新增钩子**：`HookName` 与钩子实参表是唯一真相来源，两处同改，并同步 [API](./API.md) 的钩子表
- **新增错误码**：只有真实会抛出的码才加入 `ErrorCode`（当前八个，表见 [API](./API.md)）；内部误用用普通 `Error` / `TypeError`
- **改默认值**：源码与 [API](./API.md) 的默认值表必须同改；CI 不校验默认值，属于评审项
- **新增运行时入口**：先确认它是否必须在原生宿主上存在；确需新增才加子路径与发布面，并同步
  `package.json` 的 `exports` 类型声明与构建产物——CI 的发布面断言会检查类型文件与
  `dist-weapp` 入口存在。入口分层不减小上传体积，新增入口只在宿主有打包器时才节省字节
- **新增能力**：优先落在既有入口与实现目录内，避免为一次性能力扩充发布面
- **注释与文档**：只写不变量、契约与「为什么必须这样」，只写当下契约，不复述类型

## 相关文档

- [GUIDE](./GUIDE.md)：行为语义与用法
- [API](./API.md)：入口、签名与默认值
- [COMPATIBILITY](./COMPATIBILITY.md)：支持矩阵与环境前提
- [PERFORMANCE](./PERFORMANCE.md)：成本模型与开关
- [CONTRIBUTING](../CONTRIBUTING.md)：本地开发、门禁与发布
- [文档索引](./README.md)：全部文档
