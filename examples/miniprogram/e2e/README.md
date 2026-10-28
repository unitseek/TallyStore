# e2e

两个脚本，用途不同：

| 脚本       | 依赖                           | 何时跑               | 失败语义                         |
| ---------- | ------------------------------ | -------------------- | -------------------------------- |
| host-smoke | 只需要 Node ≥ 22 与 dist-weapp | 本地 + CI 每次构建后 | 任一断言失败 exit 1              |
| automator  | 微信开发者工具 + 已登录        | 发版前人工验证       | 依赖缺失 SKIP/0；断言失败 exit 1 |

## host-smoke（CI 只跑这个）

前置条件：仓库根已执行 `pnpm run build`（生成 `dist-weapp/`）。

```bash
node examples/miniprogram/e2e/host-smoke.mjs
```

它做的事：

1. 把 `dist-weapp/` 复制到系统临时目录，并写 `{"type":"commonjs"}` 后用 `createRequire` 加载
   （与微信按目录加载的形态一致）；
2. 伪造 `wx` 的同步存储与 `getAccountInfoSync`（envVersion=develop）；
3. 用假 App / Page / Component 实例跑 `withAppStore` / `withPageStore` / `withComponentStore`，
   断言 globalData 映射、setData 时机、methods 合并、detached 后退订；
4. Skyline 场景：页面实例带 `renderer: 'skyline'`，同一 tick 两次 `setState` 后 `await` 一个微任务，
   断言只发生一次 setData 且 payload 为最终值；同时断言初始映射在 `onLoad` 内同步交付、
   `onUnload` 丢弃未交付的合并写入；
5. 用 `WxStorageBackend` + `persistencePlugin` 跑一次「写入 → 新 store 恢复」的往返；
6. 共存冒烟（`subpackage-smoke.mjs`）：把 dist-weapp 模拟成主包 `miniprogram_npm`，加载本 demo 的
   真实 `app.json` / `app.js` / 页面配置——分包页面 `packageA/pages/cart` 经 `getApp().globalData.store`
   读主包 Store 且 action 生效；未迁移页面 `pages/legacy` 仍走 `globalData`、行为不变；
7. 每条断言打印 `PASS …`，失败打印 `FAIL …` 并 exit 1；结束时删除临时目录。

CI 建议只跑这一条（不依赖图形界面的开发者工具）。

## automator（可选）

前置条件：

1. 已安装并**登录**微信开发者工具，且已打开「设置 → 安全 → 服务端口」；
2. 已安装 `miniprogram-automator`（仓库根 `pnpm add -D miniprogram-automator`，或全局安装）；
3. 能定位到开发者工具 CLI：设置环境变量 `MINIPROGRAM_CLI_PATH`，或让它落在脚本内置的常见安装
   路径上；
4. 已跑过 `node examples/miniprogram/scripts/sync-lib.mjs`。

```bash
MINIPROGRAM_CLI_PATH="<开发者工具安装目录>/cli.bat" node examples/miniprogram/e2e/automator.mjs
```

行为：未安装 automator 或找不到 CLI 时打印 `SKIP …` 并 exit 0（不阻塞本地/CI）；启动成功则进入
首页，断言 `data.count` 初始值、点击 `.btn-inc` / `.btn-dec` 后 data 变化，失败 exit 1。

## 相关文档

- [`../README.md`](../README.md)
