#!/usr/bin/env node
/**
 * 分包边界静态检查：主包代码引用分包内的 Store 模块时构建期报错。
 *
 * 规则（依赖方向：主包 → 分包 允许；分包 → 主包 正常；主包 require 分包文件 = 违规）：
 * - 从目标小程序工程的 app.json 读取 subPackages / subpackages 的 root 列表（两键同时存在时合并生效）；
 * - 扫描主包范围（工程根下的 js/ts/mjs/cjs/jsx/tsx 文件，排除分包目录与 node_modules/miniprogram_npm）；
 * - 解析每个文件的 require/import 相对路径（只解析真实存在的普通文件），命中任何分包 root 即报错；
 * - 扫描前去除注释，避免注释里被注释掉的旧代码造成误报。
 *
 * 用法：node scripts/check-package-boundary.mjs <小程序工程根目录>
 * 退出码：0 通过 / 1 存在违规或工程不可解析。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const projectRoot = process.argv[2]
if (!projectRoot || !existsSync(path.join(projectRoot, 'app.json'))) {
  console.error('[check-package-boundary] 用法：node scripts/check-package-boundary.mjs <小程序工程根目录>（需含 app.json）')
  process.exit(1)
}

const appJsonPath = path.join(projectRoot, 'app.json')
let appJson
try {
  appJson = JSON.parse(readFileSync(appJsonPath, 'utf8'))
} catch (error) {
  console.error('[check-package-boundary] app.json 解析失败：' + String(error))
  process.exit(1)
}

/**
 * 读取分包 root 列表：结构显式校验并给出可诊断错误。
 * subPackages 与 subpackages 同时存在时合并（旧实现用 ?? 只在 null/undefined 时回退，会漏掉其一）。
 */
function readSubpackageRoots(config) {
  const declared = []
  for (const key of ['subPackages', 'subpackages']) {
    const value = config[key]
    if (value === undefined) continue
    if (!Array.isArray(value)) {
      throw new Error('app.json 的 ' + key + ' 必须是数组，实际是 ' + (value === null ? 'null' : typeof value))
    }
    for (const entry of value) {
      if (typeof entry === 'string') {
        declared.push(entry)
        continue
      }
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('app.json 的 ' + key + ' 元素必须是字符串或含 root 的对象，实际是 ' + JSON.stringify(entry))
      }
      if (typeof entry.root !== 'string' || entry.root.trim() === '') {
        throw new Error('app.json 的 ' + key + ' 元素缺少非空字符串 root：' + JSON.stringify(entry))
      }
      declared.push(entry.root)
    }
  }
  return [...new Set(declared.map((root) => root.replace(/\/+$/, '')).filter((root) => root !== ''))]
}

let subpackageRoots
try {
  subpackageRoots = readSubpackageRoots(appJson)
} catch (error) {
  console.error('[check-package-boundary] app.json 结构错误：' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
}

if (subpackageRoots.length === 0) {
  console.log('[check-package-boundary] 未配置分包，检查通过（无需边界约束）')
  process.exit(0)
}

const IGNORED_DIR_NAMES = new Set(['node_modules', 'miniprogram_npm'])
const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]sx?)$/
/** 声明文件（.d.ts / .d.mts / .d.cts）不是可执行引用目标，不扫描也不作为解析后缀 */
const DECLARATION_FILE_PATTERN = /\.d\.[cm]?ts$/

/** 工程相对路径是否位于某个分包 root 内（含 root 本身） */
const isInsideSubpackage = (relative) => subpackageRoots.some((root) => relative === root || relative.startsWith(root + '/'))

/** 收集主包范围内的源文件（跳过依赖目录与整个分包目录） */
const collectMainPackageFiles = (dir, relativeDir = '') => {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = relativeDir === '' ? entry.name : relativeDir + '/' + entry.name
    if (entry.name.startsWith('.') || IGNORED_DIR_NAMES.has(entry.name) || isInsideSubpackage(relative)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectMainPackageFiles(full, relative))
    else if (SOURCE_FILE_PATTERN.test(entry.name) && !DECLARATION_FILE_PATTERN.test(entry.name)) out.push(full)
  }
  return out
}

/** 相对引用可解析的候选路径：覆盖 ts/mts/cts/js/mjs/cjs/jsx/tsx 与目录 index */
const RESOLVE_SUFFIXES = [
  '',
  '.js',
  '.ts',
  '.mjs',
  '.mts',
  '.cjs',
  '.cts',
  '.jsx',
  '.tsx',
  path.join('index.js'),
  path.join('index.ts'),
  path.join('index.mjs'),
  path.join('index.mts'),
  path.join('index.cjs'),
  path.join('index.cts'),
  path.join('index.jsx'),
  path.join('index.tsx'),
]
const resolveCandidates = (fromFile, spec) => {
  const base = path.resolve(path.dirname(fromFile), spec)
  return RESOLVE_SUFFIXES.map((suffix) => base + suffix)
}

/** 只接受真实存在的普通文件：目录/不存在都不算解析成功 */
const isResolvableFile = (candidate) => {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * 去掉注释（保留字符串字面量，require/import 的路径就在字符串里），避免注释里的旧代码误报。
 * 关键点：
 * - 用 UTF-16 code unit 数组（source.split('')）：所有下标都按 source[index] 计算，
 *   Array.from 按 code point 拆分会造成 astral 字符（emoji）后的写空格错位、串改真实代码；
 * - 维护 token 历史区分除法与正则：/["']/ 里的引号不会把状态机带进字符串；
 * - 只在「表达式起始」位置开启字符串状态：JSX 文本里的撇号（Don't）会保持为普通代码，
 *   不会吞掉后续注释里的 require；正则/JSX 的引号也不会污染状态机。
 */
function stripComments(source) {
  const chars = source.split('')
  const blank = (from, to) => {
    for (let k = from; k < to && k < chars.length; k++) {
      if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' '
    }
  }
  const MARK_START_TOKENS = new Set([
    '',
    '(',
    '[',
    '{',
    ',',
    ';',
    ':',
    '=',
    '!',
    '?',
    '+',
    '-',
    '*',
    '%',
    '&',
    '|',
    '^',
    '~',
    '<',
    '>',
    'return',
    'typeof',
    'instanceof',
    'in',
    'of',
    'case',
    'delete',
    'void',
    'yield',
    'await',
    'else',
    'do',
    'new',
    'throw',
    'from',
    'import',
    'export',
    'default',
  ])
  let lastToken = ''
  let beforeLastToken = ''
  const setToken = (token) => {
    beforeLastToken = lastToken
    lastToken = token
  }
  const isValueLike = (token) =>
    token === 'value' || token === ')' || token === ']' || token === '}' || (/^[A-Za-z_$][\w$]*$/.test(token) && !MARK_START_TOKENS.has(token))
  const isRegexStart = () => {
    if (MARK_START_TOKENS.has(lastToken)) return true
    if (lastToken === '+' || lastToken === '-') return !isValueLike(beforeLastToken)
    return false
  }
  let quote = ''
  let lineComment = false
  let blockComment = false
  let index = 0
  while (index < source.length) {
    const ch = source[index]
    if (lineComment) {
      if (ch === '\n') {
        lineComment = false
        setToken('')
      } else {
        blank(index, index + 1)
      }
      index += 1
      continue
    }
    if (blockComment) {
      if (ch === '*' && source[index + 1] === '/') {
        blank(index, index + 2)
        index += 2
        blockComment = false
        setToken('')
        continue
      }
      blank(index, index + 1)
      index += 1
      continue
    }
    if (quote !== '') {
      if (ch === '\\') {
        index += 2
        continue
      }
      if (ch === quote) quote = ''
      index += 1
      continue
    }
    // 正则字面量：跳过字符类内的 /，整段内容按注释处理（不能把其中的引号当字符串起点）
    if (ch === '/' && source[index + 1] !== '/' && source[index + 1] !== '*' && isRegexStart()) {
      let cursor = index + 1
      let inCharacterClass = false
      let closed = false
      while (cursor < source.length) {
        const current = source[cursor]
        if (current === '\\') {
          cursor += 2
          continue
        }
        if (current === '[') {
          inCharacterClass = true
          cursor += 1
          continue
        }
        if (current === ']') {
          inCharacterClass = false
          cursor += 1
          continue
        }
        if (current === '/' && !inCharacterClass) {
          closed = true
          break
        }
        if (current === '\n') break
        cursor += 1
      }
      if (closed) {
        let flagsEnd = cursor + 1
        while (flagsEnd < source.length && /[A-Za-z]/.test(source[flagsEnd])) flagsEnd += 1
        blank(index, flagsEnd)
        setToken('value')
        index = flagsEnd
        continue
      }
      setToken('/')
      index += 1
      continue
    }
    if (ch === '/' && source[index + 1] === '/') {
      blank(index, index + 2)
      index += 2
      lineComment = true
      continue
    }
    if (ch === '/' && source[index + 1] === '*') {
      blank(index, index + 2)
      index += 2
      blockComment = true
      continue
    }
    if (ch === "'" || ch === '"' || ch === '\u0060') {
      if (MARK_START_TOKENS.has(lastToken)) {
        quote = ch
        setToken('value')
        index += 1
        continue
      }
      setToken('value')
      index += 1
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let cursor = index + 1
      while (cursor < source.length && /[\w$]/.test(source[cursor])) cursor += 1
      setToken(source.slice(index, cursor))
      index = cursor
      continue
    }
    if (/[0-9]/.test(ch)) {
      let cursor = index + 1
      while (cursor < source.length && /[0-9A-Za-z_$]/.test(source[cursor])) cursor += 1
      setToken('value')
      index = cursor
      continue
    }
    if ((ch === '+' || ch === '-') && source[index + 1] === ch) {
      setToken(ch + ch)
      index += 2
      continue
    }
    if (!/\s/.test(ch)) setToken(ch)
    index += 1
  }
  return chars.join('')
}

const violations = []
const files = collectMainPackageFiles(projectRoot)
const requirePattern = /(?:require\s*\(\s*|import\s*\(\s*|(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?)['"](\.[^'"]+)['"]/g

for (const file of files) {
  const source = stripComments(readFileSync(file, 'utf8'))
  for (const match of source.matchAll(requirePattern)) {
    const spec = match[1]
    for (const candidate of resolveCandidates(file, spec)) {
      if (!isResolvableFile(candidate)) continue
      const relative = path.relative(projectRoot, candidate).split(path.sep).join('/')
      const hitRoot = subpackageRoots.find((root) => relative === root || relative.startsWith(root + '/'))
      if (hitRoot !== undefined) {
        violations.push({
          from: path.relative(projectRoot, file).split(path.sep).join('/'),
          to: relative,
          subpackage: hitRoot,
        })
        break
      }
    }
  }
}

if (violations.length > 0) {
  console.error('[check-package-boundary] 主包引用分包模块 ' + violations.length + ' 处（依赖方向违规：分包模块不可被主包引用）')
  for (const violation of violations) {
    console.error('  ' + violation.from + ' → ' + violation.to + '（分包 ' + violation.subpackage + '）')
  }
  console.error('修复方向：把被引用的 Store 模块上移到主包，或经主包聚合注册表按需获取；见 docs/MIGRATION.md')
  process.exit(1)
}

console.log('[check-package-boundary] 通过：主包 ' + files.length + ' 个源文件无分包引用（分包 ' + subpackageRoots.length + ' 个）')
