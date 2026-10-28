#!/usr/bin/env node
/**
 *  文档版本一致性门禁：
 * 1) `package.json` 的 `version` 与 `docs/versions/current.json` 的 `current` 一致（唯一 current 标记，
 *    避免多处手改漂移）；
 * 2) 当前版本对应的版本目录 `docs/versions/vMAJOR.MINOR/README.md` 存在；
 * 3) `docs/versions/README.md` 版本索引里列出该版本目录；
 * 4) `docs/README.md` 文档索引包含 MIGRATION / RELEASE / TEAM-RULES 三条链接（ 验收：文档入口完整）。
 *
 * 用法：node scripts/check-docs-version.mjs [--root=<仓库根>]
 *   默认根为脚本所在仓库；`--root` 供单测使用临时 fixture。
 * 退出码：0 通过 / 1 任一项不满足。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 解析 --root（缺省仓库根）；相对路径按仓库根解析 */
function resolveRoot() {
  const index = process.argv.indexOf('--root')
  if (index !== -1) {
    const value = process.argv[index + 1]
    if (!value) {
      console.error('[check-docs-version] --root 需要目录参数')
      process.exit(1)
    }
    return path.isAbsolute(value) ? value : path.resolve(here, '..', value)
  }
  const withEquals = process.argv.find((item) => item.startsWith('--root='))
  if (withEquals) {
    const value = withEquals.slice('--root='.length)
    if (!value) {
      console.error('[check-docs-version] --root 需要目录参数')
      process.exit(1)
    }
    return path.isAbsolute(value) ? value : path.resolve(here, '..', value)
  }
  return path.resolve(here, '..')
}

const root = resolveRoot()
const problems = []
const problemsLabel = (relative, detail) => problems.push(relative + '：' + detail)

/** 读文本；缺失/读取失败返回 null 并记录问题 */
function readText(relative) {
  const full = path.join(root, relative)
  if (!existsSync(full)) {
    problemsLabel(relative, '文件不存在')
    return null
  }
  try {
    return readFileSync(full, 'utf8')
  } catch (error) {
    problemsLabel(relative, '读取失败：' + (error instanceof Error ? error.message : String(error)))
    return null
  }
}

/** 读 JSON 并给出可定位的错误 */
function readJson(relative) {
  const text = readText(relative)
  if (text === null) {
    return null
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    problemsLabel(relative, '不是合法 JSON：' + (error instanceof Error ? error.message : String(error)))
    return null
  }
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const pkg = readJson('package.json')
let version = null
if (pkg !== null) {
  if (typeof pkg.version !== 'string' || !SEMVER_PATTERN.test(pkg.version)) {
    problemsLabel('package.json', 'version 必须是语义化版本，实际为 ' + JSON.stringify(pkg.version))
  } else {
    version = pkg.version
  }
}

const current = readJson('docs/versions/current.json')
if (current !== null) {
  if (typeof current.current !== 'string' || current.current.trim() === '') {
    problemsLabel('docs/versions/current.json', '必须包含非空字符串字段 current')
  } else if (version !== null) {
    const normalized = current.current.replace(/^v/, '')
    if (normalized !== version) {
      problemsLabel('docs/versions/current.json', 'current=' + current.current + ' 与 package.json version=' + version + ' 不一致（发布时两处必须同步）')
    }
  }
}

let versionDir = null
if (version !== null) {
  const match = version.match(/^(\d+)\.(\d+)\.\d+/)
  versionDir = 'v' + match[1] + '.' + match[2]
  const versionReadme = 'docs/versions/' + versionDir + '/README.md'
  if (!existsSync(path.join(root, versionReadme))) {
    problemsLabel(versionReadme, '当前版本的文档入口缺失（每个已发布 minor 必须有版本目录）')
  }
}

const versionsIndex = readText('docs/versions/README.md')
if (versionsIndex !== null && versionDir !== null && !versionsIndex.includes(versionDir)) {
  problemsLabel('docs/versions/README.md', '版本索引未列出当前版本目录 ' + versionDir)
}

const docsIndex = readText('docs/README.md')
if (docsIndex !== null) {
  for (const doc of ['MIGRATION.md', 'RELEASE.md', 'TEAM-RULES.md']) {
    // 允许 ./MIGRATION.md 或 MIGRATION.md 形式（可带锚点）
    const linked =
      docsIndex.includes('](./' + doc + ')') ||
      docsIndex.includes('](./' + doc + '#') ||
      docsIndex.includes('](' + doc + ')') ||
      docsIndex.includes('](' + doc + '#')
    if (!linked) {
      problemsLabel('docs/README.md', '文档索引缺少 ' + doc + ' 的链接（：文档入口必须完整）')
    }
  }
}

if (problems.length > 0) {
  console.error('[check-docs-version] 失败（' + problems.length + ' 项）：')
  for (const problem of problems) {
    console.error('  - ' + problem)
  }
  process.exit(1)
}

console.log('[check-docs-version] 通过：version=' + version + '，版本目录=docs/versions/' + versionDir + '，文档索引完整')
