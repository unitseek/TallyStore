# 发布流程与版本策略

面向库维护者的发布操作手册。版本号遵循 [SemVer](https://semver.org/)；
变更记录遵循 [Keep a Changelog](./../CHANGELOG.md)。

## 本文内容

- [版本策略](#版本策略)
- [发布检查清单](#发布检查清单)
- [发布命令与可追溯产物](#发布命令与可追溯产物)
- [发布流程](#发布流程)
- [回滚](#回滚)
- [废弃周期](#废弃周期)
- [支持窗口](#支持窗口)

## 版本策略

- **0.x 阶段**：允许破坏性变更，但必须 ① 在 CHANGELOG 的「破坏性变更」小节显式标注，
  ② 附迁移步骤（可运行的示例优先），③ 同步兼容矩阵与 `docs/MIGRATION.md`；
- **1.0 之后**：严格 SemVer——主版本承载破坏性变更，minor 只新增，patch 只修复；
- 库版本与持久化 `schemaVersion` **解耦**：升级库不强制迁移数据，迁移由业务显式触发
  （见 [API · persistencePlugin](./API.md)）；
- 每个版本的发布说明使用 [Release Notes 模板](./RELEASE-NOTES-TEMPLATE.md)，四段必备：
  **变更 / 迁移 / 已知问题 / 支持窗口**（破坏性变更的迁移步骤写进「迁移」段；体积与性能
  基线变化随 `size:gate` 与 `bench` 记录，兼容矩阵变化写进「已知问题」或「迁移」）。

## 发布检查清单

发布前逐项确认（对应 CI 门禁 G0–G4）：

```markdown
- [ ] 全部门禁绿：typecheck ×2 / format / test+coverage / build / e2e / smoke:dual-renderer / check:publish
- [ ] size:gate 通过（或预算调整已评审并记录依据链）
- [ ] api:report --check 快照已同步（导出增删在 PR 评审过）
- [ ] check:repro / check:privacy / sbom / audit 通过
- [ ] CHANGELOG 含四要素；破坏性变更有迁移步骤
- [ ] 兼容矩阵（COMPATIBILITY）与 ARCHITECTURE 漂移项已复核
- [ ] bench:compare 无超容差退化（相对入库基线，25%）
- [ ] 双渲染器冒烟记录已补录（[docs/quality/dual-renderer-smoke.md](./quality/dual-renderer-smoke.md)；CI 模拟证据 `coverage/dual-renderer-smoke.json`，真实 DevTools/真机行由发布负责人填写，禁止用模拟结果代替）
- [ ] 核心覆盖率清单已归档（`pnpm run coverage:manifest` → `coverage/core-manifest.json`；缺口例外见 `scripts/core-coverage-exceptions.json`）
- [ ] 真机冒烟记录（iOS / Android / 开发者工具 × WebView / Skyline）
```

`prepublishOnly` 已串联 `format:check → typecheck → typecheck:tests → build → test:ci → e2e → smoke:dual-renderer → coverage:manifest → check:publish → check:boundary → size:gate → check:repro → api:report --check → check:privacy → release:metadata`（build 在 test:ci 之前，保证新克隆上的 contract 测试不因缺 `dist-weapp` 而跳过；release:metadata 在发布入口强制校验版本号/CHANGELOG 标题/Release Notes 四要素）；发布账号启用 **2FA**。
SBOM（`pnpm run sbom`）、核心覆盖率清单（`pnpm run coverage:manifest` → `coverage/core-manifest.json`，记录核心模块四维覆盖率、缺口例外与 owner）与体积/性能数据随 release 归档（CI artifact `quality-coverage-manifest` 或附于 release notes）。
双渲染器冒烟（ 验收 5）：CI 执行 `pnpm run smoke:dual-renderer` 生成 Node 宿主模拟证据 `coverage/dual-renderer-smoke.json`（WebView/Skyline 分组断言）；**真实 DevTools/真机记录必须由发布负责人按 [docs/quality/dual-renderer-smoke.md](./quality/dual-renderer-smoke.md) 的四组表格补录**，属 G3 发布前人工门禁。

## 发布命令与可追溯产物

发布可追溯性由脚本固化：

| 命令                        | 作用                                                                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run release:metadata` | 校验 semver、CHANGELOG 对应版本标题、可选 tag（`--tag vX.Y.Z`；dry-run 缺省仅 warning）、Release Notes 四要素模板                                                                                  |
| `pnpm run release:manifest` | 生成 tarball 并计算 sha256；用 `npm pack --dry-run --json` 与 `files`/`publishEntries` 声明双向比对（缺/多文件即失败）；解析/生成 SBOM 并记录 sha256、运行时依赖=0、开发依赖许可证清单与上一版差异 |
| `pnpm run release:check`    | = `release:metadata` + `release:manifest`（发布前一次性检查）                                                                                                                                      |

**Artifact 清单**（全部在 `.release/` 与 `coverage/`，目录内自带 `.gitignore` 不入库）：

- `.release/release-manifest.json`：`version / gitHead / tarballSha256 / tarball / files / sbom / licenseChanges`；
- `.release/*.tgz`：`npm pack` 产物（发布用 tarball）；
- `.release/size-report.json`：`node scripts/size.mjs --json` 的体积数据；
- `sbom.cdx.json`：CycloneDX SBOM（`pnpm run sbom` 生成，缺失时 manifest 脚本会自动生成）；
- `coverage/coverage-summary.json` 与 `coverage/core-manifest.json`：覆盖率与核心模块清单。

**provenance / staged publishing**：`.github/workflows/release.yml`（`workflow_dispatch`，`dry_run` 默认 `true`）
在非 dry-run 时执行 `npm stage publish --provenance --access public`（需要 `id-token: write` 与
`NPM_TOKEN` secret；provenance 由 npm OIDC 生成并可在 npmjs.com 校验）。发布不会立即公开：
维护者需在 npm 的 **Staged Packages** 页面（或 `npm stage approve <stage-id>`）用 2FA 批准；
批准后包版本才公开。workflow 随后创建 **draft** GitHub Release（附 tarball、release-manifest、
SBOM 与 manifest/SBOM/体积/覆盖率摘要），npm 批准后再手动 publish 该 draft。本地手工发布不具备
OIDC provenance，发布说明需记录「无 provenance（本地发布）」以便审计。

## 发布流程

1. 冻结变更：确认本次发布范围与验收项全部达成；
2. 更新 `package.json` 版本号、`docs/versions/current.json` 与 CHANGELOG 日期；
3. 本地全量门禁（上面的检查清单），再跑 `pnpm run release:check`（metadata + manifest）；
4. 复制 [Release Notes 模板](./RELEASE-NOTES-TEMPLATE.md) 填写四要素；
5. 触发 `.github/workflows/release.yml`（`dry_run=true` 先演练，产物齐全后 `dry_run=false`）：
   workflow 执行 `npm stage publish --provenance`，创建 draft GitHub Release（附 tarball/manifest/
   SBOM/体积/覆盖率摘要）；
6. 在 npm **Staged Packages** 用 2FA 批准 staged 版本（或 `npm stage approve <stage-id>`），
   确认 `npm view` 可见后 publish draft GitHub Release；
7. 如走本地手工发布：`npm publish`（`prepublishOnly` 自动再跑核心门禁；2FA 确认）→
   打 tag `vX.Y.Z` → 用同一份 Release Notes 创建 GitHub Release 并附 `.release/` artifact；
8. 同步示例（`examples:sync`）与文档版本入口。

## 回滚

- **包层面**：`npm deprecate <pkg>@<bad> "说明 + 建议版本"` 立即指引接入方离开坏版本；
  严重时联系 npm support 撤回（unpublish 仅 72h 内且无依赖者时可行——**不要依赖撤回**，
  以 deprecate + 发修复版为第一手段）；
- **接入方层面**：回退到上一 patch/minor 版本即可回滚库行为（无持久化数据格式耦合；
  启用了 `schemaVersion` 的接入方回滚时存储版本高于库版本的兜底口径见：跳过恢复
  保持默认值并上报，不会注入坏数据）；
- 发布说明必须记录每个版本的回滚影响面。

## 废弃周期

- 废弃 API：源码标 `@deprecated` + 文档给出替代 + **开发期运行告警**（console.warn，
  生产静默）+ [API 稳定性分级](./API.md#api-稳定性分级)表移入 deprecated 档；
- 保留**至少一个 minor** 后移除；移除在主版本或 0.x 的显式破坏性变更中执行；
- `api:report --check` 快照变化即评审点：删除导出必须在 PR 里说明废弃期是否届满。

## 支持窗口

- 当前 minor 与上一 minor 获得修复；更早版本只处理安全漏洞；
- EOL 提前至少一个 minor 公告（CHANGELOG + Release Notes）；版本支持窗口与 EOL 口径见
  [docs/ISSUE-TRIAGE.md · 版本支持窗口与 EOL 公告](./ISSUE-TRIAGE.md#版本支持窗口与-eol-公告)；
- 每份 Release Notes 的「支持窗口」段为必填（见
  [Release Notes 模板](./RELEASE-NOTES-TEMPLATE.md#支持窗口)）；
- 响应时效与漏洞处理时限见 [SECURITY.md](../SECURITY.md)；
- 问题分级（阻断/严重/一般/建议）与首次响应/修复目标见
  [docs/ISSUE-TRIAGE.md · 分级与响应目标](./ISSUE-TRIAGE.md#分级与响应目标)。
