/** 发布 manifest——版本/CHANGELOG/tarball 清单与哈希/SBOM/许可证差异（不依赖网络与真实 npm） */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '../../..')
const script = path.join(repoRoot, 'scripts', 'release-manifest.mjs')

interface FakeNpmConfig {
  dryRunFiles?: string[]
  tarballName?: string
  tarballContent?: string
  jsonShape?: 'object' | 'array'
  brokenJson?: boolean
}

interface Manifest {
  schemaVersion: number
  version: string
  gitHead: string | null
  tarballSha256: string
  tarball: { name: string; sizeBytes: number; path: string }
  files: string[]
  fileCount: number
  checks: { changelogVersionHeading: boolean; tarballMatchesDeclarations: boolean }
  sbom: {
    path: string
    sha256: string
    runtimeDependencies: number
    componentCount: number
    licenses: Array<{ name: string; version: string; license: string }>
  }
  licenseChanges: {
    previousManifest: string | null
    added: Array<{ name: string; version: string; license: string }>
    removed: Array<{ name: string; version: string; license: string }>
    changed: Array<{ name: string; from: { version: string; license: string }; to: { version: string; license: string } }>
  }
}

interface FixtureOptions {
  version?: string
  changelog?: string | null
  files?: string[] | null
  omitSbom?: boolean
  sbom?: unknown
  deleteDistIndex?: boolean
  fakeNpm?: FakeNpmConfig
}

interface SbomComponent {
  name: string
  version: string
  license: string
}

function makeSbom(version: string, components: SbomComponent[], runtimeDependencies = '0'): unknown {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    metadata: {
      component: { type: 'library', name: '@fixture/release', version },
      properties: [{ name: 'tallystore:runtimeDependencies', value: runtimeDependencies }],
    },
    components: components.map((component) => ({
      type: 'library',
      name: component.name,
      version: component.version,
      'bom-ref': 'pkg:npm/' + component.name + '@' + component.version,
      scope: 'excluded',
      licenses: [{ license: { id: component.license } }],
    })),
  }
}

const DEFAULT_DEPS: SbomComponent[] = [
  { name: 'dep-a', version: '1.0.0', license: 'MIT' },
  { name: 'dep-b', version: '2.0.0', license: 'ISC' },
]

const DEFAULT_DRY_RUN_FILES = ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'types/index.d.ts']

function writeFakeNpm(dir: string, config: FakeNpmConfig): string {
  const cliPath = path.join(dir, 'fake-npm.cjs')
  const source = [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    'const config = ' +
      JSON.stringify({ dryRunFiles: DEFAULT_DRY_RUN_FILES, tarballName: 'fake-release.tgz', tarballContent: 'fake-tarball-content', ...config }),
    'const args = process.argv.slice(2)',
    "if (config.brokenJson) { console.log('not a json'); process.exit(0) }",
    "const dryRun = args.includes('--dry-run')",
    "const packDestinationIndex = args.indexOf('--pack-destination')",
    'const packDestination = packDestinationIndex === -1 ? null : args[packDestinationIndex + 1]',
    "const payload = { filename: config.tarballName, name: 'fixture', files: config.dryRunFiles.map((filePath) => ({ path: filePath })) }",
    'if (dryRun) {',
    "  console.log(JSON.stringify(config.jsonShape === 'array' ? [payload] : { fixture: payload }))",
    '  process.exit(0)',
    '}',
    'if (packDestination !== null) {',
    '  fs.writeFileSync(path.join(packDestination, config.tarballName), config.tarballContent)',
    "  console.log(JSON.stringify({ fixture: { filename: config.tarballName, name: 'fixture', files: config.dryRunFiles.map((filePath) => ({ path: filePath })) } }))",
    '  process.exit(0)',
    '}',
    "console.error('fake npm: unsupported args')",
    'process.exit(1)',
  ].join('\n')
  writeFileSync(cliPath, source)
  return cliPath
}

function makeFixture(options: FixtureOptions = {}): { dir: string; cliPath: string; manifestPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-manifest-'))
  const version = options.version ?? '1.2.3'
  mkdirSync(path.join(dir, 'dist'), { recursive: true })
  mkdirSync(path.join(dir, 'types'), { recursive: true })
  if (options.deleteDistIndex !== true) writeFileSync(path.join(dir, 'dist/index.js'), 'module.exports = 1\n')
  writeFileSync(path.join(dir, 'types/index.d.ts'), 'export declare const x: number\n')
  writeFileSync(path.join(dir, 'README.md'), '# fixture\n')
  writeFileSync(path.join(dir, 'LICENSE'), 'MIT\n')
  writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  const pkg: Record<string, unknown> = {
    name: '@fixture/release',
    version,
    license: 'MIT',
    miniprogram: 'dist',
    exports: { '.': { types: './types/index.d.ts' } },
  }
  if (options.files !== null) pkg.files = options.files ?? ['dist', 'types']
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  if (options.changelog !== null) {
    writeFileSync(path.join(dir, 'CHANGELOG.md'), options.changelog ?? '# Changelog\n\n## [' + version + '] - 2026-01-01\n\n- fixture\n')
  }
  if (options.omitSbom !== true) {
    writeFileSync(path.join(dir, 'sbom.cdx.json'), JSON.stringify(options.sbom ?? makeSbom(version, DEFAULT_DEPS), null, 2))
  }
  const cliPath = writeFakeNpm(dir, options.fakeNpm ?? {})
  return { dir, cliPath, manifestPath: path.join(dir, '.release', 'release-manifest.json') }
}

function runManifest(dir: string, cliPath: string, extraArgs: string[] = []): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [script, '--root', dir, '--npm-cli', cliPath, ...extraArgs], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failed.status ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' }
  }
}

function readManifest(manifestPath: string): Manifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
}

function sha256Of(content: Buffer | string): string {
  return require('node:crypto').createHash('sha256').update(content).digest('hex') as string
}

describe(' 发布 manifest（release-manifest.mjs）', () => {
  it('成功生成：版本/CHANGELOG/tarball 哈希/文件清单/SBOM/licenseChanges 形状完整', () => {
    const fixture = makeFixture()
    try {
      const result = runManifest(fixture.dir, fixture.cliPath)
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      const manifest = readManifest(fixture.manifestPath)
      expect(manifest.version).toBe('1.2.3')
      expect(manifest.gitHead).toBeNull() // 夹具不是 git 仓库
      expect(manifest.tarballSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(manifest.files).toEqual([...DEFAULT_DRY_RUN_FILES].sort())
      expect(manifest.fileCount).toBe(DEFAULT_DRY_RUN_FILES.length)
      expect(manifest.checks).toEqual({ changelogVersionHeading: true, tarballMatchesDeclarations: true })
      expect(manifest.tarball.name).toBe('fake-release.tgz')
      // 哈希与落盘 tarball 一致
      const tarballPath = path.join(fixture.dir, '.release', manifest.tarball.name)
      expect(manifest.tarballSha256).toBe(sha256Of(readFileSync(tarballPath)))
      expect(manifest.tarball.sizeBytes).toBe(statSync(tarballPath).size)
      expect(manifest.sbom.runtimeDependencies).toBe(0)
      expect(manifest.sbom.componentCount).toBe(2)
      expect(manifest.sbom.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(manifest.licenseChanges.previousManifest).toBeNull()
      expect(manifest.licenseChanges.added.map((entry) => entry.name)).toEqual(['dep-a', 'dep-b'])
      // .release 内自忽略，避免发布产物入库
      expect(readFileSync(path.join(fixture.dir, '.release', '.gitignore'), 'utf8')).toBe('*\n')
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('对比上一份 manifest：许可证 added/removed/changed 正确', () => {
    const fixture = makeFixture()
    try {
      expect(runManifest(fixture.dir, fixture.cliPath).status).toBe(0)
      writeFileSync(
        path.join(fixture.dir, 'sbom.cdx.json'),
        JSON.stringify(
          makeSbom('1.2.3', [
            { name: 'dep-a', version: '2.0.0', license: 'Apache-2.0' },
            { name: 'dep-c', version: '3.0.0', license: 'MIT' },
          ]),
        ),
      )
      const result = runManifest(fixture.dir, fixture.cliPath)
      expect(result.status).toBe(0)
      const manifest = readManifest(fixture.manifestPath)
      expect(manifest.licenseChanges.previousManifest).toContain('release-manifest.json')
      expect(manifest.licenseChanges.added.map((entry) => entry.name)).toEqual(['dep-c'])
      expect(manifest.licenseChanges.removed.map((entry) => entry.name)).toEqual(['dep-b'])
      expect(manifest.licenseChanges.changed).toEqual([
        { name: 'dep-a', from: { version: '1.0.0', license: 'MIT' }, to: { version: '2.0.0', license: 'Apache-2.0' } },
      ])
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('tarball 出现多余文件 → 退出码 1（ 验收 3：无多余文件）', () => {
    const fixture = makeFixture({ fakeNpm: { dryRunFiles: [...DEFAULT_DRY_RUN_FILES, 'stray.txt'] } })
    try {
      const result = runManifest(fixture.dir, fixture.cliPath)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('多余')
      expect(result.stderr).toContain('stray.txt')
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('tarball 缺少声明文件 → 退出码 1', () => {
    const fixture = makeFixture({ fakeNpm: { dryRunFiles: DEFAULT_DRY_RUN_FILES.filter((file) => file !== 'types/index.d.ts') } })
    try {
      const result = runManifest(fixture.dir, fixture.cliPath)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('缺少')
      expect(result.stderr).toContain('types/index.d.ts')
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('兼容旧版 npm 的数组形态 pack JSON', () => {
    const fixture = makeFixture({ fakeNpm: { jsonShape: 'array' } })
    try {
      expect(runManifest(fixture.dir, fixture.cliPath).status).toBe(0)
      expect(readManifest(fixture.manifestPath).version).toBe('1.2.3')
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('CHANGELOG 缺对应版本标题 → 退出码 1', () => {
    const fixture = makeFixture({ changelog: '# Changelog\n\n## [Unreleased]\n\n- wip\n' })
    try {
      const result = runManifest(fixture.dir, fixture.cliPath)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('CHANGELOG')
      expect(result.stderr).toContain('1.2.3')
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('兼容不带方括号的版本标题（## 1.2.3）', () => {
    const fixture = makeFixture({ changelog: '# Changelog\n\n## 1.2.3 - 2026-01-01\n\n- fixture\n' })
    try {
      expect(runManifest(fixture.dir, fixture.cliPath).status).toBe(0)
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('缺少 files 白名单 → 退出码 1（包内容最小化）', () => {
    const fixture = makeFixture({ files: null })
    try {
      const result = runManifest(fixture.dir, fixture.cliPath)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('files')
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('发布声明产物缺失 → 退出码 1（先 build 的可诊断错误）', () => {
    const fixture = makeFixture({ deleteDistIndex: true })
    try {
      const result = runManifest(fixture.dir, fixture.cliPath)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('缺少发布声明产物')
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('SBOM 缺失时自动调用 scripts/sbom.mjs 生成', () => {
    const fixture = makeFixture({ omitSbom: true })
    try {
      const result = runManifest(fixture.dir, fixture.cliPath)
      expect(result.status).toBe(0)
      expect(readFileSync(path.join(fixture.dir, 'sbom.cdx.json'), 'utf8')).toContain('CycloneDX')
      const manifest = readManifest(fixture.manifestPath)
      expect(manifest.sbom.componentCount).toBe(0)
      expect(manifest.sbom.runtimeDependencies).toBe(0)
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('SBOM 运行时依赖非 0 → 退出码 1（零运行时依赖契约）', () => {
    const fixture = makeFixture({
      sbom: makeSbom('1.2.3', DEFAULT_DEPS, '1'),
    })
    try {
      const result = runManifest(fixture.dir, fixture.cliPath)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('运行时依赖必须为 0')
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('SBOM 版本与 package.json 不一致 → 退出码 1', () => {
    const fixture = makeFixture({ sbom: makeSbom('9.9.9', DEFAULT_DEPS) })
    try {
      const result = runManifest(fixture.dir, fixture.cliPath)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('不一致')
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('npm pack JSON 输出损坏 → 退出码 1 且可诊断', () => {
    const fixture = makeFixture({ fakeNpm: { brokenJson: true } })
    try {
      const result = runManifest(fixture.dir, fixture.cliPath)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('不是合法 JSON')
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })
})
