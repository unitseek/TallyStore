# 版本化文档

本目录按 **minor** 归档已发布版本的文档入口。当前版本由 [`current.json`](./current.json) 唯一标记
（发布时与 `package.json` 的 `version` 同步），CI 的 `scripts/check-docs-version.mjs` 校验两者一致、
当前版本目录存在、以及 [docs 索引](../README.md) 含 MIGRATION / RELEASE / TEAM-RULES 入口。

## 归档规则

- **旧版全文不复制进仓库**：以 Git tag `vX.Y.Z` 快照为唯一全文来源（tag 与发布一一对应，见
  [RELEASE](../RELEASE.md)）；版本目录页只维护「入口 + 与当前版的差异摘要」。
- 每个已发布 minor 建一个目录 `vX.Y/README.md`；至少保留当前与上一个 minor 的入口，更早版本仅保留 tag 快照。
- 发布负责人步骤：发版并打 tag（`git tag vX.Y.Z`）→ 更新 `current.json` → 新增/更新版本页 →
  在 `docs/README.md` 登记；CI 校验失败即阻断。
- tag 尚未创建时，版本页必须显式标注「待发布负责人创建 tag」，不得写成已可访问。

## 版本索引

| 版本         | 文档入口                           | 全文快照         | 状态    |
| ------------ | ---------------------------------- | ---------------- | ------- |
| v0.1（当前） | [v0.1/README.md](./v0.1/README.md) | Git tag `v0.1.0` | current |

> 说明：`v0.1.0` tag 已创建；[v0.1 版本页](./v0.1/README.md) 已指向该 tag 快照。
