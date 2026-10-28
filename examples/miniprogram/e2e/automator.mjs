#!/usr/bin/env node
/**
 * 真机 / 开发者工具 e2e（可选）：用 miniprogram-automator 启动 demo 工程，点按钮断言 data 变化。
 *
 * 本机大概率不可跑（需要已安装并登录微信开发者工具、打开服务端口）。因此：
 * - 未安装 miniprogram-automator → SKIP，exit 0
 * - 未找到开发者工具 CLI → SKIP，exit 0
 * - 找到但启动/断言失败 → FAIL，exit 1
 *
 * 用法：
 *   node examples/miniprogram/e2e/automator.mjs
 *   MINIPROGRAM_CLI_PATH=<cli 路径> node examples/miniprogram/e2e/automator.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { shouldSkipMissingAutomator } from './automator-detection.mjs'
import { waitUntil, withTimeout } from './automation-poll.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const demoRoot = path.resolve(here, '..')

function skip(reason) {
  console.log('SKIP ' + reason)
  process.exit(0)
}

let automator
try {
  automator = await import('miniprogram-automator')
  automator = automator.default ?? automator
} catch (error) {
  // 只有确定「包本身未安装」才 SKIP；包已安装但依赖缺失 / 包内文件损坏必须 FAIL
  if (shouldSkipMissingAutomator(error)) {
    skip('未安装 miniprogram-automator（在仓库根 pnpm add -D miniprogram-automator 后重试）')
  }
  const message = error instanceof Error ? error.message : String(error)
  console.error('[automator] 加载 miniprogram-automator 失败：' + message)
  process.exit(1)
}

function resolveCliPath() {
  const candidates = []
  if (process.env.MINIPROGRAM_CLI_PATH) candidates.push(process.env.MINIPROGRAM_CLI_PATH)
  if (process.platform === 'win32') {
    candidates.push('C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat', 'C:/Program Files/Tencent/微信web开发者工具/cli.bat')
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/wechatwebdevtools.app/Contents/MacOS/cli')
  } else {
    candidates.push('/opt/wechat-devtools/cli', '/usr/local/bin/wechat-devtools-cli')
  }
  return candidates.find((candidate) => candidate && fs.existsSync(candidate))
}

const cliPath = resolveCliPath()
if (!cliPath) {
  skip('未找到微信开发者工具 CLI，可用 MINIPROGRAM_CLI_PATH 显式指定')
}

let miniProgram
try {
  miniProgram = await withTimeout(automator.launch({ projectPath: demoRoot, cliPath }), 60000, 'automator.launch')
  const page = await miniProgram.reLaunch('/pages/index/index')
  // onLoad 里会调用一次 action：等 data.count 变成数字，而不是固定 sleep
  const before = await waitUntil('首页 data.count 变为数字', async () => {
    const count = (await page.data()).count
    return typeof count === 'number' ? count : undefined
  })

  // page.$ 未命中返回 null：统一归一成 undefined 哨兵，配合 waitUntil 的 undefined/null 语义
  const incrementButton = await waitUntil('找到 .btn-inc 按钮', async () => (await page.$('.btn-inc')) ?? undefined)
  await incrementButton.tap()
  // 就绪条件即断言：waitUntil 只在 count === before+1 时返回（原断言是死代码，已删除）
  await waitUntil('点击 +1 后 data.count 变为 ' + (before + 1), async () => {
    const count = (await page.data()).count
    return count === before + 1 ? count : undefined
  })

  const decrementButton = await waitUntil('找到 .btn-dec 按钮', async () => (await page.$('.btn-dec')) ?? undefined)
  await decrementButton.tap()
  await waitUntil('点击 -1 后 data.count 回到初始值（' + before + '）', async () => ((await page.data()).count === before ? true : undefined))

  // 先关闭再打印 PASS——close 失败不应在 PASS 之后又打印 FAIL / 以清理结果决定退出码
  try {
    await miniProgram.close()
  } catch (closeError) {
    console.warn('[automator] miniProgram.close 失败（不影响用例结果）：' + (closeError instanceof Error ? closeError.message : String(closeError)))
  }
  console.log('PASS automator：首页初始 data.count=' + before + '，+1 / -1 按钮均生效')
  process.exit(0)
} catch (error) {
  console.error('FAIL automator：' + (error instanceof Error ? error.message : String(error)))
  if (miniProgram) {
    try {
      await miniProgram.close()
    } catch {
      // 关闭失败不影响退出码
    }
  }
  process.exit(1)
}
