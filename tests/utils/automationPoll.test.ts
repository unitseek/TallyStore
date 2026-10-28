/**
 * examples/miniprogram/e2e/automation-poll.mjs 的轮询语义。
 * .mjs 原生 ESM 无法在 jest 运行时直接 require，这里用子进程 node 加载（与 examples 其它守卫测试同口径）。
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const pollUrl = pathToFileURL(path.join(process.cwd(), 'examples/miniprogram/e2e/automation-poll.mjs')).href

function runPoll(body: string): unknown {
  const script = 'const m = await import(' + JSON.stringify(pollUrl) + ');\n' + body
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 8000 })
  return JSON.parse(stdout) as unknown
}

describe('waitUntil · 未就绪哨兵', () => {
  it('0 / false / 空串都是合法就绪结果，不再被真值判断吞掉', () => {
    expect(runPoll('process.stdout.write(JSON.stringify(await m.waitUntil("zero", async () => 0, 200, 5)))')).toBe(0)
    expect(runPoll('process.stdout.write(JSON.stringify(await m.waitUntil("falsy", async () => false, 200, 5)))')).toBe(false)
    expect(runPoll('process.stdout.write(JSON.stringify(await m.waitUntil("empty", async () => "", 200, 5)))')).toBe('')
  })

  it('undefined / null 才表示未就绪；就绪前会持续重试', () => {
    const result = runPoll(
      'let n = 0; const v = await m.waitUntil("retry", async () => { n += 1; if (n < 3) return undefined; return 7 }, 500, 1); process.stdout.write(JSON.stringify({ v, n }))',
    )
    expect(result).toEqual({ v: 7, n: 3 })

    const viaNull = runPoll(
      'let n = 0; const v = await m.waitUntil("null-sentinel", async () => { n += 1; return n < 2 ? null : 0 }, 500, 1); process.stdout.write(JSON.stringify({ v, n }))',
    )
    expect(viaNull).toEqual({ v: 0, n: 2 })
  })
})

describe('waitUntil · 单次探针也受超时约束', () => {
  it('探针永远不 resolve 时按剩余时间失败，而不是永久挂起', () => {
    const result = runPoll(
      'const start = Date.now(); try { await m.waitUntil("hang", () => new Promise(() => {}), 80, 5); process.stdout.write(JSON.stringify({ ok: true })) } catch (e) { process.stdout.write(JSON.stringify({ ok: false, message: e.message, elapsed: Date.now() - start })) }',
    ) as { ok: boolean; message: string; elapsed: number }
    expect(result.ok).toBe(false)
    expect(result.message).toContain('超时')
    expect(result.message).toContain('hang')
    expect(result.elapsed).toBeLessThan(3000)
  })

  it('always-undefined 探针在 deadline 到达后抛超时错误', () => {
    const result = runPoll(
      'const start = Date.now(); try { await m.waitUntil("never", async () => undefined, 60, 5); process.stdout.write(JSON.stringify({ ok: true })) } catch (e) { process.stdout.write(JSON.stringify({ ok: false, message: e.message, elapsed: Date.now() - start })) }',
    ) as { ok: boolean; message: string; elapsed: number }
    expect(result.ok).toBe(false)
    expect(result.message).toContain('等待超时')
    expect(result.elapsed).toBeLessThan(3000)
  })

  it('withTimeout 对永不 resolve 的 Promise 按 label 报超时', () => {
    const message = runPoll(
      'try { await m.withTimeout(new Promise(() => {}), 30, "probe"); process.stdout.write(JSON.stringify("resolved")) } catch (e) { process.stdout.write(JSON.stringify(e.message)) }',
    )
    expect(message).toBe('probe 超时（30ms）')
  })
})
