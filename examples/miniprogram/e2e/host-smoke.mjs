#!/usr/bin/env node
/**
 * 宿主级冒烟：不依赖微信开发者工具，把 dist-weapp 放进 Node 的临时目录里真实 require 一遍，
 * 再用伪造的 wx 与假 App / Page / Component 实例验证三件套集成与持久化往返。
 *
 * 为什么值得单独存在：
 * - jest 跑的是 src 的 TypeScript；这里跑的是**发布产物 dist-weapp 的 CJS 字节**，
 *   且是在「整目录拷贝 + 按路径 require」的宿主形态下加载；
 * - 集成行为（setData 时机、退订、globalData 映射、组件 methods 合并）只有在宿主生命周期里才看得到；
 * - Skyline 场景：宿主实例带 renderer:'skyline' 时，同一 tick 的多次映射写入应合并为一次 setData。
 *
 * 前置条件：仓库根已执行 pnpm run build（dist-weapp/ 存在）。
 * 用法：node examples/miniprogram/e2e/host-smoke.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runSubpackageSmoke } from './subpackage-smoke.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const demoRoot = path.resolve(here, '..')
const repoRoot = path.resolve(demoRoot, '../..')
const distSource = path.join(repoRoot, 'dist-weapp')

let passed = 0
const failures = []

function pass(label, detail) {
  passed += 1
  console.log('PASS ' + label + (detail ? ' — ' + detail : ''))
}

function check(label, ok, detail) {
  if (ok) pass(label, detail)
  else {
    failures.push(label + (detail ? ' — ' + detail : ''))
    console.log('FAIL ' + label + (detail ? ' — ' + detail : ''))
  }
}

/**
 * 跑一个场景：内部断言失败只记录，不中断后续场景；支持异步（Skyline 合并需要等微任务）。
 * 场景通过 onCleanup 注册收尾（store.destroy / 生命周期解绑）：中途抛错时也在 finally 里执行，
 * 避免失败场景把订阅、定时器与待发微任务泄漏进后续场景。
 */
async function run(label, scenario) {
  const cleanups = []
  const onCleanup = (fn) => {
    cleanups.push(fn)
  }
  try {
    await scenario(onCleanup)
  } catch (error) {
    check(label, false, error && error.stack ? error.stack : String(error))
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup()
      } catch {
        // 收尾失败不应覆盖/中断已收集的断言结果
      }
    }
  }
}

if (!fs.existsSync(path.join(distSource, 'index.js'))) {
  console.error('[host-smoke] 找不到 dist-weapp/index.js')
  console.error('[host-smoke] 请先在仓库根执行：pnpm run build')
  process.exit(1)
}

// 伪造 wx 同步存储 / 环境判定（必须在 require 产物之前挂到 globalThis）
const storage = new Map()
globalThis.wx = {
  getStorageSync(key) {
    return storage.has(key) ? storage.get(key) : ''
  },
  setStorageSync(key, value) {
    storage.set(key, value)
  },
  removeStorageSync(key) {
    storage.delete(key)
  },
  getAccountInfoSync() {
    return { miniProgram: { envVersion: 'develop' } }
  },
}

const loadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tallystore-host-smoke-'))

try {
  fs.cpSync(distSource, loadRoot, { recursive: true })
  // 仓库根 package.json 是 "type": "module"；产物的相对 require 依赖 CJS 语义，
  // 所以给临时目录单独声明 commonjs（与微信运行时按目录加载的形态一致）
  fs.writeFileSync(path.join(loadRoot, 'package.json'), '{"type":"commonjs"}\n')
  const require_ = createRequire(pathToFileURL(path.join(loadRoot, 'package.json')).href)
  const lib = require_(path.join(loadRoot, 'index.js'))
  const plugins = require_(path.join(loadRoot, 'plugins.js'))

  const createCounterStore = () =>
    lib.createStore({
      name: 'e2e-counter',
      state: () => ({ count: 0 }),
      actions: {
        increment() {
          this.setState('count', this.getState().count + 1)
        },
        decrement() {
          this.setState('count', this.getState().count - 1)
        },
      },
      getters: {
        doubled: (state) => state.count * 2,
      },
    })

  check('产物加载：CJS 临时目录 + 伪造 wx 下主入口可用', typeof lib.createStore === 'function')
  check(
    '插件入口可用：persistencePlugin / WxStorageBackend / loggerPlugin',
    typeof plugins.persistencePlugin === 'function' && typeof plugins.WxStorageBackend === 'function' && !!plugins.loggerPlugin,
  )

  await run('App：withAppStore 映射 globalData 与实例 action，状态变化后 globalData 同步', (onCleanup) => {
    const store = createCounterStore()
    onCleanup(() => {
      if (!store.destroyed) store.destroy()
    })
    const appConfig = lib.withAppStore(store, {
      mapState: ['count'],
      mapGetters: { doubledText: 'doubled' },
      mapActions: { inc: 'increment', dec: 'decrement' },
    })({
      globalData: {},
      onLaunch() {
        this.__launchCalled = true
      },
    })
    const appInstance = { globalData: {} }

    appConfig.onLaunch.call(appInstance)

    check('App：onLaunch 被调用', appInstance.__launchCalled === true)
    check('App：globalData 映射了 state / getter', appInstance.globalData.count === 0 && appInstance.globalData.doubledText === 0)
    check('App：映射的 action 是实例方法', typeof appInstance.inc === 'function' && typeof appInstance.dec === 'function')

    store.setState('count', 3)
    check('App：store 变化后 globalData 同步', appInstance.globalData.count === 3 && appInstance.globalData.doubledText === 6)

    appInstance.inc()
    check('App：调用实例 action 触发 dispatch 并同步 globalData', store.getState().count === 4 && appInstance.globalData.count === 4)
    store.destroy()
  })

  await run('Page：onLoad 映射 setData / action 绑定 / onUnload 退订', (onCleanup) => {
    const store = createCounterStore()
    onCleanup(() => {
      if (!store.destroyed) store.destroy()
    })
    const setDataCalls = []
    const pageConfig = lib.withPageStore(store, {
      mapState: ['count'],
      mapGetters: ['doubled'],
      mapActions: { inc: 'increment' },
    })({
      data: {},
      onLoad() {
        this.__loadCalled = true
      },
      onUnload() {
        this.__unloadCalled = true
      },
    })
    const pageInstance = {
      data: {},
      setData(patch) {
        setDataCalls.push(patch)
        Object.assign(pageInstance.data, patch)
      },
    }

    onCleanup(() => {
      // 异常中断时补一次解绑；正常路径末尾已解绑，disconnectHost 幂等
      if (!pageInstance.__unloadCalled) pageConfig.onUnload.call(pageInstance)
    })
    pageConfig.onLoad.call(pageInstance)
    check('Page：onLoad 被调用', pageInstance.__loadCalled === true)
    check('Page：初始映射写入 data', pageInstance.data.count === 0 && pageInstance.data.doubled === 0)
    check('Page：映射的 action 是实例方法', typeof pageInstance.inc === 'function')

    const before = setDataCalls.length
    store.setState('count', 2)
    check('Page：store 变化触发 setData 与 data 更新', setDataCalls.length > before && pageInstance.data.count === 2 && pageInstance.data.doubled === 4)

    pageInstance.inc()
    check('Page：调用映射 action 更新 data', store.getState().count === 3 && pageInstance.data.count === 3)

    pageConfig.onUnload.call(pageInstance)
    check('Page：onUnload 被调用', pageInstance.__unloadCalled === true)
    const afterUnload = setDataCalls.length
    store.setState('count', 9)
    check('Page：onUnload 退订，后续状态变化不再 setData', setDataCalls.length === afterUnload && pageInstance.data.count === 3)
    store.destroy()
  })

  await run('Component：attached 合并 methods / data 映射 / detached 清理并退订', (onCleanup) => {
    const store = createCounterStore()
    onCleanup(() => {
      if (!store.destroyed) store.destroy()
    })
    const setDataCalls = []
    const componentConfig = lib.withComponentStore(store, {
      mapState: { localCount: 'count' },
      mapGetters: { localDoubled: 'doubled' },
      mapActions: ['decrement'],
    })({
      data: {},
      methods: {
        ownMethod() {
          return 'own'
        },
      },
      lifetimes: {
        attached() {
          this.__attachedCalled = true
        },
        detached() {
          this.__detachedCalled = true
        },
      },
    })
    const componentInstance = {
      data: {},
      methods: {
        ownMethod() {
          return 'own'
        },
      },
      setData(patch) {
        setDataCalls.push(patch)
        Object.assign(componentInstance.data, patch)
      },
    }

    onCleanup(() => {
      if (!componentInstance.__detachedCalled) componentConfig.lifetimes.detached.call(componentInstance)
    })
    componentConfig.lifetimes.attached.call(componentInstance)
    check('Component：attached 被调用', componentInstance.__attachedCalled === true)
    check('Component：state / getter 映射进 data', componentInstance.data.localCount === 0 && componentInstance.data.localDoubled === 0)
    check(
      'Component：映射 action 合并进 methods 且保留自定义方法',
      typeof componentInstance.methods.decrement === 'function' && componentInstance.methods.ownMethod() === 'own',
    )

    componentInstance.methods.decrement()
    check('Component：调用映射 action 更新 data', store.getState().count === -1 && componentInstance.data.localCount === -1)

    componentConfig.lifetimes.detached.call(componentInstance)
    check('Component：detached 被调用', componentInstance.__detachedCalled === true)
    check(
      'Component：detached 后移除映射方法、保留自定义方法',
      typeof componentInstance.methods.decrement === 'undefined' && componentInstance.methods.ownMethod() === 'own',
    )

    const afterDetach = setDataCalls.length
    store.setState('count', 5)
    check('Component：detached 后不再 setData', setDataCalls.length === afterDetach)
    store.destroy()
  })

  await run('Skyline：renderer=skyline 时同一 tick 的多次写入合并为一次 setData，卸载丢弃未交付写入', async (onCleanup) => {
    const store = createCounterStore()
    onCleanup(() => {
      if (!store.destroyed) store.destroy()
    })
    const setDataCalls = []
    const pageConfig = lib.withPageStore(store, {
      mapState: ['count'],
      mapGetters: ['doubled'],
    })({
      data: {},
      onLoad() {},
    })
    // Skyline 页面实例由框架提供 renderer 属性；schedule 默认 'auto' 会据此启用微任务合并
    const pageInstance = {
      renderer: 'skyline',
      data: {},
      setData(patch) {
        setDataCalls.push(patch)
        Object.assign(pageInstance.data, patch)
      },
    }

    onCleanup(() => pageConfig.onUnload.call(pageInstance))
    pageConfig.onLoad.call(pageInstance)
    check(
      'Skyline：初始映射在 onLoad 内同步交付且合并为一次 setData',
      setDataCalls.length === 1 && setDataCalls[0].count === 0 && setDataCalls[0].doubled === 0,
      'setData calls=' + setDataCalls.length,
    )

    const initialCalls = setDataCalls.length
    store.setState('count', 1)
    store.setState('count', 2)
    check('Skyline：同一 tick 内两次 setState 尚未触发 setData', setDataCalls.length === initialCalls)

    // 合并窗口用 Promise 微任务关闭：await 一个微任务即可观察交付
    await Promise.resolve()
    check('Skyline：await 一个微任务后只新增一次 setData', setDataCalls.length === initialCalls + 1, 'setData calls=' + (setDataCalls.length - initialCalls))
    const merged = setDataCalls[setDataCalls.length - 1]
    // 没有 setData 时 merged 为 undefined，直接取属性会抛 TypeError 并中断本场景剩余断言
    check('Skyline：合并后的 payload 是最终值', !!merged && merged.count === 2 && merged.doubled === 4 && pageInstance.data.count === 2)

    // 卸载时丢弃挂起未交付的合并写入
    const beforeUnload = setDataCalls.length
    store.setState('count', 3)
    store.setState('count', 4)
    pageConfig.onUnload.call(pageInstance)
    await Promise.resolve()
    check('Skyline：onUnload 丢弃未交付的合并写入', setDataCalls.length === beforeUnload)
    store.destroy()
  })

  await run('持久化：变更同步落盘 → 新 store 用同一 key 恢复', (onCleanup) => {
    const key = 'e2e_persist_key'
    storage.delete(key)

    const writer = lib.createStore({ name: 'e2e-writer', state: () => ({ count: 0 }) })
    onCleanup(() => {
      if (!writer.destroyed) writer.destroy()
    })
    const writerUninstall = writer.use(plugins.persistencePlugin({ key, storage: new plugins.WxStorageBackend(), filter: (state) => state, debounce: 0 }))
    writer.setState('count', 7)
    const raw = storage.get(key)
    let parsed = null
    try {
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      parsed = null
    }
    check('持久化：setState 后同步落盘为 JSON', !!parsed && parsed.count === 7, raw)
    writerUninstall()
    writer.destroy()

    const reader = lib.createStore({ name: 'e2e-reader', state: () => ({ count: 0 }) })
    onCleanup(() => {
      if (!reader.destroyed) reader.destroy()
    })
    reader.use(plugins.persistencePlugin({ key, storage: new plugins.WxStorageBackend(), filter: (state) => state, debounce: 0 }))
    check('持久化：新 store 安装插件时恢复状态', reader.getState().count === 7, 'count=' + reader.getState().count)
    reader.destroy()
  })

  // 加载真实 examples 工程配置（app.json 的 subPackages / app.js / 三个页面），
  // 验证分包页面读主包 Store、未迁移页面仍走 globalData，且只有一份 Store 实例。
  await run('分包/未迁移页面共存：分包页面读主包 Store、未迁移页面仍走 globalData', async (onCleanup) => {
    await runSubpackageSmoke({ repoRoot, loadRoot, check, onCleanup })
  })
} finally {
  // 清理失败（Windows 文件锁 / 权限）不得用未捕获异常覆盖已收集的断言结果
  try {
    fs.rmSync(loadRoot, { recursive: true, force: true })
  } catch {
    // 临时目录清理失败不影响冒烟结果
  }
}

if (failures.length > 0) {
  console.error('')
  console.error('[host-smoke] 失败 ' + failures.length + ' 项 / 通过 ' + passed + ' 项')
  for (const failure of failures) console.error('  ✗ ' + failure)
  // 用 exitCode 让进程自然退出，避免 stdout 是管道（CI）时缓冲日志被截断
  process.exitCode = 1
} else {
  console.log('')
  console.log('[host-smoke] 全部通过：' + passed + ' 项检查')
  process.exitCode = 0
}
