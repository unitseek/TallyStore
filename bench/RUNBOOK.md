# 性能基准发布 RUNBOOK

固定硬件 / 受控发布任务上执行**入库基线对比**的操作手册。目标：让「性能回退阻断发布」可复现、
可审计、可归档；**避免把共享 CI 或开发机的抖动当成代码回退**。

> 工具与基线说明见 [bench/README.md](./README.md)；性能成本模型见 [docs/PERFORMANCE.md](../docs/PERFORMANCE.md)；
> 发布门禁与回滚见 [docs/RELEASE.md](../docs/RELEASE.md)。基准**不进 CI**：机器噪声大，只做同机相对比较。

## 适用与前提

- 在**固定硬件**（同一台发布机 / 受控 runner）上执行；换机器必须重新 `bench:save` 生成该机基线。
- 测的是**发布产物 `dist-weapp`**，因此必须先 `pnpm run build`（改完 src 不构建等于测旧字节）。
- 基准只用于**同机、同构建**的相对比较；Node 的 V8 与小程序运行时不同，**Node 数字不是真机数字**。

## 环境记录（与报告一起归档）

执行前记录以下字段（`scripts/bench-report.mjs` 会自动写入报告 meta）：

| 字段           | 来源                                          |
| -------------- | --------------------------------------------- |
| CPU / 核数     | 报告 meta.environment.cpuModel / cpuCount     |
| OS / 架构      | 报告 meta.environment.platform / arch         |
| Node 版本      | `node -v` / 报告 meta.node                    |
| commit         | `git rev-parse HEAD`（报告 meta.commit）      |
| 基线文件与容差 | 命令行参数 / 报告 meta.command                |
| 命令           | 实际执行的完整命令                            |
| 时间           | 报告 meta.startedAt / finishedAt / durationMs |

## 标准步骤

```bash
# 0) 前置：固定硬件、工作树干净、Node ≥ 22
pnpm install --frozen-lockfile
node -v && git rev-parse HEAD

# 1) 构建发布产物（必须；基准测 dist-weapp）
pnpm run build

# 2) 对比入库基线并生成可归档报告（默认容差 25%）
node scripts/bench-report.mjs --compare bench/baseline.json --tolerance=25

# 3) 若报告出现 regression：完整重跑一次（工具内部已对回退 case 自动复测最多 2 轮）
#    —— 复测仍超差才算阻断；单次抖动不算结论
node scripts/bench-report.mjs --compare bench/baseline.json --tolerance=25

# 4) 归档：bench/report.json（脚本默认输出；本地生成、不提交）+ 体积 + 覆盖率
pnpm run size --json > bench-size.json
```

- 报告默认写入 `bench/report.json`（可用 `--out=<path>` 改路径），脚本保留 `bench/run.mjs` 的退出码：
  **0 = 未超容差；1 = 回退/失败；2 = 配置/基线/写盘错误**。
- 报告含 `meta`（环境/commit/命令/时间/退出码）、`summary`（cases/failures/regressions/added/missing）、
  `regressions` 明细与完整 bench payload（cases 含 samples）。

## 判定口径（必须遵守）

- **容差默认 25%**；只比较同名 case 的稳健 ns/op（低半区中位数）。
- **复测后仍超差才阻断**：首次回退先复测（工具自动，最多 2 轮）；发布负责人可按需再完整跑一次，
  两次仍复现才认定回退并阻断发布。
- `missing` / `added` **不是回退**：新增/重命名 case 会出现 missing/added 提示，需要参考机重跑
  `bench:save` 重锚基线后再比较（见下节）。
- 阻断后的处置：定位归因（case → 代码路径）→ 修复或经评审重新锚定基线，并在 CHANGELOG/发布说明记录
  「特性成本/优化收益与重锚原因」；不得静默放宽容差。

## 新增/重命名 case 的重锚流程

1. 新增或重命名 case 后，首次 `bench:compare` 会显示 `added`（旧名 `missing`）——这是**提示不是失败**；
2. 在**固定硬件**上 `pnpm run bench:save`（写入 `bench/baseline.json`，本地产物）或按流程更新
   `bench/baseline.json`（入库基线，需要发布负责人/评审）；
3. 重跑 `bench:compare` 确认无回退，并把基线变化与归因写进 CHANGELOG / 发布说明；
4. **禁止手工改 `bench/baseline.json` 的数值**来「通过」门禁；数值只能由基准运行产生。

> 当前入库基线尚未包含 新增的 Skyline 合并 case
> （`page: skyline same-tick setState x2 -> 1 setData`），下次参考机 `bench:save` 时纳入并重锚。

## 归档清单（Release artifact）

- `bench/report.json`（本 RUNBOOK 的标准输出）
- `bench-size.json`（`pnpm run size --json`，raw/gzip 体积）
- 覆盖率与核心模块 manifest（`coverage/coverage-summary.json`、`coverage/core-manifest.json`，见 CI artifact）
- 环境记录表（本文件「环境记录」字段）
- 结论：通过/阻断 + 回退 case 明细 + 归因与处置

**基线、体积、覆盖率三者一起归档**：只留性能报告会在体积/覆盖变化时失去解释力。发布负责人按
[docs/RELEASE.md](../docs/RELEASE.md) 的检查清单归档并在 Release Notes 附「性能基线对比」摘要。

## 禁止事项

- 禁止把共享 CI / 开发机 / 虚拟机的抖动当作发布结论（不进 CI 门禁正是这个原因）；
- 禁止跨机器比较绝对值；换机器必须重建基线；
- 禁止把 Node 基准数字当作微信真机/开发者工具数字对外宣称；
- 禁止为通过门禁而手改基线、放宽容差或删除 case；变更必须附归因与评审。
