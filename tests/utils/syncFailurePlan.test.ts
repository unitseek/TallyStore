/**
 * examples/miniprogram/scripts/syncPathGuard.mjs 的失败收尾决策。
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const guardUrl = pathToFileURL(path.join(process.cwd(), 'examples/miniprogram/scripts/syncPathGuard.mjs')).href

function plan(state: { targetExists: boolean; staging: string; target: string }): { cleanupStaging: boolean; message: string } {
  const script =
    'const m = await import(' + JSON.stringify(guardUrl) + '); process.stdout.write(JSON.stringify(m.planSyncFailureCleanup(JSON.parse(process.env.PLAN_ARG))))'
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, PLAN_ARG: JSON.stringify(state) },
  })
  return JSON.parse(stdout) as { cleanupStaging: boolean; message: string }
}

describe('planSyncFailureCleanup · 替换失败后不能丢唯一可用产物', () => {
  it('target 仍存在：允许清理 staging，并提示「未被替换」', () => {
    const result = plan({ targetExists: true, staging: '/tmp/target.tmp', target: '/tmp/target' })
    expect(result.cleanupStaging).toBe(true)
    expect(result.message).toContain('未被替换')
    expect(result.message).toContain('/tmp/target')
  })

  it('target 已被删除（rm 后 rename 失败）：保留 staging 并给出路径', () => {
    const result = plan({ targetExists: false, staging: '/tmp/target.tmp', target: '/tmp/target' })
    expect(result.cleanupStaging).toBe(false)
    expect(result.message).toContain('保留')
    expect(result.message).toContain('/tmp/target.tmp')
  })
})
