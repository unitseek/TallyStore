/** 全局清理：每个用例结束后移除宿主 mock，避免用例间互相污染 */
import { clearStoreRegistry, uninstallWxStorage } from './utils/host.js'

afterEach(() => {
  uninstallWxStorage()
  //  全局 Store 注册表按用例隔离：同名 Store 跨用例残留会误报重复 name。
  // 注册表本身在 Store 构造/destroy 时维护，这里只做兜底清空（键集中在 tests/utils/host.ts）
  clearStoreRegistry()
  // 个别用例漏掉 mockRestore() 时，spy（尤其 console 静默）会污染后续用例；
  // 全局兜底恢复，测试内的显式 restore 仍可保留
  jest.restoreAllMocks()
  jest.useRealTimers()
})
