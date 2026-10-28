/**
 * tests/contract/loadDist.ts：入口形态校验补齐与 exit 清理钩子去重。
 */
import { cleanupLoadRoot, distAvailable, requireFromDist } from '../contract/loadDist.js'

const describeWithDist = distAvailable ? describe : describe.skip

describe('contract loadDist · 入口形态校验（无需构建）', () => {
  it('Windows 分隔符的 .. 段、空段入口同样在拼路径前被拒绝', () => {
    expect(() => requireFromDist('./..\\evil')).toThrow(/非法的 dist 入口/)
    expect(() => requireFromDist('..\\evil')).toThrow(/非法的 dist 入口/)
    expect(() => requireFromDist('./')).toThrow(/非法的 dist 入口/)
    expect(() => requireFromDist('./a//b')).toThrow(/非法的 dist 入口/)
  })

  it('合法入口不受影响（校验在 dist 可用性检查之前）', () => {
    // 合法入口但未构建时抛「dist-weapp 不可用」，说明形态校验已通过
    if (!distAvailable) {
      expect(() => requireFromDist('./plugins')).toThrow(/dist-weapp 不可用/)
    }
  })
})

describeWithDist('contract loadDist · exit 清理钩子只注册一次', () => {
  it('cleanup 后重新 prepare 不新增 exit 监听器', () => {
    cleanupLoadRoot()
    const before = process.listenerCount('exit')
    expect(typeof requireFromDist('.').createStore).toBe('function')
    cleanupLoadRoot()
    // 重新准备同一次进程：旧实现每次 prepare 都 process.once('exit') → 监听器 +1
    expect(typeof requireFromDist('.').createStore).toBe('function')
    cleanupLoadRoot()
    expect(process.listenerCount('exit')).toBe(before + 1)
  })
})
