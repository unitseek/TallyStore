/**  示例一致性门禁：scripts/check-docs-examples.mjs 正/负向 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const script = path.resolve(__dirname, '../../../scripts/check-docs-examples.mjs')

interface RunResult {
  status: number
  output: string
}

function run(root?: string): RunResult {
  const args = root === undefined ? [script] : [script, '--root', root]
  try {
    return { status: 0, output: execFileSync(process.execPath, args, { encoding: 'utf8' }) }
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? -1, output: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

const DEFAULT_README = '# demo\n\nsubPackages 声明 packageA（页面 packageA/pages/cart/cart）。\n'

/** 构造最小示例工程 + 发布产物 + exports；字段可覆盖以制造负向场景 */
function makeFixture(options: { pageFiles?: boolean; distFiles?: boolean; readme?: string } = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'docs-examples-'))
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.2.3',
      miniprogram: 'dist-weapp',
      exports: { '.': { types: './types/index.d.ts' }, './plugins': { types: './types/plugins.d.ts' } },
    }),
  )

  const demo = path.join(root, 'examples/miniprogram')
  mkdirSync(path.join(demo, 'pages/index'), { recursive: true })
  mkdirSync(path.join(demo, 'components/counter'), { recursive: true })
  mkdirSync(path.join(demo, 'packageA/pages/cart'), { recursive: true })
  writeFileSync(path.join(demo, 'app.json'), JSON.stringify({ pages: ['pages/index/index'], subPackages: [{ root: 'packageA', pages: ['pages/cart/cart'] }] }))

  const pages = ['pages/index/index', 'packageA/pages/cart/cart']
  if (options.pageFiles !== false) {
    for (const page of pages) {
      for (const extension of ['js', 'json', 'wxml', 'wxss']) {
        writeFileSync(path.join(demo, page + '.' + extension), '// fixture\n')
      }
    }
  }

  writeFileSync(
    path.join(demo, 'app.js'),
    "const { createStore, withAppStore } = require('@unitseek/tallystore')\nconst { loggerPlugin } = require('@unitseek/tallystore/plugins')\n",
  )
  writeFileSync(path.join(demo, 'pages/index/index.js'), "const { withPageStore } = require('@unitseek/tallystore')\n")
  writeFileSync(path.join(demo, 'components/counter/counter.js'), "const { withComponentStore } = require('@unitseek/tallystore')\n")
  writeFileSync(path.join(demo, 'README.md'), options.readme ?? DEFAULT_README)

  if (options.distFiles !== false) {
    mkdirSync(path.join(root, 'dist-weapp'), { recursive: true })
    writeFileSync(path.join(root, 'dist-weapp/index.js'), 'module.exports = {}\n')
    writeFileSync(path.join(root, 'dist-weapp/plugins.js'), 'module.exports = {}\n')
  }
  return root
}

/** 覆盖 fixture 的 package.json exports（负向：示例导入的 subpath 未声明） */
function rewriteExports(root: string, exportsObject: Record<string, { types: string }>): void {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>
  pkg.exports = exportsObject
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg))
}

describe(' check-docs-examples：示例与发布产物一致', () => {
  it('页面四件套齐全、导入与 exports/dist 入口一致、README 与分包一致：通过', () => {
    const root = makeFixture()
    try {
      const result = run(root)
      expect(result.status).toBe(0)
      expect(result.output).toContain('check-docs-examples')
      expect(result.output).toContain('2 个页面')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('页面四件套缺失（分包页缺 wxml）：exit 1 并指出缺哪个文件', () => {
    const root = makeFixture()
    try {
      rmSync(path.join(root, 'examples/miniprogram/packageA/pages/cart/cart.wxml'))
      const result = run(root)
      expect(result.status).toBe(1)
      expect(result.output).toContain('packageA/pages/cart/cart.wxml')
      expect(result.output).toContain('四件套')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('dist 入口缺失：exit 1 并提示先构建', () => {
    const root = makeFixture()
    try {
      rmSync(path.join(root, 'dist-weapp/plugins.js'))
      const result = run(root)
      expect(result.status).toBe(1)
      expect(result.output).toContain('plugins.js')
      expect(result.output).toContain('pnpm run build')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('示例导入的 subpath 未在 package.json exports 声明：exit 1', () => {
    const root = makeFixture()
    try {
      rewriteExports(root, { '.': { types: './types/index.d.ts' } })
      const result = run(root)
      expect(result.status).toBe(1)
      expect(result.output).toContain('./plugins')
      expect(result.output).toContain('exports')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('README 未提及 app.json 的分包页面：exit 1 并指出不一致', () => {
    const root = makeFixture({ readme: '# demo\n\nsubPackages 声明 packageA。\n' })
    try {
      const result = run(root)
      expect(result.status).toBe(1)
      expect(result.output).toContain('README')
      expect(result.output).toContain('packageA/pages/cart/cart')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('真实仓库：示例与发布产物一致（需先 pnpm run build）', () => {
    const result = run()
    expect(result.status).toBe(0)
    expect(result.output).toContain('通过')
  })
})
