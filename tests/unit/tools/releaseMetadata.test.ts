/** 类型/发布批：发布面元数据（typesVersions 回退）、Issue 模板必填项与发布元数据校验 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = path.resolve(__dirname, '../../..')
const metadataScript = path.join(root, 'scripts', 'check-release-metadata.mjs')

interface MetadataResult {
  ok: boolean
  version: string
  tag: string | null
  problems: string[]
  warnings: string[]
}

interface MetadataFixtureOptions {
  version?: string
  changelog?: string | null
  notes?: string
}

const DEFAULT_NOTES = '# Release Notes\n\n## 变更\n\n- 新增\n\n## 迁移\n\n- 升级步骤\n\n## 已知问题\n\n- 无\n\n## 支持窗口\n\n- 当前与上一 minor\n'

function makeMetadataFixture(options: MetadataFixtureOptions = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-metadata-'))
  const version = options.version ?? '2.0.0'
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@fixture/meta', version, license: 'MIT' }, null, 2))
  if (options.changelog !== null) {
    writeFileSync(path.join(dir, 'CHANGELOG.md'), options.changelog ?? '# Changelog\n\n## [' + version + '] - 2026-02-01\n\n- fixture\n')
  }
  mkdirSync(path.join(dir, 'docs'), { recursive: true })
  writeFileSync(path.join(dir, 'docs', 'RELEASE-NOTES-TEMPLATE.md'), options.notes ?? DEFAULT_NOTES)
  return dir
}

function runMetadata(targetRoot: string, args: string[] = []): { status: number; result: MetadataResult; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [metadataScript, '--root', targetRoot, '--json', ...args], {
      cwd: root,
      encoding: 'utf8',
    })
    return { status: 0, result: JSON.parse(stdout) as MetadataResult, stdout, stderr: '' }
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string }
    const stdout = failed.stdout ?? ''
    return { status: failed.status ?? -1, result: JSON.parse(stdout) as MetadataResult, stdout, stderr: failed.stderr ?? '' }
  }
}

interface ExportsEntry {
  types?: string
}

interface PackageManifest {
  name: string
  version: string
  types: string
  files: string[]
  exports: Record<string, ExportsEntry>
  typesVersions?: Record<string, Record<string, string[]>>
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageManifest

describe('发布面元数据', () => {
  it('typesVersions 为每个 exports 子路径提供经典 node 解析回退，条数与 exports 子路径一致', () => {
    const mapping = pkg.typesVersions?.['*']
    expect(mapping).toBeDefined()
    const subpaths = Object.keys(pkg.exports).filter((key) => key !== '.' && key !== './package.json')
    expect(subpaths.length).toBeGreaterThanOrEqual(3)
    for (const key of subpaths) {
      const subpath = key.replace(/^\.\//, '')
      const types = pkg.exports[key]?.types
      expect(typeof types).toBe('string')
      expect(mapping?.[subpath]).toEqual([(types as string).replace(/^\.\//, '')])
    }
  })

  it('typesVersions 的目标 .d.ts 在 types/ 产物中真实存在（构建后）', () => {
    const mapping = pkg.typesVersions?.['*'] ?? {}
    expect(Object.keys(mapping).length).toBeGreaterThanOrEqual(3)
    if (!existsSync(path.join(root, 'types'))) {
      return // types/ 是构建产物；未构建时由 CI 的 build 步骤保证（此处仅静态一致性）
    }
    for (const targets of Object.values(mapping)) {
      for (const target of targets) {
        expect(existsSync(path.join(root, target))).toBe(true)
      }
    }
  })

  it('npm files 白名单覆盖 dist-weapp 与 types 两个发布目录', () => {
    expect(pkg.files).toEqual(expect.arrayContaining(['dist-weapp', 'types']))
    expect(pkg.types).toBe('types/index.d.ts')
  })
})

describe('Issue 模板必填项', () => {
  const template = readFileSync(path.join(root, '.github/ISSUE_TEMPLATE/bug_report.yml'), 'utf8')
  const sectionFor = (id: string): string => {
    const start = template.indexOf('id: ' + id)
    expect(start).toBeGreaterThanOrEqual(0)
    const next = template.indexOf('id: ', start + 'id: '.length)
    return template.slice(start, next === -1 ? undefined : next)
  }

  it('开发者工具版本为可选，库版本与基础库版本仍必填', () => {
    expect(sectionFor('library-version')).toContain('required: true')
    expect(sectionFor('base-library-version')).toContain('required: true')
    expect(sectionFor('devtools-version')).not.toContain('required: true')
  })
})

describe(' 发布元数据校验（check-release-metadata.mjs）', () => {
  it('仓库根 dry-run：通过且无 --tag 仅 warning（exit 0）', () => {
    const result = runMetadata(root)
    expect(result.status).toBe(0)
    expect(result.result.ok).toBe(true)
    expect(result.result.version).toBe('0.1.0')
    expect(result.result.tag).toBeNull()
    expect(result.result.warnings.length).toBeGreaterThanOrEqual(1)
    expect(result.result.warnings.join(' ')).toContain('--tag')
  })

  it('夹具：版本/CHANGELOG/notes 齐备时 dry-run 通过；带匹配 tag 也通过', () => {
    const fixture = makeMetadataFixture()
    try {
      const dryRun = runMetadata(fixture)
      expect(dryRun.status).toBe(0)
      expect(dryRun.result.ok).toBe(true)
      const tagged = runMetadata(fixture, ['--tag', 'v2.0.0'])
      expect(tagged.status).toBe(0)
      expect(tagged.result.tag).toBe('v2.0.0')
      const expected = runMetadata(fixture, ['--expect-version', '2.0.0'])
      expect(expected.result.ok).toBe(true)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('夹具：tag 与版本不匹配 → 失败', () => {
    const fixture = makeMetadataFixture()
    try {
      const result = runMetadata(fixture, ['--tag', 'v1.0.0'])
      expect(result.status).toBe(1)
      expect(result.result.ok).toBe(false)
      expect(result.result.problems.join(' ')).toContain('tag')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('夹具：正式发布 --require-tag 缺 tag → 失败', () => {
    const fixture = makeMetadataFixture()
    try {
      const result = runMetadata(fixture, ['--require-tag'])
      expect(result.status).toBe(1)
      expect(result.result.problems.join(' ')).toContain('--tag')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('夹具：期望版本与 package.json 不一致 → 失败', () => {
    const fixture = makeMetadataFixture()
    try {
      const result = runMetadata(fixture, ['--expect-version', '3.0.0'])
      expect(result.status).toBe(1)
      expect(result.result.problems.join(' ')).toContain('期望发布的版本')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('夹具：非法 semver → 失败', () => {
    const fixture = makeMetadataFixture({ version: 'abc' })
    try {
      const result = runMetadata(fixture)
      expect(result.status).toBe(1)
      expect(result.result.problems.join(' ')).toContain('semver')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('夹具：CHANGELOG 缺对应版本标题 → 失败', () => {
    const fixture = makeMetadataFixture({ changelog: '# Changelog\n\n## [Unreleased]\n\n- wip\n' })
    try {
      const result = runMetadata(fixture)
      expect(result.status).toBe(1)
      expect(result.result.problems.join(' ')).toContain('CHANGELOG')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('夹具：Release Notes 缺必需段 → 失败并列出缺段', () => {
    const fixture = makeMetadataFixture({ notes: '# Release Notes\n\n## 变更\n\n- 只有变更\n\n## 迁移\n\n- x\n\n## 已知问题\n\n- y\n' })
    try {
      const result = runMetadata(fixture)
      expect(result.status).toBe(1)
      expect(result.result.problems.join(' ')).toContain('Release Notes')
      expect(result.result.problems.join(' ')).toContain('支持窗口')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('夹具：自定义 --notes 文件同样校验四要素', () => {
    const fixture = makeMetadataFixture()
    const notesPath = path.join(fixture, 'custom-notes.md')
    try {
      writeFileSync(notesPath, DEFAULT_NOTES)
      expect(runMetadata(fixture, ['--notes', notesPath]).status).toBe(0)
      writeFileSync(notesPath, '# 只有变更\n\n## 变更\n\n- x\n')
      const result = runMetadata(fixture, ['--notes', notesPath])
      expect(result.status).toBe(1)
      expect(result.result.problems.join(' ')).toContain('已知问题')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
