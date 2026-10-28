import path from 'node:path'

/**
 * target 是否严格位于 npmRoot 目录之下。
 *
 * sync-lib 会先 rmSync(target) 再复制 dist-weapp 到 target：target 一旦等于 npmRoot 或越出它，
 * 就会清空 / 污染 miniprogram_npm。这里对 resolved 路径做严格前缀判定（连同分隔符），
 * 去掉原先 `target !== npmRoot &&` 的 fail-open 短路——等于 npmRoot 时也应直接失败。
 *
 * @param {string} npmRoot
 * @param {string} target
 * @returns {boolean}
 */
export function isStrictlyInsideDirectory(npmRoot, target) {
  const root = path.resolve(npmRoot)
  const resolved = path.resolve(target)
  return resolved !== root && resolved.startsWith(root + path.sep)
}

/**
 * 同步失败后的收尾决策：只有 target 仍然存在时才能安全丢弃 staging。
 * 若失败发生在 `rmSync(target)` 之后（典型：rename 因权限/占用失败），staging 是唯一可用的
 * 新产物——删除 staging 会同时丢掉旧版本与新版本，且「现有 miniprogram_npm 未被替换」的提示
 * 也不再成立。
 *
 * @param {{ targetExists: boolean, staging: string, target: string }} state
 * @returns {{ cleanupStaging: boolean, message: string }}
 */
export function planSyncFailureCleanup(state) {
  if (state.targetExists) {
    return {
      cleanupStaging: true,
      message: '[sync-lib] 现有 miniprogram_npm 未被替换：' + state.target,
    }
  }
  return {
    cleanupStaging: false,
    message: '[sync-lib] 目标已被删除但替换失败，新产物保留在：' + state.staging,
  }
}
