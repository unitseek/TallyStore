#!/usr/bin/env node
/**
 * 双渲染器冒烟记录（ 验收 5 / G3 发布前人工门禁的 CI 模拟证据）
 *
 * 做什么：
 * - 复用既有 examples/miniprogram/e2e/host-smoke.mjs（在 Node 里加载 dist-weapp 真实产物的宿主模拟）；
 * - host-smoke 单次运行内同时覆盖 WebView（默认 schedule）与 Skyline（renderer='skyline' 合并）两类场景，
 *   本脚本把输出按场景标签拆成 WebView / Skyline 两组结果；
 * - 结果写入 coverage/dual-renderer-smoke.json（gitignored），供 release artifact 归档。
 *
 * 边界（不伪造记录）：
 * - 本脚本只能给出 Node 宿主模拟结果，**不能替代微信开发者工具/真机的真实执行**；
 *   因此 JSON 的 combinations 四组（DevTools/真机 × WebView/Skyline）一律标 status='pending'，
 *   真实结果由发布负责人按 docs/quality/dual-renderer-smoke.md 补录，不得把模拟结果填成真实结果。
 *
 * 用法：pnpm run smoke:dual-renderer（需先 pnpm run build 生成 dist-weapp）
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const coverageDir = path.join(repoRoot, 'coverage')
const outputPath = path.join(coverageDir, 'dual-renderer-smoke.json')
const hostSmokePath = path.join(repoRoot, 'examples/miniprogram/e2e/host-smoke.mjs')
const distEntry = path.join(repoRoot, 'dist-weapp/index.js')

function readGitHead() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function parseChecks(stdout) {
  const checks = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(PASS|FAIL) (.+?)(?: — (.*))?$/.exec(line.trim())
    if (match === null) continue
    checks.push({ status: match[1] === 'PASS' ? 'pass' : 'fail', label: match[2], detail: match[3] ?? null })
  }
  return checks
}

function summarize(checks) {
  const passed = checks.filter((check) => check.status === 'pass').length
  const failed = checks.filter((check) => check.status === 'fail').length
  return { total: checks.length, passed, failed, ok: failed === 0, checks }
}

const combinations = [
  {
    device: 'WeChat DevTools',
    renderer: 'WebView',
    command: 'node examples/miniprogram/e2e/automator.mjs（需开发者工具 + 已登录 + 服务端口）',
    status: 'pending',
    result: '待执行：需微信开发者工具真实运行后手工补录（本脚本的 Node 宿主模拟结果见 simulated.webview）',
    date: null,
    environment: null,
  },
  {
    device: 'WeChat DevTools',
    renderer: 'Skyline',
    command: 'node examples/miniprogram/e2e/automator.mjs（project.config.json 切 renderer=skyline）',
    status: 'pending',
    result: '待执行：需微信开发者工具真实运行后手工补录（本脚本的 Node 宿主模拟结果见 simulated.skyline）',
    date: null,
    environment: null,
  },
  {
    device: '真机 Android',
    renderer: 'WebView',
    command: '微信开发者工具 → 预览二维码 → Android 真机打开；按 COMPATIBILITY 矩阵记录',
    status: 'pending',
    result: '待执行：真机执行记录由发布负责人补录（禁止用模拟结果代替）',
    date: null,
    environment: null,
  },
  {
    device: '真机 iOS',
    renderer: 'Skyline',
    command: '微信开发者工具 → 预览二维码 → iOS 真机打开；按 COMPATIBILITY 矩阵记录',
    status: 'pending',
    result: '待执行：真机执行记录由发布负责人补录（禁止用模拟结果代替）',
    date: null,
    environment: null,
  },
]

const notes = [
  'host-smoke 单次运行内同时覆盖 WebView（默认 schedule）与 Skyline（renderer=skyline 合并）两类宿主模拟场景；simulated 分组为按场景标签拆分的结果。',
  '四组 combinations 是  验收 5 要求的 DevTools/真机 × WebView/Skyline 真实记录位；CI 仅能提供 Node 宿主模拟证据，真实行必须由发布负责人执行后补录。',
  '记录模板与补录步骤见 docs/quality/dual-renderer-smoke.md；CI artifact 归档 coverage/dual-renderer-smoke.json。',
]

const environment = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cwd: repoRoot,
}

let payload
if (!fs.existsSync(distEntry)) {
  payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gitHead: readGitHead(),
    environment,
    source: { script: 'examples/miniprogram/e2e/host-smoke.mjs', command: 'node examples/miniprogram/e2e/host-smoke.mjs' },
    simulated: {
      ok: false,
      exitCode: null,
      webview: summarize([]),
      skyline: summarize([]),
      reason: 'dist-weapp/index.js 不存在，请先执行 pnpm run build（CI 中 build 步骤在 e2e 之前）',
    },
    combinations,
    notes,
    ok: false,
  }
  fs.mkdirSync(coverageDir, { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2) + '\n')
  console.error('[dual-renderer-smoke] 缺少 dist-weapp/index.js，请先运行 pnpm run build；已写入待执行记录 ' + path.relative(repoRoot, outputPath))
  process.exit(1)
}

const startedAt = new Date().toISOString()
const result = spawnSync(process.execPath, [hostSmokePath], { cwd: repoRoot, encoding: 'utf8', timeout: 180000 })
const checks = parseChecks(result.stdout ?? '')
const skylineChecks = checks.filter((check) => check.label.startsWith('Skyline'))
const webviewChecks = checks.filter((check) => !check.label.startsWith('Skyline'))
const simulated = {
  ok: result.status === 0 && checks.every((check) => check.status === 'pass'),
  exitCode: result.status,
  webview: summarize(webviewChecks),
  skyline: summarize(skylineChecks),
  stderrTail: (result.stderr ?? '').trim().split(/\r?\n/).slice(-5).join('\n') || null,
}

payload = {
  schemaVersion: 1,
  generatedAt: startedAt,
  gitHead: readGitHead(),
  environment,
  source: { script: 'examples/miniprogram/e2e/host-smoke.mjs', command: 'node examples/miniprogram/e2e/host-smoke.mjs' },
  simulated,
  combinations,
  notes,
  ok: simulated.ok,
}
fs.mkdirSync(coverageDir, { recursive: true })
fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2) + '\n')

console.log(
  '[dual-renderer-smoke] host-smoke（Node 宿主模拟，非真机）WebView ' +
    simulated.webview.passed +
    '/' +
    simulated.webview.total +
    ' 项通过，Skyline ' +
    simulated.skyline.passed +
    '/' +
    simulated.skyline.total +
    ' 项通过',
)
console.log('[dual-renderer-smoke] 真实 DevTools/真机四组记录仍为 pending，需发布负责人按 docs/quality/dual-renderer-smoke.md 补录')
console.log('[dual-renderer-smoke] 输出：' + path.relative(repoRoot, outputPath))

if (!simulated.ok) {
  console.error('[dual-renderer-smoke] host-smoke 失败：' + (simulated.stderrTail ?? 'see demo harness output'))
  process.exit(1)
}
