#!/usr/bin/env node
/**
 *  基准报告归档：跑 `bench/run.mjs --compare ... --json`，把结构化结果写到 bench/report.json。
 *
 * 为什么单独一层：
 * - 发布 RUNBOOK 需要一份**可归档**的报告（meta/regressions 可直接进 release artifact），
 *   而 `run.mjs --json` 是给终端看的原始 payload；
 * - 报告补充 command/commit/起止时间/退出码等审计字段，并**原样保留 bench 的退出码**
 *   （0 未超容差 / 1 回退 / 2 配置或基线错误），不会把失败吞成 0。
 *
 * 用法（在仓库根，先 pnpm run build）：
 *   node scripts/bench-report.mjs --compare bench/baseline.json --tolerance=25
 *   node scripts/bench-report.mjs --compare bench/baseline.json --out=bench/report.json
 *
 * 说明：`bench/report.json` 是本地/发布产物的生成文件，不提交仓库；RUNBOOK 见 bench/RUNBOOK.md。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const benchRun = path.join(repoRoot, 'bench', 'run.mjs')

/** 解析并剥离脚本自身参数（其余原样透传给 bench/run.mjs） */
function parseArgs(argv) {
  let out = 'bench/report.json'
  const forwarded = []
  for (const arg of argv) {
    if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length)
      continue
    }
    forwarded.push(arg)
  }
  return { out, forwarded }
}

const { out, forwarded } = parseArgs(process.argv.slice(2))
const args = [...forwarded]
if (!args.includes('--json')) {
  args.push('--json')
}

/** git commit（贡献构建可追溯性；非 git 环境回退环境变量/unknown） */
function resolveCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch {
    return process.env.GITHUB_SHA || 'unknown'
  }
}

const startedAt = new Date().toISOString()
const startedMs = Date.now()
const child = spawnSync(process.execPath, [benchRun, ...args], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
const finishedAt = new Date().toISOString()
const durationMs = Date.now() - startedMs
const exitCode = typeof child.status === 'number' ? child.status : 1
const stdout = (child.stdout ?? '').trim()
const stderr = (child.stderr ?? '').trim()

let payload = null
let parseError = null
if (stdout.length > 0) {
  try {
    payload = JSON.parse(stdout)
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error)
  }
}

const comparison = payload && payload.comparison ? payload.comparison : null
const failures = payload && Array.isArray(payload.failures) ? payload.failures : []
const cases = payload && Array.isArray(payload.cases) ? payload.cases : []
const report = {
  schemaVersion: 1,
  generatedAt: finishedAt,
  meta: {
    tool: 'scripts/bench-report.mjs',
    command: 'node scripts/bench-report.mjs ' + process.argv.slice(2).join(' '),
    forwardedArgs: args,
    cwd: repoRoot,
    commit: resolveCommit(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    startedAt,
    finishedAt,
    durationMs,
    exitCode,
    status: exitCode === 0 ? 'pass' : exitCode === 2 ? 'error' : 'regressions-or-failures',
    stdoutBytes: Buffer.byteLength(stdout),
    stderr: stderr.length > 0 ? stderr.slice(0, 8000) : undefined,
    // CPU / OS / 目标样本 / 轮数等来自 bench 自身 meta，便于按 RUNBOOK 的「环境记录」直接归档
    environment: payload && payload.meta ? payload.meta : undefined,
  },
  summary: {
    cases: cases.length,
    failures: failures.length,
    added: comparison && Array.isArray(comparison.added) ? comparison.added.length : 0,
    missing: comparison && Array.isArray(comparison.missing) ? comparison.missing.length : 0,
    invalid: comparison && Array.isArray(comparison.invalid) ? comparison.invalid.length : 0,
    regressions: comparison && Array.isArray(comparison.regressions) ? comparison.regressions.length : 0,
    normalized: comparison ? Boolean(comparison.normalized) : false,
    probeNsPerOpUsed: comparison ? comparison.probeNsPerOpUsed : undefined,
    formatVersion: payload && payload.meta ? payload.meta.formatVersion : undefined,
  },
  regressions: comparison && Array.isArray(comparison.regressions) ? comparison.regressions : [],
  failures,
  bench: payload,
}
if (parseError !== null) {
  report.parseError = parseError
  report.stdoutExcerpt = stdout.slice(0, 4000)
}

const outPath = path.isAbsolute(out) ? out : path.join(repoRoot, out)
try {
  mkdirSync(path.dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
} catch (error) {
  console.error('[bench-report] 写入报告失败：' + (error instanceof Error ? error.message : String(error)))
  console.error('[bench-report] 基准退出码=' + exitCode + '（报告未写出，退出码按写盘错误处理）')
  process.exit(2)
}

console.log(
  '[bench-report] 报告已写入 ' +
    path.relative(repoRoot, outPath) +
    '：exit=' +
    exitCode +
    '，cases=' +
    report.summary.cases +
    '，regressions=' +
    report.summary.regressions +
    '，added=' +
    report.summary.added +
    '，missing=' +
    report.summary.missing,
)
if (parseError !== null) {
  console.error('[bench-report] 警告：bench 输出不是合法 JSON（' + parseError + '），报告已保留 stdout 摘要')
}
process.exit(exitCode)
