/** scripts/publish-entries.mjs：路径规范化 / 单文件入口 / 条件目标 / 去重 / 配置错误诊断（low backlog 批） */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = path.resolve(__dirname, '../../..')
const moduleUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'publish-entries.mjs')).href

interface RuntimeEntry {
  key: string
  file: string
}

interface PublishResult {
  distDir: string
  runtimeFiles: string[]
  runtimeEntries: RuntimeEntry[]
  typeFiles: string[]
}

interface DriverResult {
  publish?: PublishResult
  resolved?: string
  typesOutDir?: string
  error?: string
}

/** 在临时目录里运行 ESM 驱动脚本（可附带 package.json 与额外参数），返回其 JSON 输出 */
function runDriver(lines: string[], options: { pkg?: Record<string, unknown> | string; args?: string[] } = {}): DriverResult {
  const dir = mkdtempSync(path.join(tmpdir(), 'publish-entries-'))
  try {
    if (options.pkg !== undefined) {
      writeFileSync(path.join(dir, 'package.json'), typeof options.pkg === 'string' ? options.pkg : JSON.stringify(options.pkg, null, 2))
    }
    const driverPath = path.join(dir, 'driver.mjs')
    writeFileSync(driverPath, lines.join('\n'))
    const output = execFileSync(process.execPath, [driverPath, dir, ...(options.args ?? [])], { encoding: 'utf8' })
    return JSON.parse(output) as DriverResult
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const driverErrorCatch = ['} catch (error) {', '  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))', '}']

/** 调用 publishEntries 并输出 JSON */
function callPublishEntries(pkg: Record<string, unknown> | string): DriverResult {
  return runDriver(
    [
      'import { loadPackage, publishEntries } from ' + JSON.stringify(moduleUrl),
      'try {',
      '  console.log(JSON.stringify({ publish: publishEntries(loadPackage(process.argv[2])) }))',
      ...driverErrorCatch,
    ],
    { pkg },
  )
}

/** 调用 resolveInsideRepo（参数经 argv[3] 传入） */
function callResolveInsideRepo(relative: string): DriverResult {
  return runDriver(
    [
      'import { resolveInsideRepo } from ' + JSON.stringify(moduleUrl),
      'try {',
      '  console.log(JSON.stringify({ resolved: resolveInsideRepo(process.argv[3], "test") }))',
      ...driverErrorCatch,
    ],
    { args: [relative] },
  )
}

/** 调用 resolveTypesOutDir（参数经 argv[3] 传入） */
function callResolveTypesOutDir(root: string): DriverResult {
  return runDriver(
    [
      'import { resolveTypesOutDir } from ' + JSON.stringify(moduleUrl),
      'try {',
      '  console.log(JSON.stringify({ typesOutDir: resolveTypesOutDir(process.argv[3]) }))',
      ...driverErrorCatch,
    ],
    { args: [root] },
  )
}

const baseManifest = (extra: Record<string, unknown>): Record<string, unknown> => ({
  name: '@fixture/pkg',
  version: '1.2.3',
  miniprogram: 'dist-weapp',
  exports: {
    '.': { types: './types/index.d.ts' },
    './plugins': { types: './types/plugins.d.ts' },
  },
  ...extra,
})

describe('publish-entries 发布面清单（low backlog 批）', () => {
  it('目录形态：前导 ./ 归一化，exports 子路径按 key 推导运行时文件', () => {
    const result = callPublishEntries(baseManifest({ miniprogram: './dist-weapp' }))
    expect(result.error).toBeUndefined()
    expect(result.publish?.distDir).toBe('dist-weapp')
    expect(result.publish?.runtimeFiles).toEqual(['index.js', 'plugins.js'])
    expect(result.publish?.typeFiles).toEqual(['types/index.d.ts', 'types/plugins.d.ts'])
  })

  it('单文件入口：.mjs 不再被误判为目录', () => {
    const result = callPublishEntries(
      baseManifest({
        miniprogram: './build/index.mjs',
        exports: { '.': { types: './types/index.d.ts' } },
      }),
    )
    expect(result.error).toBeUndefined()
    expect(result.publish?.distDir).toBe('build')
    expect(result.publish?.runtimeFiles).toEqual(['index.mjs'])
  })

  it('exports 声明条件目标时优先使用目标路径，并转为 distDir 相对路径', () => {
    const result = callPublishEntries(
      baseManifest({
        exports: {
          '.': { types: './types/index.d.ts', default: './dist-weapp/index.js' },
          './plugins': { types: './types/plugins.d.ts', import: './dist-weapp/plugins/index.js' },
        },
      }),
    )
    expect(result.error).toBeUndefined()
    expect(result.publish?.runtimeFiles).toEqual(['index.js', 'plugins/index.js'])
  })

  it('运行时/类型文件去重（exports 多个键指向同一目标）', () => {
    const result = callPublishEntries(
      baseManifest({
        exports: {
          '.': { types: './types/index.d.ts', default: './dist-weapp/index.js' },
          './plugins': { types: './types/plugins.d.ts', default: './dist-weapp/plugins.js' },
          './plugins-alias': { types: './types/plugins.d.ts', default: './dist-weapp/plugins.js' },
        },
      }),
    )
    expect(result.publish?.runtimeFiles).toEqual(['index.js', 'plugins.js'])
    expect(result.publish?.typeFiles).toEqual(['types/index.d.ts', 'types/plugins.d.ts'])
  })

  it('越出包根的路径被拒绝', () => {
    const result = callPublishEntries(baseManifest({ miniprogram: '../escape' }))
    expect(result.error).toContain('非法包内路径')
  })

  it('损坏的 package.json 报错带文件路径', () => {
    const result = callPublishEntries('{ "name": "@fixture/pkg", ')
    expect(result.error).toContain('不是合法 JSON')
    expect(result.error).toContain('package.json')
  })

  it('缺少 miniprogram 时给出明确配置错误', () => {
    const result = callPublishEntries(baseManifest({ miniprogram: undefined }))
    expect(result.error).toContain('miniprogram')
  })

  it('包根单文件入口被拒绝，避免 distDir 退化为仓库根（ critical）', () => {
    const result = callPublishEntries(baseManifest({ miniprogram: './index.js' }))
    expect(result.error).toContain('不能位于包根')
  })

  it('中间 .. 段与绝对路径都被拒绝（ high）', () => {
    expect(callPublishEntries(baseManifest({ miniprogram: 'dist/../../etc' })).error).toContain('非法包内路径')
    expect(callPublishEntries(baseManifest({ miniprogram: '/etc/passwd' })).error).toContain('非法包内路径')
    expect(callPublishEntries(baseManifest({ exports: { '.': { types: './types/index.d.ts', require: './dist-weapp/../../outside.js' } } })).error).toContain(
      '非法包内路径',
    )
  })

  it('runtimeEntries 保留 exports 键 → 文件映射，别名导出不被去重吞掉', () => {
    const result = callPublishEntries(
      baseManifest({
        exports: {
          '.': { types: './types/index.d.ts', require: './dist-weapp/index.js' },
          './plugins': { types: './types/plugins.d.ts', require: './dist-weapp/plugins.js' },
          './plugins-alias': { types: './types/plugins.d.ts', require: './dist-weapp/plugins.js' },
        },
      }),
    )
    expect(result.publish?.runtimeFiles).toEqual(['index.js', 'plugins.js'])
    expect(result.publish?.runtimeEntries).toEqual([
      { key: '.', file: 'index.js' },
      { key: './plugins', file: 'plugins.js' },
      { key: './plugins-alias', file: 'plugins.js' },
    ])
  })

  it('CJS 发布面下 require 优先于 import/default；嵌套/数组目标显式报错', () => {
    const dual = callPublishEntries(
      baseManifest({
        exports: { '.': { types: './types/index.d.ts', import: './dist-weapp/index.mjs', require: './dist-weapp/index.js' } },
      }),
    )
    expect(dual.publish?.runtimeFiles).toEqual(['index.js'])

    const nested = callPublishEntries(baseManifest({ exports: { '.': { types: './types/index.d.ts', node: { require: './dist-weapp/index.js' } } } }))
    expect(nested.error).toContain('只支持字符串路径')

    const arrayTarget = callPublishEntries(baseManifest({ exports: { '.': { types: './types/index.d.ts', require: ['./dist-weapp/index.js'] } } }))
    expect(arrayTarget.error).toContain('只支持字符串路径')
  })

  it('resolveInsideRepo 拒绝仓库根与越界路径，接受仓库内子目录', () => {
    expect(callResolveInsideRepo('.').error).toContain('仓库根之外')
    expect(callResolveInsideRepo('..').error).toContain('仓库根之外')
    expect(callResolveInsideRepo('../outside').error).toContain('仓库根之外')
    const inside = callResolveInsideRepo('dist-weapp')
    expect(inside.error).toBeUndefined()
    expect(path.isAbsolute(inside.resolved ?? '')).toBe(true)
    expect((inside.resolved ?? '').endsWith('dist-weapp')).toBe(true)
  })

  it('resolveTypesOutDir 对损坏/缺失 tsconfig 显式报错', () => {
    const missingRoot = mkdtempSync(path.join(tmpdir(), 'types-outdir-'))
    try {
      expect(callResolveTypesOutDir(missingRoot).error).toContain('无法读取/解析')
      writeFileSync(path.join(missingRoot, 'tsconfig.types.json'), '{ not-json ')
      expect(callResolveTypesOutDir(missingRoot).error).toContain('无法读取/解析')
    } finally {
      rmSync(missingRoot, { recursive: true, force: true })
    }
  })
})
