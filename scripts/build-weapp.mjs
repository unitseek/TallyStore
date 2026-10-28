/**
 * 把 src 逐模块转成 CJS，产出微信「构建 npm」整目录拷贝的 dist-weapp/。
 * 逐模块而非 bundle：跨入口共享同一份模块实例，运行时只 require 真正用到的文件。
 */
import { readdir, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { transform } from 'esbuild'
import { publishEntries, repoRoot, resolveInsideRepo } from './publish-entries.mjs'

const root = repoRoot
const srcDir = path.join(root, 'src')
// 输出目录与入口清单同源：distDir 来自 package.json.miniprogram；
// 解析结果必须在仓库内（后续 rm 递归删除，越界/仓库根本身直接拒绝，/017）
const publish = publishEntries()
const outDir = resolveInsideRepo(publish.distDir, 'build-weapp')

/** 有界并发：逐文件读写互相独立，限制并发避免 Windows/CI 上的 fd 峰值 */
const CONCURRENCY = 8
async function mapWithConcurrency(items, limit, worker) {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      await worker(items[index])
    }
  })
  await Promise.all(runners)
}

/** 统一的目录遍历（walk / walkJs 合并，避免规则改两处漂移） */
const walkFiles = async (dir, accept) => {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walkFiles(full, accept)))
    else if (accept(entry.name)) out.push(full)
  }
  return out
}

const isSourceModule = (name) => name.endsWith('.ts') && !name.endsWith('.d.ts')
const isJsModule = (name) => name.endsWith('.js')

/** 纯类型模块：相对路径中任一目录段为 types（含嵌套，如 src/plugins/types/x.ts） */
const isTypeOnlyModule = (relative) => relative.split(path.sep).slice(0, -1).includes('types')

const files = await walkFiles(srcDir, isSourceModule)
// 单独执行 build:weapp 也必须从干净目录开始，避免已删除模块的旧产物残留并被发布
await rm(outDir, { recursive: true, force: true })

let skipped = 0
await mapWithConcurrency(files, CONCURRENCY, async (file) => {
  const relative = path.relative(srcDir, file)
  if (isTypeOnlyModule(relative)) {
    skipped += 1
    return
  }
  const source = await readFile(file, 'utf8')
  const { code } = await transform(source, {
    loader: 'ts',
    format: 'cjs',
    target: 'es2020',
    minify: true,
    charset: 'utf8',
    sourcefile: path.relative(root, file),
  })
  const outFile = path.join(outDir, path.relative(srcDir, file)).replace(/\.ts$/, '.js')
  await mkdir(path.dirname(outFile), { recursive: true })
  await writeFile(outFile, code)
})

// 根 package.json 是 "type": "module"，而本目录产物是 CJS：在产物内单独声明 commonjs，
// 让 Node 工具/按路径 require 的消费者按 CJS 解释这些 .js（微信「构建 npm」拷贝同样包含该文件）
const distManifest = JSON.stringify({ type: 'commonjs' }) + '\n'
await writeFile(path.join(outDir, 'package.json'), distManifest)

for (const entry of publish.runtimeFiles) {
  const artifactPath = path.join(outDir, entry)
  let artifactStat
  try {
    artifactStat = await stat(artifactPath)
  } catch (error) {
    // 只有「文件不存在」才映射为缺少产物；权限/IO 错误原样上抛，避免掩盖真实原因
    if (error && error.code === 'ENOENT') throw new Error('[build-weapp] 缺少入口产物：' + entry)
    throw error
  }
  if (!artifactStat.isFile() || artifactStat.size === 0) {
    throw new Error('[build-weapp] 入口产物为空或不是文件：' + entry)
  }
}

const output = await walkFiles(outDir, isJsModule)
const buffers = await Promise.all(output.map((file) => readFile(file)))
let bytes = buffers.reduce((sum, buffer) => sum + buffer.length, 0)
// 产物清单文件同样计入产物体积（发布面按整目录拷贝计费，size.mjs 亦会统计该文件）
bytes += Buffer.byteLength(distManifest)
console.log(
  '[build-weapp] ' + files.length + ' 个源模块 → ' + output.length + ' 个 js（跳过 ' + skipped + ' 个纯类型模块）、另有 package.json（CJS 声明），共 ' + (bytes / 1024).toFixed(1) + ' KB',
)
