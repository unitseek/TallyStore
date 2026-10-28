# Release Notes 模板（vX.Y.Z）

> 用法：发布时复制本文件为 `.release/release-notes.md`，按四要素填写后作为 GitHub Release 正文。
> `node scripts/check-release-metadata.mjs --notes <file>` 会校验四个必需段标题齐全；
> 发布自动化 workflow 会把 release-manifest / SBOM / 体积 / 覆盖率摘要追加到正文末尾。

## 变更

- 新增：
- 修复：
- 破坏性变更（含迁移指引链接）：

## 迁移

- 从 vX.Y.Z 升级需要的代码 / 配置改动（可运行示例优先）：
- 对应 [docs/MIGRATION.md](./MIGRATION.md) 小节：

## 已知问题

- 已知缺陷与规避方式：
- 兼容矩阵缺口（[COMPATIBILITY](./COMPATIBILITY.md)）：
- 依赖 / 许可证变化（引用 release-manifest.licenseChanges）：

## 支持窗口

> 本段为**必填**：每份 Release Notes 必须写明支持范围与 EOL 计划；不适用时显式写「不适用」。
> 分级与响应目标见 [docs/ISSUE-TRIAGE.md](./ISSUE-TRIAGE.md)；发布流程见
> [docs/RELEASE.md](./RELEASE.md)。

- 支持范围（必填）：当前 minor 与上一 minor 获得修复；更早版本仅处理高危安全漏洞。
- EOL 公告（必填）：提前至少一个 minor 在 CHANGELOG 与本 Release Notes 公告，给出下一版本计划与
  最后支持版本。
- 回滚影响面（必填）：npm deprecate / 持久化 schemaVersion 兼容说明。
