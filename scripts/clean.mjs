import { rm } from 'node:fs/promises'
import path from 'node:path'
import { publishEntries, repoRoot, resolveInsideRepo, resolveTypesOutDir } from './publish-entries.mjs'

/**
 * 清理目标唯一口径：distDir 来自 package.json.miniprogram，types 目录来自 tsconfig.types.json.outDir。
 * 递归删除前必须解析为「仓库内绝对路径」：越界（../x、/abs、仓库根本身）直接拒绝，
 * 防止配置错误导致删掉仓库外的目录。
 */
let absoluteTargets
try {
  const relativeTargets = [...new Set([publishEntries().distDir, resolveTypesOutDir()])]
  absoluteTargets = relativeTargets.map((dir) => resolveInsideRepo(dir, 'clean'))
} catch (error) {
  console.error('[clean] 清理目标解析失败：' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
}

// 两个目录互相独立：并发删除，失败项汇总后统一退出
const results = await Promise.allSettled(absoluteTargets.map((target) => rm(target, { recursive: true, force: true })))
const failures = results
  .map((result, index) => ({ target: absoluteTargets[index], result }))
  .filter((entry) => entry.result.status === 'rejected')
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(
      '[clean] 删除 ' +
        path.relative(repoRoot, failure.target) +
        ' 失败：' +
        (failure.result.reason instanceof Error ? failure.result.reason.message : String(failure.result.reason)),
    )
  }
  process.exit(1)
}
