/** tests/contract/loadDist.ts：入口校验、失败错误信息与临时目录清理 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { cleanupLoadRoot, distAvailable, requireFromDist } from '../../contract/loadDist.js'

const repoRoot = path.resolve(__dirname, '../../..')
const distIndexPath = path.join(repoRoot, 'dist-weapp', 'index.js')
const describeWithDist = distAvailable ? describe : describe.skip
// 共享工作区里其他任务可能并发 build/clean（CI 在 build 之后串行跑测试，无此并发）：
// 产物在测试执行期间消失时按跳过处理，避免环境抖动被记成假红。
const distGone = (): boolean => !existsSync(distIndexPath)
const isDistUnavailableError = (error: unknown): boolean => error instanceof Error && error.message.includes('dist-weapp 不可用')

describe('contract loadDist · 产物可用性', () => {
  it('distAvailable 是布尔值（本机是否已构建由它声明）', () => {
    expect(typeof distAvailable).toBe('boolean')
  })
})

describe('contract loadDist · 入口形态校验（无需构建）', () => {
  it('非法入口（.. / 绝对路径）在拼接路径前被拒绝', () => {
    expect(() => requireFromDist('../index')).toThrow(/非法的 dist 入口/)
    expect(() => requireFromDist('/etc/passwd')).toThrow(/非法的 dist 入口/)
    expect(() => requireFromDist('./plugins/../index')).toThrow(/非法的 dist 入口/)
  })
})

describeWithDist('contract loadDist · 加载与临时目录（dist-weapp 可用）', () => {
  it('require 失败时错误信息带真实产物目录与原入口', () => {
    if (distGone()) return
    let caught: unknown
    try {
      requireFromDist('./no-such-entry')
    } catch (error) {
      caught = error
    }
    if (isDistUnavailableError(caught)) return
    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toContain('从发布产物加载入口失败')
    expect(message).toContain('entry=./no-such-entry')
    expect(message).toContain(path.join(repoRoot, 'dist-weapp'))
    // 原错误可能是 Node 的 ModuleNotFoundError（不一定是宿主 realm 的 Error 实例），断言 cause 存在即可
    expect((caught as { cause?: unknown }).cause).toBeDefined()
  })

  it('合法入口可加载；cleanupLoadRoot 幂等且之后可重新准备', () => {
    if (distGone()) return
    try {
      expect(typeof requireFromDist('.').createStore).toBe('function')
      expect(() => cleanupLoadRoot()).not.toThrow()
      expect(() => cleanupLoadRoot()).not.toThrow()
      expect(typeof requireFromDist('.').createStore).toBe('function')
    } catch (error) {
      if (isDistUnavailableError(error)) return
      throw error
    }
  })
})
