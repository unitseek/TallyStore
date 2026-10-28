/**
 * 分包 / 未迁移页面共存冒烟（ 验收 1/3）
 *
 * 与 host-smoke 一样只依赖 Node 与 dist-weapp：把发布产物模拟成「构建 npm」后的主包
 * miniprogram_npm（Node 形态为 node_modules/<pkg>），再加载 examples/miniprogram 的**真实**
 * app.json / app.js / 页面配置，在伪造的小程序宿主里跑生命周期，断言：
 * 1. 分包页面 packageA/pages/cart 通过 getApp().globalData.store 读到主包 Store，映射与 action 生效；
 * 2. 主包与分包只存在一个 Store 实例（分包页面不 createStore / 不复制实例）；
 * 3. 未迁移页面 pages/legacy 的 globalData 读写路径不变，且与 Store 状态互不影响。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** 示例代码/插件在开发态会打印日志；只在加载与生命周期调用期间静默，避免污染 host-smoke 的 PASS/FAIL 输出 */
function withSilencedConsole(fn) {
  const originals = { log: console.log, warn: console.warn, error: console.error }
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
  try {
    return fn()
  } finally {
    console.log = originals.log
    console.warn = originals.warn
    console.error = originals.error
  }
}

/** 伪造页面实例：与微信一致——config.data 作为初始 data，config 上的方法挂到实例，setData 浅合并 */
function createPageInstance(config) {
  const instance = {
    data: { ...(config && config.data ? config.data : {}) },
    setData(patch) {
      Object.assign(instance.data, patch)
    },
  }
  for (const [key, value] of Object.entries(config || {})) {
    if (key !== 'data' && typeof value === 'function') {
      instance[key] = value
    }
  }
  return instance
}

/**
 * @param {{ repoRoot: string, loadRoot: string, check: (label: string, ok: boolean, detail?: string) => void, onCleanup: (fn: () => void) => void }} params
 */
export async function runSubpackageSmoke({ repoRoot, loadRoot, check, onCleanup }) {
  const demoRoot = path.join(repoRoot, 'examples/miniprogram')
  const projectRoot = path.join(loadRoot, 'example-project')
  const packageRoot = path.join(projectRoot, 'node_modules', '@unitseek', 'tallystore')

  // 1) 用本次 dist-weapp 产物模拟「构建 npm」后的主包 miniprogram_npm（Node 等价形态：node_modules/<pkg>）
  fs.mkdirSync(packageRoot, { recursive: true })
  for (const entry of fs.readdirSync(loadRoot)) {
    if (entry === 'example-project') continue
    fs.cpSync(path.join(loadRoot, entry), path.join(packageRoot, entry), { recursive: true })
  }
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify(
      {
        name: '@unitseek/tallystore',
        version: '0.0.0-smoke',
        main: 'index.js',
        exports: {
          '.': './index.js',
          './plugins': './plugins.js',
          './plugins/persistence': './plugins/persistence.js',
          './plugins/logger': './plugins/logger.js',
        },
      },
      null,
      2,
    ) + '\n',
  )

  // 2) 复制真实示例工程（不复制 miniprogram_npm；上面已用发布产物等价模拟）
  for (const entry of ['app.js', 'app.json', 'pages', 'packageA', 'components']) {
    fs.cpSync(path.join(demoRoot, entry), path.join(projectRoot, entry), { recursive: true })
  }
  fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"example-project","private":true,"type":"commonjs"}\n')

  // 3) 伪造小程序宿主全局：App/Page/Component 捕获配置，getApp 返回当前 App 实例
  const savedGlobals = {}
  const defineGlobal = (name, value) => {
    savedGlobals[name] = globalThis[name]
    globalThis[name] = value
  }
  const appCaptures = []
  const pageCaptures = []
  let appInstance
  defineGlobal('App', (config) => {
    appCaptures.push(config)
  })
  defineGlobal('Page', (config) => {
    pageCaptures.push(config)
  })
  defineGlobal('Component', () => {})
  defineGlobal('getApp', () => appInstance)
  const requireExample = createRequire(pathToFileURL(path.join(projectRoot, 'package.json')).href)

  try {
    // 4) 启动 App（创建主包 Store、注册 globalData.store、安装持久化/日志插件）
    withSilencedConsole(() => requireExample('./app.js'))
    check('分包冒烟：示例 App 配置被框架捕获', appCaptures.length === 1)
    const appConfig = appCaptures[0]
    const store = appConfig && appConfig.globalData && appConfig.globalData.store
    check('分包冒烟：globalData.store 由主包 App 唯一创建', !!store && store.name === 'demo-counter')
    if (!store) return
    onCleanup(() => {
      if (!store.destroyed) store.destroy()
    })
    appInstance = { globalData: appConfig.globalData }
    withSilencedConsole(() => {
      appConfig.onLaunch.call(appInstance)
      if (typeof appConfig.onShow === 'function') appConfig.onShow.call(appInstance)
    })
    check('分包冒烟：主包 Store 初始 count=0', store.getState().count === 0)
    check(
      '分包冒烟：withAppStore 把映射写入 globalData',
      appInstance.globalData.count === 0 && appInstance.globalData.doubledText === 0,
      'count=' + appInstance.globalData.count + ' doubledText=' + appInstance.globalData.doubledText,
    )

    // 5) 主包首页（迁移后的页面）
    withSilencedConsole(() => requireExample('./pages/index/index.js'))
    const indexConfig = pageCaptures.shift()
    check('分包冒烟：主包首页 Page 配置被捕获', !!indexConfig)
    const indexPage = createPageInstance(indexConfig)
    withSilencedConsole(() => indexConfig.onLoad.call(indexPage))
    check('分包冒烟：主包首页 mapState/getter 生效', typeof indexPage.data.count === 'number' && indexPage.data.doubled === indexPage.data.count * 2)
    check('分包冒烟：主包首页 onLoad 自动 +1 只执行一次', store.getState().count === 1, 'count=' + store.getState().count)

    // 6) 分包页面：只经 getApp().globalData.store 取主包实例（依赖方向：分包 → 主包）
    const storeBeforeCart = appConfig.globalData.store
    withSilencedConsole(() => requireExample('./packageA/pages/cart/cart.js'))
    const cartConfig = pageCaptures.shift()
    check('分包冒烟：分包页面 Page 配置被捕获', !!cartConfig)
    check('分包冒烟：分包页面未替换/复制主包 Store 实例', appConfig.globalData.store === storeBeforeCart)
    const cartPage = createPageInstance(cartConfig)
    withSilencedConsole(() => cartConfig.onLoad.call(cartPage))
    check(
      '分包冒烟：分包页面读到主包 Store（mapState/getter 同值）',
      cartPage.data.count === store.getState().count && cartPage.data.doubled === store.getState().count * 2,
      'data.count=' + cartPage.data.count + ' store.count=' + store.getState().count,
    )
    const beforeAction = store.getState().count
    withSilencedConsole(() => cartPage.addOne())
    check('分包冒烟：分包页面映射 action 更新主包 Store', store.getState().count === beforeAction + 1)
    check('分包冒烟：action 后分包页面 data 同步', cartPage.data.count === beforeAction + 1)
    withSilencedConsole(() => cartPage.removeOne())
    check('分包冒烟：分包页面 decrement 后回到 action 前的值', store.getState().count === beforeAction)

    // 7) 未迁移页面：完全走 globalData，不受 subPackages 配置与 Store 影响
    withSilencedConsole(() => requireExample('./pages/legacy/legacy.js'))
    const legacyConfig = pageCaptures.shift()
    check('分包冒烟：未迁移页面 Page 配置被捕获', !!legacyConfig)
    const legacyPage = createPageInstance(legacyConfig)
    withSilencedConsole(() => legacyConfig.onLoad.call(legacyPage))
    check('分包冒烟：未迁移页面 onLoad 读取 globalData 初值', legacyPage.data.legacyCount === 0)
    const storeCountBeforeLegacy = store.getState().count
    withSilencedConsole(() => legacyPage.incLegacy())
    check('分包冒烟：未迁移页面仍可写 globalData（行为不变）', appInstance.globalData.legacyCount === 1 && legacyPage.data.legacyCount === 1)
    check('分包冒烟：未迁移页面的 globalData 写入不影响 Store', store.getState().count === storeCountBeforeLegacy)

    // 8) 静态约束：分包页面源码不得创建/复制 Store 实例
    const cartSource = fs.readFileSync(path.join(demoRoot, 'packageA/pages/cart/cart.js'), 'utf8')
    check('分包冒烟：分包页面源码未创建 Store 实例（仅取 globalData.store）', !/createStore\s*\(/.test(cartSource) && cartSource.includes('globalData.store'))
  } catch (error) {
    check('分包冒烟：宿主模拟执行完成', false, error && error.stack ? error.stack : String(error))
  } finally {
    for (const [name, value] of Object.entries(savedGlobals)) {
      if (value === undefined) delete globalThis[name]
      else globalThis[name] = value
    }
  }
}
