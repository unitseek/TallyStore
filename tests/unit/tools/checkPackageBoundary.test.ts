/**  / AS-04：分包边界静态检查脚本——主包引用分包 Store 构建期拦截 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const script = path.resolve(__dirname, '../../../scripts/check-package-boundary.mjs')

function makeFixture(violating: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), 'boundary-'))
  writeFileSync(path.join(root, 'app.json'), JSON.stringify({ subPackages: [{ root: 'packageA', pages: ['pages/list/index'] }] }))
  mkdirSync(path.join(root, 'packageA/store'), { recursive: true })
  mkdirSync(path.join(root, 'pages/index'), { recursive: true })
  writeFileSync(path.join(root, 'packageA/store/cart.js'), 'module.exports = {}')
  writeFileSync(
    path.join(root, 'pages/index/index.js'),
    violating ? "const cart = require('../../packageA/store/cart.js')" : "const util = require('../../main/util.js')",
  )
  writeFileSync(path.join(root, 'app.js'), "const cart = require('./packageA/store/cart.js')")
  return root
}

function run(root: string): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [script, root], { encoding: 'utf8' })
    return { status: 0, output }
  } catch (error) {
    const e = error as { status?: number; stderr?: string }
    return { status: e.status ?? -1, output: e.stderr ?? '' }
  }
}

describe(' 分包边界静态检查', () => {
  it('主包引用分包 Store：退出码 1 并指出引用文件与分包路径（AS-04）', () => {
    const root = makeFixture(true)
    try {
      const result = run(root)
      expect(result.status).toBe(1)
      expect(result.output).toContain('pages/index/index.js')
      expect(result.output).toContain('packageA/store/cart.js')
      expect(result.output).toContain('packageA')
      expect(result.output).toContain('MIGRATION.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('无违规：通过并统计主包文件数；未配置分包直接通过', () => {
    const root = makeFixture(false)
    try {
      // app.js 引用了 './packageA/...' —— 主包根文件引用分包同样违规，先清掉
      const { writeFileSync: wf } = require('node:fs') as typeof import('node:fs')
      wf(path.join(root, 'app.js'), '// clean')
      const result = run(root)
      expect(result.status).toBe(0)
      expect(result.output).toContain('通过')

      // 未配置分包的工程
      const noSub = mkdtempSync(path.join(tmpdir(), 'boundary-nosub-'))
      try {
        writeFileSync(path.join(noSub, 'app.json'), '{}')
        writeFileSync(path.join(noSub, 'app.js'), '// clean')
        const pass = run(noSub)
        expect(pass.status).toBe(0)
        expect(pass.output).toContain('未配置分包')
      } finally {
        rmSync(noSub, { recursive: true, force: true })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('工程根缺失或无 app.json：退出码 1 并给出用法', () => {
    const result = run(path.join(tmpdir(), 'definitely-not-exist-' + Date.now()))
    expect(result.status).toBe(1)
    expect(result.output).toContain('用法')
  })

  it('app.json 结构非法：退出码 1 并给出结构错误而不是裸抛栈', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'boundary-bad-'))
    try {
      writeFileSync(path.join(root, 'app.json'), JSON.stringify({ subPackages: { root: 'packageA' } }))
      writeFileSync(path.join(root, 'app.js'), '// clean')
      const result = run(root)
      expect(result.status).toBe(1)
      expect(result.output).toContain('结构错误')
      expect(result.output).toContain('必须是数组')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('subPackages 与 subpackages 同时存在：两键合并生效', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'boundary-dualkeys-'))
    try {
      writeFileSync(path.join(root, 'app.json'), JSON.stringify({ subPackages: [], subpackages: [{ root: 'packageA' }] }))
      mkdirSync(path.join(root, 'packageA'), { recursive: true })
      writeFileSync(path.join(root, 'packageA/index.js'), 'module.exports = {}')
      writeFileSync(path.join(root, 'app.js'), "require('./packageA/index.js')")
      const result = run(root)
      expect(result.status).toBe(1)
      expect(result.output).toContain('packageA')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('.mjs / 目录 index 的引用也能被解析并命中分包', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'boundary-ext-'))
    try {
      writeFileSync(path.join(root, 'app.json'), JSON.stringify({ subPackages: [{ root: 'packageA' }] }))
      mkdirSync(path.join(root, 'packageA/store'), { recursive: true })
      writeFileSync(path.join(root, 'packageA/store/cart.mjs'), 'export const cart = {}')
      writeFileSync(path.join(root, 'app.js'), "import('./packageA/store/cart.mjs')")
      const result = run(root)
      expect(result.status).toBe(1)
      expect(result.output).toContain('packageA/store/cart.mjs')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('注释中的旧引用不产生误报', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'boundary-comment-'))
    try {
      writeFileSync(path.join(root, 'app.json'), JSON.stringify({ subPackages: [{ root: 'packageA' }] }))
      mkdirSync(path.join(root, 'packageA'), { recursive: true })
      writeFileSync(path.join(root, 'packageA/index.js'), 'module.exports = {}')
      writeFileSync(path.join(root, 'app.js'), "// 旧的引用：require('./packageA/index.js')\n// import x from './packageA/index.js'\nconst count = 1\n")
      const result = run(root)
      expect(result.status).toBe(0)
      expect(result.output).toContain('通过')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('仓库提交的违规 fixture 必须被检出（CI 门禁防空转）', () => {
    const fixtureRoot = path.resolve(__dirname, '../../../scripts/fixtures/boundary-violation')
    const result = run(fixtureRoot)
    expect(result.status).toBe(1)
    expect(result.output).toContain('pages/index/index.js')
    expect(result.output).toContain('packageA/store/cart.js')
    expect(result.output).toContain('分包 packageA')
  })

  it('emoji 等 astral 字符不会让注释抹除错位', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'boundary-emoji-'))
    try {
      writeFileSync(path.join(root, 'app.json'), JSON.stringify({ subPackages: [{ root: 'packageA' }] }))
      mkdirSync(path.join(root, 'packageA/store'), { recursive: true })
      mkdirSync(path.join(root, 'pages/index'), { recursive: true })
      writeFileSync(path.join(root, 'packageA/store/cart.js'), 'module.exports = {}')
      writeFileSync(
        path.join(root, 'pages/index/index.js'),
        "// 😀📦 emoji 注释里的伪引用 require('./packageA/store/cart.js')\nconst cart = require('../../packageA/store/cart.js')\n",
      )
      const result = run(root)
      expect(result.status).toBe(1)
      // 只有真实引用被计入：注释里的伪引用必须被抹掉（错位会把它算进来或破坏真实代码）
      expect(result.output).toContain('主包引用分包模块 1 处')
      expect(result.output).toContain('packageA/store/cart.js')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('正则与 JSX 文本中的引号不会污染注释识别', () => {
    const clean = mkdtempSync(path.join(tmpdir(), 'boundary-regex-clean-'))
    try {
      writeFileSync(path.join(clean, 'app.json'), JSON.stringify({ subPackages: [{ root: 'packageA' }] }))
      mkdirSync(path.join(clean, 'packageA'), { recursive: true })
      mkdirSync(path.join(clean, 'pages/index'), { recursive: true })
      writeFileSync(path.join(clean, 'packageA/index.js'), 'module.exports = {}')
      writeFileSync(
        path.join(clean, 'pages/index/index.tsx'),
        ['const re = /["\']/', 'const text = "<p>Don\'t</p>"', "// require('../../packageA/index.js')", 'const count = 1', 'export default count'].join('\n'),
      )
      const result = run(clean)
      expect(result.status).toBe(0)
      expect(result.output).toContain('通过')
    } finally {
      rmSync(clean, { recursive: true, force: true })
    }
  })

  it('.mts 引用可解析、声明文件不参与扫描', () => {
    const mts = mkdtempSync(path.join(tmpdir(), 'boundary-mts-'))
    try {
      writeFileSync(path.join(mts, 'app.json'), JSON.stringify({ subPackages: [{ root: 'packageA' }] }))
      mkdirSync(path.join(mts, 'packageA/store'), { recursive: true })
      mkdirSync(path.join(mts, 'pages/index'), { recursive: true })
      writeFileSync(path.join(mts, 'packageA/store/cart.mts'), 'export const cart = {}')
      writeFileSync(path.join(mts, 'pages/index/index.js'), "require('../../packageA/store/cart')\n")
      const result = run(mts)
      expect(result.status).toBe(1)
      expect(result.output).toContain('packageA/store/cart.mts')
    } finally {
      rmSync(mts, { recursive: true, force: true })
    }

    // .d.mts 是声明文件：其中的 import/require 文本不应被当作真实引用
    const declaration = mkdtempSync(path.join(tmpdir(), 'boundary-dmts-'))
    try {
      writeFileSync(path.join(declaration, 'app.json'), JSON.stringify({ subPackages: [{ root: 'packageA' }] }))
      mkdirSync(path.join(declaration, 'packageA'), { recursive: true })
      mkdirSync(path.join(declaration, 'pages/index'), { recursive: true })
      writeFileSync(path.join(declaration, 'packageA/index.js'), 'module.exports = {}')
      writeFileSync(path.join(declaration, 'pages/index/types.d.mts'), "require('../../packageA/index.js')\n")
      const result = run(declaration)
      expect(result.status).toBe(0)
      expect(result.output).toContain('通过')
    } finally {
      rmSync(declaration, { recursive: true, force: true })
    }
  })
})
