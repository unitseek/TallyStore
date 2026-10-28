#!/usr/bin/env node
/**
 *  示例一致性门禁（构建后执行）：
 * 1) `examples/miniprogram/app.json` 的 pages/subPackages 里每个页面都具备 js/json/wxml/wxss 四件套；
 * 2) app.js / pages/index/index.js / components/counter/counter.js 中对 `@unitseek/tallystore`
 *    的 subpath 导入都能在 `package.json` 的 `exports` 找到键，且对应 dist-weapp 运行时入口文件存在
 *    （发布产物入口与示例用法一致；不加载产物执行，避免脚本对宿主全局的副作用）；
 * 3) `examples/miniprogram/README.md` 与实际 app.json 分包配置一致：每个 subpackage root 与页面路径
 *    都被文档提及（文档与示例同源，防漂移）。
 *
 * 用法：node scripts/check-docs-examples.mjs [--root=<仓库根>]
 *   默认根为脚本所在仓库；`--root` 供单测使用临时 fixture。
 * 前置：dist-weapp 已构建（CI 在 build 之后执行）。
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
      console.error('[check-docs-examples] --root 需要目录参数')
      process.exit(1)
    }
    return path.isAbsolute(value) ? value : path.resolve(here, '..', value)
  }
  const withEquals = process.argv.find((item) => item.startsWith('--root='))
  if (withEquals) {
    const value = withEquals.slice('--root='.length)
    if (!value) {
      console.error('[check-docs-examples] --root 需要目录参数')
      process.exit(1)
    }
    return path.isAbsolute(value) ? value : path.resolve(here, '..', value)
  }
  return path.resolve(here, '..')
}

const root = resolveRoot()
const demoRoot = path.join(root, 'examples/miniprogram')
const problems = []
const problemsLabel = (detail) => problems.push(detail)

/** 读文本；缺失/读取失败返回 null 并记录问题 */
function readText(absolute, label) {
  if (!existsSync(absolute)) {
    problemsLabel(label + '：文件不存在')
    return null
  }
  try {
    return readFileSync(absolute, 'utf8')
  } catch (error) {
    problemsLabel(label + '：读取失败：' + (error instanceof Error ? error.message : String(error)))
    return null
  }
}

const pkgText = readText(path.join(root, 'package.json'), 'package.json')
let pkg = null
if (pkgText !== null) {
  try {
    pkg = JSON.parse(pkgText)
  } catch (error) {
    problemsLabel('package.json：不是合法 JSON：' + (error instanceof Error ? error.message : String(error)))
  }
}

const exportsKeys = pkg && pkg.exports && typeof pkg.exports === 'object' ? Object.keys(pkg.exports) : []
const distDir = pkg && typeof pkg.miniprogram === 'string' ? pkg.miniprogram : 'dist-weapp'
const distRoot = path.join(root, distDir)

// ---------- 1) app.json 页面四件套 ----------
const APP_PAGE_EXTENSIONS = ['js', 'json', 'wxml', 'wxss']
const appJsonText = readText(path.join(demoRoot, 'app.json'), 'examples/miniprogram/app.json')
let appJson = null
if (appJsonText !== null) {
  try {
    appJson = JSON.parse(appJsonText)
  } catch (error) {
    problemsLabel('examples/miniprogram/app.json：不是合法 JSON：' + (error instanceof Error ? error.message : String(error)))
  }
}

/** app.json 收集页面全路径：主包 pages + subPackages[].pages（root 前缀） */
function collectDeclaredPages(config) {
  const pages = Array.isArray(config.pages) ? config.pages.filter((page) => typeof page === 'string') : []
  const subpackages = []
  for (const key of ['subPackages', 'subpackages']) {
    const value = config[key]
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object' || typeof entry.root !== 'string' || !Array.isArray(entry.pages)) continue
      const rootName = entry.root.replace(/\/+$/, '')
      subpackages.push({ root: rootName, pages: entry.pages.filter((page) => typeof page === 'string') })
      for (const page of entry.pages) {
        if (typeof page === 'string') pages.push(rootName + '/' + page)
      }
    }
  }
  return { pages, subpackages }
}

const declarations = appJson === null ? { pages: [], subpackages: [] } : collectDeclaredPages(appJson)
if (declarations.pages.length === 0) {
  problemsLabel('examples/miniprogram/app.json：未声明任何页面（pages/subPackages 均为空）')
}
for (const page of declarations.pages) {
  for (const extension of APP_PAGE_EXTENSIONS) {
    const relative = 'examples/miniprogram/' + page + '.' + extension
    if (!existsSync(path.join(root, relative))) {
      problemsLabel(relative + '：页面四件套缺失（' + page + ' 缺 .' + extension + '）')
    }
  }
}

// ---------- 2) 示例导入 ↔ package exports / dist 入口 ----------
const LIBRARY_SPECIFIER = '@unitseek/tallystore'
const EXAMPLE_SOURCES = ['examples/miniprogram/app.js', 'examples/miniprogram/pages/index/index.js', 'examples/miniprogram/components/counter/counter.js']
const DESTRUCTURE_REQUIRE = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"](@unitseek\/tallystore(?:\/[^'"]*)?)['"]\s*\)/g
const DESTRUCTURE_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"](@unitseek\/tallystore(?:\/[^'"]*)?)['"]/g

/** subpath → package.json exports 键：''/'.' → '.'；'/plugins' → './plugins' */
function toExportsKey(specifier) {
  const suffix = specifier.slice(LIBRARY_SPECIFIER.length)
  if (suffix === '') return '.'
  return './' + suffix.replace(/^\//, '')
}

/** exports 键 → dist-weapp 运行时入口文件：'.' → index.js；'./plugins' → plugins.js */
function toRuntimeFile(exportsKey) {
  if (exportsKey === '.') return 'index.js'
  return exportsKey.replace(/^\.\//, '') + '.js'
}

const importedSubpaths = new Set()
for (const source of EXAMPLE_SOURCES) {
  const text = readText(path.join(root, source), source)
  if (text === null) continue
  for (const pattern of [DESTRUCTURE_REQUIRE, DESTRUCTURE_IMPORT]) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text)) !== null) {
      const specifier = match[2]
      importedSubpaths.add(specifier)
      const exportsKey = toExportsKey(specifier)
      if (!exportsKeys.includes(exportsKey)) {
        problemsLabel(source + '：导入 ' + specifier + ' 对应的 exports 键 ' + exportsKey + ' 未在 package.json 声明')
        continue
      }
      const runtimeFile = toRuntimeFile(exportsKey)
      const runtimePath = path.join(distRoot, runtimeFile)
      if (!existsSync(runtimePath)) {
        problemsLabel(source + '：导入 ' + specifier + ' 需要 dist 入口 ' + path.join(distDir, runtimeFile) + '，但该文件不存在（先 pnpm run build）')
      }
    }
  }
}
if (importedSubpaths.size === 0) {
  problemsLabel('examples/miniprogram：未找到任何 ' + LIBRARY_SPECIFIER + ' 的导入（示例应与库集成）')
}

// ---------- 3) demo README ↔ app.json 分包配置 ----------
const demoReadme = readText(path.join(demoRoot, 'README.md'), 'examples/miniprogram/README.md')
if (demoReadme !== null) {
  for (const subpackage of declarations.subpackages) {
    if (!demoReadme.includes(subpackage.root)) {
      problemsLabel('examples/miniprogram/README.md：未提及 app.json 声明的分包 root `' + subpackage.root + '`')
    }
    for (const page of subpackage.pages) {
      const pagePath = subpackage.root + '/' + page
      if (!demoReadme.includes(pagePath)) {
        problemsLabel('examples/miniprogram/README.md：未提及分包页面 `' + pagePath + '`（README 与 app.json 配置不一致）')
      }
    }
  }
}

if (problems.length > 0) {
  console.error('[check-docs-examples] 失败（' + problems.length + ' 项）：')
  for (const problem of problems) {
    console.error('  - ' + problem)
  }
  process.exit(1)
}

console.log(
  '[check-docs-examples] 通过：' +
    declarations.pages.length +
    ' 个页面四件套齐全，' +
    importedSubpaths.size +
    ' 个库导入与 exports/dist 入口一致，' +
    declarations.subpackages.length +
    ' 个分包与 README 一致',
)
