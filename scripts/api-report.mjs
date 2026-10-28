#!/usr/bin/env node
/**
 * API 报告与稳定性门禁：
 * - 提取四个运行时入口的导出面 + Store 原型方法，生成**排序后**的 API 表面快照；
 * - --check 与已提交快照（scripts/api-snapshot.json）比对：新增/删除导出即失败，
 *   PR 里必须同步更新快照——这正是「API 报告用于评审」的落点（签名级变化由类型测试
 *   tests/types 与 tsc 承载，此处管名字级增删）。
 *
 * 口径：
 * - 导出面按 Object.keys（enumerable own）统计：与 CJS 消费者实际可见导出一致；
 *   非枚举/__esModule 等转译产物噪声不纳入。
 * - 比对顺序不敏感：逐入口按名字集合求差集，快照键重排不会误报。
 *
 * 用法：
 *   node scripts/api-report.mjs                 # 生成/打印当前表面（stdout JSON）
 *   node scripts/api-report.mjs --save          # 写入 scripts/api-snapshot.json
 *   node scripts/api-report.mjs --check         # 与快照比对，差异退出码 1
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { repoRoot, publishEntries, loadPackage } from './publish-entries.mjs'

const distDir = path.join(repoRoot, 'dist-weapp')
if (!existsSync(path.join(distDir, 'index.js'))) {
  console.error('[api-report] 缺少 dist-weapp（先运行 pnpm run build）')
  process.exit(1)
}

// 用 runtimeEntries 而不是去重后的 runtimeFiles：两个 exports 键指向同一运行时文件时，
// 表面仍要保留两个键，否则新增别名导出的差异会被静默吞掉
const { runtimeEntries } = publishEntries()
const snapshotLabel = 'scripts/api-snapshot.json'
const snapshotPath = path.join(repoRoot, 'scripts', 'api-snapshot.json')

/** 表面名字总数（save/check 共用，避免三处重复计算） */
const countNames = (surface) => Object.values(surface).reduce((sum, names) => sum + names.length, 0)

// 仓库根 package.json 是 "type": "module"，Node 会把产物的 CJS require 判为 ESM；
// 拷贝到临时目录并声明 commonjs 后再 require（与微信按目录加载的形态一致）
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'tallystore-api-'))
/**
 * process.exit() 会立即终止进程、**不执行 finally 栈展开**，所以 --save / --check（成功或失败）
 * 等退出路径上的 finally 都不会运行——把清理注册到 exit 钩子，保证临时目录不残留。
 * 清理本身必须吞错：退出期抛错会改变进程退出码。
 */
const cleanupTempRoot = () => {
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    // 退出期清理失败不影响退出码
  }
}
process.on('exit', cleanupTempRoot)
/**
 * SIGINT/SIGTERM 终止时 'exit' 事件不会触发：显式清理后按约定退出码结束。
 * 130 = 128 + SIGINT(2)，143 = 128 + SIGTERM(15)。
 */
const exitOnSignal = (signal, code) => {
  process.once(signal, () => {
    cleanupTempRoot()
    process.exit(code)
  })
}
exitOnSignal('SIGINT', 130)
exitOnSignal('SIGTERM', 143)
try {
  cpSync(distDir, tempRoot, { recursive: true })
  writeFileSync(path.join(tempRoot, 'package.json'), '{"type":"commonjs"}\n')
  const require = createRequire(pathToFileURL(path.join(tempRoot, 'package.json')).href)

  const surface = {}
  for (const entry of runtimeEntries) {
    surface[entry.key] = Object.keys(require(path.join(tempRoot, entry.file))).sort()
  }
  // Store 原型公开方法（运行时导出之外的实例面）：产物未导出 Store 时给出可诊断错误而不是 TypeError
  const indexModule = require(path.join(tempRoot, 'index.js'))
  if (indexModule === null || typeof indexModule !== 'object' || typeof indexModule.Store !== 'function') {
    console.error('[api-report] 入口 index.js 未导出 Store 构造函数：无法提取 Store.prototype 表面（产物损坏或导出被改名）')
    process.exit(1)
  }
  surface['Store.prototype'] = Object.getOwnPropertyNames(indexModule.Store.prototype)
    .filter((name) => name !== 'constructor')
    .sort()

  const report = {
    version: loadPackage().version,
    generatedAt: 'snapshot', // 固定值：快照内容不随生成时间漂移
    surface,
  }

  if (process.argv.includes('--save')) {
    writeFileSync(snapshotPath, JSON.stringify(report, null, 2) + '\n')
    console.log('[api-report] 快照已写入 ' + snapshotLabel + '（' + runtimeEntries.length + ' 入口 + Store.prototype，共 ' + countNames(surface) + ' 个名字）')
    process.exit(0)
  }

  if (process.argv.includes('--check')) {
    if (!existsSync(snapshotPath)) {
      console.error('[api-report] 快照不存在：先运行 pnpm run api:report -- --save 并提交（' + snapshotLabel + '）')
      process.exit(1)
    }
    let snapshot
    try {
      snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
    } catch (error) {
      console.error('[api-report] 快照不是合法 JSON（' + snapshotLabel + '）：' + (error instanceof Error ? error.message : String(error)))
      process.exit(1)
    }
    if (
      snapshot === null ||
      typeof snapshot !== 'object' ||
      snapshot.surface === null ||
      typeof snapshot.surface !== 'object' ||
      Array.isArray(snapshot.surface)
    ) {
      console.error('[api-report] 快照缺少合法的 surface 对象（' + snapshotLabel + '）：请重新 --save 生成')
      process.exit(1)
    }
    // 每个入口的值必须是「字符串数组」：手工编辑/合并冲突后可能是字符串或对象，
    // 否则会在后续 diff 处抛 TypeError 或静默做子串匹配，绕过可诊断错误
    const invalidSurface = Object.entries(snapshot.surface).find(
      ([, names]) => !Array.isArray(names) || names.some((name) => typeof name !== 'string'),
    )
    if (invalidSurface) {
      console.error(
        '[api-report] 快照 surface 条目必须是字符串数组（' +
          invalidSurface[0] +
          '：' +
          JSON.stringify(invalidSurface[1]).slice(0, 120) +
          '）：请重新 --save 生成',
      )
      process.exit(1)
    }

    const problems = []
    // 版本只在快照里落一份，--check 必须真正比较它，否则版本升级后快照会静默过期
    if (snapshot.version !== report.version) {
      problems.push('version: ' + JSON.stringify(snapshot.version) + ' → ' + JSON.stringify(report.version) + '（快照版本过期，请重新 --save）')
    }
    // 逐入口按名字集合求差：顺序不敏感
    const keys = new Set([...Object.keys(surface), ...Object.keys(snapshot.surface)])
    for (const key of keys) {
      const now = surface[key] ?? []
      const before = snapshot.surface[key] ?? []
      for (const added of now.filter((name) => !before.includes(name))) problems.push('+ ' + key + ' → ' + added)
      for (const removed of before.filter((name) => !now.includes(name))) problems.push('- ' + key + ' → ' + removed)
    }

    if (problems.length === 0) {
      console.log('[api-report] 通过：与快照一致（' + countNames(surface) + ' 个名字）')
      process.exit(0)
    }
    console.error('[api-report] 公开 API 表面与快照不一致 ' + problems.length + ' 处（API 变更需评审：更新快照并在 CHANGELOG 记录稳定性分级）：')
    for (const problem of problems) console.error('  ' + problem)
    process.exit(1)
  }

  // 默认打印当前表面
  console.log(JSON.stringify(report, null, 2))
} finally {
  // 正常路径（默认打印）主动清理，并注销 exit 钩子避免重复删除
  process.off('exit', cleanupTempRoot)
  cleanupTempRoot()
}
