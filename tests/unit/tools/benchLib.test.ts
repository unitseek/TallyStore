/**
 * bench/lib.mjs 的配置/统计契约。
 *
 * bench 是纯 ESM 脚本，jest 侧用 node 子进程直接 import 执行：避免 ts-jest CJS 转译 ESM 的限制，
 * 也与真实 node bench/run.mjs 的模块形态一致。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '../../..')
const distIndex = path.join(repoRoot, 'dist-weapp', 'index.js')
const itWithDist = existsSync(distIndex) ? it : it.skip

/** 在仓库根起一个 node ESM 子进程执行 body（body 内可用 lib / await），返回 JSON 结果 */
function runBenchScript(body: string): any {
  const script =
    "import * as lib from './bench/lib.mjs'\n" +
    'const run = async () => { ' +
    body +
    ' }\n' +
    'run().then((value) => { process.stdout.write(JSON.stringify(value)) }).catch((error) => { console.error(String((error && error.stack) || error)); process.exit(1) })\n'
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: repoRoot, encoding: 'utf8' })
  return JSON.parse(stdout)
}

describe('bench/lib.mjs · 基线格式版本', () => {
  it('常量、提交的 baseline.json 与比较器的兼容性判定一致', () => {
    const result = runBenchScript(
      "const fs = await import('node:fs')\n" +
        "const baseline = JSON.parse(fs.readFileSync('./bench/baseline.json', 'utf8'))\n" +
        'const legacy = lib.compareWithBaseline({ cases: [] }, [], 25)\n' +
        "const mismatched = lib.compareWithBaseline({ meta: { formatVersion: 999 }, cases: [{ suite: 's', name: 'n', nsPerOp: 1 }] }, [{ suite: 's', name: 'n', nsPerOp: 1 }], 25)\n" +
        'return { current: lib.BASELINE_FORMAT_VERSION, baselineVersion: baseline.meta.formatVersion, legacyCompatible: legacy.formatVersion.compatible, mismatchCompatible: mismatched.formatVersion.compatible, mismatchedRegressions: mismatched.regressions.length, mismatchBaselineVersion: mismatched.formatVersion.baseline }',
    )
    expect(result).toEqual({
      current: 1,
      baselineVersion: 1,
      legacyCompatible: true,
      mismatchCompatible: false,
      mismatchedRegressions: 0,
      mismatchBaselineVersion: 999,
    })
  })
})

describe('bench/lib.mjs · configure', () => {
  it('忽略 null、校验非法取值，显式 rounds 记录 roundsExplicit', () => {
    const result = runBenchScript(
      'const defaults = { rounds: lib.config.rounds, warmup: lib.config.warmup, targetMs: lib.config.targetMs, roundsExplicit: lib.config.roundsExplicit }\n' +
        'lib.configure({ rounds: null, warmup: null, targetMs: null })\n' +
        'const afterNull = { rounds: lib.config.rounds, warmup: lib.config.warmup, targetMs: lib.config.targetMs }\n' +
        "let invalidError = ''\n" +
        'try { lib.configure({ rounds: 0 }) } catch (error) { invalidError = error instanceof Error ? error.message : String(error) }\n' +
        'lib.configure({ rounds: 2, warmup: 1, targetMs: 5 })\n' +
        'return { defaults, afterNull, invalidError, explicit: lib.config.roundsExplicit, rounds: lib.config.rounds }',
    )
    expect(result.defaults).toEqual({ rounds: 3, warmup: 2, targetMs: 50, roundsExplicit: false })
    expect(result.afterNull).toEqual({ rounds: 3, warmup: 2, targetMs: 50 })
    expect(String(result.invalidError)).toContain('rounds')
    expect(result.explicit).toBe(true)
    expect(result.rounds).toBe(2)
  })

  it('显式 rounds 时不自适应加样本；未显式指定时仍会补到 >=3 样本', () => {
    const explicit = runBenchScript(
      'lib.configure({ rounds: 1, warmup: 0 })\n' +
        "const result = await lib.measure('probe', () => { let x = 0; for (let i = 0; i < 100; i += 1) x += i; return x }, { targetMs: 1 })\n" +
        'return { samples: result.samples.length }',
    )
    expect(explicit.samples).toBe(1)

    const adaptive = runBenchScript(
      "const result = await lib.measure('probe', () => { let x = 0; for (let i = 0; i < 100; i += 1) x += i; return x }, { targetMs: 1 })\n" +
        'return { samples: result.samples.length }',
    )
    expect(adaptive.samples).toBeGreaterThanOrEqual(3)
  })
})

describe('bench/lib.mjs · 重复 case 标识', () => {
  it('indexCases 对重复 suite/name 抛错而不是静默覆盖', () => {
    const result = runBenchScript(
      "let error = ''\n" +
        "try { lib.indexCases([{ suite: 's', name: 'n' }, { suite: 's', name: 'n' }]) } catch (caught) { error = caught instanceof Error ? caught.message : String(caught) }\n" +
        'return { error }',
    )
    expect(String(result.error)).toContain('重复')
  })
})

describe('bench/lib.mjs · console 静默', () => {
  it('silenceConsole 同时屏蔽 info/debug/trace，restoreConsole 对称还原', () => {
    const result = runBenchScript(
      'const before = { info: lib.io.info, debug: lib.io.debug, trace: lib.io.trace }\n' +
        'lib.silenceConsole()\n' +
        'const silenced = { info: typeof console.info, debug: typeof console.debug, trace: typeof console.trace }\n' +
        'lib.restoreConsole()\n' +
        'return { restored: console.info === before.info && console.debug === before.debug && console.trace === before.trace, silenced }',
    )
    expect(result.silenced).toEqual({ info: 'function', debug: 'function', trace: 'function' })
    expect(result.restored).toBe(true)
  })
})

describe('bench/lib.mjs · loadLib（需要 dist-weapp，未构建时 skip）', () => {
  itWithDist('cleanup 删除临时目录并恢复 globalThis.wx', () => {
    const result = runBenchScript(
      "const fs = await import('node:fs')\n" +
        'const before = globalThis.wx\n' +
        'const loaded = lib.loadLib()\n' +
        'const rootExists = fs.existsSync(loaded.root)\n' +
        'loaded.cleanup()\n' +
        "return { rootExists, rootRemoved: !fs.existsSync(loaded.root), wxRestored: globalThis.wx === before, libReady: typeof loaded.lib.createStore === 'function' }",
    )
    expect(result).toEqual({ rootExists: true, rootRemoved: true, wxRestored: true, libReady: true })
  })
})

describe('bench/lib.mjs · 探针聚合与比较失败', () => {
  it('averageProbe 只统计有效一侧探针，两侧都无效才返回 undefined', () => {
    const result = runBenchScript(
      'return {' +
        'both: lib.averageProbe([100, 200]),' +
        'oneSidedStart: lib.averageProbe([100, 0]),' +
        'oneSidedEnd: lib.averageProbe([undefined, 200]),' +
        'allInvalid: lib.averageProbe([0, Number.NaN]) === undefined,' +
        'empty: lib.averageProbe([]) === undefined,' +
        'nonArray: lib.averageProbe(undefined) === undefined,' +
        '}',
    )
    expect(result).toEqual({ both: 150, oneSidedStart: 100, oneSidedEnd: 200, allInvalid: true, empty: true, nonArray: true })
  })

  it('comparisonInvalidFailures 把无法判定的 case 转成 failures', () => {
    const result = runBenchScript(
      "const converted = lib.comparisonInvalidFailures({ invalid: ['proxy/read: a', 'store/setState'] })\n" +
        'return {' +
        'converted,' +
        'empty: lib.comparisonInvalidFailures({ invalid: [] }).length,' +
        'none: lib.comparisonInvalidFailures(null).length,' +
        '}',
    )
    expect(result.empty).toBe(0)
    expect(result.none).toBe(0)
    expect(result.converted.map((item: { suite: string; case: string }) => [item.suite, item.case])).toEqual([
      ['compare', 'proxy/read: a'],
      ['compare', 'store/setState'],
    ])
    for (const item of result.converted) expect(item.error).toContain('无法判定回退')
  })

  it('compareWithBaseline 对候选无有效样本的 case 返回 invalid，并可被转成 failures', () => {
    const result = runBenchScript(
      'const comparison = lib.compareWithBaseline(' +
        "{ cases: [{ suite: 's', name: 'n', nsPerOp: 10, samples: [10, 10, 10] }] }," +
        "[{ suite: 's', name: 'n', nsPerOp: 0, samples: [0, 0, 0] }]," +
        '25,' +
        ')\n' +
        'return { invalid: comparison.invalid, failures: lib.comparisonInvalidFailures(comparison) }',
    )
    expect(result.invalid).toEqual(['s/n'])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatchObject({ suite: 'compare', case: 's/n' })
  })
})

describe('bench/lib.mjs · OCR3 比较门禁', () => {
  it('formatVersion 不一致时 comparisonInvalidFailures 计入失败而不是「无回退」', () => {
    const result = runBenchScript(
      'const comparison = lib.compareWithBaseline({ meta: { formatVersion: 999 }, cases: [] }, [], 25)\n' +
        'const failures = lib.comparisonInvalidFailures(comparison)\n' +
        'return { compatible: comparison.formatVersion.compatible, regressions: comparison.regressions.length, failures }',
    )
    expect(result.compatible).toBe(false)
    expect(result.regressions).toBe(0)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatchObject({ suite: 'compare', case: '<formatVersion>' })
    expect(result.failures[0].error).toContain('formatVersion')
  })

  it('comparisonRetryKeys 把回退与无效样本 case 合并去重', () => {
    const result = runBenchScript(
      'return {' +
        'empty: lib.comparisonRetryKeys(null),' +
        "keys: lib.comparisonRetryKeys({ regressions: [{ key: 'a/1' }, { key: 'a/2' }], invalid: ['a/2', 'a/3'] })," +
        '}',
    )
    expect(result.empty).toEqual([])
    expect(result.keys).toEqual(['a/1', 'a/2', 'a/3'])
  })

  it('partitionUsableResults 剔除无有效 nsPerOp 的 case 并计入失败，已标记的不重复计', () => {
    const result = runBenchScript(
      'const input = [' +
        "{ suite: 's', name: 'ok', nsPerOp: 12 }," +
        "{ suite: 's', name: 'zero', nsPerOp: 0 }," +
        "{ suite: 's', name: 'nan', nsPerOp: Number.NaN }," +
        "{ suite: 's', name: 'flagged', nsPerOp: 0 }," +
        ']\n' +
        "const partitioned = lib.partitionUsableResults(input, ['s/flagged'])\n" +
        'return {' +
        'usable: partitioned.usable.map((item) => item.name),' +
        'failures: partitioned.failures.map((item) => [item.suite, item.case]),' +
        'empty: lib.partitionUsableResults(undefined).usable.length,' +
        '}',
    )
    expect(result.usable).toEqual(['ok'])
    expect(result.failures).toEqual([
      ['s', 'zero'],
      ['s', 'nan'],
    ])
    expect(result.empty).toBe(0)
  })
})

describe('bench/lib.mjs · OCR4 门禁与基线一致性', () => {
  it('formatVersion 不一致：comparison.skipped=true，renderComparison 不再输出「无回退」', () => {
    const result = runBenchScript(
      'const comparison = lib.compareWithBaseline({ meta: { formatVersion: 999 }, cases: [] }, [], 25)\n' +
        'return { skipped: comparison.skipped, text: lib.renderComparison(comparison, 25) }',
    )
    expect(result.skipped).toBe(true)
    expect(result.text).toContain('已跳过比较')
    expect(result.text).not.toContain('无回退')
  })

  it('assertBaselineShape 拒绝 null/数组/缺 cases，放行合法基线', () => {
    const result = runBenchScript(
      'const err = (value) => { try { lib.assertBaselineShape(value); return null } catch (error) { return error instanceof Error ? error.message : String(error) } }\n' +
        'return {' +
        'nullError: err(null),' +
        'arrayError: err([]),' +
        'emptyObjectError: err({}),' +
        "casesNotArray: err({ cases: 'x' })," +
        'ok: lib.assertBaselineShape({ cases: [] }).cases.length,' +
        '}',
    )
    expect(String(result.nullError)).toContain('形状非法')
    expect(String(result.arrayError)).toContain('形状非法')
    expect(String(result.emptyObjectError)).toContain('形状非法')
    expect(String(result.casesNotArray)).toContain('形状非法')
    expect(result.ok).toBe(0)
  })

  it('configure 部分字段非法时不留下半套配置', () => {
    const result = runBenchScript(
      'const before = { rounds: lib.config.rounds, roundsExplicit: lib.config.roundsExplicit, warmup: lib.config.warmup }\n' +
        "let error = ''\n" +
        'try { lib.configure({ rounds: 2, warmup: -1 }) } catch (caught) { error = caught instanceof Error ? caught.message : String(caught) }\n' +
        'return { before, after: { rounds: lib.config.rounds, roundsExplicit: lib.config.roundsExplicit, warmup: lib.config.warmup }, error }',
    )
    expect(String(result.error)).toContain('warmup')
    expect(result.after).toEqual(result.before)
  })

  it('committed baseline 的 case 名都能在对应 bench 源码中找到（防重命名后失去回归覆盖，/009）', () => {
    const baseline = JSON.parse(readFileSync(path.join(repoRoot, 'bench/baseline.json'), 'utf8')) as { cases: Array<{ suite: string; name: string }> }
    const suiteFiles: Record<string, string> = {
      proxy: 'proxy.bench.mjs',
      store: 'store.bench.mjs',
      integrations: 'integrations.bench.mjs',
      plugins: 'plugins.bench.mjs',
    }
    const stale: string[] = []
    for (const item of baseline.cases) {
      const file = suiteFiles[item.suite]
      if (!file) {
        stale.push('未知 suite：' + item.suite)
        continue
      }
      const source = readFileSync(path.join(repoRoot, 'bench', file), 'utf8')
      if (!source.includes("'" + item.name + "'")) stale.push(item.suite + '/' + item.name)
    }
    expect(stale).toEqual([])
  })
})

describe('bench/lib.mjs · 稳健统计', () => {
  it('robustNsPerOp 在 3 样本时取两个最快样本的均值', () => {
    const result = runBenchScript('return { value: lib.robustNsPerOp({ nsPerOp: 100, samples: [30, 10, 20] }) }')
    expect(result.value).toBe(15)
  })
})
