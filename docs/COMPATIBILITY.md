# 兼容性

本库只面向**原生微信小程序**。本文列出支持矩阵、明确不支持的范围，以及会改变运行行为的环境前提。
安装与快速开始见 [README](../README.md)，用法见 [GUIDE](./GUIDE.md)，API 与默认值见 [API](./API.md)。

## 本文内容

- [支持矩阵](#支持矩阵)
- [明确不支持](#明确不支持)
- [渲染器与 Skyline](#渲染器与-skyline)
- [生产判定](#生产判定)
- [宿主环境坑](#宿主环境坑)
- [状态保护不是安全边界](#状态保护不是安全边界)
- [相关文档](#相关文档)

## 支持矩阵

| 维度       | 要求                              | 说明                                                                                                        |
| ---------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 宿主       | 原生微信小程序                    | 逻辑层状态管理 + `Page` / `Component` / `App` 集成                                                          |
| 渲染器     | WebView / Skyline                 | 状态管理与渲染器无关；Skyline 需按「渲染器与 Skyline」配置，集成在 Skyline 下默认合并同一 tick 的 `setData` |
| 微信基础库 | **≥ 3.15.0**                      | 仅 `withComponentStore` 的自动退订依赖 `lifetimes.attached` / `lifetimes.detached`                          |
| TypeScript | **≥ 5.4**                         | 仅类型检查需要（公开签名使用 `NoInfer`）；不影响宿主运行时                                                  |
| Node.js    | **≥ 22**                          | 仅开发、构建、测试与基准需要；小程序运行时不加载 Node                                                       |
| 包管理     | pnpm 12.x                         | 仓库开发与发布；包使用者不受此限制                                                                          |
| 构建方式   | 微信开发者工具「工具 → 构建 npm」 | 按 `package.json` 的 `miniprogram` 字段整目录拷贝 `dist-weapp/`，不需要打包器                               |
| 运行时依赖 | 零                                | 不依赖第三方运行时，也不依赖 `tslib`                                                                        |
| 发布产物   | `dist-weapp/` + `types/`          | 前者是逐模块 CJS，后者是类型声明；`exports` 只声明类型                                                      |

**基础库版本口径**：本库自身的最低要求是 **≥ 3.15.0**（`withComponentStore` 自动退订依赖
`lifetimes`）。Skyline 另有官方宿主门槛（见「渲染器与 Skyline」的版本要求）；两者取较高者，整体
建议 **≥ 3.15.0**。其余能力按微信公开 API 使用；分发前请在自己支持的最低基础库与渲染器组合上做一遍
冒烟。

## 明确不支持

- **Node / SSR**：没有 Node 运行时入口。
- **浏览器 / H5**：没有 DOM / `window` / `localStorage` 适配。
- **Taro / uni-app**：不做跨框架编译层适配。
- **打包器宿主**：没有供打包器使用的 ESM / CJS 运行时出口（运行时只有微信侧的 `dist-weapp/`），
  不能作为 bundler 依赖直接 `import` 运行时代码。

## 渲染器与 Skyline

状态管理与渲染器**无关**：它只维护逻辑层状态，通过 `setData` 把映射字段交给宿主。WebView 与
Skyline 两种渲染器都支持；集成在 Skyline 下默认把同一 tick 的多次映射写入合并为一次 `setData`，
WebView 仍逐次同步。调度选项与取舍见 [PERFORMANCE](./PERFORMANCE.md)。

### 配置要求

`app.json` 开启 Skyline（必需三项 + `rendererOptions`）：

```json
{
  "renderer": "skyline",
  "componentFramework": "glass-easel",
  "lazyCodeLoading": "requiredComponents",
  "rendererOptions": {
    "skyline": {
      "defaultDisplayBlock": true,
      "defaultContentBox": true,
      "tagNameStyleIsolation": "legacy",
      "enableScrollViewAutoSize": true,
      "disableABTest": true
    }
  }
}
```

每个页面 json 需要：

```json
{
  "navigationStyle": "custom",
  "disableScroll": true
}
```

- 页面滚动交给 `scroll-view`，纯文本放进 `<text>`，不要依赖页面级全局滚动
- 组件生命周期继续写在 `lifetimes` / `pageLifetimes`；`withComponentStore` 的自动退订依赖它
- 仓库内 `examples/miniprogram` demo 已按上述方式切换到 Skyline，可作为配置参考

### 版本要求

- Android / iOS：微信 8.0.40+、基础库 3.0.2+
- HarmonyOS：微信 1.0.10+、基础库 3.11.3+
- 本库 `withComponentStore` 的自动退订要求基础库 **≥ 3.15.0**，因此整体建议 **≥ 3.15.0**

### 限制

- **没有原生导航栏**：Skyline 页面必须 `navigationStyle: "custom"`，导航栏需要自行实现
- **没有页面级全局滚动**：页面设 `disableScroll: true`，滚动交给 `scroll-view`
- **不支持 `web-view` 组件**：需要 web-view 的页面只能继续用 WebView 渲染器
- 依赖原生导航栏、页面级滚动或 web-view 的既有页面，不要直接切到 Skyline

### 渲染器判定与调度

- 页面 / 组件实例上有 `this.renderer`（`'skyline' | 'webview'`），也可用 `wx.getSkylineInfoSync()` 判断
- 集成选项 `schedule`：`'auto'`（默认：Skyline 合并、其余宿主逐次同步）、`'sync'`（始终逐次同步）、
  `'microtask'`（始终合并；Promise 微任务）；三个集成入口都支持
- 初始映射始终同步交付，`onLoad` / `attached` 内可立即读到映射后的 `data`
- 卸载 / 重入 / `detached` 会丢弃尚未交付的合并写入；写入失败开发期 `console.error`，生产期不打印
  console，但仍 `onError` 上报（`source` 为 `'withPageStore'` / `'withComponentStore'` /
  `'withAppStore'`）

## 生产判定

`isProduction()` 按顺序取第一个有信号的档，首次判定后缓存：

1. `process.env.NODE_ENV`
2. `__DEV__`
3. `wx.getAccountInfoSync().miniProgram.envVersion`：`release` / `trial` 判生产，`develop` 判开发
4. 兜底：**开发模式**（保护优先）

生产模式的影响面：状态保护的非法直写处理方式、日志输出、插件是否静默。注意 `trial`（体验版）也按
生产处理；要在体验版复现严格行为，可显式设置 `__DEV__ = true`（优先级高于宿主信号）。

## 宿主环境坑

- **沙箱 `typeof`**：小程序 AppService 的全局是沙箱代理，读**未声明**标识符连 `typeof` 都抛
  `ReferenceError`。探测全局请用 `globalThis.xxx` + `try/catch`，不要写裸 `typeof`。
- **组件生命周期**：必须写在 `lifetimes` / `pageLifetimes` 内；写在配置顶层的 `attached` /
  `detached` 不会执行，集成层的自动退订也不会发生。
- **持久化后端**：必须是同步后端；默认使用 `WxStorageBackend`，`wx` 同步存储 API 不可用时降级为
  内存存储并告警（生产期不刷 console，但会通过 `onError` 的 `'persistence'` 源上报）。
- **分包**：`project.config.json` 的 `packNpmManually` + `miniprogramNpmDistDir` 可把
  `miniprogram_npm` 挪进分包；只改变包额度，不改变字节总量（见 [PERFORMANCE](./PERFORMANCE.md)）。
  demo 提供真实分包示例：分包页面 `packageA/pages/cart` 经 `getApp().globalData.store` 复用主包 Store，
  主包 `pages/legacy` 保留 `globalData` 写法；`node scripts/check-package-boundary.mjs examples/miniprogram`
  与 `pnpm run e2e` 覆盖正向依赖与新旧共存行为（迁移步骤见 [MIGRATION](./MIGRATION.md#分包与未迁移页面示例)）。

## 状态保护不是安全边界

`stateProtection` 是**开发期护栏**：开发期非法直写抛错，生产期默认只 `warn` 后放行；`getState()`
返回的是内部原始引用，可被直接修改；`wx` storage 是明文存储（库不提供加密与完整性校验）；库
不替代权限控制与服务端鉴权。不要把状态保护当作防篡改或防逆向的安全机制；敏感数据请在业务侧
自行加密、最小化持久化内容。库侧 / 业务侧责任划分与敏感数据推荐路径见
[SECURITY.md](../SECURITY.md)。

## 相关文档

- [PERFORMANCE](./PERFORMANCE.md)：成本模型与开关
- [RECIPES](./RECIPES.md)：可复制配方
- [GUIDE](./GUIDE.md)：概念与用法
- [../CONTRIBUTING.md](../CONTRIBUTING.md)：开发环境、测试与发布
