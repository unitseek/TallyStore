# v0.1 文档入口

- 版本：`0.1.0`（**当前版本**，唯一标记见 [`../current.json`](../current.json)）
- 对应 Git tag：**`v0.1.0`**
- 全文快照：旧版文档不复制进仓库，**以 Git tag 快照为唯一全文来源**。tag 创建后可通过
  https://github.com/unitseek/tallystore/tree/v0.1.0/docs 访问该版本的完整文档。
  下列入口指向当前主干；如主干已先行演进，以 tag 快照为准。

## 文档入口

| 文档                                    | 说明                        |
| --------------------------------------- | --------------------------- |
| [GUIDE](../../GUIDE.md)                 | 概念、完整用法与常见问题    |
| [API](../../API.md)                     | 入口、签名与默认值          |
| [COMPATIBILITY](../../COMPATIBILITY.md) | 支持矩阵、渲染器与生产判定  |
| [PERFORMANCE](../../PERFORMANCE.md)     | 使用侧成本模型与可调开关    |
| [RECIPES](../../RECIPES.md)             | 可直接复制的常见场景配方    |
| [ARCHITECTURE](../../ARCHITECTURE.md)   | 分层、依赖方向与设计取舍    |
| [MIGRATION](../../MIGRATION.md)         | globalData → Store 迁移指南 |

## 与本目录的关系

- 归档规则与当前版本标记见 [版本索引](../README.md)；
- 发布流程、tag 与回滚见 [RELEASE](../../RELEASE.md)；
- 版本索引与 current 标记见 [版本索引](../README.md)；CI 的 `check-docs-version` 持续校验
  `current.json` 与 `package.json` 的版本一致性。
