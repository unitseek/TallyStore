#!/usr/bin/env node
/**
 * 把仓库根构建好的 dist-weapp/ 手工同步成 demo 可 require 的 npm 包目录：
 *
 *   examples/miniprogram/miniprogram_npm/@unitseek/tallystore/
 *
 * 为什么手工同步、不走 npm install + 微信「构建 npm」：
 * - demo 要「打开即可运行」，不依赖 registry、不依赖网络；
 * - 微信侧运行时按 miniprogram_npm/<包名>/ 下的文件路径解析，dist-weapp 本身就是
 *   CJS 整目录产物，原样拷进去与「构建 npm」对 miniprogram 字段整目录拷贝的结果一致。
 *
 * 注意：在微信开发者工具里点「构建 npm」会按 project.config.json 重算 miniprogram_npm，
 * 可能清掉这里复制的内容；改完源码后重新 build + sync 即可。
 *
 * 用法（任意 cwd）：node examples/miniprogram/scripts/sync-lib.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isStrictlyInsideDirectory, planSyncFailureCleanup } from './syncPathGuard.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const demoRoot = path.resolve(here, '..')
const repoRoot = path.resolve(demoRoot, '../..')
const source = path.join(repoRoot, 'dist-weapp')
const packageName = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).name
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i
if (typeof packageName !== 'string' || !PACKAGE_NAME_PATTERN.test(packageName)) {
  console.error('[sync-lib] 根 package.json 的 name 缺失或不是合法包名：' + String(packageName))
  process.exit(1)
}
const npmRoot = path.join(demoRoot, 'miniprogram_npm')
const target = path.join(npmRoot, ...packageName.split('/'))
if (!isStrictlyInsideDirectory(npmRoot, target)) {
  console.error('[sync-lib] 目标路径越出 miniprogram_npm：' + target)
  process.exit(1)
}

if (!fs.existsSync(path.join(source, 'index.js'))) {
  console.error('[sync-lib] 找不到 ' + path.relative(repoRoot, source) + '/index.js')
  console.error('[sync-lib] 请先在仓库根执行：pnpm run build')
  process.exit(1)
}

// 先复制到同级 staging 目录，成功后再替换 target：
// 先删目标再 cpSync 一旦中途失败（磁盘满/权限/中断），会留下「目标已被清空、新内容没拷进来」的坏状态
const staging = target + '.tmp'
fs.rmSync(staging, { recursive: true, force: true })
try {
  fs.mkdirSync(staging, { recursive: true })
  fs.cpSync(source, staging, { recursive: true })
  fs.rmSync(target, { recursive: true, force: true })
  fs.renameSync(staging, target)
} catch (error) {
  // 失败可能发生在 rmSync(target) 之后（如 rename 失败），此时 staging 是唯一可用的
  // 新产物，不能无条件删除；按 target 是否仍存在决定「清理 staging」还是「保留并提示路径」。
  const plan = planSyncFailureCleanup({ targetExists: fs.existsSync(target), staging, target })
  if (plan.cleanupStaging) {
    try {
      fs.rmSync(staging, { recursive: true, force: true })
    } catch {
      // staging 清理失败不得掩盖原始错误
    }
  }
  console.error('[sync-lib] 同步失败：' + (error instanceof Error ? error.message : String(error)))
  console.error(plan.message)
  process.exit(1)
}

const files = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else files.push(full)
  }
}
walk(target)
const bytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0)

console.log('[sync-lib] 已复制 ' + files.length + ' 个文件 / ' + (bytes / 1024).toFixed(1) + ' KB')
console.log('[sync-lib] ' + path.relative(repoRoot, source) + ' → ' + path.relative(repoRoot, target))
console.log('[sync-lib] 现在用微信开发者工具打开 examples/miniprogram 即可（不要点「构建 npm」）')
