/**
 *  验收 1/3：示例工程的分包正向依赖与未迁移页面共存自动化。
 *
 * 只做静态/结构断言；真实生命周期加载由 e2e/宿主模拟覆盖：
 * - examples/miniprogram/e2e/subpackage-smoke.mjs（经 `pnpm run e2e` 触发，CI 在 build 后运行）；
 * - 边界检查用仓库脚本 scripts/check-package-boundary.mjs（不改脚本，只断言行为）。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const repoRoot = path.resolve(__dirname, '../../..')
const demoRoot = path.join(repoRoot, 'examples/miniprogram')
const boundaryScript = path.join(repoRoot, 'scripts/check-package-boundary.mjs')

function runBoundary(projectRoot: string): { status: number; output: string } {
  try {
    return { status: 0, output: execFileSync(process.execPath, [boundaryScript, projectRoot], { encoding: 'utf8' }) }
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? -1, output: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

describe(' 示例工程：分包正向依赖与未迁移页面共存', () => {
  it('app.json 声明真实 subPackages 与未迁移页面，页面四件套齐全', () => {
    const appJson = JSON.parse(readFileSync(path.join(demoRoot, 'app.json'), 'utf8')) as {
      pages: string[]
      subPackages: Array<{ root: string; pages: string[] }>
    }
    expect(appJson.pages).toContain('pages/index/index')
    // 未迁移页面留在主包 pages 列表（不随分包改造被移动）
    expect(appJson.pages).toContain('pages/legacy/legacy')
    const pkg = appJson.subPackages.find((entry) => entry.root === 'packageA')
    expect(pkg).toBeDefined()
    expect(pkg?.pages).toContain('pages/cart/cart')
    for (const base of ['packageA/pages/cart/cart', 'pages/legacy/legacy']) {
      for (const ext of ['js', 'json', 'wxml', 'wxss']) {
        expect(existsSync(path.join(demoRoot, base + '.' + ext))).toBe(true)
      }
    }
  })

  it('分包页面只经 getApp().globalData.store 取主包实例，不创建/复制 Store', () => {
    const cart = readFileSync(path.join(demoRoot, 'packageA/pages/cart/cart.js'), 'utf8')
    expect(cart).toContain('globalData')
    expect(cart).toContain('withPageStore')
    expect(cart).not.toMatch(/createStore\s*\(/)
  })

  it('未迁移页面保留 globalData 写法且不依赖 Store API', () => {
    const legacy = readFileSync(path.join(demoRoot, 'pages/legacy/legacy.js'), 'utf8')
    expect(legacy).toContain('globalData')
    // 未迁移页不引入库、也不使用 Store 集成/构造 API
    expect(legacy).not.toMatch(/withPageStore|createStore|@unitseek\/tallystore/)
  })

  it('check:boundary 对示例工程通过（主包不引用分包，正向依赖合法）', () => {
    const result = runBoundary(demoRoot)
    expect(result.status).toBe(0)
    expect(result.output).toContain('通过')
    expect(result.output).toContain('分包 1 个')
  })

  it('反向违规 fixture 仍以退出码 1 拦截（防空转，不破坏既有门禁）', () => {
    const result = runBoundary(path.join(repoRoot, 'scripts/fixtures/boundary-violation'))
    expect(result.status).toBe(1)
    expect(result.output).toContain('packageA/store/cart.js')
  })
})
