#!/usr/bin/env node
/**
 * SBOM 生成与许可证扫描：
 * - 从 package.json + node_modules 生成 CycloneDX 1.5 JSON（本库为根组件，
 *   开发依赖列为 scope: excluded 的组件——零运行时依赖是发布面断言的硬口径）；
 * - 许可证解析：string / { type } / legacy licenses 数组；
 * - SPDX 表达式按语义求值：OR 任一分支允许即通过、AND 全部分支允许才通过，
 *   未知/畸形表达式与 WITH 例外保守判不兼容（fail-closed）；
 * - purl：npm scoped 包名的 @ 编码为 %40（根组件与依赖一致）；
 * - 根组件许可证从 package.json 派生（缺失/无法解析即失败）；
 * - 运行时依赖数从 package.json 计算，非零即报错。
 *
 * 用法：node scripts/sbom.mjs [输出路径，默认 sbom.cdx.json]
 *       node scripts/sbom.mjs --root <目录> [输出路径]
 *       （--root 仅供测试夹具：从指定根读取 package.json/node_modules/pnpm-lock.yaml，
 *        避免测试依赖仓库真实依赖树；正常发布流程不要使用）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { repoRoot, loadPackage } from './publish-entries.mjs'

/** 兼容许可证白名单（OSI 宽松类）；新增需评审 */
const COMPATIBLE_LICENSES = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD'])

/** 解析命令行：--root 为测试夹具入口，其余位置参数第一个是输出路径 */
function parseArgs(argv) {
  let root = repoRoot
  const positionals = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      const value = argv[i + 1]
      if (!value) {
        console.error('[sbom] --root 需要一个目录参数')
        process.exit(1)
      }
      root = path.resolve(value)
      i++
      continue
    }
    positionals.push(argv[i])
  }
  return { root, output: positionals[0] ?? 'sbom.cdx.json' }
}

/**
 * 从 package.json 形状解析许可证标识：
 * - license: "MIT"（字符串）
 * - license: { type: "MIT" }（对象；缺 type 时不再退化成字符串 "undefined"）
 * - licenses: [{ type: "MIT" }]（legacy 数组；join 为 OR 表达式）
 * 无法识别返回 'unknown'。
 */
function resolveLicense(manifest) {
  if (typeof manifest.license === 'string') {
    const declared = manifest.license.trim()
    if (declared !== '') return declared
  }
  if (manifest.license !== null && typeof manifest.license === 'object' && typeof manifest.license.type === 'string') {
    const declared = manifest.license.type.trim()
    if (declared !== '') return declared
  }
  if (Array.isArray(manifest.licenses)) {
    const identifiers = []
    for (const entry of manifest.licenses) {
      if (typeof entry === 'string') {
        identifiers.push(entry.trim())
      } else if (entry !== null && typeof entry === 'object' && typeof entry.type === 'string') {
        identifiers.push(entry.type.trim())
      }
    }
    const valid = identifiers.filter((identifier) => identifier !== '')
    if (valid.length > 0) return valid.join(' OR ')
  }
  return 'unknown'
}

/** SPDX 表达式 → token 序列（括号独立成 token；AND/OR 仅识别大写，其余按标识符处理） */
function tokenizeSpdx(expression) {
  return expression
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .split(/\s+/)
    .filter((token) => token !== '')
}

/**
 * SPDX 表达式求值：OR 任一分支允许即通过，AND 全部分支允许才通过。
 * 递归下降：orExpr := andExpr (OR andExpr)*；andExpr := primary (AND primary)*。
 * 未知标识符、WITH 例外、多余/缺失括号一律保守判不兼容。
 */
function isCompatibleLicense(license) {
  if (license === 'unknown') return false
  const tokens = tokenizeSpdx(license)
  let position = 0
  const nextToken = () => tokens[position++]
  const peekToken = () => tokens[position]
  const parsePrimary = () => {
    const token = nextToken()
    if (token === undefined) return false
    if (token === '(') {
      const value = parseOr()
      if (nextToken() !== ')') return false
      return value
    }
    if (token === ')' || token === 'AND' || token === 'OR') return false
    return COMPATIBLE_LICENSES.has(token)
  }
  const parseAnd = () => {
    let allowed = parsePrimary()
    while (peekToken() === 'AND') {
      nextToken()
      // 不能短路：右侧仍需消费 token，保证位置校验有效
      const right = parsePrimary()
      allowed = allowed && right
    }
    return allowed
  }
  const parseOr = () => {
    let allowed = parseAnd()
    while (peekToken() === 'OR') {
      nextToken()
      const right = parseAnd()
      allowed = allowed || right
    }
    return allowed
  }
  const result = parseOr()
  return result && position === tokens.length
}

/**
 * CycloneDX 许可证条目：单一 SPDX 标识用 license.id，SPDX 表达式用 expression，
 * 无法识别用 NOASSERTION（仍是合法 CycloneDX，且已由兼容性检查报错）。
 */
function licenseEntry(license) {
  if (license === 'unknown') return { license: { id: 'NOASSERTION' } }
  if (/^[A-Za-z0-9.+-]+$/.test(license)) return { license: { id: license } }
  return { expression: license }
}

/** npm 包名 → purl：scoped 包名的 @ 必须百分号编码（pkg:npm/%40types/node@20.0.0） */
function toPurl(name, version) {
  const encodedName = name
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return 'pkg:npm/' + encodedName + '@' + version
}

const { root, output } = parseArgs(process.argv.slice(2))
const pkg = loadPackage(root)

// 根组件 name/version 是 purl 与 serialNumber 的必需输入：缺失会在后续产出
// pkg:npm/<name>@undefined，或在 createHash().update(undefined) 处抛裸 TypeError
if (typeof pkg.name !== 'string' || pkg.name.trim() === '') {
  console.error('[sbom] 根 package.json 缺少有效 name：无法生成根组件 purl，失败退出')
  process.exit(1)
}
if (typeof pkg.version !== 'string' || pkg.version.trim() === '') {
  console.error('[sbom] 根 package.json 缺少有效 version：无法生成根组件 purl 与序列号，失败退出')
  process.exit(1)
}

//  / 运行时依赖必须为零——从 package.json 实际计算，不是写死 0
const runtimeDependencies = Object.keys(pkg.dependencies ?? {})
if (runtimeDependencies.length > 0) {
  console.error(
    '[sbom] package.json 声明了 ' +
      runtimeDependencies.length +
      ' 个运行时依赖（' +
      runtimeDependencies.join(', ') +
      '），与「零运行时依赖」发布面契约冲突：请移除依赖，或先更新发布面/文档/本脚本',
  )
  process.exit(1)
}

// 根组件许可证从 package.json 派生：缺失/无法解析时失败退出，不写失真的 BOM
const rootLicense = resolveLicense(pkg)
if (rootLicense === 'unknown') {
  console.error('[sbom] package.json 未声明可解析的 license（string / license.type / legacy licenses 数组）：无法派生根组件许可证，失败退出')
  process.exit(1)
}
// 根组件许可证与依赖同口径校验：UNLICENSED / SEE LICENSE IN LICENSE / 非白名单表达式
// 不能产出「看起来成功」而实际不可消费的 BOM
if (!isCompatibleLicense(rootLicense)) {
  console.error(
    '[sbom] 根组件 license 不兼容或无法识别：' + rootLicense + '（白名单：' + [...COMPATIBLE_LICENSES].join(', ') + '）',
  )
  process.exit(1)
}

/** 读取已安装开发依赖的版本与许可证（缺失即失败，避免生成无法解析的 purl 与假 license） */
const devDependencies = Object.keys(pkg.devDependencies ?? {})
const components = []
const incompatible = []
for (const name of devDependencies) {
  const manifestPath = path.join(root, 'node_modules', name, 'package.json')
  if (!existsSync(manifestPath)) {
    console.error('[sbom] 开发依赖 ' + name + ' 未安装（缺少 ' + manifestPath + '）：无法读取许可证，请先安装依赖')
    process.exit(1)
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    // 坏 manifest 必须点名到依赖，而不是抛裸 SyntaxError；版本无法得知时不做假 purl，直接失败
    console.error('[sbom] 开发依赖 ' + name + ' 的 package.json 无法解析（' + manifestPath + '）：' + (error instanceof Error ? error.message : String(error)))
    process.exit(1)
  }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    console.error('[sbom] 开发依赖 ' + name + ' 的 package.json 缺少有效 version：无法生成合法 purl')
    process.exit(1)
  }
  const version = manifest.version
  const license = resolveLicense(manifest)
  if (!isCompatibleLicense(license)) {
    incompatible.push(name + '@' + version + ' -> ' + license)
  }
  components.push({
    type: 'library',
    'bom-ref': toPurl(name, version),
    name,
    version,
    scope: 'excluded',
    licenses: [licenseEntry(license)],
  })
}

// lockfile 哈希用于锚定依赖图身份/完整性；缺失时明确失败而不是从 BOM 构造深处抛 ENOENT
const lockfilePath = path.join(root, 'pnpm-lock.yaml')
if (!existsSync(lockfilePath)) {
  console.error('[sbom] 缺少 ' + lockfilePath + '：SBOM 的 lockfile 锚定依赖它，请先安装依赖或还原锁文件')
  process.exit(1)
}
const lockfileSha256 = createHash('sha256').update(readFileSync(lockfilePath)).digest('hex')

const rootPurl = toPurl(pkg.name, pkg.version)
const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber:
    'urn:uuid:' +
    createHash('sha256')
      .update(JSON.stringify({ v: pkg.version, deps: components.map((component) => component['bom-ref']) }))
      .digest('hex')
      .slice(0, 8) +
    '-0000-4000-8000-' +
    createHash('sha256').update(pkg.version).digest('hex').slice(0, 12),
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: 'library',
      'bom-ref': rootPurl,
      name: pkg.name,
      version: pkg.version,
      licenses: [licenseEntry(rootLicense)],
      purl: rootPurl,
    },
    properties: [
      { name: 'tallystore:runtimeDependencies', value: String(runtimeDependencies.length) },
      { name: 'tallystore:generatedBy', value: 'scripts/sbom.mjs' },
      // 组件表与许可证扫描都只覆盖**直接依赖**；lockfile 哈希只锚定依赖图身份/完整性，
      // 不代表传递依赖的许可证已被扫描
      { name: 'tallystore:lockfileSha256', value: lockfileSha256 },
    ],
  },
  components,
}

// 先完成许可证校验再落盘：失败时不留下含不兼容组件的 BOM
if (incompatible.length > 0) {
  console.error('[sbom] 许可证不兼容或未知的开发依赖 ' + incompatible.length + ' 个：')
  for (const item of incompatible) console.error('  ' + item)
  console.error('[sbom] 未写入 BOM（先修复许可证或更新白名单后重试）')
  process.exit(1)
}

const outputPath = path.isAbsolute(output) ? output : path.join(root, output)
try {
  writeFileSync(outputPath, JSON.stringify(bom, null, 2) + '\n')
} catch (error) {
  // 父目录不存在/只读时给出可操作诊断
  console.error('[sbom] 写入 SBOM 失败（' + outputPath + '）：' + (error instanceof Error ? error.message : String(error)) + '；请确认父目录存在且可写')
  process.exit(1)
}

console.log(
  '[sbom] CycloneDX ' +
    output +
    '：根组件 ' +
    pkg.name +
    '@' +
    pkg.version +
    '（' +
    rootLicense +
    '，零运行时依赖），开发依赖 ' +
    components.length +
    ' 个（全部 scope:excluded，许可证白名单通过）',
)
