# 测试约定

- 只测公开行为与文档承诺的契约；不复制实现细节。
- 一个文件一个主题；describe 用中文短句，it 描述「输入 → 期望」。
- 宿主 mock 用 `tests/utils/host.ts`；wx 全局在每个用例后由 `tests/setup.ts` 清掉。
- 异步：优先 `await flush()`（delay 0），不要 sleep；防抖/超时用 `jest.useFakeTimers()`。
- 生产模式分支：`process.env.NODE_ENV='production'` + `jest.resetModules()` + 动态 `await import(...)`，用完恢复并再次 resetModules。
- 不写 `.only`、不提交 `console.log`、不改 `src/`、不改 jest 配置。
- 覆盖率：行/语句/函数 ≥98%，分支 ≥95%（按分配到的文件集合统计）。

## 分层

- **单元**：`tests/unit/**`，从 `src/` 加载。
- **契约**：`tests/contract/**`，从**发布产物 `dist-weapp/`** 加载（临时目录 + `{"type":"commonjs"}`，
  与微信「构建 npm」形态一致）；断言入口、导出面与核心行为。需先 `pnpm run build`，
  未构建时自动 skip（CI 把 Build 排在 Test 前，保证走真实产物）。
- **类型**：`tests/types/*.test-d.ts`，不进 jest（`*.test-d.ts` 不匹配 testMatch），由
  `pnpm run typecheck:tests` 承载；正向断言用精确类型赋值，负向断言用 `@ts-expect-error`
  （类型退化时 tsc 以 Unused directive 报错，CI 阻断）。

常用命令（在仓库根执行；退出码在未达标前可能为 1，只看表格）：

```
node node_modules/jest/bin/jest.js tests/unit/<你的目录> --coverage \
  --collectCoverageFrom="src/.../**/*.ts" --coverageThreshold='{}'
```
