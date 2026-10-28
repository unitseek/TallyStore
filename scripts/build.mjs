import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { publishEntries, repoRoot, resolveTypesOutDir } from './publish-entries.mjs'

// 仓库根由脚本位置推导，不依赖调用方 cwd
const root = repoRoot

/** 分阶段执行：失败时抛出带阶段标签的错误，CI 一眼定位失败阶段 */
function runPhase(label, command, args) {
  try {
    execFileSync(command, args, { cwd: root, stdio: 'inherit' })
  } catch (error) {
    const exitCode = error && typeof error.status === 'number' ? error.status : 'unknown'
    throw new Error('[build] 阶段「' + label + '」失败（exit code: ' + exitCode + '）', { cause: error })
  }
}

/** 期望产物与发布面/类型配置同一来源，避免目录改名后此处校验陈旧路径 */
function expectedArtifacts() {
  try {
    const publish = publishEntries()
    const rootRuntime = publish.runtimeEntries.find((entry) => entry.key === '.')
    const rootTypes = publish.typeFiles[0]
    return [
      path.join(publish.distDir, rootRuntime === undefined ? 'index.js' : rootRuntime.file),
      rootTypes === undefined ? path.join(resolveTypesOutDir(), 'index.d.ts') : rootTypes,
    ]
  } catch (error) {
    throw new Error('[build] 无法解析发布面期望产物：' + (error instanceof Error ? error.message : String(error)))
  }
}

runPhase('clean', process.execPath, [path.join('scripts', 'clean.mjs')])
runPhase('build:types', process.execPath, [path.join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.types.json'])
runPhase('build:weapp', process.execPath, [path.join('scripts', 'build-weapp.mjs')])

// 产物完整性校验：校验期望文件存在且非空（目录存在不足以证明构建成功），并在 size 之前执行
for (const relative of expectedArtifacts()) {
  const full = path.join(root, relative)
  if (!existsSync(full)) throw new Error('[build] 缺少期望产物：' + relative)
  if (statSync(full).size === 0) throw new Error('[build] 产物为空：' + relative)
}

runPhase('size', process.execPath, [path.join('scripts', 'size.mjs')])
