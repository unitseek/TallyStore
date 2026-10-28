# Changelog

TallyStore 遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。
仓库：https://github.com/unitseek/tallystore
支持窗口与响应时效：见 [docs/ISSUE-TRIAGE.md](docs/ISSUE-TRIAGE.md)。

## [0.1.0] - 2026-10-28

首个正式版本：面向原生微信小程序的状态管理库，零运行时依赖，发布产物为 `dist-weapp/`
（微信「构建 npm」可直接消费的 CJS）与 `types/`。

### 状态管理

- `createStore` / `Store`：`getState` / `setState` / `$patch` / `$replaceState` /
  `$snapshot` / `$restore` / `dispatch` / `getter` / `subscribe` / `use` / `batch` /
  `startBatch` / `endBatch` / `destroy` / `$reset`。
- 显式写入口与状态保护代理；开发期非法直写拦截，生产期可配置降级并统一经 `onError` 上报。
- Action 同步/异步执行、直接调用与 `dispatch` 语义一致；Getters 无缓存、错误码可判别。
- 只读订阅零拷贝；可写订阅按份克隆；`notify.clone` / `onlyOnChange` / `async`；
  脏键查询、订阅上限与驱逐策略。
- 批量写入、快照/恢复（深克隆 + 冻结 + 体积上限）、身份切换状态重置。
- `defineStores` 模块注册、循环依赖检测、`resetAll`。

### 小程序集成

- `withPageStore` / `withComponentStore` / `withAppStore`；`mapState` /
  `mapGetters` / `mapActions`；生命周期自动解绑与泄漏告警。
- 渲染器无关调度：WebView 逐次、Skyline 同 tick 合并；前后台更新策略可配置。
- 字段级脏键过滤、`setData` 载荷守卫与拆分建议、运行期不可序列化值拦截。
- 分包边界检查、渐进迁移支持；宿主 `data` / `properties` / `methods` 冲突处理。

### 插件与数据

- `persistencePlugin` + `WxStorageBackend`：必须显式 `filter` 白名单，默认不落盘；
  版本迁移、配额告警、恢复延迟/关闭、卸载补写。
- `loggerPlugin`：开发期结构化日志（脱敏、可开关），reset/hostWrite 归因。
- `metricsPlugin`：通知/宿主写入/action/错误/订阅指标，单次与累计载荷、Action→宿主归因，
  sink 可注入、采样可配置、事件 schema 运行时校验。
- `createRaceGuard`：请求序号/最新判定/取消，结果级取消不等于网络中断。

### 安全与质量

- 敏感键清单、递归落盘审计（命中拒绝整次落盘）、日志深度脱敏、隐私 API 扫描。
- 错误码体系、错误隔离、开发期校验与生产降级、可观测错误通道。
- 类型契约、API 稳定性分级、契约测试、类型测试、覆盖率与体积/性能门禁。
- SBOM、许可证白名单、可复现构建、发布 manifest（tarball sha256）与 provenance 发布流程。
- 文档：API/GUIDE/ARCHITECTURE/COMPATIBILITY/PERFORMANCE/MIGRATION/RELEASE/SECURITY/
  TEAM-RULES/ISSUE-TRIAGE；示例工程与宿主模拟 e2e。

### 已知边界

- 仅支持原生微信小程序；存储为明文，库不提供加密、权限控制或服务端鉴权。
- 受限路径增量更新（path patch）不在本版本范围，后续版本按需评估。
