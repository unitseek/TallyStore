/**
 * 产物体积报告与门禁。
 *
 * 口径：
 * - 主口径 raw 字节：微信「构建 npm」按 raw 整目录拷贝 dist-weapp，这是唯一硬预算；
 * - 辅口径 gzip：衡量传输/解析成本，只报告不阻断；
 * - 核心入口闭包：index.js 及其 require 可达的模块图（避免「核心库 ≤XKB」的不可判定口径）。
 *
 * 门禁（--budget）：
 * - raw 超过硬预算（120KB，锚定 FR 修复批次实测 111.6KB + 评审余量）→ 失败；
 * - 相对基线 scripts/size-baseline.json 增长同时超过 +2KB 且 +3% → 失败
 *   （「或」口径：只要一项在容差内即通过，超出需架构评审并在发布说明记录）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { repoRoot } from './publish-entries.mjs'

const root = repoRoot
const jsonMode = process.argv.includes('--json')
const budgetMode = process.argv.includes('--budget')

/** raw 硬预算（字节）：微信整目录拷贝计费口径；调整需架构评审并同步需求文档。
 * v0.1.0 发布预算 120KB（当前约 114.6KB，余量约 8.1KB）；每版本增长容差 +2KB 或 +3%，
 * 超出需评审并记录；发布后回补目标 92KB（优先错误消息表压缩与后续能力体积控制）。
 */
const RAW_BUDGET_BYTES = 120 * 1024
/** 每版本增长容差：绝对值（字节）与相对比例，两项同时超出才阻断 */
const GROWTH_TOLERANCE_BYTES = 2 * 1024
const GROWTH_TOLERANCE_RATIO = 0.03
const BASELINE_FILE = 'scripts/size-baseline.json'

const walk = async (dir) => {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

const gzipBytes = (buffer) => gzipSync(buffer, { level: 9 }).length

const report = async (dir) => {
  const files = await walk(dir)
  // 文件读取互相独立：并发读，避免数百文件时逐次等待 I/O 延迟
  const buffers = await Promise.all(files.map((file) => readFile(file)))
  let bytes = 0
  let gzBytes = 0
  const byDir = new Map()
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]
    const buffer = buffers[index]
    bytes += buffer.length
    gzBytes += gzipBytes(buffer)
    const rel = path.relative(dir, file).split(path.sep)
    const key = rel.length > 1 ? rel[0] : '(根)'
    byDir.set(key, (byDir.get(key) || 0) + buffer.length)
  }
  return { files: files.length, bytes, gzBytes, byDir }
}

/** 核心入口闭包：从入口出发沿相对 require 可达的文件集合（ 可判定边界） */
const coreClosure = async (distDir, entry) => {
  const entryFile = path.join(distDir, entry)
  if (!existsSync(entryFile)) {
    throw new Error('[size] 核心入口不存在：' + entryFile + '（构建产物不完整）')
  }
  const queue = [entryFile]
  const seen = new Set()
  // 未解析的相对 require 用 Set 去重：同一个缺失模块可能被多个文件引用
  const unresolved = new Set()
  while (queue.length > 0) {
    const file = queue.shift()
    if (seen.has(file)) continue
    if (!existsSync(file)) {
      unresolved.add(file)
      continue
    }
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/require\((['"])(\.[^'"]+)\1\)/g)) {
      let spec = match[2]
      if (!spec.endsWith('.js')) spec += '.js'
      // 相对 require 按各自文件所在目录解析
      queue.push(path.resolve(path.dirname(file), spec))
    }
  }
  let bytes = 0
  let gzBytes = 0
  for (const file of seen) {
    const buffer = readFileSync(file)
    bytes += buffer.length
    gzBytes += gzipBytes(buffer)
  }
  return { files: seen.size, bytes, gzBytes, unresolved: [...unresolved] }
}

for (const dir of ['dist-weapp', 'types']) {
  if (!existsSync(path.join(root, dir))) {
    console.error('[size] 缺少构建产物目录：' + dir + '（先运行 pnpm run build）')
    process.exit(1)
  }
}

const weapp = await report(path.join(root, 'dist-weapp'))
const types = await report(path.join(root, 'types'))
const core = await coreClosure(path.join(root, 'dist-weapp'), 'index.js')

// 未解析的 require 意味着核心闭包体积被低估（构建产物不完整）：必须可见，不能静默丢弃。
// --budget 模式只在 failures 里输出一次（避免同一清单打印两遍）；--json 消费者通过 payload 字段感知
if (core.unresolved.length > 0 && !budgetMode) {
  console.error('[size] 核心闭包存在 ' + core.unresolved.length + ' 个未解析的相对 require（构建产物可能不完整，核心体积被低估）：')
  for (const file of core.unresolved) console.error('  ' + path.relative(root, file))
}

const kb = (n) => (n / 1024).toFixed(1)

if (jsonMode) {
  // --json 是机器契约：stdout 只输出一行 JSON，人类可读报告走 stderr
  console.error('[size] dist-weapp ' + weapp.files + ' files, types ' + types.files + ' files')
  console.log(
    JSON.stringify({
      distWeappBytes: weapp.bytes,
      distWeappGzipBytes: weapp.gzBytes,
      distWeappFiles: weapp.files,
      coreClosureBytes: core.bytes,
      coreClosureGzipBytes: core.gzBytes,
      coreClosureFiles: core.files,
      // 核心闭包未解析的相对 require 数量：>0 表示体积被低估（机器消费者可据此失败）
      coreClosureUnresolved: core.unresolved.length,
      typesBytes: types.bytes,
      typesFiles: types.files,
    }),
  )
} else {
  console.log(
    'dist-weapp  ' + String(weapp.files).padStart(3) + ' 文件  raw ' + kb(weapp.bytes).padStart(7) + ' KB   gzip ' + kb(weapp.gzBytes).padStart(7) + ' KB',
  )
  for (const [dir, bytes] of [...weapp.byDir.entries()].sort((a, b) => b[1] - a[1])) {
    console.log('  ' + dir.padEnd(24) + kb(bytes).padStart(7) + ' KB')
  }
  console.log(
    '核心闭包    ' + String(core.files).padStart(3) + ' 文件  raw ' + kb(core.bytes).padStart(7) + ' KB   gzip ' + kb(core.gzBytes).padStart(7) + ' KB',
  )
  console.log('types       ' + String(types.files).padStart(3) + ' 文件  ' + kb(types.bytes).padStart(7) + ' KB')
  console.log('npm 解包约  ' + kb(weapp.bytes + types.bytes) + ' KB（不含 README/LICENSE/package.json）')
}

if (budgetMode) {
  const failures = []
  if (core.unresolved.length > 0) {
    failures.push(
      '核心闭包存在 ' +
        core.unresolved.length +
        ' 个未解析的相对 require（构建不完整？）：' +
        core.unresolved.map((file) => path.relative(root, file)).join(', '),
    )
  }
  if (weapp.bytes > RAW_BUDGET_BYTES) {
    failures.push('dist-weapp raw ' + weapp.bytes + 'B 超过硬预算 ' + RAW_BUDGET_BYTES + 'B（' + kb(RAW_BUDGET_BYTES) + ' KB）')
  }
  // 基线缺失/损坏时门禁必须 fail-closed：不能把「未校验增长」说成通过
  let baselineState = 'missing'
  const baselinePath = path.join(root, BASELINE_FILE)
  if (existsSync(baselinePath)) {
    // null 不能当「解析失败」哨兵：JSON.parse('null') 是成功解析。用显式 parsed 标志。
    let baseline
    let baselineParsed = false
    try {
      baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
      baselineParsed = true
    } catch (error) {
      failures.push('基线文件 ' + BASELINE_FILE + ' 不是合法 JSON：' + (error instanceof Error ? error.message : String(error)))
    }
    if (baselineParsed) {
      const baselineBytes = baseline && typeof baseline.distWeappBytes === 'number' ? baseline.distWeappBytes : NaN
      if (!Number.isFinite(baselineBytes) || baselineBytes <= 0) {
        failures.push(
          '基线 ' +
            BASELINE_FILE +
            ' 的 distWeappBytes 必须是有限正数（实际：' +
            JSON.stringify(baseline && baseline.distWeappBytes) +
            '），无法计算增长容差',
        )
      } else {
        baselineState = 'checked'
        const delta = weapp.bytes - baselineBytes
        const ratio = delta / baselineBytes
        if (delta > GROWTH_TOLERANCE_BYTES && ratio > GROWTH_TOLERANCE_RATIO) {
          failures.push(
            'dist-weapp raw 较基线增长 ' +
              delta +
              'B（+' +
              (ratio * 100).toFixed(1) +
              '%），同时超出容差（+' +
              GROWTH_TOLERANCE_BYTES +
              'B 且 +3%）；如属预期请评审后更新 ' +
              BASELINE_FILE,
          )
        }
      }
    }
  } else {
    failures.push('未找到基线 ' + BASELINE_FILE + '：增长容差无法校验（fail-closed），请恢复/生成基线后再跑门禁')
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error('[size:gate] FAIL ' + failure)
    process.exit(1)
  }
  const reportSuccess = jsonMode ? console.error : console.log
  const growthLine =
    baselineState === 'checked'
      ? '增长在容差内（基线 ' + BASELINE_FILE + '）'
      : '增长容差未执行（基线缺失，已按 fail-closed 处理）'
  reportSuccess('[size:gate] 通过：raw ' + weapp.bytes + 'B ≤ ' + RAW_BUDGET_BYTES + 'B，' + growthLine)
}
