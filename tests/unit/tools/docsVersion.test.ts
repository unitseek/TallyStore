/**  版本化文档门禁：scripts/check-docs-version.mjs 正/负向 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const script = path.resolve(__dirname, '../../../scripts/check-docs-version.mjs')

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

interface FixtureOptions {
  packageVersion?: string
  current?: string | null
  withVersionDir?: boolean
  versionsReadme?: string
  docsIndex?: string
}

/** 构造最小版本化文档仓库；各字段可覆盖以制造负向场景 */
function makeFixture(options: FixtureOptions = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'docs-version-'))
  const version = options.packageVersion ?? '1.2.3'
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version }))
  mkdirSync(path.join(root, 'docs/versions/v1.2'), { recursive: true })
  if (options.withVersionDir !== false) {
    writeFileSync(path.join(root, 'docs/versions/v1.2/README.md'), '# v1.2 文档入口\n')
  }
  if (options.current !== null) {
    writeFileSync(path.join(root, 'docs/versions/current.json'), JSON.stringify({ current: options.current ?? version }))
  }
  writeFileSync(path.join(root, 'docs/versions/README.md'), options.versionsReadme ?? '# 版本化文档\n\n| v1.2 | [v1.2](./v1.2/README.md) |\n')
  writeFileSync(
    path.join(root, 'docs/README.md'),
    options.docsIndex ?? '# 文档索引\n\n- [MIGRATION](./MIGRATION.md)\n- [RELEASE](./RELEASE.md)\n- [TEAM-RULES](./TEAM-RULES.md)\n',
  )
  return root
}

describe(' check-docs-version：版本化文档一致性', () => {
  it('版本一致、版本目录存在、文档索引完整：通过', () => {
    const root = makeFixture()
    try {
      const result = run(root)
      expect(result.status).toBe(0)
      expect(result.output).toContain('check-docs-version')
      expect(result.output).toContain('v1.2')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('package.json 与 current.json 版本不一致：exit 1 并指出两处值', () => {
    const root = makeFixture({ packageVersion: '1.2.3', current: '9.9.9' })
    try {
      const result = run(root)
      expect(result.status).toBe(1)
      expect(result.output).toContain('不一致')
      expect(result.output).toContain('1.2.3')
      expect(result.output).toContain('9.9.9')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('缺少当前版本目录：exit 1 并指出版本入口缺失', () => {
    const root = makeFixture({ withVersionDir: false })
    try {
      const result = run(root)
      expect(result.status).toBe(1)
      expect(result.output).toContain('docs/versions/v1.2/README.md')
      expect(result.output).toContain('缺失')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('缺少 current.json：exit 1', () => {
    const root = makeFixture({ current: null })
    try {
      const result = run(root)
      expect(result.status).toBe(1)
      expect(result.output).toContain('current.json')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('docs/README.md 索引缺 TEAM-RULES 链接：exit 1', () => {
    const root = makeFixture({ docsIndex: '# 文档索引\n\n- [MIGRATION](./MIGRATION.md)\n- [RELEASE](./RELEASE.md)\n' })
    try {
      const result = run(root)
      expect(result.status).toBe(1)
      expect(result.output).toContain('TEAM-RULES.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('真实仓库：当前版本化文档通过门禁', () => {
    const result = run()
    expect(result.status).toBe(0)
    expect(result.output).toContain('通过')
  })
})
