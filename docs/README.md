# 文档索引

按意图选择入口。“用户文档”面向接入方，“工程与社区”面向贡献者与发布流程。

## 用户文档

| 文档                                | 一句话                                                   |
| ----------------------------------- | -------------------------------------------------------- |
| [项目 README](../README.md)         | 定位、安装、快速开始、能力地图、设计边界、环境要点与质量 |
| [GUIDE](./GUIDE.md)                 | 概念、完整用法与常见问题                                 |
| [API](./API.md)                     | 入口、签名与默认值                                       |
| [COMPATIBILITY](./COMPATIBILITY.md) | 支持矩阵、明确不支持的范围、渲染器说明与生产判定         |
| [PERFORMANCE](./PERFORMANCE.md)     | 使用侧成本模型与可调开关，以及如何用基准测数据           |
| [RECIPES](./RECIPES.md)             | 可直接复制的常见场景配方                                 |
| [ARCHITECTURE](./ARCHITECTURE.md)   | 分层、依赖方向、数据流与设计取舍                         |
| [MIGRATION](./MIGRATION.md)         | 从 globalData 迁移、分包边界检查与新旧共存示例           |

## 工程与社区

| 文档                                                  | 一句话                                   |
| ----------------------------------------------------- | ---------------------------------------- |
| [CONTRIBUTING](../CONTRIBUTING.md)                    | 开发环境、测试、基准、示例与发布流程     |
| [CHANGELOG](../CHANGELOG.md)                          | 版本变更记录                             |
| [SECURITY](../SECURITY.md)                            | 支持版本与漏洞报告通道                   |
| [TEAM-RULES](./TEAM-RULES.md)                         | 团队规范、命名/模块边界与 CR 清单        |
| [RELEASE](./RELEASE.md)                               | 版本策略、发布检查清单与回滚             |
| [RELEASE-NOTES-TEMPLATE](./RELEASE-NOTES-TEMPLATE.md) | 发布说明四要素模板                       |
| [ISSUE-TRIAGE](./ISSUE-TRIAGE.md)                     | 问题分级、响应时效、支持窗口与 EOL       |
| [双渲染器冒烟](./quality/dual-renderer-smoke.md)      | DevTools/真机 × WebView/Skyline 记录模板 |
| [版本化文档](./versions/README.md)                    | 按 minor 归档的文档入口与旧版快照规则    |
| [CODE_OF_CONDUCT](../CODE_OF_CONDUCT.md)              | 社区行为准则                             |

## 示例、基准与检索

| 位置                                               | 一句话                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| [examples/miniprogram](../examples/miniprogram)    | 可直接用微信开发者工具打开的原生 demo（App / Page / Component + 插件） |
| [bench/README.md](../bench/README.md)              | 仓库内部性能基准：只测 `dist-weapp`，不发布、不进 CI                   |
| [skills/tallystore](../skills/tallystore/SKILL.md) | 面向 AI 助手的检索层：使用规则、常见坑与文件指针                       |
