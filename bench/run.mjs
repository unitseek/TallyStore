#!/usr/bin/env node
/**
 * TallyStore 内部性能基准 CLI。
 *
 * 默认跑全部 suite；--json 输出纯 JSON；--save/--compare 用于同一台机器上的相对回归检测。
 * 先决条件：仓库根已执行 pnpm run build（bench 直接加载 dist-weapp 发布产物）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  ALL_SUITES,
  BASELINE_FORMAT_VERSION,
  assertBaselineShape,
  averageProbe,
  comparisonInvalidFailures,
  comparisonRetryKeys,
  configure,
  compareWithBaseline,
  environment,
  formatDuration,
  helpText,
  io,
  loadLib,
  measure,
  measureMachineProbe,
  parseArgs,
  partitionUsableResults,
  renderComparison,
  renderTable,
  restoreConsole,
  silenceConsole,
} from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

/** suite → 定义文件：由 lib.ALL_SUITES 单一来源派生，避免两份清单漂移 */
const SUITE_FILES = new Map(ALL_SUITES.map((suite) => [suite, suite + '.bench.mjs']))

const describeError = (error) => (error && error.stack ? error.stack : String(error))

/** 测量单个 case（setup → measure → teardown），失败也返回 result/failures 而不是抛出 */
async function measureOne(suite, testCase, loaded) {
  const failures = []
  let context
  try {
    context = testCase.setup ? await testCase.setup(loaded) : undefined
  } catch (error) {
    // setup 就失败时没有可信上下文可交给 teardown；半途创建的资源只能由 setup 自身负责清理
    return { failures: [{ suite, case: testCase.name, error: describeError(error) }] }
  }

  let result
  try {
    result = { suite, ...(await measureCase(testCase, context)) }
  } catch (error) {
    failures.push({ suite, case: testCase.name, error: describeError(error) })
  } finally {
    try {
      await testCase.teardown?.(context)
    } catch (error) {
      failures.push({ suite, case: testCase.name + ' (teardown)', error: describeError(error) })
      // 卸载失败说明定时器/订阅/存储状态未释放，本 case 的计时已不可信：
      // 丢弃结果，避免污染表格与 --save 写出的基线
      result = undefined
    }
  }
  return { result, failures }
}

async function runCases(options, loaded) {
  const results = []
  const failures = []
  const registry = new Map()

  for (const suite of options.suites) {
    // parseArgs 已保证 suite ∈ ALL_SUITES，SUITE_FILES 又由其派生 → get 必有值；
    // 保留一条兜底派生表达式而不是不可达的 if 分支，文件缺失由下面的 import try/catch 记 <load> 失败
    const suiteFile = SUITE_FILES.get(suite) ?? suite + '.bench.mjs'
    const suitePath = path.join(here, suiteFile)
    let mod
    try {
      mod = await import(pathToFileURL(suitePath).href)
    } catch (error) {
      failures.push({ suite, case: '<load>', error: describeError(error) })
      continue
    }

    for (const testCase of mod.cases) {
      const key = suite + '/' + testCase.name
      // 重复 case 名会让 registry/indexCases 静默覆盖、测量被丢弃
      if (registry.has(key)) {
        failures.push({ suite, case: testCase.name, error: '重复的 case 名：' + key })
        continue
      }
      registry.set(key, { suite, testCase })
      const outcome = await measureOne(suite, testCase, loaded)
      if (outcome.result) results.push(outcome.result)
      failures.push(...outcome.failures)
    }
  }

  return { results, failures, registry }
}

/** 复测被判回退的 case 并原地替换结果：真实回退会复现，瞬态争用噪声不会 */
async function retryRegressions(keys, registry, loaded, results, failures) {
  const retriedKeys = []
  for (const key of keys) {
    const entry = registry.get(key)
    if (!entry) continue
    const outcome = await measureOne(entry.suite, entry.testCase, loaded)
    failures.push(...outcome.failures)
    const index = results.findIndex((item) => item.suite === entry.suite && item.name === entry.testCase.name)
    if (!outcome.result) {
      // 复测失败：旧结果是没能复现的噪声数据，不能继续参与回退判定/--save
      if (index !== -1) results.splice(index, 1)
      continue
    }
    if (index !== -1) results[index] = outcome.result
    else results.push(outcome.result)
    retriedKeys.push(key)
  }
  return retriedKeys
}

async function measureCase(testCase, context) {
  // lib.mjs 不 import suite，静态导入 measure 不存在循环依赖；此前每个 case 的动态 import 是多余开销
  return measure(testCase.name, () => testCase.fn(context), testCase.opts ?? {})
}

const serializableFailures = (failures) => failures.map((failure) => ({ suite: failure.suite, case: failure.case, error: failure.error }))

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    io.error('[bench] ' + (error instanceof Error ? error.message : String(error)))
    return 2
  }

  if (options.help) {
    io.log(helpText())
    return 0
  }

  configure({ quick: options.quick })
  if (options.rounds !== null) configure({ rounds: options.rounds })
  if (options.warmup !== null) configure({ warmup: options.warmup })
  if (options.targetMs !== null) configure({ targetMs: options.targetMs })

  try {
    loadLib()
  } catch (error) {
    io.error('[bench] ' + (error instanceof Error ? error.message : String(error)))
    return 2
  }

  const env = environment()
  const startedAt = Date.now()
  let results = []
  let failures = []

  // 基线在开跑前读取/校验——路径拼错或 JSON 损坏不必等整轮测量才报，也不会丢已测数据
  let baseline
  if (options.compare) {
    try {
      // JSON.parse 只证明合法 JSON；形状校验（null/数组/缺 cases）必须开跑前就失败
      baseline = assertBaselineShape(JSON.parse(fs.readFileSync(path.resolve(process.cwd(), options.compare), 'utf8')))
    } catch (error) {
      io.error('[bench] 读取基线失败：' + (error instanceof Error ? error.message : String(error)))
      return 2
    }
  }

  let probeStart = 0
  let probeEnd = 0
  // 探针在 compare 前已定型，只聚合一次——compare 归一与落盘 meta 共用同一口径
  let probeNsPerOp
  let registry = new Map()
  let comparison = null
  let retryRounds = 0
  const retriedCases = []
  silenceConsole()
  try {
    // 前后各测一次机器探针：平均后作为本次运行的「机器速度」，compare 用它归一。
    // 探针只是归一化输入：单次失败应记入 failures 并继续，不能丢弃已测结果。
    try {
      probeStart = await measureMachineProbe()
    } catch (error) {
      failures.push({ suite: 'meta', case: 'machine probe (start)', error: describeError(error) })
    }
    const outcome = await runCases(options, loadLib())
    results = outcome.results
    failures.push(...outcome.failures)
    registry = outcome.registry
    try {
      probeEnd = await measureMachineProbe()
    } catch (error) {
      failures.push({ suite: 'meta', case: 'machine probe (end)', error: describeError(error) })
    }

    // 只统计有效的一侧探针，一侧失败时不再把另一侧已测得的值整份丢弃
    probeNsPerOp = averageProbe([probeStart, probeEnd])

    if (options.compare) {
      let probeForCompare = probeNsPerOp
      comparison = compareWithBaseline(baseline, results, options.tolerance, probeForCompare)
      // 回退复测：共享宿主上的瞬时争用会让某 case 整窗变慢；真实回退复测仍会复现。
      // 候选无有效样本（samples 全 0/NaN）同样是瞬时采样失败，与回退 case 一起复测；
      // 复测后仍无有效样本的 case 才由下面的 comparisonInvalidFailures 计入失败。
      // 最多复测 2 轮，每轮只重测仍被判回退/无效的 case，结果原地替换；复测窗口前再测一次探针，
      // 用「复测窗口的机器速度」重新归一，避免把局部争用当成代码回退。
      while (retryRounds < 2) {
        const keys = comparisonRetryKeys(comparison)
        if (keys.length === 0) break
        retryRounds += 1
        let retryProbe
        try {
          retryProbe = await measureMachineProbe()
        } catch (error) {
          // 复测窗口的探针失败同样只是降级归一——记入 failures 并继续，
          // 不能让异常穿透 try/finally 丢掉已测得的 results/failures
          failures.push({ suite: 'meta', case: 'machine probe (retry)', error: describeError(error) })
        }
        if (Number.isFinite(retryProbe) && retryProbe > 0) {
          probeForCompare = Number.isFinite(probeForCompare) && probeForCompare > 0 ? (probeForCompare + retryProbe) / 2 : retryProbe
        }
        const retriedKeys = await retryRegressions(keys, registry, loadLib(), results, failures)
        if (retriedKeys.length === 0) break
        retriedCases.push(...retriedKeys)
        comparison = compareWithBaseline(baseline, results, options.tolerance, probeForCompare)
      }
      comparison.probeNsPerOpUsed = probeForCompare
      comparison.retryRounds = retryRounds
      comparison.retriedCases = [...new Set(retriedCases)]
      // 候选无有效样本、无法判定回退的 case 必须计入 failures，
      // 否则 compare 会以「无回退」exit 0 假阴性通过（只进报告文本不足以拦住门禁）
      failures.push(...comparisonInvalidFailures(comparison))
    }
  } finally {
    restoreConsole()
  }
  // 无有效 nsPerOp 的 case 不得静默写进基线/输出——基线里 nsPerOp 为 0/NaN 时，
  // 后续 compareWithBaseline 会永久跳过它（既不报 missing 也不报 invalid）。
  // 与 compare 已判 invalid 的 case 去重后统一计入 failures，并从 results 中剔除。
  const comparedInvalidKeys = comparison && Array.isArray(comparison.invalid) ? comparison.invalid : []
  const partitioned = partitionUsableResults(results, comparedInvalidKeys)
  results = partitioned.usable
  failures.push(...partitioned.failures)
  const durationMs = Date.now() - startedAt

  const payload = {
    //  前置：基线必须自带 formatVersion，否则 compare 的版本门禁对新生成的基线永远不生效
    meta: {
      formatVersion: BASELINE_FORMAT_VERSION,
      ...env,
      durationMs,
      probeNsPerOp,
      probeStartNsPerOp: probeStart,
      probeEndNsPerOp: probeEnd,
    },
    cases: results,
    failures: serializableFailures(failures),
    ...(comparison ? { comparison } : {}),
  }

  if (options.json) {
    io.log(JSON.stringify(payload, null, 2))
  } else {
    io.log('TallyStore benchmark — ' + env.node + ' / ' + env.platform + '-' + env.arch + ' / ' + env.runMode)
    io.log('dist-weapp: ' + env.dist.files + ' files / ' + (env.dist.bytes / 1024).toFixed(1) + ' KB | cpu: ' + env.cpuModel + ' x' + env.cpuCount)
    io.log('')
    io.log(renderTable(results))
    io.log('')
    io.log('cases: ' + results.length + ' | wall: ' + formatDuration(durationMs))
    if (comparison) {
      io.log(renderComparison(comparison, options.tolerance))
    }
    if (failures.length > 0) {
      io.error('')
      io.error('失败 ' + failures.length + ' 项：')
      for (const failure of failures) io.error('  x ' + failure.suite + '/' + failure.case + ': ' + failure.error)
    }
  }

  // 先渲染报告再落盘——--save 路径写失败时已算出的结果仍可见（--json 也可被重定向捕获）
  let saveFailed = false
  if (options.save) {
    if (probeNsPerOp === undefined) {
      // 没有可用探针的基线缺少 meta.probeNsPerOp，之后所有 --compare 都会永久失去归一能力；
      // 与其写出一份会误导后续门禁的基线，不如拒绝并提示重跑
      saveFailed = true
      io.error('[bench] start/end 机器探针均失败，拒绝写出缺少 meta.probeNsPerOp 的基线（否则后续 --compare 永久失去归一能力）；请排查机器负载后重跑')
    } else {
      try {
        fs.writeFileSync(path.resolve(process.cwd(), options.save), JSON.stringify(payload, null, 2) + '\n')
        if (!options.json) io.log('saved: ' + options.save)
      } catch (error) {
        saveFailed = true
        io.error('[bench] 写入结果失败：' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }

  if (saveFailed) return 2
  const regressionCount = comparison ? comparison.regressions.length : 0
  return failures.length > 0 || regressionCount > 0 ? 1 : 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    restoreConsole()
    io.error(describeError(error))
    process.exitCode = 1
  })
