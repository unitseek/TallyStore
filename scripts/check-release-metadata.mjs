#!/usr/bin/env node
/**
 * 发布元数据校验（ 发布可追溯性的可执行部分）：
 * - package.json version 必须为合法 semver 且（可选）与 --expect-version 一致；
 * - CHANGELOG.md 必须存在对应版本标题；
 * - tag 校验：--tag 必须等于 v<version>；未提供 --tag 时按 dry-run 处理（warning 后 exit 0），
 *   正式发布传 --require-tag 使缺失 tag 成为错误；
 * - Release Notes 模板/文件必须包含四要素：变更 / 迁移 / 已知问题 / 支持窗口。
 *
 * 用法：
 *   node scripts/check-release-metadata.mjs [--root <dir>] [--tag <tag>] [--require-tag]
 *        [--notes <file>] [--expect-version <version>] [--json]
 * 退出码：0 通过（无 tag 的 dry-run 仅 warning）/ 1 校验失败
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPackage, repoRoot } from './publish-entries.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const NOTES_SECTIONS = ['变更', '迁移', '已知问题', '支持窗口']
const REGEX_SPECIAL = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])

function escapeRegExp(text) {
  let out = ''
  for (const ch of text) out += REGEX_SPECIAL.has(ch) ? '\\' + ch : ch
  return out
}

function parseArgs(argv) {
  const options = { root: repoRoot, tag: '', requireTag: false, notes: '', expectVersion: '', json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        console.error('[check-release-metadata] 参数 ' + arg + ' 缺少值')
        process.exit(1)
      }
      index += 1
      return value
    }
    if (arg === '--root') options.root = path.resolve(next())
    else if (arg === '--tag') options.tag = next()
    else if (arg === '--require-tag') options.requireTag = true
    else if (arg === '--notes') options.notes = path.resolve(next())
    else if (arg === '--expect-version') options.expectVersion = next()
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') {
      console.log(
        '用法：node scripts/check-release-metadata.mjs [--root <dir>] [--tag <tag>] [--require-tag] [--notes <file>] [--expect-version <version>] [--json]'
      )
      process.exit(0)
    } else {
      console.error('[check-release-metadata] 未知参数：' + arg)
      process.exit(1)
    }
  }
  if (options.notes === '') options.notes = path.join(options.root, 'docs', 'RELEASE-NOTES-TEMPLATE.md')
  return options
}

function hasVersionHeading(changelog, version) {
  const escaped = escapeRegExp(version)
  return (
    new RegExp('^##\\s*\\[v?' + escaped + '\\](?:\\s|$)', 'm').test(changelog) ||
    new RegExp('^##\\s*v?' + escaped + '(?:\\s|$)', 'm').test(changelog)
  )
}

const options = parseArgs(process.argv.slice(2))
const problems = []
const warnings = []

const pkg = loadPackage(options.root)
const version = pkg.version
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
if (typeof version !== 'string' || !SEMVER.test(version)) {
  problems.push('package.json version 不是合法 semver：' + JSON.stringify(version))
} else if (options.expectVersion !== '' && options.expectVersion !== version) {
  problems.push('期望发布的版本（' + options.expectVersion + '）与 package.json version（' + version + '）不一致')
}

const changelogPath = path.join(options.root, 'CHANGELOG.md')
if (!existsSync(changelogPath)) {
  problems.push('缺少 CHANGELOG.md（' + changelogPath + '）')
} else if (typeof version === 'string' && SEMVER.test(version) && !hasVersionHeading(readFileSync(changelogPath, 'utf8'), version)) {
  problems.push('CHANGELOG.md 缺少版本 ' + version + ' 的标题（应为 ## [' + version + '] 或 ## ' + version + '）')
}

if (options.tag !== '') {
  const expectedTag = 'v' + version
  if (options.tag !== expectedTag) problems.push('tag（' + options.tag + '）与版本不匹配：应为 ' + expectedTag)
} else if (options.requireTag) {
  problems.push('缺少 --tag：正式发布必须提供 tag（形如 v' + version + '）')
} else {
  warnings.push('未提供 --tag：按 dry-run 处理，跳过 tag 校验（正式发布请传 --tag v' + version + ' 或 --require-tag）')
}

if (!existsSync(options.notes)) {
  problems.push('缺少 Release Notes 模板/文件（' + options.notes + '）')
} else {
  const notes = readFileSync(options.notes, 'utf8')
  const missingSections = NOTES_SECTIONS.filter((section) => !new RegExp('^##\\s*' + section, 'm').test(notes))
  if (missingSections.length > 0) {
    problems.push('Release Notes 缺少必需段：' + missingSections.join(' / ') + '（四要素：' + NOTES_SECTIONS.join(' / ') + '）')
  }
}

if (options.json) {
  console.log(JSON.stringify({ ok: problems.length === 0, version: version, tag: options.tag === '' ? null : options.tag, problems, warnings }, null, 2))
} else {
  for (const warning of warnings) console.warn('[check-release-metadata] warning: ' + warning)
  for (const problem of problems) console.error('[check-release-metadata] FAIL: ' + problem)
  if (problems.length === 0) {
    console.log(
      '[check-release-metadata] 通过：version=' +
        version +
        ' tag=' +
        (options.tag === '' ? '(dry-run 未校验)' : options.tag) +
        ' notes=' +
        path.relative(options.root, options.notes).split(path.sep).join('/'),
    )
  }
}
process.exit(problems.length === 0 ? 0 : 1)
