#!/usr/bin/env node
/**
 * 核心模块覆盖率清单（ 验收 7 / FR-DECISIONS ）
 *
 * 输入：coverage/coverage-summary.json（jest json-summary reporter）
 *       coverage/coverage-final.json（jest json reporter，可选；用于把缺口定位到行）
 *       scripts/core-coverage-exceptions.json（缺口例外清单：file/line/metric/reason/owner）
 * 输出：coverage/core-manifest.json（gitignored；CI 作为 release artifact 归档）
 *
 * 口径：
 * - 核心模块（Store/StateProxy/Notifier/connect/visibility/with-store/utils）目标四维 = 100%；
 * - 达不到 100% 的指标，每条未覆盖语句/分支/函数必须在例外清单登记原因与 owner，否则退出码 1；
 * - 全局阈值仍由 jest.config.js 维持 98%（：不把全局阈值改为 100%）。
 *
 * 用法：pnpm run coverage:manifest（需先跑 test:ci 生成 coverage/coverage-summary.json）
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const coverageDir = path.join(repoRoot, 'coverage')
const summaryPath = path.join(coverageDir, 'coverage-summary.json')
const finalPath = path.join(coverageDir, 'coverage-final.json')
const exceptionsPath = path.join(here, 'core-coverage-exceptions.json')
const outputPath = path.join(coverageDir, 'core-manifest.json')

const METRICS = ['statements', 'branches', 'functions', 'lines']
const EXCEPTION_KINDS = ['unreachable', 'defensive', 'coverage-gap']
const FRESHNESS_TOLERANCE_MS = 60 * 1000

const CORE_MODULES = [
  { name: 'Store', file: 'src/core/store/Store.ts' },
  { name: 'StateProxy', file: 'src/core/store/StateProxy.ts' },
  { name: 'Notifier', file: 'src/core/store/StoreNotifier.ts' },
  { name: 'connect', file: 'src/integrations/connect.ts' },
  { name: 'visibility', file: 'src/integrations/visibility.ts' },
  { name: 'with-store', file: 'src/integrations/with-store.ts' },
  { name: 'utils', file: 'src/integrations/utils.ts' },
]

const normalize = (value) => value.replace(/\\/g, '/')
const toRepoRelative = (absolute) => normalize(path.relative(repoRoot, absolute))

function fail(message) {
  console.error('[coverage-manifest] ' + message)
  process.exit(1)
}

function readJson(file, label) {
  if (!fs.existsSync(file)) {
    fail('缺少 ' + label + '：' + path.relative(repoRoot, file) + '（请先运行 pnpm run test:ci）')
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(label + ' 不是合法 JSON：' + error.message)
  }
}

function readGitHead() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function findSummaryEntry(summary, moduleFile) {
  const target = '/' + normalize(moduleFile)
  for (const [key, value] of Object.entries(summary)) {
    if (key === 'total') continue
    if (normalize(key).endsWith(target)) return value
  }
  return undefined
}

/** 从 coverage-final.json 建立「仓库相对路径 → 各指标未覆盖行号集合」 */
function loadUncoveredLines(finalCoverage) {
  const table = new Map()
  for (const [absolutePath, data] of Object.entries(finalCoverage)) {
    const entry = { statements: new Set(), branches: new Set(), functions: new Set(), lines: new Set() }
    for (const [id, count] of Object.entries(data.s ?? {})) {
      if (count !== 0) continue
      const line = data.statementMap?.[id]?.start?.line
      if (typeof line === 'number') {
        entry.statements.add(line)
        entry.lines.add(line)
      }
    }
    for (const [id, count] of Object.entries(data.f ?? {})) {
      if (count !== 0) continue
      const line = data.fnMap?.[id]?.decl?.start?.line
      if (typeof line === 'number') entry.functions.add(line)
    }
    for (const [id, counts] of Object.entries(data.b ?? {})) {
      if (!Array.isArray(counts) || !counts.some((count) => count === 0)) continue
      const line = data.branchMap?.[id]?.loc?.start?.line
      if (typeof line === 'number') entry.branches.add(line)
    }
    table.set(toRepoRelative(absolutePath), entry)
  }
  return table
}

function validateExceptions(exceptions) {
  const problems = []
  const seen = new Set()
  exceptions.forEach((entry, index) => {
    const label = 'exceptions[' + index + ']'
    if (typeof entry.file !== 'string' || !entry.file.startsWith('src/')) problems.push(label + ': file 必须是仓库相对 src/ 路径')
    if (!Number.isInteger(entry.line) || entry.line < 1) problems.push(label + ': line 必须是从 1 开始的整数')
    if (!METRICS.includes(entry.metric)) problems.push(label + ': metric 必须是 ' + METRICS.join('|'))
    if (!EXCEPTION_KINDS.includes(entry.kind)) problems.push(label + ': kind 必须是 ' + EXCEPTION_KINDS.join('|'))
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') problems.push(label + ': reason 不能为空')
    if (typeof entry.owner !== 'string' || entry.owner.trim() === '') problems.push(label + ': owner 不能为空')
    const key = [entry.file, entry.line, entry.metric].join('|')
    if (seen.has(key)) problems.push(label + ': 重复登记 ' + key)
    seen.add(key)
  })
  if (problems.length > 0) fail('例外清单不合法：\n  - ' + problems.join('\n  - '))
  return exceptions
}

const summary = readJson(summaryPath, 'coverage/coverage-summary.json')
const exceptionsFile = readJson(exceptionsPath, 'scripts/core-coverage-exceptions.json')
const exceptions = validateExceptions(Array.isArray(exceptionsFile.exceptions) ? exceptionsFile.exceptions : [])

const finalFresh = fs.existsSync(finalPath) && fs.statSync(finalPath).mtimeMs >= fs.statSync(summaryPath).mtimeMs - FRESHNESS_TOLERANCE_MS
const uncoveredTable = finalFresh ? loadUncoveredLines(readJson(finalPath, 'coverage/coverage-final.json')) : null

const coreModules = []
const problems = []
const coverageGaps = []
let passCount = 0
let exceptionCount = 0
let failCount = 0

for (const module of CORE_MODULES) {
  const summaryEntry = findSummaryEntry(summary, module.file)
  if (summaryEntry === undefined) {
    coreModules.push({
      name: module.name,
      file: module.file,
      status: 'fail',
      metrics: null,
      deficits: [],
      exceptions: [],
      unmatched: [{ reason: 'coverage-summary 未包含该文件' }],
    })
    problems.push(module.name + '：coverage-summary 未包含 ' + module.file + '（是否被 collectCoverageFrom 排除？）')
    failCount += 1
    continue
  }

  const metrics = {}
  for (const metric of METRICS) {
    const raw = summaryEntry[metric] ?? { covered: 0, total: 0, pct: 100 }
    metrics[metric] = { covered: raw.covered, total: raw.total, pct: raw.pct }
  }

  const deficits = METRICS.filter((metric) => metrics[metric].total > 0 && metrics[metric].covered < metrics[metric].total)
  const matchedExceptions = []
  const unmatched = []

  for (const metric of deficits) {
    // statements 与 lines 共享同一批行号缺口：登记一次 statements 即可同时覆盖 lines 指标
    const fileExceptions = exceptions.filter(
      (entry) => entry.file === module.file && (entry.metric === metric || (metric === 'lines' && entry.metric === 'statements')),
    )
    const lines = uncoveredTable === null ? null : [...((uncoveredTable.get(module.file) ?? {})[metric] ?? [])].sort((a, b) => a - b)
    if (lines === null) {
      // CI 未产出 coverage-final.json 时只能做文件级登记校验（行号无法验证）
      if (fileExceptions.length === 0) {
        unmatched.push({ metric, reason: '指标未达 100% 且无任何例外登记（且缺少 coverage-final.json，无法行级定位）' })
      } else {
        for (const entry of fileExceptions) matchedExceptions.push({ metric, line: entry.line, kind: entry.kind, owner: entry.owner, lineVerified: false })
      }
      continue
    }
    if (lines.length === 0) {
      if (fileExceptions.length === 0) unmatched.push({ metric, reason: '汇总显示缺口但行级明细为空且无例外登记' })
      else for (const entry of fileExceptions) matchedExceptions.push({ metric, line: entry.line, kind: entry.kind, owner: entry.owner, lineVerified: false })
      continue
    }
    for (const line of lines) {
      const hit = fileExceptions.find((entry) => entry.line === line)
      if (hit === undefined) {
        unmatched.push({ metric, line })
      } else {
        matchedExceptions.push({ metric, line, kind: hit.kind, owner: hit.owner, reason: hit.reason, lineVerified: true })
      }
    }
  }

  let status
  if (deficits.length === 0) {
    status = 'pass'
    passCount += 1
  } else if (unmatched.length === 0) {
    status = 'exception'
    exceptionCount += 1
  } else {
    status = 'fail'
    failCount += 1
    for (const item of unmatched) {
      problems.push(
        module.name +
          ' / ' +
          module.file +
          (item.line === undefined ? '' : ':' + item.line) +
          (item.metric ? ' (' + item.metric + ')' : '') +
          '：未覆盖且未登记例外' +
          (item.reason ? ' — ' + item.reason : ''),
      )
    }
  }
  for (const entry of matchedExceptions) {
    if (entry.kind === 'coverage-gap')
      coverageGaps.push({ module: module.name, file: module.file, line: entry.line, metric: entry.metric, owner: entry.owner, reason: entry.reason })
  }

  coreModules.push({ name: module.name, file: module.file, status, metrics, deficits, exceptions: matchedExceptions, unmatched })
}

const ok = problems.length === 0
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  gitHead: readGitHead(),
  policy: {
    decision: 'FR-DECISIONS：核心模块 100% 目标 + 例外清单归档',
    target: 'statements/lines/functions/branches = 100% 或逐条例外登记',
    globalThreshold: 'CI 全局四维 98%（jest.config.js，不改为 100%）',
    exceptionsFile: 'scripts/core-coverage-exceptions.json',
    lineLevelVerified: finalFresh,
  },
  totals: {
    modules: coreModules.length,
    pass: passCount,
    exception: exceptionCount,
    fail: failCount,
    exceptions: exceptions.length,
    coverageGapExceptions: coverageGaps.length,
  },
  coreModules,
  coverageGapDebt: coverageGaps,
  ok,
}

fs.mkdirSync(coverageDir, { recursive: true })
fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n')

// 人类可读摘要（CI 日志与 release 归档均可引用）
console.log('[coverage-manifest] 核心模块覆盖率（目标四维 100%，例外见 scripts/core-coverage-exceptions.json）')
for (const module of coreModules) {
  const metricText = METRICS.map((metric) => metric.slice(0, 4) + '=' + (module.metrics === null ? 'n/a' : module.metrics[metric].pct + '%')).join(' ')
  console.log('  ' + (module.status === 'pass' ? 'PASS' : module.status === 'exception' ? 'EXCP' : 'FAIL') + '  ' + module.name.padEnd(11) + ' ' + metricText)
}
console.log(
  '[coverage-manifest] modules=' +
    coreModules.length +
    ' pass=' +
    passCount +
    ' exception=' +
    exceptionCount +
    ' fail=' +
    failCount +
    ' exceptions=' +
    exceptions.length +
    '（coverage-gap 待补=' +
    coverageGaps.length +
    '）',
)
console.log(
  '[coverage-manifest] 输出：' + path.relative(repoRoot, outputPath) + (finalFresh ? '（缺口已行级校验）' : '（缺 coverage-final.json，例外仅文件级校验）'),
)

if (!ok) {
  console.error('[coverage-manifest] 存在未登记覆盖率缺口：')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
