/** 校验发布面：dist-weapp 运行时入口、types 声明、无意外 dist/ 残留（CI 与本地同源） */
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { publishEntries, repoRoot, resolveTypesOutDir } from './publish-entries.mjs'

let entries
try {
  entries = publishEntries()
} catch (error) {
  // 配置错误按统一的发布面报告格式输出，而不是抛原始栈
  console.error('[publish-surface] 发布面配置错误：' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
}

// 类型产物目录与 tsconfig.types.json 同源；解析失败 fail-closed 报配置错误，
// 不再静默回退 types/（回退可能让校验在错误目录上通过）
let typesOutDir
try {
  typesOutDir = resolveTypesOutDir()
} catch (error) {
  console.error('[publish-surface] 无法解析类型产物目录（tsconfig.types.json）：' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
}

const { distDir, runtimeFiles, typeFiles } = entries
const problems = []

/** 校验 entry 存在且是普通文件（existsSync 无法区分同名目录） */
function checkFiles(files, base, label) {
  for (const file of files) {
    const full = path.join(repoRoot, base, file)
    const relative = path.relative(repoRoot, full)
    if (!existsSync(full)) {
      problems.push('missing ' + label + ': ' + relative)
      continue
    }
    if (!statSync(full).isFile()) {
      problems.push('not a file (' + label + '): ' + relative)
    }
  }
}

// 基路径口径：runtime 入口位于 package.json.miniprogram 指向的目录内；
// types 声明路径相对包根（publish-entries 已去掉 ./ 前缀）
checkFiles(runtimeFiles, distDir, 'runtime entry')
checkFiles(typeFiles, '', 'type declaration')

// 意外目录：期望的构建输出只有 distDir（来自 miniprogram）与 types outDir，其余一律报错
const expectedDirs = new Set([distDir, typesOutDir])
for (const candidate of ['dist']) {
  if (!expectedDirs.has(candidate) && existsSync(path.join(repoRoot, candidate))) {
    problems.push('unexpected ' + candidate + '/ directory')
  }
}

if (problems.length > 0) {
  console.error('[publish-surface] failed:')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
console.log('[publish-surface] ok: ' + runtimeFiles.length + ' runtime entries, ' + typeFiles.length + ' type declarations, no unexpected dist/')
