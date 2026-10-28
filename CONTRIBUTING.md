# 参与贡献

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。提交 Issue 请使用
[模板](./.github/ISSUE_TEMPLATE) 并填写环境信息；安全漏洞请走私密渠道（见
[SECURITY.md](./SECURITY.md)）。

## 环境

| 要求       | 版本             |
| ---------- | ---------------- |
| Node       | ≥ 22             |
| pnpm       | 12.x             |
| TypeScript | 5.4+（仅开发期） |

```bash
pnpm install
pnpm run typecheck # 源码类型检查
pnpm run typecheck:tests # 测试代码类型检查
pnpm test # jest 单元/行为测试
pnpm run test:coverage # 带覆盖率（阈值见 jest.config.js）
pnpm run test:ci # CI 用：--ci --coverage --maxWorkers=2
pnpm run build # 产出 dist-weapp/ 与 types/
pnpm run examples:sync # 把 dist-weapp 同步进 demo 的 miniprogram_npm
pnpm run e2e # 宿主模拟 e2e（CI 运行）
pnpm run e2e:devtools # 可选：开发者工具 / 真机 e2e（缺依赖时 SKIP）
pnpm run bench # 性能基准（全部 suite；不进 CI）
pnpm run bench:quick # 快速基准
pnpm run bench:save # 保存本机基线
pnpm run bench:compare # 与基线比较（默认容差 25%）
pnpm run size # 产物字节统计（--json 为机器可读）
pnpm run check:publish # 发布面校验：运行时入口 / 类型声明 / 无 dist/
pnpm run format # prettier --write
pnpm run format:check # prettier --check
```

测试分两层：

- `tests/unit/**`：jest 行为测试，覆盖 Store、通知中枢、两个代理、小程序集成与插件。
  覆盖率阈值：lines / statements / functions / branches 均 ≥ 98%（`jest.config.js`）。
- `examples/miniprogram/e2e/`：宿主模拟 e2e（CI 必跑）与可选的开发者工具 e2e。

性能基准在 `bench/`（仓库内工具，不发布，`files` 白名单天然排除）：

- 只测 `dist-weapp` 发布产物，改完 src 先 `pnpm run build`；
- 默认 3 轮取中位数并做机器漂移归一；`--quick` 用于日常；
- `bench:save` / `bench:compare` 做同机回归（默认容差 25%），**不进 CI**（噪声大）；
- 新增 case 见 `bench/README.md`。

## 示例与 e2e

- `examples/miniprogram/`：原生小程序 demo，已内置预构建 `miniprogram_npm`，可直接用微信开发者工具打开。
  修改 `src/` 后执行 `pnpm run build && pnpm run examples:sync` 并提交预构建产物；不要点「构建 npm」——
  它可能重算 `miniprogram_npm`，重跑 sync 即可恢复。
- `pnpm run e2e`：宿主模拟 e2e。Node 加载 `dist-weapp`、伪造 `wx` 与 App/Page/Component
  生命周期，覆盖映射、action、退订与持久化往返；不依赖开发者工具，CI 必跑。
- `pnpm run e2e:devtools`：真实开发者工具 / 真机 e2e，需要 `miniprogram-automator` 与
  CLI 路径（`MINIPROGRAM_CLI_PATH`）；缺依赖时打印 SKIP 并退出 0，适合发版前人工跑。
- demo 的持久化配置了 100ms 防抖：验证恢复前先等过防抖窗口。

## 代码约定

- **源码是纯 ESM**：相对导入带 `.js` 扩展名（TS 的 `NodeNext` 语义）
- **零运行时依赖**：不引第三方包，也不用 `tslib`
- **依赖方向**：`types ← core ← {integrations, plugins}`；内部模块不反向 import，反向依赖只允许在入口装配
- **注释写「为什么」**：不变量、反直觉之处、被否掉的方案；不复述类型已经说清的东西
- **公开面最小**：新增导出前先确认它必须被宿主直接使用；内部函数留在实现处私有

## 文档约定

| 文件                                 | 写什么                                             |
| ------------------------------------ | -------------------------------------------------- |
| `README.md`                          | 定位、安装、快速开始、能力地图、体积模型、环境要点 |
| `docs/README.md`                     | 文档索引与阅读路径                                 |
| `docs/GUIDE.md`                      | 概念与用法                                         |
| `docs/API.md`                        | 入口、签名与默认值                                 |
| `docs/ARCHITECTURE.md`               | 分层、目录职责、关键取舍                           |
| `docs/COMPATIBILITY.md`              | 支持矩阵、不支持范围、渲染器与生产判定             |
| `docs/PERFORMANCE.md`                | 使用侧成本模型与开关                               |
| `docs/RECIPES.md`                    | 可复制配方                                         |
| `SECURITY.md` / `CODE_OF_CONDUCT.md` | 安全报告与社区准则                                 |
| `skills/tallystore/`                 | 面向 AI 助手的检索层：规则、常见坑、文件指针       |

文档里只能出现真实存在的导出与入口；示例中的名字必须与 `types/**/*.d.ts` 一致。

`tests/unit/docs.test.ts` 会检查：相对链接与锚点可解析、已删除能力不再出现、
Store 公开成员与入口运行时导出都在 `docs/API.md` 登记、代码围栏成对。

## 发布

分支模型：`develop` 做日常集成，`main` 只放发布提交。

1. 在 `develop` 确认 CI 全绿、工作树干净
2. 改 `package.json` 的 `version`，同步 README / SECURITY / `skills/tallystore/SKILL.md` 的版本描述
3. 在 `CHANGELOG.md` 顶部加新节
4. 合并 `develop` → `main`（发布提交只进 main）
5. 在 `main` 执行 `pnpm run typecheck && pnpm run typecheck:tests && pnpm run build && pnpm run test:ci && pnpm run check:publish && pnpm run check:boundary examples/miniprogram && pnpm run size:gate && pnpm run check:repro && pnpm run api:report -- --check && pnpm run check:privacy`
6. `git tag vX.Y.Z && git push origin main --tags`
7. `pnpm publish`：`publishConfig.access` 为 public，`prepublishOnly` 会重跑 typecheck / typecheck:tests / test:ci / build / check:publish / check:boundary / size:gate / check:repro / api:report --check / check:privacy

## 版本政策

`0.x` 期间次版本号可能含破坏性变更，会在 `CHANGELOG` 中逐条列出；
`1.0.0` 起遵循语义化版本。
