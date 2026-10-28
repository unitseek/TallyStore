/**
 * 契约测试加载器：从发布产物 dist-weapp/ 加载（与微信「构建 npm」整目录拷贝后的
 * require 形态一致），而不是从 src 的 TypeScript 加载。
 *
 * 加载方式与 examples/miniprogram/e2e/host-smoke.mjs 相同：仓库根 package.json 是
 * "type": "module"，Node 会把产物的 CJS 相对 require 判为 ESM 而崩溃；产物拷贝到
 * 临时目录并声明 {"type":"commonjs"} 后再 require，与微信运行时按目录加载的形态一致。
 *
 * dist-weapp 不存在时（如只跑单测没构建），所有契约用例跳过并给出明确提示；
 * CI 在 build 之后运行测试，保证一定走真实产物。
 */
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const repoRoot = path.resolve(__dirname, '../..')
const distDir = path.join(repoRoot, 'dist-weapp')

export const distAvailable = existsSync(path.join(distDir, 'index.js'))

let loadRoot: string | undefined
/** exit 清理钩子只注册一次——cleanup 后重新 prepare 不得反复累积监听器 */
let exitHookRegistered = false

/**
 * 惰性准备临时加载目录（整个测试进程只拷贝一次）。
 * 先在局部目录完成 copy + commonjs 标记，全部成功后才发布到 loadRoot：
 * 中途失败时不会把「半准备的目录」缓存下来，后续 require 只会得到真实错误而不是 ERR_REQUIRE_ESM。
 */
function prepareLoadRoot(): string {
  if (loadRoot !== undefined) {
    return loadRoot
  }
  const root = mkdtempSync(path.join(os.tmpdir(), 'tallystore-contract-'))
  try {
    cpSync(distDir, root, { recursive: true })
    writeFileSync(path.join(root, 'package.json'), '{"type":"commonjs"}\n')
  } catch (error) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // 准备失败时的清理失败不掩盖原始错误
    }
    throw error
  }
  loadRoot = root
  // 整个产物拷贝不能在 os.tmpdir() 里无限累积，进程退出时清理（测试也可主动调用）。
  // cleanupLoadRoot 后可重新 prepare，钩子只注册一次，避免 exit 监听器随 prepare 次数增长。
  if (!exitHookRegistered) {
    exitHookRegistered = true
    process.once('exit', cleanupLoadRoot)
  }
  return loadRoot
}

/** 删除契约测试的临时加载目录（幂等；测试 afterAll 或进程退出时调用） */
export function cleanupLoadRoot(): void {
  if (loadRoot === undefined) {
    return
  }
  const root = loadRoot
  loadRoot = undefined
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // 临时目录清理失败不影响测试结果
  }
}

/**
 * 入口 → 产物文件：只接受 '.' 或 './xxx' 形式，拒绝 .. 段与绝对路径，
 * 不把任意字符串拼进临时目录的可加载路径。
 */
function resolveEntryFile(entry: string): string {
  // 同时按 / 与 \ 切分（Windows 的 path.join 也把 \ 当分隔符），拒绝 .. 段与空段：
  // - './..\evil' 旧实现只 split('/') 会漏掉 '..' → 在 Windows 上越出临时目录；
  // - './' 旧实现能通过，拼出奇怪的 '.js'；'./a//b' 同样应拒绝。
  const segments = entry.split(/[\\/]/)
  const valid = entry === '.' || (entry.startsWith('./') && segments.length > 1 && segments[0] === '.' && !segments.includes('..') && !segments.includes(''))
  if (!valid) {
    throw new Error('非法的 dist 入口（只支持 "." 或 "./xxx"，且不得包含 .. 或空路径段）：' + entry)
  }
  return entry === '.' ? 'index.js' : entry.replace(/^\.\//, '') + '.js'
}

/**
 * 从发布产物 require 一个入口。
 * @param entry `'.'` → index.js；`'./plugins'` → plugins.js（对应 package.json exports 键）
 */
export function requireFromDist(entry: string): Record<string, unknown> {
  // 入口形态校验与产物是否构建无关，先做（契约测试在未构建时会 skip，但输入校验始终可验证）
  const file = resolveEntryFile(entry)
  if (!distAvailable) {
    throw new Error('dist-weapp 不可用：请先执行 pnpm run build')
  }
  const root = prepareLoadRoot()
  const require = createRequire(pathToFileURL(path.join(root, 'package.json')).href)
  try {
    return require(path.join(root, file)) as Record<string, unknown>
  } catch (error) {
    // require 失败时补上真实产物目录与入口，否则栈里只有 /tmp/tallystore-contract-xxx 的临时路径
    const wrapped = new Error('从发布产物加载入口失败：entry=' + entry + '，产物目录=' + distDir + '，临时加载目录=' + root)
    ;(wrapped as { cause?: unknown }).cause = error
    throw wrapped
  }
}
