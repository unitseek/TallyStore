/**
 * bench 公共设施：加载发布产物 dist-weapp、计时/统计、表格与 JSON 输出、参数解析。
 *
 * 为什么跑 dist-weapp 而不是 src：
 * 微信「构建 npm」上传的是 dist-weapp 整目录 CJS 产物，内部基准必须测这份字节，
 * 而不是为测试另建一套 ESM 入口。做法与 examples/miniprogram/e2e/host-smoke.mjs 一致：
 * 把 dist-weapp 复制到 os.tmpdir()，单独声明 {"type":"commonjs"}，再用 createRequire 加载。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 仓库根目录 */
export const repoRoot = path.resolve(here, '..')

/** 发布产物目录（微信上传的那一份） */
export const distSource = path.join(repoRoot, 'dist-weapp')

/** 保存原始 console：基准期间屏蔽业务日志，输出统一走 io，保证 --json 时不混入杂讯 */
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
  trace: console.trace.bind(console),
}

export const io = originalConsole

let consoleSilenced = false

/** 屏蔽业务侧 console 输出（插件安装日志、集成参数告警等），表格/JSON 由 io 负责 */
export function silenceConsole() {
  if (consoleSilenced) return
  consoleSilenced = true
  // 不只 log/warn/error：插件或第三方代码的 console.info/debug/trace 同样会污染 --json 输出
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
  console.info = () => {}
  console.debug = () => {}
  console.trace = () => {}
}

export function restoreConsole() {
  if (!consoleSilenced) return
  consoleSilenced = false
  console.log = originalConsole.log
  console.warn = originalConsole.warn
  console.error = originalConsole.error
  console.info = originalConsole.info
  console.debug = originalConsole.debug
  console.trace = originalConsole.trace
}

// ==================== 发布产物加载 ====================

let loaded

/** @typedef {{ lib: Record<string, any>, plugins: Record<string, any>, storage: Map<string, string>, root: string }} LoadedLib */

/**
 * 加载 dist-weapp：整目录复制到临时目录 + CJS 声明 + createRequire。
 *
 * 进程内只加载一次（同一份字节），用例通过各自新建 store/宿主隔离状态。
 * @returns {LoadedLib}
 */
export function loadLib() {
  if (loaded) return loaded

  if (!fs.existsSync(path.join(distSource, 'index.js'))) {
    throw new Error('bench 需要先构建发布产物：找不到 ' + path.relative(repoRoot, distSource) + '/index.js。请在仓库根执行 pnpm run build')
  }

  // 先创建临时目录，再替换 wx——mkdtemp 失败时不得把进程全局改成 bench stub
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tallystore-bench-'))

  // wx 全局必须在 require 之前挂上：isProduction() 首次调用会读 envVersion 并缓存结果，
  // 用 develop 确保 logger 插件、开发期告警等分支按「开发者工具」形态被测量。
  // 保存旧值：cleanup 时恢复，避免永久改写宿主进程的 globalThis.wx。
  const previousWx = globalThis.wx
  const storage = new Map()
  globalThis.wx = {
    getStorageSync(key) {
      return storage.has(key) ? storage.get(key) : ''
    },
    setStorageSync(key, value) {
      storage.set(key, value)
    },
    removeStorageSync(key) {
      storage.delete(key)
    },
    getAccountInfoSync() {
      return { miniProgram: { envVersion: 'develop' } }
    },
  }

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败不影响基准结果
    }
    if (previousWx === undefined) {
      delete globalThis.wx
    } else {
      globalThis.wx = previousWx
    }
  }
  // 注册必须早于 copy/require：准备阶段任一环节失败也要清理临时目录并还原 wx
  process.once('exit', cleanup)
  try {
    fs.cpSync(distSource, root, { recursive: true })
    // 仓库根是 "type": "module"；产物的相对 require 依赖 CJS 语义
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"commonjs"}\n')
    const require_ = createRequire(pathToFileURL(path.join(root, 'package.json')).href)
    const lib = require_(path.join(root, 'index.js'))
    const plugins = require_(path.join(root, 'plugins.js'))
    loaded = { lib, plugins, storage, root, cleanup }
    return loaded
  } catch (error) {
    cleanup()
    throw error
  }
}

/** 发布产物体量信息（写进 JSON meta，便于比较不同构建） */
export function distInfo() {
  let files = 0
  let bytes = 0
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        files += 1
        bytes += fs.statSync(full).size
      }
    }
  }
  if (fs.existsSync(distSource)) walk(distSource)
  return { files, bytes }
}

/** 运行环境信息 */
export function environment() {
  const cpus = os.cpus()
  return {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0] ? cpus[0].model : 'unknown',
    cpuCount: cpus.length,
    totalMemBytes: os.totalmem(),
    runMode: config.quick ? 'quick' : 'full',
    dist: distInfo(),
  }
}

// ==================== 计时与测量 ====================

/** 基线 JSON 的 schema 版本：写进 meta.formatVersion，compare 时校验，形状漂移不再静默 */
export const BASELINE_FORMAT_VERSION = 1

/** 全局测量配置（run.mjs 按命令行参数覆盖） */
export const config = {
  quick: false,
  rounds: 3,
  /** rounds 是否由调用方显式指定（--rounds）：显式时 measure 不再自适应加样本 */
  roundsExplicit: false,
  warmup: 2,
  targetMs: 50,
}

/**
 * 按命令行覆盖配置：忽略 null / undefined（parseArgs 未指定的标志位是 null），
 * 并对取值做范围校验——坏配置必须响亮失败，而不是让 measure 采到空样本产生 NaN。
 * 显式传入 rounds 时置 roundsExplicit，measure 的自适应加样本据此不再覆盖用户轮数。
 */
export function configure(patch) {
  if (patch === null || typeof patch !== 'object') {
    throw new TypeError('[bench] configure 需要对象，收到 ' + String(patch))
  }
  const next = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) continue
    next[key] = value
  }
  // 先完成全部校验，再一次性落盘——部分字段非法时不得留下半套配置
  // （此前 rounds 校验通过就先置 roundsExplicit，warmup/targetMs 后续抛错会污染自适应采样开关）
  if ('rounds' in next) {
    if (!Number.isInteger(next.rounds) || next.rounds < 1) {
      throw new TypeError('[bench] rounds 需要 >=1 的整数，收到 ' + String(next.rounds))
    }
  }
  if ('warmup' in next) {
    if (!Number.isInteger(next.warmup) || next.warmup < 0) {
      throw new TypeError('[bench] warmup 需要 >=0 的整数，收到 ' + String(next.warmup))
    }
  }
  if ('targetMs' in next) {
    if (!Number.isFinite(next.targetMs) || next.targetMs <= 0) {
      throw new TypeError('[bench] targetMs 需要正数值，收到 ' + String(next.targetMs))
    }
  }
  Object.assign(config, next)
  if ('rounds' in next) {
    config.roundsExplicit = true
  }
  if (next.quick === true) {
    config.targetMs = Math.min(config.targetMs, 10)
  }
}

const hrtime = () => Number(process.hrtime.bigint())

/** 中位数（samples 为 ns/op） */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * compare 用的稳健 ns/op：对 samples 排序后取「较低半区」的中位数。
 *
 * 为什么不用全样本中位数：共享宿主上的 GC 尖峰/邻接负载会随机抬高少数轮，
 * 全样本中位数仍会被污染；低半区代表该 case 在不被干扰时的 best-case 速度，
 * 两台（次）运行在同一机器上的比值更稳定。真实回退会整体抬高分布，低半区同样会变慢。
 * 表格仍按契约展示全样本中位数（nsPerOp）。
 */
export function robustNsPerOp(value) {
  const samples = value && Array.isArray(value.samples) ? value.samples.filter((sample) => Number.isFinite(sample) && sample > 0) : []
  if (samples.length < 3) return value && Number.isFinite(value.nsPerOp) ? value.nsPerOp : 0
  const sorted = [...samples].sort((a, b) => a - b)
  const half = sorted.slice(0, Math.max(2, Math.ceil(sorted.length / 2)))
  return median(half)
}

/**
 * 迭代上限：允许极快操作（如裸对象读 ~0.3ns）也能凑满单样本目标时长，
 * 同时防止 targetMs 配得过大时把迭代次数推到不可接受量级。
 */
function maxIterationsFor(targetMs) {
  return Math.max(1000, Math.min(2e8, Math.round(targetMs * 4e6)))
}

/**
 * 测量一个操作的稳态开销。
 *
 * 流程：探测一次判断是否异步 → 自动校准迭代次数使单样本达到 targetMs → warmup 轮 →
 * rounds 轮计时取中位数。单样本不足 targetMs 时按实测耗时换算放大，最多 3 次校准，
 * 迭代上限见 maxIterationsFor。
 *
 * @param {string} name 用例名
 * @param {() => any} fn 被测操作；返回 thenable 时按异步操作测量（每次迭代 await）
 * @param {{ iterations?: number, rounds?: number, warmup?: number, targetMs?: number, isAsync?: boolean, opsPerIteration?: number }} [opts]
 *   opsPerIteration 用于亚纳秒级操作：fn 内部一次做 K 个操作时按 K 归一，降低循环/闭包调用开销占比。
 * @returns {Promise<{ name: string, iterations: number, nsPerOp: number, opsPerSec: number, samples: number[], isAsync: boolean }>}
 */
export async function measure(name, fn, opts = {}) {
  let rounds = opts.rounds ?? config.rounds
  const warmup = opts.warmup ?? config.warmup
  const targetMs = opts.targetMs ?? config.targetMs
  const opsPerIteration = Math.max(1, Math.floor(opts.opsPerIteration ?? 1))
  const maxIterations = maxIterationsFor(targetMs)

  const probe = fn()
  const isAsync = opts.isAsync ?? (probe !== null && typeof probe === 'object' && typeof probe.then === 'function')
  if (isAsync) await probe

  const runIterations = async (count) => {
    const start = hrtime()
    if (isAsync) {
      for (let i = 0; i < count; i++) await fn()
    } else {
      for (let i = 0; i < count; i++) fn()
    }
    return hrtime() - start
  }

  let iterations = Math.max(1, opts.iterations ?? 1)
  let elapsed = await runIterations(iterations)
  for (let attempt = 0; attempt < 3 && elapsed < targetMs * 1e6 && iterations < maxIterations; attempt++) {
    // 按实测比例一步投影到目标时长（计时精度不足时直接顶到迭代上限），
    // 避免逐次有界放大把亚微秒级 case 的校准拖成好几轮整样本。
    const projected = elapsed > 0 ? Math.ceil((iterations * targetMs * 1e6 * 1.05) / elapsed) : maxIterations
    iterations = Math.min(maxIterations, Math.max(iterations + 1, projected))
    elapsed = await runIterations(iterations)
  }

  // 亚微秒级操作对调度/频率波动更敏感：默认 3 轮中位数之外自动加样本，
  // 用更多轮次换稳定性（任务书允许按抖动调整样本数；阈值远小于 25% 容差）。
  // --rounds 显式指定时不自动调整：轮数写入 config.rounds，这里必须再看 roundsExplicit
  if (opts.rounds === undefined && config.roundsExplicit !== true) {
    const estimatedNsPerOp = elapsed / Math.max(1, iterations * opsPerIteration)
    if (estimatedNsPerOp < 50) rounds = Math.max(rounds, 7)
    else if (estimatedNsPerOp < 5000) rounds = Math.max(rounds, 5)
  }

  for (let w = 0; w < warmup; w++) {
    await runIterations(iterations)
  }

  const takeSample = async () => {
    // 轮间让出事件循环：把上一轮的 GC/调度残留在计时窗口外消化掉
    await new Promise((resolve) => setImmediate(resolve))
    const took = await runIterations(iterations)
    samples.push(took / (iterations * opsPerIteration))
  }

  const samples = []
  for (let r = 0; r < rounds; r++) await takeSample()

  // 离散度自适应加样本：GC/共享宿主噪声会让少数轮的 ns/op 偏高，3 轮中位数不足以压住。
  // 相对离散度 >12% 时补样本，最多 7 轮；样本已稳定就提前停（--rounds 显式指定时不干预）。
  if (opts.rounds === undefined && config.roundsExplicit !== true) {
    while (samples.length < 7) {
      const mid = median(samples)
      const spreadPct = mid > 0 ? ((Math.max(...samples) - Math.min(...samples)) / mid) * 100 : 0
      if (spreadPct <= 12) break
      await takeSample()
    }
  }

  const nsPerOp = median(samples)
  return { name, iterations: iterations * opsPerIteration, nsPerOp, opsPerSec: nsPerOp > 0 ? 1e9 / nsPerOp : 0, samples, isAsync }
}

// ==================== 机器漂移探针 ====================

/**
 * 与库无关的固定标量循环：用来估计本次运行相对基线的机器速度漂移
 * （CPU 频率、共享宿主负载、热降频）。compare 用它归一后再判回退，
 * 避免整机变慢把每个 case 都误报成代码回退。
 */
export function machineProbeWorkload() {
  let probeSink = 0
  return function probe() {
    let x = 0
    for (let i = 0; i < 100000; i++) x = (x + i) % 1000003
    probeSink = x
    return probeSink
  }
}

/** 测一次机器探针（约 0.15s）：返回固定工作量的 ns/op（同一个循环的绝对耗时）。 */
export async function measureMachineProbe() {
  const result = await measure('machine: scalar loop probe', machineProbeWorkload(), { rounds: 5, warmup: 2, targetMs: 20 })
  return result.nsPerOp
}

/**
 * 聚合 start/end 探针：只统计有效（有限正数）的一侧。
 * 探针失败是独立事件——一侧成功一侧失败时，丢弃已测到的一侧会让本次运行退化为不归一，
 * 共享宿主上反而更容易出现假回退；两侧都无效才返回 undefined。
 * @param {Array<number | undefined>} values
 */
export function averageProbe(values) {
  const valid = Array.isArray(values) ? values.filter((value) => Number.isFinite(value) && value > 0) : []
  if (valid.length === 0) return undefined
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

// ==================== 内存存储后端 ====================

/**
 * 内存版 StorageBackend（插件基准用）：同步三方法 + 暴露底层 Map 便于预置/断言。
 * @param {Record<string, string>} [initial]
 */
export function memoryBackend(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) {
      map.set(key, value)
    },
    removeItem(key) {
      map.delete(key)
    },
    map,
  }
}

// ==================== 输出格式化 ====================

/** 紧凑 ops/s 显示 */
export function formatOpsPerSec(value) {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1e9) return (value / 1e9).toFixed(2) + 'G'
  if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M'
  if (value >= 1e3) return (value / 1e3).toFixed(2) + 'k'
  return value.toFixed(0)
}

/** ns/op 显示：保留 3 位有效量级，便于读数量级 */
export function formatNsPerOp(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 ns'
  if (value >= 1e6) return (value / 1e6).toFixed(2) + ' ms'
  if (value >= 1e3) return (value / 1e3).toFixed(2) + ' us'
  return value.toFixed(1) + ' ns'
}

/** 渲染对齐表格：suite / case / ops/s / ns/op */
export function renderTable(rows) {
  const header = ['suite', 'case', 'ops/s', 'ns/op']
  const body = rows.map((row) => [row.suite, row.name, formatOpsPerSec(row.opsPerSec), formatNsPerOp(row.nsPerOp)])
  const widths = header.map((cell, column) => Math.max(cell.length, ...body.map((line) => line[column].length)))
  const line = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join('  ')
  const divider = widths.map((width) => '-'.repeat(width)).join('  ')
  return [line(header), divider, ...body.map(line)].join('\n')
}

/** 汇总耗时显示 */
export function formatDuration(ms) {
  return ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : ms.toFixed(0) + ' ms'
}

// ==================== 参数解析 ====================

export const ALL_SUITES = ['proxy', 'store', 'integrations', 'plugins']

/**
 * 解析命令行参数。
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = {
    suites: [],
    quick: false,
    json: false,
    save: null,
    compare: null,
    tolerance: 25,
    rounds: null,
    warmup: null,
    targetMs: null,
    help: false,
  }

  const readValue = (index, flag) => {
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) throw new Error('缺少参数值：' + flag)
    return next
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--quick') {
      options.quick = true
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--suite' || arg.startsWith('--suite=')) {
      const raw = arg.includes('=') ? arg.slice('--suite='.length) : readValue(i++, '--suite')
      for (const name of raw.split(',')) {
        const suite = name.trim()
        if (!suite) continue
        if (!ALL_SUITES.includes(suite)) throw new Error('未知 suite：' + suite + '（可选：' + ALL_SUITES.join(', ') + '）')
        if (!options.suites.includes(suite)) options.suites.push(suite)
      }
    } else if (arg === '--save' || arg.startsWith('--save=')) {
      options.save = arg.includes('=') ? arg.slice('--save='.length) : readValue(i++, '--save')
    } else if (arg === '--compare' || arg.startsWith('--compare=')) {
      options.compare = arg.includes('=') ? arg.slice('--compare='.length) : readValue(i++, '--compare')
    } else if (arg === '--tolerance' || arg.startsWith('--tolerance=')) {
      const raw = arg.includes('=') ? arg.slice('--tolerance='.length) : readValue(i++, '--tolerance')
      const tolerance = Number(raw)
      if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('--tolerance 需要非负数值，收到：' + raw)
      options.tolerance = tolerance
    } else if (arg === '--rounds' || arg.startsWith('--rounds=')) {
      const raw = arg.includes('=') ? arg.slice('--rounds='.length) : readValue(i++, '--rounds')
      const rounds = Number(raw)
      if (!Number.isInteger(rounds) || rounds < 1) throw new Error('--rounds 需要 >=1 的整数，收到：' + raw)
      options.rounds = rounds
    } else if (arg === '--warmup' || arg.startsWith('--warmup=')) {
      const raw = arg.includes('=') ? arg.slice('--warmup='.length) : readValue(i++, '--warmup')
      const warmup = Number(raw)
      if (!Number.isInteger(warmup) || warmup < 0) throw new Error('--warmup 需要 >=0 的整数，收到：' + raw)
      options.warmup = warmup
    } else if (arg === '--target-ms' || arg.startsWith('--target-ms=')) {
      const raw = arg.includes('=') ? arg.slice('--target-ms='.length) : readValue(i++, '--target-ms')
      const targetMs = Number(raw)
      if (!Number.isFinite(targetMs) || targetMs <= 0) throw new Error('--target-ms 需要正数值，收到：' + raw)
      options.targetMs = targetMs
    } else {
      throw new Error('未知参数：' + arg + '（--help 查看用法）')
    }
  }

  if (options.suites.length === 0) options.suites = [...ALL_SUITES]
  return options
}

/** 帮助文本 */
export function helpText() {
  return [
    'TallyStore 内部性能基准（测 dist-weapp 发布产物）',
    '',
    '用法：',
    '  node bench/run.mjs [options]',
    '',
    '选项：',
    '  --suite=<names>    逗号分隔或重复指定，可选：' + ALL_SUITES.join(' / ') + '（默认全部）',
    '  --quick            快速模式：单样本目标 >=10ms，迭代上限随之下调',
    '  --json             只输出 JSON（环境信息 + cases）',
    '  --save <path>      把本次结果写为 JSON',
    '  --compare <path>   与基线 JSON 比较，candidate 比 baseline 慢超过阈值时逐条报告并 exit 1',
    '  --tolerance=<pct>  比较容差（默认 25）',
    '  --rounds=<n>       测量轮数（默认 3）',
    '  --warmup=<n>       预热轮数（默认 2）',
    '  --target-ms=<n>    单样本目标时长（默认 50，--quick 时 10）',
    '  --help             显示本帮助',
    '',
    '示例：',
    '  node bench/run.mjs --quick',
    '  node bench/run.mjs --suite=proxy,store --quick',
    '  node bench/run.mjs --save bench/baseline.json',
    '  node bench/run.mjs --compare bench/baseline.json --tolerance=25',
  ].join('\n')
}

// ==================== 结果比较 ====================

/**
 * 把 cases 数组转成可比较的索引（suite/name 唯一）。
 * @param {Array<{ suite: string, name: string, nsPerOp: number }>} cases
 */
export function indexCases(cases) {
  const index = new Map()
  for (const item of cases) {
    const key = item.suite + '/' + item.name
    // 重复的 suite/name 会静默覆盖前一条：作者笔误时测量被丢弃且无任何提示
    if (index.has(key)) {
      throw new Error('[bench] 重复的 case 标识：' + key)
    }
    index.set(key, item)
  }
  return index
}

/**
 * 校验 --compare 读入的 JSON 确实是基线形状。
 *
 * JSON.parse 只证明是合法 JSON：null/数组/缺 cases 会在整轮测量跑完后才在
 * compareWithBaseline 里炸掉（--save 输出丢失），而 '{}' 会静默按空基线比较
 * （所有 case 报 added、exit 0）。形状校验必须在开跑前失败。
 * @param {unknown} baseline
 * @returns {{ meta?: any, cases: Array<any> }}
 */
export function assertBaselineShape(baseline) {
  if (baseline === null || typeof baseline !== 'object' || Array.isArray(baseline) || !Array.isArray(baseline.cases)) {
    const actual = baseline === null ? 'null' : Array.isArray(baseline) ? 'array' : typeof baseline
    throw new TypeError('[bench] 基线 JSON 形状非法：需要 { meta?, cases: [...] }，实际为 ' + actual)
  }
  return baseline
}

/**
 * 与基线比较：只对同名 case 计算 ns/op 回退比例。
 *
 * 机器漂移归一：若基线/候选两侧都带机器探针（meta.probeNsPerOp），按候选探针与基线探针
 * 的比值先缩放到「基线机器速度」再比较，抵消共享宿主整机变慢/变快造成的假回退。
 * 探针是与本库无关的固定标量循环，真正的库内回退不会同步影响探针。
 *
 * @param {{ meta?: any, cases: Array<any> }} baseline
 * @param {Array<any>} candidateCases
 * @param {number} tolerance 允许回退百分比
 * @param {number} [candidateProbeNsPerOp] 候选运行的机器探针
 */
export function compareWithBaseline(baseline, candidateCases, tolerance, candidateProbeNsPerOp) {
  const baseIndex = indexCases(Array.isArray(baseline.cases) ? baseline.cases : [])
  const candidateIndex = indexCases(candidateCases)
  const regressions = []
  const missing = []
  const added = []
  const invalid = []

  const baseProbe = baseline && baseline.meta ? baseline.meta.probeNsPerOp : undefined
  // 基线格式版本：meta.formatVersion 缺失视作旧基线（按当前形状读取）；不一致时
  // 不再做逐 case 比较，避免把「形状漂移」静默解释成 missing/回退。
  const baselineFormatVersion = baseline && baseline.meta ? baseline.meta.formatVersion : undefined
  const formatVersion = {
    baseline: baselineFormatVersion,
    current: BASELINE_FORMAT_VERSION,
    compatible: baselineFormatVersion === undefined || baselineFormatVersion === BASELINE_FORMAT_VERSION,
  }
  if (!formatVersion.compatible) {
    // 显式标记「本次没有做任何比较」——调用方/报告不能再把它当作「无回退」
    return { skipped: true, regressions: [], missing: [], added: [], invalid: [], normalized: false, driftPct: 0, formatVersion }
  }
  const canNormalize = Number.isFinite(baseProbe) && baseProbe > 0 && Number.isFinite(candidateProbeNsPerOp) && candidateProbeNsPerOp > 0
  const driftRatio = canNormalize ? candidateProbeNsPerOp / baseProbe : 1
  const driftPct = canNormalize ? (driftRatio - 1) * 100 : 0

  for (const [key, base] of baseIndex) {
    const candidate = candidateIndex.get(key)
    if (!candidate) {
      missing.push(key)
      continue
    }
    if (!Number.isFinite(base.nsPerOp) || base.nsPerOp <= 0) continue
    // 基线/candidate 各自的 samples 取低半区中位数，抵消 GC 尖峰与邻接负载造成的单侧噪声
    const baselineRobust = robustNsPerOp(base)
    const candidateRobust = robustNsPerOp(candidate)
    if (!Number.isFinite(baselineRobust) || baselineRobust <= 0) continue
    if (!Number.isFinite(candidateRobust) || candidateRobust <= 0) {
      invalid.push(key)
      continue
    }
    const normalizedCandidate = candidateRobust / driftRatio
    const deltaPct = ((normalizedCandidate - baselineRobust) / baselineRobust) * 100
    if (deltaPct > tolerance) {
      regressions.push({
        key,
        baselineNsPerOp: baselineRobust,
        candidateNsPerOp: candidateRobust,
        normalizedCandidateNsPerOp: normalizedCandidate,
        deltaPct,
      })
    }
  }

  for (const key of candidateIndex.keys()) {
    if (!baseIndex.has(key)) added.push(key)
  }

  return { regressions, missing, added, invalid, normalized: canNormalize, driftPct, formatVersion }
}

/**
 * 把 compare 的 invalid case 转成 failures。
 *
 * 候选侧采样整体失效（samples 全 0/NaN → robustNsPerOp 返回 0）时该 case 只是从回退判定中
 * 被剔除、只进报告文本；多数门禁只看 failures/regressions，会因此输出「无回退」并以 exit 0
 * 通过。无法判定必须按失败计数，避免假阴性。
 * @param {{ invalid?: string[] } | null | undefined} comparison
 * @returns {Array<{ suite: string, case: string, error: string }>}
 */
export function comparisonInvalidFailures(comparison) {
  if (!comparison) {
    return []
  }
  // 基线 formatVersion 不一致时 compareWithBaseline 直接返回空比较结果（没有做任何判定），
  // 同样属于「无法判定」，必须计入失败，否则门禁会以「无回退」exit 0 假阴性通过
  if (comparison.formatVersion && comparison.formatVersion.compatible === false) {
    return [
      {
        suite: 'compare',
        case: '<formatVersion>',
        error: '基线 formatVersion 与当前不一致，本次未做任何比较（计入失败，避免门禁假阴性）',
      },
    ]
  }
  if (!Array.isArray(comparison.invalid) || comparison.invalid.length === 0) {
    return []
  }
  return comparison.invalid.map((key) => ({
    suite: 'compare',
    case: key,
    error: '本次候选无有效样本，无法判定回退（计入失败，避免门禁假阴性）',
  }))
}

/**
 * 复测候选：除回退 case 外，把「候选无有效样本」的 case 也纳入复测。
 *
 * 采样全 0/NaN 常见于共享宿主的瞬时抖动，正是复测机制要过滤的噪声；若不复测就直接计成
 * 永久失败，一次抖动就会把门禁判死，与 retryRegressions 的设计不一致。
 * @param {{ regressions?: Array<{ key: string }>, invalid?: string[] } | null | undefined} comparison
 * @returns {string[]} 去重后的 case key
 */
export function comparisonRetryKeys(comparison) {
  if (!comparison) {
    return []
  }
  const keys = []
  for (const item of Array.isArray(comparison.regressions) ? comparison.regressions : []) {
    keys.push(item.key)
  }
  for (const key of Array.isArray(comparison.invalid) ? comparison.invalid : []) {
    keys.push(key)
  }
  return [...new Set(keys)]
}

/**
 * 把 results 拆成「可写入基线」与「无效」两部分。
 *
 * 基线里 nsPerOp 为 0/NaN/缺失的 case 会被 compareWithBaseline 永久跳过（既不报 missing
 * 也不报 invalid），属于假阴性漏口；因此写盘/输出前统一剔除，并计入 failures。
 * alreadyFlaggedKeys 里的 case（如 --compare 已判 invalid）不重复计失败。
 * @param {Array<{ suite: string, name: string, nsPerOp: number }>} results
 * @param {string[]} [alreadyFlaggedKeys]
 */
export function partitionUsableResults(results, alreadyFlaggedKeys = []) {
  const flagged = new Set(Array.isArray(alreadyFlaggedKeys) ? alreadyFlaggedKeys : [])
  const usable = []
  const failures = []
  for (const result of Array.isArray(results) ? results : []) {
    if (Number.isFinite(result.nsPerOp) && result.nsPerOp > 0) {
      usable.push(result)
      continue
    }
    const key = result.suite + '/' + result.name
    if (!flagged.has(key)) {
      failures.push({
        suite: result.suite,
        case: result.name,
        error: '无有效 nsPerOp（' + String(result.nsPerOp) + '），已从结果/基线中剔除（计入失败，避免后续 compare 永久跳过该 case）',
      })
    }
  }
  return { usable, failures }
}

/** 渲染比较报告（多行文本） */
export function renderComparison(comparison, tolerance) {
  const lines = []
  if (comparison.skipped === true) {
    // 跳过比较 ≠ 无回退——输出「已跳过」后直接返回，不能再拼「无回退」等判定性结论
    if (comparison.formatVersion && comparison.formatVersion.compatible === false) {
      lines.push(
        'compare: 基线 formatVersion=' +
          comparison.formatVersion.baseline +
          ' 与当前 ' +
          comparison.formatVersion.current +
          ' 不一致，已跳过比较；请用 --save 重新生成基线',
      )
    } else {
      lines.push('compare: 本次未执行任何比较（已跳过）')
    }
    return lines.join('\n')
  }
  if (comparison.formatVersion && comparison.formatVersion.baseline === undefined) {
    lines.push('compare: 基线缺少 formatVersion（旧基线，按当前形状读取）')
  }
  if (comparison.retryRounds > 0 && Array.isArray(comparison.retriedCases)) {
    lines.push('compare: 已复测 ' + comparison.retriedCases.length + ' 次回退 case（' + comparison.retryRounds + ' 轮）')
  }
  if (comparison.normalized) {
    lines.push('compare: 机器漂移归一 ' + (comparison.driftPct >= 0 ? '+' : '') + comparison.driftPct.toFixed(1) + '%（探针）')
  }
  if (comparison.regressions.length === 0) {
    lines.push('compare: 无回退（容差 ' + tolerance + '%）')
  } else {
    lines.push('compare: ' + comparison.regressions.length + ' 个 case 超出容差 ' + tolerance + '%：')
    for (const item of comparison.regressions) {
      lines.push(
        '  REGRESSION ' +
          item.key +
          ': ' +
          formatNsPerOp(item.baselineNsPerOp) +
          ' -> ' +
          formatNsPerOp(item.candidateNsPerOp) +
          (item.normalizedCandidateNsPerOp !== undefined ? '（归一后 ' + formatNsPerOp(item.normalizedCandidateNsPerOp) + '）' : '') +
          ' (+' +
          item.deltaPct.toFixed(1) +
          '%)',
      )
    }
  }
  if (comparison.missing.length > 0) {
    lines.push('compare: 基线中的 case 本次未运行：' + comparison.missing.join(', '))
  }
  if (comparison.added.length > 0) {
    lines.push('compare: 本次新增（基线中不存在）：' + comparison.added.join(', '))
  }
  if (Array.isArray(comparison.invalid) && comparison.invalid.length > 0) {
    lines.push('compare: 本次候选无有效样本（不参与回退判定）：' + comparison.invalid.join(', '))
  }
  return lines.join('\n')
}
