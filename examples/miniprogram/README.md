# TallyStore 原生小程序 demo

一个**可运行**的原生微信小程序工程，演示 TallyStore 的全部宿主能力：

- `createStore`：全局 store（count + actions + getters）
- `defineStores`：聚合登记工厂、`get()` 惰性实例化（多模块 / 分包场景的推荐组织方式；
  本 demo 单 Store 用 `createStore` 直建，对照写法见[聚合注册](#聚合注册definestores)）
- `withAppStore`：`mapState` / `mapGetters` → `globalData`，`mapActions` → App 实例方法
- `withPageStore`：页面 `data` 映射、action 绑定、`onUnload` 自动退订
- `withComponentStore`：组件 `data` 映射、action 并入 `methods`、`detached` 自动退订
- `persistencePlugin` + `WxStorageBackend`：跨启动恢复状态（必须显式 `filter` 白名单；demo 只落 `count`，100ms 防抖）
- `loggerPlugin`：开发期控制台日志（生产模式自动静默）
- `metricsPlugin`：可选指标上报；demo 未挂载 sink，接入方式见 [API](../../docs/API.md#metricsplugin)
- **Skyline 渲染**：`app.json` 已切换到 Skyline；集成层在 Skyline 宿主下自动合并同一 tick 的多次
  `setData`（见下方 [Skyline](#skyline)）

## 目录

```text
examples/miniprogram/
├── app.js / app.json / app.wxss / sitemap.json    # App 入口 + 全局配置
├── project.config.json                            # 开发者工具工程配置（appid=touristappid）
├── pages/index/                                   # 页面集成（index.js/json/wxml/wxss）
├── pages/legacy/                                  # 未迁移页面：直接读写 globalData（与 Store 共存演示）
├── packageA/pages/cart/                           # 分包页面：经 globalData.store 复用主包 Store
├── components/counter/                            # 组件集成
├── scripts/sync-lib.mjs                           # 把仓库根 dist-weapp 同步成 miniprogram_npm 包
├── e2e/                                           # host-smoke（CI，含分包/未迁移页面冒烟）+ automator（可选）
└── miniprogram_npm/                               # 预构建产物，改库后 sync 并提交
```

## 聚合注册（defineStores）

本 demo 只有一个 Store，`app.js` 直接 `createStore` 建实例即可。**多模块 / 分包场景**推荐用
`defineStores` 聚合登记：只登记工厂、`get()` 首次调用才实例化（未使用的模块零启动开销），
模块边界与依赖方向可被静态检查（`check:boundary`）与 `dependsOn` 循环检测兜底
（规约见 [TEAM-RULES](../../docs/TEAM-RULES.md)）。把 `app.js` 的 store 定义换写成：

```js
const { createStore, defineStores, withAppStore } = require('@unitseek/tallystore')

const stores = defineStores({
  counter: {
    // factory 里与现在的 createStore 写法完全一致（state/actions/getters 原样搬入）
    factory: () =>
      createStore({
        name: 'demo-counter',
        state: () => ({ count: 0 }),
        // actions / getters 同 app.js
      }),
  },
})

// 首次 get 才实例化并记忆，后续 get 返回同一实例；
// 之后 globalData.store = stores.get('counter')，页面 / 组件取用方式不变
const store = stores.get('counter')
```

多模块时在声明上补 `dependsOn: ['counter']` 即可参与循环依赖检测；主包聚合注册后分包
可直接引用（反向会被静态检查拦截，见 [MIGRATION](../../docs/MIGRATION.md)）。

## 分包与未迁移页面

demo 自带一份**真实分包配置**与一个**未迁移页面**，用于演示并自动化验证依赖方向与渐进迁移：

- `app.json` 的 `subPackages` 声明 `packageA`（页面 `packageA/pages/cart/cart`）；
- 分包页面**只通过 `getApp().globalData.store` 取主包 Store**，不 `createStore`、不复制实例；
  `require('@unitseek/tallystore')` 解析到主包根的 `miniprogram_npm`（构建 npm 形态）；
- 未迁移页面 `pages/legacy/legacy` 保留 `globalData` 直接读写，行为与接入分包前一致，
  且与 Store 状态互不影响——迁移页面与旧逻辑可长期共存；
- 依赖方向：**分包 → 主包允许；主包 → 分包禁止**（分包可能未加载，主包引用会在运行时找不到模块）。

验证（不需要开发者工具）：

```bash
# 静态边界：主包不引用分包；正向（分包 → 主包 Store）合法
node scripts/check-package-boundary.mjs examples/miniprogram

# 宿主模拟 e2e：除原有 App/Page/Component/持久化/Skyline 外，还会加载本 demo 的真实
# app.json / 页面配置，断言分包页读到主包 Store、action 生效、未迁移页 globalData 路径不变
node examples/miniprogram/e2e/host-smoke.mjs
```

拆包与迁移的完整步骤见 [MIGRATION](../../docs/MIGRATION.md#分包与未迁移页面示例)。

## Skyline

本 demo 使用 **Skyline** 渲染器（而不是 WebView）。

### 必需配置

- `app.json`：`renderer: "skyline"`、`componentFramework: "glass-easel"`、
  `lazyCodeLoading: "requiredComponents"`，以及 `rendererOptions.skyline`
  （`defaultDisplayBlock` / `defaultContentBox` / `tagNameStyleIsolation` /
  `enableScrollViewAutoSize` / `disableABTest`，原样见 [app.json](./app.json)）；
- 页面 json：`navigationStyle: "custom"`（Skyline 不支持原生导航栏）、`disableScroll: true`
  （页面级全局滚动被禁用，滚动交给 `scroll-view` 局部完成），以及
  `componentFramework: "glass-easel"` + `glassEaselWebview: true`（glass-easel 编译器/运行时）；
- `scroll-view` 必须有确定高度，并自行处理安全区：
  `height: 100vh` +
  `padding: calc(env(safe-area-inset-top) + 88rpx) 24rpx calc(env(safe-area-inset-bottom) + 24rpx)`
  （见 [pages/index/index.wxss](./pages/index/index.wxss)）；
- **纯文本必须放在 `<text>` 内**：`view` / `button` 里直接写文字在 Skyline 下不会按文本节点渲染；
- 组件生命周期继续写在 `lifetimes` / `pageLifetimes` 里（与 WebView 相同）。

### 集成的 setData 合并

- 三个集成入口的 `schedule` 默认是 `'auto'`：宿主实例 `this.renderer === 'skyline'` 时，把同一 tick
  的多次映射写入合并成**一次** `setData`（用 Promise 微任务）；WebView 实例保持逐次同步写入；
- 初始映射始终同步交付（`flushNow`），所以 `onLoad` / `attached` 里能立刻读到映射后的 `data`；
- 卸载 / 重入 / `detached` 会丢弃尚未交付的合并写入，不会写回已销毁实例；
- 需要「每次写入都立即 `setData`」时显式传 `schedule: 'sync'`；想全局强制合并可传
  `schedule: 'microtask'`。本 demo 页面 JS 没有写 `schedule`，走默认 `'auto'` 即可。

### 版本与限制

- 版本：Android / iOS 微信 8.0.40+、基础库 3.0.2+；HarmonyOS 微信 1.0.10+、基础库 3.11.3+。
  本 demo 的组件自动退订仍依赖基础库 3.15.0+，建议整体 ≥ 3.15.0；
- 限制：不支持 `web-view` 组件、页面级全局滚动、依赖原生导航栏的能力（因此用了自定义导航 +
  `scroll-view`）；
- 切回 WebView：删除 `app.json` 的 `renderer` / `componentFramework` / `rendererOptions`、页面
  json 的 `navigationStyle` / `disableScroll`，并去掉 wxml 外层 `scroll-view` 即可；集成层无需改动。

## 跑起来

项目已内置预构建的 `miniprogram_npm`（与当前 `dist-weapp` 一致），无需先执行构建命令：

1. 打开微信开发者工具 → 导入项目 → 选择本目录 `examples/miniprogram`（AppID 用测试号
   `touristappid` 即可）；
2. 点「编译」。首页会显示 `count` / `doubled`，以及「进入页面时恢复的 count」；页面 `onLoad`
   会自动 +1 一次；
3. 点 **+1 / -1**：页面与下方组件里的数字同步变化（同一份 store）；
4. 等 100ms 以上（防抖窗口），点开发者工具的「编译」（相当于冷启动）：
   - `count` 从持久化里恢复，「进入页面时恢复的 count」显示的就是恢复值；
   - 随后 `onLoad` 再 +1，所以当前值 = 恢复值 + 1。

### 修改源码后重新生成

修改仓库 `src/` 后，示例内置的 `miniprogram_npm` 不会自动更新；执行：

```bash
pnpm run build
pnpm run examples:sync
```

然后把 `examples/miniprogram/miniprogram_npm` 的变更一并提交。CI 会重新 sync 并校验它
与 `dist-weapp` 一致，防止预构建产物漂移。

### 不点「构建 npm」

本项目**不用**「工具 → 构建 npm」：`sync-lib.mjs` 已按微信的运行时目录规则，把
`dist-weapp/` 整目录放进 `miniprogram_npm/@unitseek/tallystore/`，因此
`require('@unitseek/tallystore')` 与 `require('@unitseek/tallystore/plugins')` 可直接解析。

如果误点了「构建 npm」：`miniprogram_npm/` 可能被重算/清空，重新执行 `pnpm run build` + `pnpm run examples:sync` 即可。
另外**改了仓库 `src/` 之后**必须重新构建并同步，demo 才会用到新代码。

## 验证

```bash
# 静态边界检查（主包不得引用分包）
node scripts/check-package-boundary.mjs examples/miniprogram

# 不需要开发者工具：真实加载 dist-weapp 的 CJS 字节并模拟 App/Page/Component/持久化，
# 另含 Skyline 场景（renderer='skyline' 下同 tick 多次 setState 合并为一次 setData），
# 以及分包页面 / 未迁移页面的共存冒烟
node examples/miniprogram/e2e/host-smoke.mjs
```

输出每条 `PASS …`，失败 exit 1。

## 常见问题

- **报错 `module '@unitseek/tallystore' is not defined` / 找不到包**：没跑 `pnpm run build` 或没跑
  `sync-lib.mjs`，或者点了「构建 npm」。按「跑起来」重跑即可。
- **组件 `detached` 不退订**：生命周期必须写在 `lifetimes` 里（基础库 ≥ 3.15.0）；demo 的
  `components/counter` 是正确写法。
- **持久化没恢复**：`debounce: 100` 意味着改完状态要等 100ms 才落盘；另外开发者工具模拟器也使用
  真实 `wx.setStorageSync`，清缓存会一起清掉。
- **`libVersion`**：`project.config.json` 里写了一个较新的稳定版；本地工具若不识别，改成开发者
  工具「详情 → 本地设置」里的当前稳定版本即可。

## 相关文档

- 真机 / 开发者工具的可选 e2e 见 [`e2e/README.md`](./e2e/README.md)
