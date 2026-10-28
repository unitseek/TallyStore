/** 发布面入口清单唯一来源：从 package.json 的 miniprogram + exports 派生 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 读取并解析 package.json；错误信息带文件路径上下文 */
export function loadPackage(root = repoRoot) {
  const packagePath = path.join(root, 'package.json')
  let raw
  try {
    raw = readFileSync(packagePath, 'utf8')
  } catch (error) {
    throw new Error('[publish-entries] 无法读取 ' + packagePath + '：' + (error instanceof Error ? error.message : String(error)))
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error('[publish-entries] ' + packagePath + ' 不是合法 JSON：' + (error instanceof Error ? error.message : String(error)))
  }
}

/**
 * 规范化包内路径：去前导 ./、统一分隔符、拒绝绝对路径与任何 .. 段。
 * 只拒绝「前导 ..」是不够的：dist/../../etc 这类中间 .. 段会让后续的递归 rm 越出仓库。
 */
function normalizePackagePath(value) {
  const slashPath = String(value).replace(/\\/g, '/')
  const segments = slashPath.split('/')
  const escapesByDotDot = segments.some((segment) => segment === '..')
  const normalized = segments.filter((segment) => segment !== '' && segment !== '.').join('/')
  if (
    normalized === '' ||
    escapesByDotDot ||
    path.posix.isAbsolute(slashPath) ||
    /^[A-Za-z]:/.test(slashPath)
  ) {
    throw new Error('[publish-entries] 非法包内路径：' + JSON.stringify(value) + '（必须是相对包根、且任何段都不得越出包根的路径）')
  }
  return normalized
}

/** 单文件入口的扩展名判定：.js/.mjs/.cjs 都算文件而非目录 */
const isFileEntry = (value) => /\.(?:[cm]?js)$/.test(value)

/**
 * exports 目标里的运行时文件：优先条件目标，其次退回 key 推导。
 * 本发布面是 CJS（微信构建 npm）：require 优先于 default/import；
 * 嵌套条件对象/数组目标无法可靠判定，显式报错而不是静默 fallback。
 */
function runtimeTargetOf(value) {
  for (const condition of ['require', 'default', 'import', 'node', 'browser']) {
    if (!(condition in value)) continue
    const target = value[condition]
    if (typeof target === 'string') return normalizePackagePath(target)
    throw new Error(
      '[publish-entries] exports 条件目标只支持字符串路径（' + condition + ' 为 ' + JSON.stringify(target) + '）；嵌套条件/数组目标请先人工确认发布面',
    )
  }
  return undefined
}

/**
 * 把包内相对路径解析为仓库内的绝对路径；解析结果等于仓库根或越出仓库根时抛错。
 * 供 clean/build 等**递归删除**目标使用。
 */
export function resolveInsideRepo(relative, label = 'root') {
  const target = path.resolve(repoRoot, String(relative))
  const relativeToRoot = path.relative(repoRoot, target)
  if (relativeToRoot === '' || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error('[publish-entries] 拒绝操作仓库根之外/根本身：' + JSON.stringify(relative) + '（' + label + '）')
  }
  return target
}

/** 读取 tsconfig.types.json 的类型产物目录（缺失/损坏 throw，不静默回退；/024） */
export function resolveTypesOutDir(root = repoRoot) {
  const tsconfigPath = path.join(root, 'tsconfig.types.json')
  let tsconfig
  try {
    tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'))
  } catch (error) {
    throw new Error('[publish-entries] 无法读取/解析 ' + tsconfigPath + '：' + (error instanceof Error ? error.message : String(error)))
  }
  const outDir = tsconfig && typeof tsconfig === 'object' && tsconfig.compilerOptions ? tsconfig.compilerOptions.outDir : undefined
  return typeof outDir === 'string' && outDir.trim() !== '' ? normalizePackagePath(outDir) : 'types'
}

/**
 * @param {object} [pkg]
 * @returns {{ distDir: string, runtimeFiles: string[], runtimeEntries: Array<{ key: string, file: string }>, typeFiles: string[] }}
 */
export function publishEntries(pkg = loadPackage()) {
  // miniprogram 可以是目录（微信官方写法）或单文件入口（.js / .mjs / .cjs）
  const miniprogramRaw = typeof pkg.miniprogram === 'string' ? normalizePackagePath(pkg.miniprogram) : ''
  if (miniprogramRaw === '') {
    throw new Error('[publish-entries] package.json.miniprogram must point to a directory or single-file entry')
  }
  const entryIsFile = isFileEntry(miniprogramRaw)
  const distDir = entryIsFile ? path.posix.dirname(miniprogramRaw) : miniprogramRaw
  // 单文件入口位于包根时 dirname 为 '.'：该目录就是仓库根，后续递归 rm 会清空整个仓库（ critical）。
  // npm 包的运行时入口不能与包根混同（否则 index.js 会与仓库根文件混在一起），直接拒绝。
  if (distDir === '' || distDir === '.') {
    throw new Error(
      '[publish-entries] miniprogram 单文件入口不能位于包根（' +
        JSON.stringify(pkg.miniprogram) +
        '）：distDir 会退化为仓库根，clean/build 的递归删除将误删整个仓库；请改用目录形态（miniprogram: "dist-weapp"）或把入口放进子目录',
    )
  }
  const fallbackRootRuntimeFile = entryIsFile ? path.posix.basename(miniprogramRaw) : 'index.js'

  const exportsField = pkg.exports
  if (
    exportsField === null ||
    typeof exportsField !== 'object' ||
    Array.isArray(exportsField) ||
    Object.keys(exportsField).length === 0
  ) {
    throw new Error('[publish-entries] package.json.exports must be a non-empty object')
  }

  /** exports 的运行时目标通常是 distDir 内路径：转成 runtimeFiles 约定的「distDir 相对路径」 */
  const toRuntimeFile = (target) => {
    const prefix = distDir + '/'
    return target.startsWith(prefix) ? target.slice(prefix.length) : target
  }

  /** 对外键名：'.' 保持；其余统一为 './xxx' 形态（api-report 用它生成表面键） */
  const toSurfaceKey = (key) => (key === '.' ? '.' : './' + normalizePackagePath(key.replace(/^\.\//, '')))

  const runtimeEntries = []
  const typeFiles = []
  for (const [key, value] of Object.entries(exportsField)) {
    if (key === './package.json') continue
    if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof value.types !== 'string') {
      throw new Error('[publish-entries] exports["' + key + '"] must declare a types path')
    }
    typeFiles.push(normalizePackagePath(value.types))
    const declaredTarget = runtimeTargetOf(value)
    let file
    if (key === '.') {
      file = declaredTarget === undefined ? fallbackRootRuntimeFile : toRuntimeFile(declaredTarget)
    } else if (declaredTarget === undefined) {
      file = normalizePackagePath(key.replace(/^\.\//, '')) + '.js'
    } else {
      file = toRuntimeFile(declaredTarget)
    }
    runtimeEntries.push({ key: toSurfaceKey(key), file })
  }
  // runtimeFiles 供 clean/build/发布面存在性校验使用（唯一文件集）；
  // runtimeEntries 保留 exports 键 → 文件 的映射，避免别名导出被去重后 API 表面静默少一项
  const runtimeFiles = [...new Set(runtimeEntries.map((entry) => entry.file))]
  return { distDir, runtimeFiles, runtimeEntries, typeFiles: [...new Set(typeFiles)] }
}
