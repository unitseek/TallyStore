# 双渲染器冒烟记录（发布前人工门禁）

本文件记录 **DevTools / 真机 × WebView / Skyline** 四组冒烟的真实执行结果，随发布归档。
CI 只能提供 Node 宿主模拟证据（`coverage/dual-renderer-smoke.json`），**不得把模拟结果填成真实执行结果**。

## 记录规则

1. 四组组合必须逐行填写：执行人、日期、环境（开发者工具版本 / iOS/Android 版本 / 基础库 / 机型）、命令、结果（通过/失败+现象）；
2. 未执行的组合填「待执行」，由发布负责人（Release Owner）在发版前补录，不得留空、不得伪造；
3. 失败项必须附最小复现与 issue 链接；修复后重跑并更新日期；
4. 本文件与 `coverage/dual-renderer-smoke.json`（CI 模拟证据）一并随 release artifact 归档。

## 四组真实执行记录（发布负责人补录）

| 组合 | 设备 / 渲染器          | 执行命令                                                                  | 状态         | 日期       | 环境（版本/机型）                                                     | 结果与备注                                      |
| ---- | ---------------------- | ------------------------------------------------------------------------- | ------------ | ---------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| 1    | DevTools × WebView     | 临时切换 `app.json` renderer=webview 后用开发者工具编译（或 automator）   | 待执行       | —          | —                                                                     | 需开发者工具 + 已登录 + 开启服务端口            |
| 2    | DevTools × Skyline     | 微信开发者工具导入 `examples/miniprogram` → 编译 → 首页 +1/-1、冷启动恢复 | 通过（手工） | 2026-10-28 | Windows DevTools 2.02.2610212 / 基础库 3.17.5 / Skyline + glass-easel | 用户确认示例运行正常；正式 automator 记录仍待补 |
| 3    | 真机 Android × WebView | 开发者工具「预览」→ Android 真机打开                                      | 待执行       | —          | —                                                                     | 按 COMPATIBILITY 矩阵记录基础库/机型            |
| 4    | 真机 iOS × Skyline     | 开发者工具「预览」→ iOS 真机打开（Skyline 页面）                          | 待执行       | —          | —                                                                     | 同上；Skyline 需基础库支持                      |

## CI 模拟证据（自动生成，非真实执行）

命令：`pnpm run smoke:dual-renderer`（内部调用 `pnpm run e2e` 的 host-smoke，需先 `pnpm run build`）

- 产物：`coverage/dual-renderer-smoke.json`（gitignored，CI artifact 归档；含 WebView/Skyline 分组断言数、Node/平台环境、git HEAD、四组 pending 占位）；
- 最近一次本机模拟结果（2026-10-28，v26.10.0 / win32）：**WebView 41/41 项通过、Skyline 5/5 项通过**（含 App/Page/Component/持久化/分包冒烟与 Skyline 合并场景；完整断言见 JSON `simulated`）；
- host-smoke 的 Skyline 场景验证 `renderer: 'skyline'` 下同一 tick 多次写入合并、初始映射同步交付、`onUnload` 丢弃未交付写入；WebView 分组覆盖默认 schedule 的同步交付与生命周期解绑。

> 模拟证据会随代码与用例增减变化，以 CI artifact 中当次的 `coverage/dual-renderer-smoke.json` 为准；本文件只固定四组真实执行记录。

## 与 CI / 发布的关系

- CI：`.github/workflows/ci.yml` 在 e2e 后执行 `pnpm run smoke:dual-renderer`，并把 `coverage/dual-renderer-smoke.json` 与核心覆盖率清单一起上传 artifact；
- 发布：`docs/RELEASE.md` 发布检查清单要求「双渲染器冒烟记录已补录」；真机项属 G3 发布前人工门禁，发布负责人对本文件的四组记录负责；
- 真机执行受限（无设备/无登录）时，保持「待执行」并注明阻塞原因，**不得用 CI 模拟结果替代**。
