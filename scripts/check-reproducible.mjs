#!/usr/bin/env node
/**
 * 可复现构建校验（ 验收 2）：同源码连续两次构建，dist-weapp 逐文件 sha256 一致。
 *
 * esbuild 转译是确定性的（无时间戳/随机标识注入），本脚本把该性质固化为门禁：
 * 两次 build:weapp 后对 dist-weapp 全部文件取哈希，逐文件比对；不一致即失败
 * （意味着构建引入了不确定性——缓存污染、依赖漂移或非确定性插件）。
 *
 * 用法：node scripts/check-reproducible.mjs
 * 退出码：0 可复现 / 1 哈希不一致（构建非确定性） / 2 构建失败或产物缺失（无法判定）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { repoRoot } from './publish-entries.mjs'

const distDir = path.join(repoRoot, 'dist-weapp')

/**
 * 目录遍历：只收集普通文件；符号链接等非常规条目按真实类型处理。
 * 用 realpath 的 visited 集合防止链接环/链接越出 dist-weapp 导致无限递归。
 */
const walk = (dir, visited = new Set()) => {
  let realDir
  try {
    realDir = realpathSync(dir)
  } catch {
    return []
  }
  if (visited.has(realDir)) return []
  visited.add(realDir)
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(full, visited))
      continue
    }
    if (entry.isFile()) {
      out.push(full)
      continue
    }
    // 符号链接/设备等：跟随一次再判断，避免把链接目录当文件读取
    let linked
    try {
      linked = statSync(full)
    } catch {
      continue
    }
    if (linked.isDirectory()) out.push(...walk(full, visited))
    else if (linked.isFile()) out.push(full)
  }
  return out
}

const hashDist = () => {
  const hashes = new Map()
  for (const file of walk(distDir)) {
    hashes.set(path.relative(distDir, file).split(path.sep).join('/'), createHash('sha256').update(readFileSync(file)).digest('hex'))
  }
  return hashes
}

/** 构建失败与哈希不一致必须可区分：捕获构建错误并给出独立诊断/退出码 2 */
const build = () => {
  try {
    execFileSync(process.execPath, [path.join('scripts', 'build-weapp.mjs')], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    })
  } catch (error) {
    console.error('[check-reproducible] 构建失败（构建本身出错，与「可复现性不一致」无关）：')
    const stderr = error && typeof error.stderr === 'string' ? error.stderr.trim() : ''
    console.error(stderr === '' ? (error instanceof Error ? error.message : String(error)) : stderr)
    process.exit(2)
  }
}

// 不能在建 dist-weapp 之前先检查它是否存在：build() 自己就会创建该目录。
// 构建失败由 build() 的 try/catch 以退出码 2 报出；构建成功但产物缺失才是异常。
build()
if (!existsSync(distDir)) {
  console.error('[check-reproducible] 构建未产出 dist-weapp（无法判定可复现性）')
  process.exit(2)
}
const first = hashDist()
build()
const second = hashDist()

const problems = []
const names = new Set([...first.keys(), ...second.keys()])
for (const name of names) {
  if (first.get(name) !== second.get(name)) {
    problems.push(name + ': ' + (first.get(name) ?? '(缺失)') + ' ≠ ' + (second.get(name) ?? '(缺失)'))
  }
}

if (problems.length > 0) {
  console.error('[check-reproducible] 两次构建存在差异 ' + problems.length + ' 处（构建非确定性）：')
  for (const problem of problems) console.error('  ' + problem)
  process.exit(1)
}

console.log('[check-reproducible] 通过：两次构建 ' + first.size + ' 个文件 sha256 全部一致')
