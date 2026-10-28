# Pull Request

## 改动内容

<!-- 说明改了什么、为什么这样改。 -->

## 关联 Issue

<!-- 例如 Closes #123；没有就写“无”。 -->

## 自检清单

- [ ] `pnpm run typecheck` 通过
- [ ] `pnpm run typecheck:tests` 通过
- [ ] `pnpm run format:check` 通过
- [ ] `pnpm run test:ci` 通过（含覆盖率）
- [ ] 改动运行时代码时：`pnpm run build` 与 `pnpm run e2e` 通过
- [ ] 改动公开 API、默认值、钩子或错误码时：已同步 `docs/API.md`
- [ ] 涉及 Store 命名 / 模块边界 / 持久化白名单时：已按 [TEAM-RULES 的 Code Review 清单](../docs/TEAM-RULES.md#code-review-清单) 逐条核对
- [ ] 未提交调试日志、`.only` 或与本次改动无关的文件

## 破坏性变更

<!-- 有则说明影响的 API 与迁移方式；没有就写“无”。 -->

## 备注

<!-- 需要 reviewer 特别关注的点、后续工作等。 -->
