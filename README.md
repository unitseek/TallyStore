# TallyStore

TallyStore 是一个只面向原生微信小程序的状态管理库：零运行时依赖、类型完备、行为可预测。

[![npm](https://img.shields.io/npm/v/@unitseek/tallystore.svg)](https://www.npmjs.com/package/@unitseek/tallystore)
[![CI](https://github.com/unitseek/tallystore/actions/workflows/ci.yml/badge.svg)](https://github.com/unitseek/tallystore/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@unitseek/tallystore.svg)](./LICENSE)

当前 **v0.1.0** · 微信「构建 npm」直接用 · 仅原生小程序 · MIT

## 它解决什么

小程序逻辑层没有 `localStorage`、没有 `window`、也不一定带打包器。TallyStore 把状态管理收敛成四件事：

- **状态与订阅**：`setState` / `$patch` / `$replaceState`；只读订阅与可写订阅分离，`store.state` 是只读保护代理（对象、数组、Map/Set 的变异都会被拦）
- **Action 与 Getters**：业务逻辑集中在一处，`this` 已绑定当前 Store；getter 无缓存、只读状态
- **App / Page / Component 集成**：三类宿主统一映射；Skyline 下自动合并同一 tick 的 `setData`
- **三个可选插件**：持久化（`persistencePlugin` + `WxStorageBackend`）、日志（`loggerPlugin`）与指标（`metricsPlugin`）

## 安装

```bash
pnpm add @unitseek/tallystore
```

- 文档与仓库脚本统一使用 pnpm；包本身不绑定包管理器，任意包管理器安装后用法相同
- 宿主只需微信开发者工具的「工具 → 构建 npm」，不需要打包器
- **仅支持原生微信小程序**：发布产物只有微信用的 CJS 与类型声明，不支持 Node / 浏览器 / Taro / uni-app
- 零运行时依赖，也不依赖 `tslib`；Node ≥ 22 只与开发和构建有关

## 快速开始

三步接入：创建 Store、接入页面、在开发者工具里构建 npm。

### 1. 创建 Store

```ts
// store/counter.ts
import { createStore } from '@unitseek/tallystore'

export const counter = createStore({
  name: 'counter',
  state: () => ({ count: 0 }),
  actions: {
    increment(delta = 1) {
      this.setState('count', this.getState().count + delta)
    },
  },
  getters: {
    doubled: (state) => state.count * 2,
  },
})
```

### 2. 接入页面

```ts
// pages/index/index.ts
import { withPageStore } from '@unitseek/tallystore'
import { counter } from '../../store/counter'

Page(
  withPageStore(counter, {
    mapState: ['count'], // → this.data.count
    mapGetters: ['doubled'], // → this.data.doubled
    mapActions: ['increment'], // → this.increment()
  })({
    onLoad() {
      this.increment()
    },
  }),
)
```

```xml
<!-- pages/index/index.wxml -->
<view>{{count}} / {{doubled}}</view>
<button bindtap="increment">+1</button>
```

### 3. 构建 npm

在微信开发者工具中执行「工具 → 构建 npm」，然后编译即可。页面卸载时自动退订；
`mapState` / `mapGetters` 的字段随状态变化自动 `setData`。

### 4. 持久化（必须显式声明 filter）

```ts
import { persistencePlugin, WxStorageBackend } from '@unitseek/tallystore/plugins'

store.use(
  persistencePlugin({
    key: 'tallystore_counter',
    storage: new WxStorageBackend(),
    // 必填：只落盘白名单字段（默认不落盘任何字段，禁止自动全量持久化）
    filter: (state) => ({ count: state.count }),
  }),
)
```

`filter` 是必填项：不传会在开发期抛 `INVALID_CONFIG`，生产期经 `onError(INVALID_CONFIG, 'persistence')`
上报后禁用持久化（零 storage 调用）。显式关闭请传 `filter: false`（不读 storage、不恢复、不写盘/清理）。
从旧版本升级时按 [MIGRATION](./docs/MIGRATION.md) 补显式 filter。

## 能力地图

只有下面这些入口，没有别的子路径：

| 入口                                       | 内容                                                                        | 何时用                 |
| ------------------------------------------ | --------------------------------------------------------------------------- | ---------------------- |
| `@unitseek/tallystore`                     | `createStore` / `Store` / 三类集成 / 插件契约 / 错误类型                    | 总是                   |
| `@unitseek/tallystore/plugins`             | `persistencePlugin` / `WxStorageBackend` / `loggerPlugin` / `metricsPlugin` | 需要持久化、日志或指标 |
| `@unitseek/tallystore/plugins/persistence` | 持久化单入口（只带持久化实现）                                              | 只要持久化             |
| `@unitseek/tallystore/plugins/logger`      | 日志单入口（只带日志实现）                                                  | 只要日志               |

运行时代码由 `dist-weapp/` 提供；`exports` 只声明类型，微信侧按 `miniprogram` 字段解析。

## 设计边界

- **宿主**：只支持原生微信小程序；不做跨端适配，也不提供供打包器使用的运行时入口
- **状态保护**：是开发期护栏，不是安全边界（不防恶意代码 / 逆向 / 篡改）；`getState()` 返回内部裸引用
- **存储**：`wx` 本地存储为明文，库不提供加密与完整性校验；敏感字段默认不落盘（ 拦截）
- **权限**：库不调用需用户授权的隐私接口，不替代权限控制与服务端鉴权；责任划分与推荐路径见 [SECURITY.md](./SECURITY.md)
- **持久化**：按 JSON 往返，`Date` / `Map` / `Set` 恢复后类型会变化；`filter` 白名单**必填**，默认不落盘任何字段（`filter: false` 显式关闭），必要时在 filter 内派生普通数据
- **体积**：微信「构建 npm」整目录拷贝 `dist-weapp/`，只有删代码才能减少上传体积；入口分层只降低运行时 `require`

完整支持矩阵见 [COMPATIBILITY](./docs/COMPATIBILITY.md)，成本与取舍见 [PERFORMANCE](./docs/PERFORMANCE.md)。

## 环境要点

- **生产判定**：四档，取第一个有信号的——`process.env.NODE_ENV` → `__DEV__` → `wx.getAccountInfoSync().miniProgram.envVersion` → 兜底开发；`release` 与 `trial` 都判生产
- **状态保护**：默认开启。开发期非法直写抛错；生产期由 `stateProtection.productionHandler` 决定（默认 `warn`）。Map/Set 的 `set/add/delete/clear` 与属性写入同口径；`store.state.map` 是代理，不是内部原 Map
- **Skyline**：支持。按官方要求开启即可；集成默认合并同一 tick 的映射 `setData`（`schedule: 'auto'`），WebView 保持逐次同步。配置与限制见 [COMPATIBILITY](./docs/COMPATIBILITY.md)
- **组件生命周期**：必须写在 `lifetimes` / `pageLifetimes` 内（基础库 ≥ 3.15.0），否则 `detached` 不执行、集成不会退订
- **`typeof` 陷阱**：小程序沙箱里读未声明标识符连 `typeof` 都抛 `ReferenceError`；探测全局请用 `globalThis.xxx` + `try/catch`
- **分包**：`project.config.json` 的 `packNpmManually` + `miniprogramNpmDistDir` 可把 `miniprogram_npm` 挪进分包

## 示例

[`examples/miniprogram`](./examples/miniprogram) 是可直接用微信开发者工具打开的原生 demo：
全局 store + App / Page / Component 三类集成 + 持久化 / 日志 / 指标插件。

示例已内置预构建的 `miniprogram_npm`，**导入即可运行**；修改库源码后才需要重新生成：

```bash
pnpm run build # 产出 dist-weapp/
pnpm run examples:sync # 把 dist-weapp 同步进 demo 的 miniprogram_npm（需提交）
pnpm run e2e # 宿主模拟 e2e（不依赖开发者工具，CI 运行）
pnpm run e2e:devtools # 可选：需要 miniprogram-automator 与开发者工具 CLI
```

## 质量

- 单元/行为测试覆盖 Store、通知中枢、状态代理、集成层与插件；CI 有覆盖率阈值
- 宿主模拟 e2e 覆盖 App / Page / Component、持久化与 Skyline 合并；文档有链接与 API 一致性门禁
- 开发命令、测试约定与发布流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)，基准方法见 [bench/README.md](./bench/README.md)

## 性能基准（仓库内部）

`bench/` 是仓库内部的性能基准套件，**不随 npm 包发布**，直接测 `dist-weapp` 产物：

```bash
pnpm run build # 基准测构建产物，改完 src 必须先构建
pnpm run bench # 全部 suite（proxy / store / integrations / plugins）
pnpm run bench:quick # 快速模式
pnpm run bench:save # 保存本机基线到 bench/baseline.json
pnpm run bench:compare # 与基线比较，超容差的 case 报告并失败
```

基准不进 CI（机器噪声大），用于同机重构前后对比；方法论与新增 case 见 [bench/README.md](./bench/README.md)。

## 文档

| 文档                                             | 内容                     |
| ------------------------------------------------ | ------------------------ |
| [docs/README.md](./docs/README.md)               | 文档索引与阅读路径       |
| [docs/GUIDE.md](./docs/GUIDE.md)                 | 概念与完整用法           |
| [docs/API.md](./docs/API.md)                     | 入口、签名与默认值       |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)   | 分层、目录职责、关键取舍 |
| [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md) | 兼容性与运行环境         |
| [docs/PERFORMANCE.md](./docs/PERFORMANCE.md)     | 性能模型与优化建议       |
| [docs/RECIPES.md](./docs/RECIPES.md)             | 常见场景配方             |
| [CONTRIBUTING.md](./CONTRIBUTING.md)             | 本地开发与发布           |
| [SECURITY.md](./SECURITY.md)                     | 安全策略与漏洞报告       |
| [docs/TEAM-RULES.md](./docs/TEAM-RULES.md)       | 团队规范与 CR 清单       |
| [docs/RELEASE.md](./docs/RELEASE.md)             | 发布流程与版本策略       |
| [docs/MIGRATION.md](./docs/MIGRATION.md)         | globalData 迁移指南      |
| [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)       | 社区行为准则             |
| [CHANGELOG.md](./CHANGELOG.md)                   | 版本变更                 |

面向 AI 助手的检索型参考在 [skills/tallystore](./skills/tallystore)：规则、常见坑与文件指针。

## Community

- 问题与提案：[GitHub Issues](https://github.com/unitseek/tallystore/issues)
- 安全漏洞：请走 [私密报告](https://github.com/unitseek/tallystore/security/advisories/new)，流程见 [SECURITY.md](./SECURITY.md)
- 社区准则：[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- 参与开发：[CONTRIBUTING.md](./CONTRIBUTING.md)

## 许可

MIT
