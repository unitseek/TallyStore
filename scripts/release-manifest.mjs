#!/usr/bin/env node
/**
 * 发布 manifest 与可追溯性（ 验收 3/5/6 的可执行部分）：
 * - 校验 package.json version 与 CHANGELOG 对应版本标题；
 * - npm pack 生成 tarball 并记录 sha256；用 npm pack --dry-run --json 的文件清单
 *   与 package.json.files / publishEntries 声明双向比对（缺文件/多文件即失败）；
 * - 解析 sbom.cdx.json（缺失时先调用 scripts/sbom.mjs）并记录 SBOM sha256、运行时依赖=0、
 *   开发依赖许可证清单；与上一份 release-manifest.json 对比输出许可证差异；
 * - 输出 release-manifest.json 到 .release/（目录内写自忽略 .gitignore，避免入库）。
 *
 * 用法：
 *   node scripts/release-manifest.mjs [--root <dir>] [--out <file>] [--previous <file>]
 *        [--tarball-dir <dir>] [--npm-cli <path>]
 * 退出码：0 成功 / 1 校验失败
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPackage, publishEntries, repoRoot } from './publish-entries.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
/** npm 总会在 tarball 中附带这些文件（存在时），即使未写进 files 声明 */
const ALWAYS_INCLUDED = ['package.json', 'README.md', 'README', 'LICENSE', 'LICENSE.md', 'LICENCE', 'LICENCE.md']
const REGEX_SPECIAL = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])

function fail(message) {
  console.error('[release-manifest] ' + message)
  process.exit(1)
}

function escapeRegExp(text) {
  let out = ''
  for (const ch of text) out += REGEX_SPECIAL.has(ch) ? '\\' + ch : ch
  return out
}

function parseArgs(argv) {
  const options = { root: repoRoot, out: '', previous: '', tarballDir: '', npmCli: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) fail('参数 ' + arg + ' 缺少值')
      index += 1
      return value
    }
    if (arg === '--root') options.root = path.resolve(next())
    else if (arg === '--out') options.out = path.resolve(next())
    else if (arg === '--previous') options.previous = path.resolve(next())
    else if (arg === '--tarball-dir') options.tarballDir = path.resolve(next())
    else if (arg === '--npm-cli') options.npmCli = next()
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/release-manifest.mjs [--root <dir>] [--out <file>] [--previous <file>] [--tarball-dir <dir>] [--npm-cli <path>]')
      process.exit(0)
    } else fail('未知参数：' + arg)
  }
  const root = options.root
  if (options.out === '') options.out = path.join(root, '.release', 'release-manifest.json')
  if (options.previous === '') options.previous = options.out
  if (options.tarballDir === '') options.tarballDir = path.dirname(options.out)
  return { root, out: options.out, previous: options.previous, tarballDir: options.tarballDir, npmCli: options.npmCli }
}

function readJson(file, label) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    fail('无法读取' + label + '（' + file + '）：' + (error instanceof Error ? error.message : String(error)))
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    fail(label + '不是合法 JSON（' + file + '）：' + (error instanceof Error ? error.message : String(error)))
  }
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** CHANGELOG 中是否存在对应版本标题（Keep a Changelog：## [x.y.z] 或 ## x.y.z） */
function hasVersionHeading(changelog, version) {
  const escaped = escapeRegExp(version)
  const bracket = new RegExp('^##\\s*\\[v?' + escaped + '\\](?:\\s|$)', 'm')
  const plain = new RegExp('^##\\s*v?' + escaped + '(?:\\s|$)', 'm')
  return bracket.test(changelog) || plain.test(changelog)
}

/** 递归收集目录下的文件（相对 root 的 posix 路径，排序保证确定） */
function walkFiles(root, relativeDir) {
  const out = []
  const absolute = path.join(root, relativeDir)
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = relativeDir === '' ? entry.name : relativeDir + '/' + entry.name
    if (entry.isDirectory()) out.push(...walkFiles(root, relative))
    else if (entry.isFile()) out.push(relative)
  }
  return out.sort()
}

/** 按 files 声明 + npm 固定附带文件 + publishEntries 声明，推导「应当出现在 tarball 中」的文件集 */
function collectExpectedFiles(root, pkg) {
  const expected = new Set()
  const problems = []
  const declaredEntries = Array.isArray(pkg.files) ? pkg.files : []
  if (declaredEntries.length === 0) {
    problems.push('package.json 缺少 files 白名单：npm pack 会把整个仓库打进 tarball（违反包内容最小化）')
  }
  for (const declared of declaredEntries) {
    const normalized = String(declared).replace(/\\/g, '/').replace(/^\.\//, '')
    const absolute = path.join(root, normalized)
    if (!existsSync(absolute)) {
      problems.push('files 声明的发布路径不存在：' + normalized + '（先运行 pnpm run build）')
      continue
    }
    if (statSync(absolute).isDirectory()) {
      for (const file of walkFiles(root, normalized)) expected.add(file)
    } else {
      expected.add(normalized)
    }
  }
  for (const mandatory of ALWAYS_INCLUDED) {
    if (existsSync(path.join(root, mandatory))) expected.add(mandatory)
  }

  // 与发布面声明交叉校验：publishEntries 声明的入口/类型文件必须真实存在且被 files 覆盖
  let publish = null
  try {
    publish = publishEntries(pkg)
  } catch (error) {
    if (typeof pkg.miniprogram === 'string' || pkg.exports !== undefined) {
      problems.push('发布面配置无法解析：' + (error instanceof Error ? error.message : String(error)))
    }
  }
  if (publish !== null) {
    const declaredArtifacts = [
      ...publish.runtimeEntries.map((entry) => path.posix.join(publish.distDir, entry.file)),
      ...publish.typeFiles,
    ]
    for (const artifact of declaredArtifacts) {
      if (!existsSync(path.join(root, artifact))) {
        problems.push('缺少发布声明产物：' + artifact + '（先运行 pnpm run build）')
        continue
      }
      if (!expected.has(artifact)) {
        problems.push('发布声明产物未被 package.json.files 覆盖：' + artifact)
      }
    }
  }
  return { expected, problems, publish }
}

function resolveNpmCli(explicit) {
  if (explicit !== '') return explicit
  const fromEnv = process.env.RELEASE_NPM_CLI
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const bundled = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(bundled) ? bundled : ''
}

/** 运行 npm；优先用 node 执行 npm-cli.js（跨平台、无 shell 引号问题），缺失时才退回命令名 */
function runNpm(args, cwd, npmCli) {
  const env = { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }
  try {
    if (npmCli !== '') {
      return execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
    }
    return execFileSync('npm', args, { cwd, encoding: 'utf8', env, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const stderr = error && typeof error.stderr === 'string' ? error.stderr.trim() : ''
    fail('npm ' + args.join(' ') + ' 失败：' + (stderr === '' ? (error instanceof Error ? error.message : String(error)) : stderr))
  }
}

/** 解析 npm pack --json：npm 12 返回 { "<pkg name>": {...} }，旧版本返回 [{...}] */
function parsePackResult(stdout) {
  let data
  try {
    data = JSON.parse(stdout.trim())
  } catch (error) {
    fail('npm pack --json 输出不是合法 JSON：' + (error instanceof Error ? error.message : String(error)))
  }
  if (Array.isArray(data)) {
    if (data.length === 0) fail('npm pack --json 未返回任何包信息')
    return data[0]
  }
  if (data !== null && typeof data === 'object') {
    if (typeof data.filename === 'string' && typeof data.name === 'string') return data
    const values = Object.values(data)
    if (values.length > 0 && values[0] !== null && typeof values[0] === 'object') return values[0]
  }
  fail('npm pack --json 输出结构无法识别')
}

/** tarball 内路径归一化：去掉 npm 的 package/ 前缀与 ./ */
function normalizeTarballPath(value) {
  return String(value)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^package\//, '')
}

function packFileList(packResult) {
  const files = Array.isArray(packResult.files) ? packResult.files : []
  return files.map((file) => normalizeTarballPath(file && typeof file === 'object' ? file.path : file)).sort()
}

/** 从 CycloneDX SBOM 提取开发依赖许可证清单（name/version/license） */
function licensesFromSbom(sbom) {
  const components = Array.isArray(sbom.components) ? sbom.components : []
  return components
    .map((component) => {
      const entry = Array.isArray(component.licenses) && component.licenses.length > 0 ? component.licenses[0] : null
      let license = 'NOASSERTION'
      if (entry !== null) {
        if (entry.expression !== undefined) license = String(entry.expression)
        else if (entry.license !== undefined && entry.license !== null && typeof entry.license.id === 'string') license = entry.license.id
      }
      return { name: String(component.name), version: String(component.version), license }
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function diffLicenses(previous, current) {
  const previousByName = new Map(previous.map((entry) => [entry.name, entry]))
  const currentByName = new Map(current.map((entry) => [entry.name, entry]))
  const added = current.filter((entry) => !previousByName.has(entry.name))
  const removed = previous.filter((entry) => !currentByName.has(entry.name))
  const changed = []
  for (const entry of current) {
    const before = previousByName.get(entry.name)
    if (before === undefined) continue
    if (before.version !== entry.version || before.license !== entry.license) {
      changed.push({ name: entry.name, from: { version: before.version, license: before.license }, to: { version: entry.version, license: entry.license } })
    }
  }
  return { added, removed, changed }
}

function readGitHead(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/** 输出目录若在仓库内，写入自忽略 .gitignore（*），确保 .release/ 等发布产物不入库 */
function ensureOutputDir(root, outDir) {
  mkdirSync(outDir, { recursive: true })
  const relative = path.relative(root, outDir)
  const insideRoot = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  if (insideRoot) {
    const ignoreFile = path.join(outDir, '.gitignore')
    if (!existsSync(ignoreFile)) writeFileSync(ignoreFile, '*\n')
  }
}

const options = parseArgs(process.argv.slice(2))
const { root, out, previous, tarballDir } = options
const npmCli = resolveNpmCli(options.npmCli)

const pkg = loadPackage(root)
const version = pkg.version
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  fail('package.json version 不是合法 semver：' + JSON.stringify(version))
}

const changelogPath = path.join(root, 'CHANGELOG.md')
if (!existsSync(changelogPath)) fail('缺少 CHANGELOG.md（' + changelogPath + '）')
const changelog = readFileSync(changelogPath, 'utf8')
if (!hasVersionHeading(changelog, version)) {
  fail('CHANGELOG.md 缺少版本 ' + version + ' 的标题（应为 ## [' + version + '] 或 ## ' + version + '）')
}

const collected = collectExpectedFiles(root, pkg)
if (collected.problems.length > 0) {
  console.error('[release-manifest] 发布声明校验失败：')
  for (const problem of collected.problems) console.error('  - ' + problem)
  process.exit(1)
}
const expected = collected.expected

// ① 干跑：tarball 文件清单与声明双向比对
const dryRunResult = parsePackResult(runNpm(['pack', '--dry-run', '--json', '--ignore-scripts'], root, npmCli))
const actual = packFileList(dryRunResult)
const actualSet = new Set(actual)
const missingInTarball = [...expected].filter((file) => !actualSet.has(file)).sort()
const extraInTarball = actual.filter((file) => !expected.has(file)).sort()
if (missingInTarball.length > 0 || extraInTarball.length > 0) {
  console.error('[release-manifest] tarball 与发布声明不一致（缺失 ' + missingInTarball.length + ' / 多余 ' + extraInTarball.length + '）：')
  for (const file of missingInTarball.slice(0, 20)) console.error('  - 缺少：' + file)
  for (const file of extraInTarball.slice(0, 20)) console.error('  - 多余：' + file)
  process.exit(1)
}

// ② 正式 pack：tarball 落盘 + sha256 记录
const packTempDir = mkdtempSync(path.join(os.tmpdir(), 'tallystore-release-pack-'))
let tarballName
let tarballSha256
let tarballSizeBytes
try {
  const packResult = parsePackResult(runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', packTempDir], root, npmCli))
  const packedPath = path.join(packTempDir, String(packResult.filename))
  if (!existsSync(packedPath)) fail('npm pack 未产出 tarball：' + packedPath)
  ensureOutputDir(root, tarballDir)
  const destination = path.join(tarballDir, path.basename(packedPath))
  copyFileSync(packedPath, destination)
  tarballName = path.basename(destination)
  tarballSha256 = sha256File(destination)
  tarballSizeBytes = statSync(destination).size
} finally {
  rmSync(packTempDir, { recursive: true, force: true })
}

// ③ SBOM：缺失则先生成，然后校验版本/运行时依赖并记录许可证清单
const sbomPath = path.join(root, 'sbom.cdx.json')
if (!existsSync(sbomPath)) {
  console.log('[release-manifest] 未找到 sbom.cdx.json，先运行 scripts/sbom.mjs 生成')
  try {
    execFileSync(process.execPath, [path.join(scriptDir, 'sbom.mjs'), '--root', root, sbomPath], { cwd: repoRoot, stdio: 'inherit' })
  } catch (error) {
    fail('生成 SBOM 失败：' + (error instanceof Error ? error.message : String(error)))
  }
}
const sbom = readJson(sbomPath, 'SBOM')
const metadata = sbom !== null && typeof sbom === 'object' ? sbom.metadata : null
const componentMeta = metadata !== null && typeof metadata === 'object' ? metadata.component : null
if (componentMeta === null || typeof componentMeta !== 'object') fail('SBOM 缺少 metadata.component')
if (componentMeta.version !== version) {
  fail('SBOM 根组件版本（' + String(componentMeta.version) + '）与 package.json version（' + version + '）不一致：请重新运行 pnpm run sbom')
}
const properties = metadata !== null && typeof metadata === 'object' && Array.isArray(metadata.properties) ? metadata.properties : []
const runtimeDependencyProperty = properties.find((property) => property && property.name === 'tallystore:runtimeDependencies')
const runtimeDependencies = runtimeDependencyProperty === undefined ? NaN : Number(runtimeDependencyProperty.value)
if (!Number.isFinite(runtimeDependencies) || runtimeDependencies !== 0) {
  fail('SBOM/package.json 运行时依赖必须为 0（实际：' + String(runtimeDependencyProperty === undefined ? '未声明' : runtimeDependencyProperty.value) + '）')
}
if (pkg.dependencies !== undefined && Object.keys(pkg.dependencies).length > 0) {
  fail('package.json 存在运行时依赖（' + Object.keys(pkg.dependencies).join(', ') + '）：违反零运行时依赖契约')
}
const currentLicenses = licensesFromSbom(sbom)

// ④ 与上一份 manifest 对比许可证变化
let licenseChanges = { previousManifest: null, added: currentLicenses, removed: [], changed: [] }
if (existsSync(previous)) {
  const previousManifest = readJson(previous, '上一份 release-manifest')
  const previousLicenses =
    previousManifest !== null &&
    typeof previousManifest === 'object' &&
    previousManifest.sbom !== null &&
    typeof previousManifest.sbom === 'object' &&
    Array.isArray(previousManifest.sbom.licenses)
      ? previousManifest.sbom.licenses
      : null
  if (previousLicenses === null) {
    fail('上一份 release-manifest 缺少 sbom.licenses 数组（' + previous + '）：无法计算许可证差异，请删除后重跑')
  }
  licenseChanges = {
    previousManifest: path.relative(root, previous).split(path.sep).join('/'),
    ...diffLicenses(previousLicenses, currentLicenses),
  }
}

const relativeTarballPath = path.relative(root, path.join(tarballDir, tarballName)).split(path.sep).join('/')
const manifest = {
  schemaVersion: 1,
  version,
  gitHead: readGitHead(root),
  generatedAt: new Date().toISOString(),
  tarballSha256,
  tarball: {
    name: tarballName,
    sizeBytes: tarballSizeBytes,
    path: relativeTarballPath,
  },
  files: actual,
  fileCount: actual.length,
  checks: {
    changelogVersionHeading: true,
    tarballMatchesDeclarations: true,
  },
  sbom: {
    path: path.relative(root, sbomPath).split(path.sep).join('/'),
    sha256: sha256File(sbomPath),
    runtimeDependencies,
    componentCount: currentLicenses.length,
    licenses: currentLicenses,
  },
  licenseChanges,
}

ensureOutputDir(root, path.dirname(out))
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n')

const totalChanges = licenseChanges.added.length + licenseChanges.removed.length + licenseChanges.changed.length
console.log(
  '[release-manifest] 通过：version=' +
    version +
    ' tarball=' +
    tarballName +
    ' sha256=' +
    tarballSha256 +
    ' files=' +
    actual.length +
    ' sbomComponents=' +
    currentLicenses.length +
    ' licenseChanges=' +
    totalChanges,
)
console.log('[release-manifest] 输出：' + path.relative(root, out).split(path.sep).join('/'))
