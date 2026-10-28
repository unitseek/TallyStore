/** 供应链——SBOM 结构与许可证扫描、可复现构建校验 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const root = path.resolve(__dirname, '../../..')

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

const run = (script: string, args: string[] = []): RunResult => {
  try {
    const stdout = execFileSync(process.execPath, [path.join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8' })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failed.status ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' }
  }
}

interface BomLicense {
  license?: { id: string }
  expression?: string
}

interface BomComponent {
  name: string
  version: string
  scope: string
  'bom-ref': string
  purl?: string
  licenses: BomLicense[]
}

interface Bom {
  bomFormat: string
  specVersion: string
  metadata: {
    component: { name: string; version: string; 'bom-ref': string; purl: string; licenses: BomLicense[] }
    properties: Array<{ name: string; value: string }>
  }
  components: BomComponent[]
}

interface FixtureDependency {
  version?: string
  manifest?: Record<string, unknown>
  /** 直接写入的原始 manifest 文本（用于构造损坏 JSON 的夹具） */
  rawManifest?: string
}

interface FixtureOptions {
  rootName?: string
  /** null 表示 package.json 不写 license 字段 */
  rootLicense?: string | null
  dependencies?: Record<string, string>
  devDependencies: Record<string, FixtureDependency>
}

const readBom = (file: string): Bom => JSON.parse(readFileSync(file, 'utf8')) as Bom

const expectedPurl = (name: string, version: string): string =>
  'pkg:npm/' +
  name
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/') +
  '@' +
  version

/** 生成 SBOM 测试夹具根（--root）：package.json + node_modules + pnpm-lock.yaml */
function makeFixture(options: FixtureOptions): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbom-fixture-'))
  const packageJson: Record<string, unknown> = {
    name: options.rootName ?? '@fixture/root',
    version: '1.2.3',
    devDependencies: Object.fromEntries(Object.entries(options.devDependencies).map(([name, dependency]) => [name, dependency.version ?? '1.0.0'])),
  }
  const license = options.rootLicense === undefined ? 'MIT' : options.rootLicense
  if (license !== null) {
    packageJson.license = license
  }
  if (options.dependencies !== undefined) {
    packageJson.dependencies = options.dependencies
  }
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(packageJson, null, 2))
  writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  for (const [name, dependency] of Object.entries(options.devDependencies)) {
    const manifestDir = path.join(dir, 'node_modules', name)
    mkdirSync(manifestDir, { recursive: true })
    writeFileSync(
      path.join(manifestDir, 'package.json'),
      dependency.rawManifest ?? JSON.stringify({ name, version: dependency.version ?? '1.0.0', ...dependency.manifest }, null, 2),
    )
  }
  return dir
}

describe(' SBOM 生成与许可证扫描', () => {
  const output = path.join(root, 'sbom.test.cdx.json')

  afterEach(() => {
    if (existsSync(output)) {
      rmSync(output)
    }
  })

  it('仓库依赖：根组件 license 派生、purl scoped 编码、零运行时依赖', () => {
    const result = run('sbom.mjs', [output])
    expect(result.status).toBe(0)
    const bom = readBom(output)
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      name: string
      version: string
      license: string
      dependencies?: Record<string, string>
    }

    expect(bom.bomFormat).toBe('CycloneDX')
    expect(bom.specVersion).toBe('1.5')
    expect(bom.metadata.component.name).toBe(pkg.name)
    expect(bom.metadata.component.version).toBe(pkg.version)
    // 根组件 license 从 package.json 派生，不再硬编码
    expect(bom.metadata.component.licenses[0].license?.id).toBe(pkg.license)
    // purl：scoped 包名的 @ 编码为 %40（根组件 + 依赖）
    const rootPurl = expectedPurl(pkg.name, pkg.version)
    expect(rootPurl).toContain('%40')
    expect(bom.metadata.component['bom-ref']).toBe(rootPurl)
    expect(bom.metadata.component.purl).toBe(rootPurl)

    // 零运行时依赖的声明属性从 package.json 计算
    expect(bom.metadata.properties.find((prop) => prop.name === 'tallystore:runtimeDependencies')?.value).toBe(
      String(Object.keys(pkg.dependencies ?? {}).length),
    )
    expect(bom.metadata.properties.find((prop) => prop.name === 'tallystore:runtimeDependencies')?.value).toBe('0')
    expect(bom.metadata.properties.find((prop) => prop.name === 'tallystore:lockfileSha256')?.value).toMatch(/^[a-f0-9]{64}$/)

    // 开发依赖全部 excluded 且许可证在白名单
    expect(bom.components.length).toBeGreaterThanOrEqual(5)
    for (const component of bom.components) {
      expect(component.scope).toBe('excluded')
      expect(component['bom-ref']).not.toContain('pkg:npm/@')
      expect(component['bom-ref']).toBe(expectedPurl(component.name, component.version))
    }
    const typesJest = bom.components.find((component) => component.name === '@types/jest')
    expect(typesJest?.['bom-ref']).toContain('pkg:npm/%40types/jest@')
  })

  it('夹具：license 解析支持 string / object.type / legacy licenses 数组，SPDX OR/AND 语义通过', () => {
    const fixture = makeFixture({
      rootName: '@scope/root',
      rootLicense: 'Apache-2.0',
      devDependencies: {
        'pkg-string': { manifest: { license: 'MIT' } },
        'pkg-object': { manifest: { license: { type: 'ISC' } } },
        'pkg-legacy': { manifest: { licenses: [{ type: 'BSD-3-Clause' }] } },
        'pkg-or': { manifest: { license: 'GPL-3.0-only OR MIT' } },
        'pkg-and': { manifest: { license: 'MIT AND ISC' } },
        '@scope/pkg': { manifest: { license: 'Apache-2.0' } },
      },
    })
    const outputPath = path.join(fixture, 'sbom.cdx.json')
    try {
      const result = run('sbom.mjs', ['--root', fixture, outputPath])
      expect(result.status).toBe(0)
      const bom = readBom(outputPath)

      // 根组件 license 来自夹具 package.json
      expect(bom.metadata.component.licenses[0].license?.id).toBe('Apache-2.0')
      expect(bom.metadata.component.name).toBe('@scope/root')
      expect(bom.metadata.component['bom-ref']).toBe('pkg:npm/%40scope/root@1.2.3')
      expect(bom.metadata.properties.find((prop) => prop.name === 'tallystore:runtimeDependencies')?.value).toBe('0')

      const byName = new Map(bom.components.map((component) => [component.name, component] as const))
      expect(byName.get('pkg-string')?.licenses[0].license?.id).toBe('MIT')
      expect(byName.get('pkg-object')?.licenses[0].license?.id).toBe('ISC')
      // legacy licenses 数组 → 单一标识
      expect(byName.get('pkg-legacy')?.licenses[0].license?.id).toBe('BSD-3-Clause')
      // SPDX 表达式：OR 任一允许即通过，以 CycloneDX expression 输出
      expect(byName.get('pkg-or')?.licenses[0].expression).toBe('GPL-3.0-only OR MIT')
      expect(byName.get('pkg-and')?.licenses[0].expression).toBe('MIT AND ISC')
      // scoped 依赖 purl 编码
      expect(byName.get('@scope/pkg')?.['bom-ref']).toBe('pkg:npm/%40scope/pkg@1.0.0')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('夹具：非白名单许可证 / AND 含不允许分支 → 退出码 1 并列出依赖', () => {
    const fixture = makeFixture({
      devDependencies: {
        'pkg-gpl': { manifest: { license: 'GPL-3.0-only' } },
        'pkg-and-bad': { manifest: { license: 'MIT AND GPL-3.0-only' } },
        'pkg-ok': { manifest: { license: 'MIT' } },
      },
    })
    const outputPath = path.join(fixture, 'sbom.cdx.json')
    try {
      const result = run('sbom.mjs', ['--root', fixture, outputPath])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('pkg-gpl')
      expect(result.stderr).toContain('pkg-and-bad')
      expect(result.stderr).not.toContain('pkg-ok')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('夹具：运行时依赖非零 → 退出码 1 且不生成 BOM', () => {
    const fixture = makeFixture({
      dependencies: { 'left-pad': '^1.0.0' },
      devDependencies: { 'pkg-ok': { manifest: { license: 'MIT' } } },
    })
    const outputPath = path.join(fixture, 'sbom.cdx.json')
    try {
      const result = run('sbom.mjs', ['--root', fixture, outputPath])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('运行时依赖')
      expect(result.stderr).toContain('left-pad')
      expect(existsSync(outputPath)).toBe(false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('夹具：根组件缺失 license → 退出码 1，不写失真 BOM', () => {
    const fixture = makeFixture({
      rootLicense: null,
      devDependencies: { 'pkg-ok': { manifest: { license: 'MIT' } } },
    })
    const outputPath = path.join(fixture, 'sbom.cdx.json')
    try {
      const result = run('sbom.mjs', ['--root', fixture, outputPath])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('license')
      expect(existsSync(outputPath)).toBe(false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('夹具：开发依赖未安装 → 退出码 1（不产出无法解析的 purl/假 license）', () => {
    const fixture = makeFixture({ devDependencies: {} })
    const packagePath = path.join(fixture, 'package.json')
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>
    packageJson.devDependencies = { 'not-installed': '^1.0.0' }
    writeFileSync(packagePath, JSON.stringify(packageJson))
    const outputPath = path.join(fixture, 'sbom.cdx.json')
    try {
      const result = run('sbom.mjs', ['--root', fixture, outputPath])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('未安装')
      expect(existsSync(outputPath)).toBe(false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('夹具：依赖 manifest 损坏 → 退出码 1 且点名依赖', () => {
    const fixture = makeFixture({
      devDependencies: { 'pkg-broken': { rawManifest: '{ "name": "pkg-broken", ' } },
    })
    const outputPath = path.join(fixture, 'sbom.cdx.json')
    try {
      const result = run('sbom.mjs', ['--root', fixture, outputPath])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('pkg-broken')
      expect(result.stderr).toContain('无法解析')
      expect(existsSync(outputPath)).toBe(false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('夹具：缺少 pnpm-lock.yaml → 退出码 1 且明确提示', () => {
    const fixture = makeFixture({ devDependencies: { 'pkg-ok': { manifest: { license: 'MIT' } } } })
    rmSync(path.join(fixture, 'pnpm-lock.yaml'))
    const outputPath = path.join(fixture, 'sbom.cdx.json')
    try {
      const result = run('sbom.mjs', ['--root', fixture, outputPath])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('pnpm-lock.yaml')
      expect(existsSync(outputPath)).toBe(false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('夹具：许可证不兼容时不落盘 BOM', () => {
    const fixture = makeFixture({ devDependencies: { 'pkg-gpl': { manifest: { license: 'GPL-3.0-only' } } } })
    const outputPath = path.join(fixture, 'sbom.cdx.json')
    try {
      const result = run('sbom.mjs', ['--root', fixture, outputPath])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('pkg-gpl')
      expect(existsSync(outputPath)).toBe(false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('夹具：输出目录不存在 → 退出码 1 且给出写入失败诊断', () => {
    const fixture = makeFixture({ devDependencies: { 'pkg-ok': { manifest: { license: 'MIT' } } } })
    const outputPath = path.join(fixture, 'missing-dir', 'sbom.cdx.json')
    try {
      const result = run('sbom.mjs', ['--root', fixture, outputPath])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('写入 SBOM 失败')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('夹具：根组件缺少 name/version → 退出码 1 且给出可诊断错误', () => {
    const cases: Array<{ field: 'name' | 'version'; label: string }> = [
      { field: 'version', label: 'version' },
      { field: 'name', label: 'name' },
    ]
    for (const { field, label } of cases) {
      const fixture = makeFixture({ devDependencies: { 'pkg-ok': { manifest: { license: 'MIT' } } } })
      const packagePath = path.join(fixture, 'package.json')
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>
      delete packageJson[field]
      writeFileSync(packagePath, JSON.stringify(packageJson))
      const outputPath = path.join(fixture, 'sbom.cdx.json')
      try {
        const result = run('sbom.mjs', ['--root', fixture, outputPath])
        expect(result.status).toBe(1)
        expect(result.stderr).toContain(label)
        expect(existsSync(outputPath)).toBe(false)
      } finally {
        rmSync(fixture, { recursive: true, force: true })
      }
    }
  })

  it('夹具：根组件 license 非白名单 → 退出码 1，不产出成功 BOM', () => {
    const fixture = makeFixture({
      rootLicense: 'GPL-3.0-only',
      devDependencies: { 'pkg-ok': { manifest: { license: 'MIT' } } },
    })
    const outputPath = path.join(fixture, 'sbom.cdx.json')
    try {
      const result = run('sbom.mjs', ['--root', fixture, outputPath])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('根组件')
      expect(existsSync(outputPath)).toBe(false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})

describe(' 可复现构建', () => {
  it('两次 build:weapp 后 dist-weapp 逐文件 sha256 一致', () => {
    const result = run('check-reproducible.mjs')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('全部一致')
  }, 120000)
})

/** 产物是 CJS，必须自带 package.json 声明，否则根 package.json 的 type: module 会覆盖它 */
describe(' 发布产物 CJS 声明', () => {
  it('build-weapp 生成 dist-weapp/package.json 声明 commonjs', () => {
    const manifestPath = path.join(root, 'dist-weapp', 'package.json')
    expect(existsSync(manifestPath)).toBe(true)
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual({ type: 'commonjs' })
  })

  it('Node 可经产物内声明按 CJS 直接加载 dist-weapp（无需临时目录重写）', () => {
    const requireFromRepo = createRequire(pathToFileURL(path.join(root, 'package.json')).href)
    // 若产物缺 package.json（{"type":"commonjs"}），根 type: module 会让该 require 抛 ERR_REQUIRE_ESM
    const entry = requireFromRepo('./dist-weapp/index.js') as { createStore?: unknown }
    expect(typeof entry.createStore).toBe('function')
  })
})

/** API 表面门禁（与可复现构建同文件串行执行——两者都依赖/重建 dist-weapp） */
describe(' API 表面门禁', () => {
  it('当前表面与提交快照一致（--check 通过）', () => {
    const result = run('api-report.mjs', ['--check'])
    expect(result.status).toBe(0)
    expect(result.stdout + result.stderr).toContain('与快照一致')
  })

  it('快照缺失一个导出时 --check 失败并指出当前新增项', () => {
    const snapshotPath = path.join(root, 'scripts', 'api-snapshot.json')
    const original = readFileSync(snapshotPath, 'utf8')
    const tampered = JSON.parse(original) as { surface: Record<string, string[]> }
    tampered.surface['.'] = tampered.surface['.'].filter((name) => name !== 'defineStores')
    try {
      writeFileSync(snapshotPath, JSON.stringify(tampered))
      const result = run('api-report.mjs', ['--check'])
      expect(result.status).toBe(1)
      expect(result.stderr + result.stdout).toContain('+ . → defineStores')
    } finally {
      writeFileSync(snapshotPath, original)
    }
    expect(run('api-report.mjs', ['--check']).status).toBe(0)
  })

  it('--check 退出后不残留 tallystore-api-* 临时目录', () => {
    const tempDirs = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith('tallystore-api-'))
    const before = tempDirs().length
    const result = run('api-report.mjs', ['--check'])
    expect(result.status).toBe(0)
    // process.exit 绕过 finally 时该断言失败（每个退出路径泄漏 1 个目录）
    expect(tempDirs().length).toBe(before)
  })
})

/**  门禁健壮性：坏快照/版本过期要给可诊断错误；快照键顺序不应影响判定 */
describe(' API 门禁健壮性', () => {
  const snapshotPath = path.join(root, 'scripts', 'api-snapshot.json')

  const withSnapshot = (mutate: (snapshot: { version: string; surface: Record<string, string[]> }) => void, assertion: () => void): void => {
    const original = readFileSync(snapshotPath, 'utf8')
    try {
      const snapshot = JSON.parse(original) as { version: string; surface: Record<string, string[]> }
      mutate(snapshot)
      writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2))
      assertion()
    } finally {
      writeFileSync(snapshotPath, original)
    }
  }

  it('快照键顺序变化不误报', () => {
    withSnapshot(
      (snapshot) => {
        snapshot.surface = Object.fromEntries(Object.entries(snapshot.surface).reverse())
      },
      () => {
        const result = run('api-report.mjs', ['--check'])
        expect(result.status).toBe(0)
        expect(result.stdout + result.stderr).toContain('与快照一致')
      },
    )
  })

  it('快照 JSON 损坏 → 退出码 1 且给出可诊断信息', () => {
    const original = readFileSync(snapshotPath, 'utf8')
    try {
      writeFileSync(snapshotPath, '{ not-valid-json ')
      const result = run('api-report.mjs', ['--check'])
      expect(result.status).toBe(1)
      expect(result.stderr + result.stdout).toContain('不是合法 JSON')
    } finally {
      writeFileSync(snapshotPath, original)
    }
  })

  it('快照 version 过期 → 退出码 1 并提示重新生成', () => {
    withSnapshot(
      (snapshot) => {
        snapshot.version = '0.0.0'
      },
      () => {
        const result = run('api-report.mjs', ['--check'])
        expect(result.status).toBe(1)
        expect(result.stderr + result.stdout).toContain('version')
      },
    )
  })

  it('快照 surface 条目不是字符串数组 → 退出码 1 且给出可诊断错误', () => {
    const original = readFileSync(snapshotPath, 'utf8')
    try {
      const snapshot = JSON.parse(original) as { version: string; surface: Record<string, unknown> }
      snapshot.surface['Store.prototype'] = 'batch'
      writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2))
      const result = run('api-report.mjs', ['--check'])
      expect(result.status).toBe(1)
      expect(result.stderr + result.stdout).toContain('字符串数组')
    } finally {
      writeFileSync(snapshotPath, original)
    }
  })
})
