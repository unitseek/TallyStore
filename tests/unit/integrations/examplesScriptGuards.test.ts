/**
 * examples/miniprogram 脚本纯守卫的单元测试。
 *
 * helper 是 .mjs 原生 ESM：jest 运行时默认不允许 require(ESM)，这里用子进程 node 加载，
 * 避免把 side-effect 型入口脚本（automator.mjs / sync-lib.mjs）整体 import 进来。
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 在独立 node 进程里加载 ESM helper 并调用指定导出（参数经环境变量 JSON 传入，避免引号转义） */
function runGuard(relativePath: string, fnName: string, args: unknown[]): unknown {
  const url = pathToFileURL(path.join(process.cwd(), relativePath)).href
  const script =
    'const { ' +
    fnName +
    ' } = await import(' +
    JSON.stringify(url) +
    '); const args = JSON.parse(process.env.GUARD_ARG); process.stdout.write(JSON.stringify(' +
    fnName +
    '(...args)))'
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, GUARD_ARG: JSON.stringify(args) },
  })
  return JSON.parse(stdout) as unknown
}

function shouldSkip(error: unknown): boolean {
  return runGuard('examples/miniprogram/e2e/automator-detection.mjs', 'shouldSkipMissingAutomator', [error]) as boolean
}

function insideNpmRoot(npmRoot: string, target: string): boolean {
  return runGuard('examples/miniprogram/scripts/syncPathGuard.mjs', 'isStrictlyInsideDirectory', [npmRoot, target]) as boolean
}

describe('automator-detection · 缺失包判定', () => {
  it('只有错误消息点名 miniprogram-automator 才判定为「包未安装」', () => {
    expect(shouldSkip({ code: 'ERR_MODULE_NOT_FOUND', message: "Cannot find package 'miniprogram-automator' imported from /repo/x.mjs" })).toBe(true)
    expect(shouldSkip({ code: 'MODULE_NOT_FOUND', message: "Cannot find module 'miniprogram-automator'" })).toBe(true)
    // 无 code 但消息明确点名（手工构造/其它运行时）同样按未安装处理
    expect(shouldSkip({ message: "Cannot find package 'miniprogram-automator'" })).toBe(true)
  })

  it('包装好了但依赖缺失 / 包内文件损坏：不 SKIP（必须 FAIL）', () => {
    expect(
      shouldSkip({
        code: 'ERR_MODULE_NOT_FOUND',
        message: "Cannot find package 'puppeteer-core' imported from /repo/node_modules/miniprogram-automator/index.js",
      }),
    ).toBe(false)
    expect(
      shouldSkip({
        code: 'ERR_MODULE_NOT_FOUND',
        message: "Cannot find module '/repo/node_modules/miniprogram-automator/dist/index.js'",
      }),
    ).toBe(false)
    expect(shouldSkip({ code: 'MODULE_NOT_FOUND', message: "Cannot find module 'some-other-dep'" })).toBe(false)
  })

  it('非「模块找不到」类错误一律不 SKIP', () => {
    expect(shouldSkip({ code: 'ERR_INVALID_PACKAGE_CONFIG', message: "Cannot find package 'miniprogram-automator'" })).toBe(false)
    expect(shouldSkip({ name: 'SyntaxError', message: 'unexpected token' })).toBe(false)
    expect(shouldSkip(null)).toBe(false)
    expect(shouldSkip('boom')).toBe(false)
  })
})

describe('syncPathGuard · 目标路径必须严格位于 miniprogram_npm 下', () => {
  const npmRoot = path.join(process.cwd(), 'examples/miniprogram/miniprogram_npm')

  it('等于 npmRoot 时不通过（去掉 fail-open 短路）', () => {
    expect(insideNpmRoot(npmRoot, npmRoot)).toBe(false)
  })

  it('子目录通过，兄弟目录前缀与越界路径不通过', () => {
    expect(insideNpmRoot(npmRoot, path.join(npmRoot, '@unitseek/tallystore'))).toBe(true)
    expect(insideNpmRoot(npmRoot, npmRoot + '-evil/pkg')).toBe(false)
    expect(insideNpmRoot(npmRoot, path.join(npmRoot, '../outside'))).toBe(false)
    expect(insideNpmRoot(npmRoot, path.dirname(npmRoot))).toBe(false)
  })
})
