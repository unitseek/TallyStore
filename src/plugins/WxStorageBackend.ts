/** TallyStore - 微信同步存储后端（内置 `StorageBackend` 实现 + 「同步存储」契约的运行时守卫） */

import type { StorageBackend } from '../types/plugins.js'
import { isProduction } from '../core/store/utils.js'

/** 小程序 `wx` 同步存储 API 在本库视角下的最小形状 */
export type WxStorageApi = {
  getStorageSync?: (key: string) => unknown
  setStorageSync?: (key: string, value: string) => unknown
  removeStorageSync?: (key: string) => unknown
}

/**
 * 运行时检测异步存储后端。
 * JS 调用方仍可能传入异步实现（如 localStorage 的 Promise 封装），
 * 静默使用会导致恢复时 JSON.parse(Promise) 抛错、保存时异步 rejection 逃出
 * try/catch —— 数据丢失且无感知，因此必须显式报错。
 * @param result 待检的返回值
 * @param methodLabel 出错方法的完整定位串（`storage.getItem` / `wx.getStorageSync`）：
 * 用户后端与内置 wx 适配器共用本守卫，只写 `storage.xxx` 会让「压根没传 storage」的
 * 兼容层场景指向一个调用方并没有用的选项
 */
export function assertSyncStorageResult(result: unknown, methodLabel: string): void {
  if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as PromiseLike<unknown>).then === 'function') {
    // 同步抛错后调用方不会再 await 这个 Promise：若它是 rejected（异步 polyfill 写失败），
    // 会留下无人处理的 rejection（Node 严格模式可致进程退出）。先挂一个空 catch 吸收掉
    void Promise.resolve(result as PromiseLike<unknown>).catch(() => {})
    throw new Error(
      `[TallyStore][persistence] ${methodLabel}() 返回了 Promise：persistencePlugin 仅支持同步存储后端` +
        `（如 wx.getStorageSync、WxStorageBackend 或同步封装的 localStorage）。` +
        `异步后端请在外部自行订阅 store 实现持久化。`,
    )
  }
}

/** 读取 `globalThis.wx` 的同步存储 API —— 全库唯一读取点（未声明的全局标识符只能经 globalThis 取，TS2304） */
export function readWxStorageSyncApi(): WxStorageApi | undefined {
  return (globalThis as { wx?: WxStorageApi }).wx
}

/** 「本环境是否具备可用的 wx 同步存储」——判定口径的唯一来源。 */
export function isWxStorageSyncAvailable(): boolean {
  const api = readWxStorageSyncApi()

  return typeof api?.getStorageSync === 'function' && typeof api?.setStorageSync === 'function' && typeof api?.removeStorageSync === 'function'
}

/** wx 存储值 → `StorageBackend.getItem` 要求的 `string | null`（「键无数据」的唯一口径） */
export function normalizeWxStoredValue(value: unknown): string | null {
  // 空串是 wx「缺键」的表达，只能按无数据处理；但非字符串载荷（原生 wx.setStorageSync
  // 写入的对象/数字，或其它模块共用同一 key）会被静默归一成 null，与「键不存在」无法区分，
  // 下次落盘即覆盖真实数据且无痕迹。此处是唯一归一化点，开发期告警可诊断，
  // 不改变契约。
  if (typeof value === 'string' && value !== '') {
    return value
  }
  if (value !== null && value !== undefined && value !== '' && !isProduction()) {
    // 存储载荷通常含 token/手机号等敏感字段，不能把原值（尤其对象）打进控制台。
    // 对象/函数只输出可诊断摘要（键数），保持与 logger 脱敏、persistence 敏感键审计的口径一致；
    // 原始值（number/boolean）无嵌套结构，保留原值以便定位（既有单测断言该形态，本批 write scope
    // 不含 tests/unit/plugins，故保持两参调用契约不变）。
    const detail = typeof value === 'object' ? '<object with ' + Object.keys(value as object).length + ' keys>' : value
    console.warn('[WxStorage] 非字符串存储值已按「无数据」处理，请确认无其它代码共用同一 key：', detail)
  }
  return null
}

/** 微信存储后端 */
export class WxStorageBackend implements StorageBackend {
  /** 经 globalThis 读取 wx，避免直接引用未声明的小程序全局标识符 */
  private get wxApi(): WxStorageApi | undefined {
    return readWxStorageSyncApi()
  }

  /** 取出 `wx.<name>` 方法本体及其宿主，缺失或不 callable 时抛错。 */
  private resolve<K extends keyof WxStorageApi>(name: K): { api: WxStorageApi; fn: NonNullable<WxStorageApi[K]> } {
    const api = this.wxApi
    const fn = api?.[name]
    if (!api || typeof fn !== 'function') {
      throw new Error(
        `[TallyStore][persistence] wx.${name} 不可用：WxStorageBackend 需要小程序同步存储 API，` +
          `静默跳过会让写入丢失而调用方看到成功。请改用自建 storage 后端（persistencePlugin 的 storage 选项），` +
          `或确认运行环境已注入 wx。`,
      )
    }
    // indexed access 收窄不到具体签名，运行时已校验过 callable
    return { api, fn: fn as NonNullable<WxStorageApi[K]> }
  }

  /** 统一「记录 + 重抛」口径：三个方法的失败都必须让调用方看见。 */
  private run<T>(method: string, fn: () => T): T {
    try {
      return fn()
    } catch (error) {
      if (!isProduction()) {
        console.error(`[WxStorage] ${method} error:`, error)
      }
      throw error
    }
  }

  getItem(key: string): string | null {
    return this.run('getItem', () => {
      const { api, fn } = this.resolve('getStorageSync')
      const value = fn.call(api, key)
      // 守卫必须在归一化之前：Promise 不是字符串，先归一化就会把「异步后端」洗成
      // 「键无数据」，随后的一次落盘即覆盖真实数据。本类同时是 `persistencePlugin`
      // 未传 `storage` 时的默认后端，那条路径就靠这里报错
      assertSyncStorageResult(value, 'wx.getStorageSync')

      return normalizeWxStoredValue(value)
    })
  }

  setItem(key: string, value: string): void {
    this.run('setItem', () => {
      // JS 调用方可能绕过 TS 传入非字符串：wx.setStorageSync 会接受，但读回时
      // normalizeWxStoredValue 永远归一成 null（数据写入成功却读不回）。与异步后端守卫
      // 同口径显式 fail-fast，避免制造不可读数据
      if (typeof value !== 'string') {
        throw new TypeError('[TallyStore][persistence] WxStorageBackend.setItem 只接受字符串：wx.setStorageSync 写入的非字符串无法读回')
      }
      const { api, fn } = this.resolve('setStorageSync')
      assertSyncStorageResult(fn.call(api, key, value), 'wx.setStorageSync')
    })
  }

  removeItem(key: string): void {
    this.run('removeItem', () => {
      const { api, fn } = this.resolve('removeStorageSync')
      assertSyncStorageResult(fn.call(api, key), 'wx.removeStorageSync')
    })
  }
}
