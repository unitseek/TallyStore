/**
 * WxStorageBackend：wx 同步存储封装、可用性探测、同步契约守卫与错误上抛
 */
import {
  WxStorageBackend,
  assertSyncStorageResult,
  isWxStorageSyncAvailable,
  normalizeWxStoredValue,
  readWxStorageSyncApi,
} from '../../../src/plugins/WxStorageBackend.js'
import { installWxStorage } from '../../utils/host.js'

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('wx 存储值归一化', () => {
  it('非空字符串原样返回，其余一律视为无数据', () => {
    expect(normalizeWxStoredValue('value')).toBe('value')
    expect(normalizeWxStoredValue('')).toBeNull()
    expect(normalizeWxStoredValue(undefined)).toBeNull()
    expect(normalizeWxStoredValue(null)).toBeNull()
    expect(normalizeWxStoredValue(0)).toBeNull()
    expect(normalizeWxStoredValue({ a: 1 })).toBeNull()
  })

  it('非字符串载荷在开发期告警（与「键不存在」可区分），仍按无数据处理', () => {
    const warn = console.warn as jest.Mock
    expect(normalizeWxStoredValue(123)).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('非字符串存储值'), 123)

    warn.mockClear()
    expect(normalizeWxStoredValue({ a: 1 })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('空串 / null / undefined 是「缺键」正常口径，不告警', () => {
    const warn = console.warn as jest.Mock
    expect(normalizeWxStoredValue('')).toBeNull()
    expect(normalizeWxStoredValue(null)).toBeNull()
    expect(normalizeWxStoredValue(undefined)).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('wx 同步存储可用性探测', () => {
  it('没有 wx 全局时读不到 API 且判定不可用', () => {
    delete (globalThis as { wx?: unknown }).wx
    expect(readWxStorageSyncApi()).toBeUndefined()
    expect(isWxStorageSyncAvailable()).toBe(false)
  })

  it('三个同步方法齐备才判定可用', () => {
    installWxStorage()
    expect(readWxStorageSyncApi()).toBeDefined()
    expect(isWxStorageSyncAvailable()).toBe(true)
  })

  it('任一同步方法缺失即判定不可用（逐个短路）', () => {
    ;(globalThis as { wx?: unknown }).wx = { setStorageSync() {}, removeStorageSync() {} }
    expect(isWxStorageSyncAvailable()).toBe(false)
    ;(globalThis as { wx?: unknown }).wx = { getStorageSync() {}, removeStorageSync() {} }
    expect(isWxStorageSyncAvailable()).toBe(false)
    ;(globalThis as { wx?: unknown }).wx = { getStorageSync() {}, setStorageSync() {} }
    expect(isWxStorageSyncAvailable()).toBe(false)
  })

  it('方法存在但不是函数时判定不可用', () => {
    ;(globalThis as { wx?: unknown }).wx = { getStorageSync: 1, setStorageSync() {}, removeStorageSync() {} }
    expect(isWxStorageSyncAvailable()).toBe(false)
  })
})

describe('assertSyncStorageResult 同步契约守卫', () => {
  it('同步返回值一律放行', () => {
    expect(() => assertSyncStorageResult(null, 'm')).not.toThrow()
    expect(() => assertSyncStorageResult(undefined, 'm')).not.toThrow()
    expect(() => assertSyncStorageResult('v', 'm')).not.toThrow()
    expect(() => assertSyncStorageResult(0, 'm')).not.toThrow()
    expect(() => assertSyncStorageResult({ a: 1 }, 'm')).not.toThrow()
    expect(() => assertSyncStorageResult(() => {}, 'm')).not.toThrow()
  })

  it('thenable 对象 / Promise / 带 then 的函数都抛错', () => {
    expect(() => assertSyncStorageResult({ then: () => {} }, 'storage.getItem')).toThrow('storage.getItem')
    expect(() => assertSyncStorageResult(Promise.resolve(), 'wx.getStorageSync')).toThrow('仅支持同步存储后端')
    const thenableFn = Object.assign(() => {}, { then: () => {} })
    expect(() => assertSyncStorageResult(thenableFn, 'm')).toThrow('m')
  })

  it('rejected Promise 在抛错前被吸收，不产生未处理拒绝', async () => {
    expect(() => assertSyncStorageResult(Promise.reject(new Error('async write failed')), 'm')).toThrow('Promise')
    await Promise.resolve()
  })
})

describe('WxStorageBackend 读写封装', () => {
  it('getItem 返回已存字符串，缺失键归一为 null', () => {
    installWxStorage({ key: 'value' })
    const backend = new WxStorageBackend()
    expect(backend.getItem('key')).toBe('value')
    expect(backend.getItem('missing')).toBeNull()
  })

  it('getItem 把非字符串载荷归一为 null', () => {
    ;(globalThis as { wx?: unknown }).wx = {
      getStorageSync: () => 123,
      setStorageSync() {},
      removeStorageSync() {},
    }
    const backend = new WxStorageBackend()
    expect(backend.getItem('key')).toBeNull()
  })

  it('setItem / removeItem 转发参数，且方法以 wx 对象为 this 调用', () => {
    const store = new Map<string, string>()
    const receivers: unknown[] = []
    const wxApi = {
      getStorageSync(key: string) {
        receivers.push(this)
        return store.has(key) ? (store.get(key) as string) : ''
      },
      setStorageSync(this: unknown, key: string, value: string) {
        receivers.push(this)
        store.set(key, value)
      },
      removeStorageSync(this: unknown, key: string) {
        receivers.push(this)
        store.delete(key)
      },
    }
    ;(globalThis as { wx?: unknown }).wx = wxApi
    const backend = new WxStorageBackend()

    expect(backend.getItem('k')).toBeNull()
    backend.setItem('k', 'v')
    expect(store.get('k')).toBe('v')
    backend.removeItem('k')
    expect(store.has('k')).toBe(false)
    expect(receivers).toHaveLength(3)
    expect(receivers[0]).toBe(wxApi)
    expect(receivers[1]).toBe(wxApi)
    expect(receivers[2]).toBe(wxApi)
  })

  it('setItem 对非字符串 value 直接 fail-fast（JS 调用方），不写坏存储', () => {
    const setStorageSync = jest.fn()
    ;(globalThis as { wx?: unknown }).wx = { getStorageSync: () => '', setStorageSync, removeStorageSync() {} }
    const backend = new WxStorageBackend()

    expect(() => backend.setItem('k', 42 as never)).toThrow(/只接受字符串/)
    expect(setStorageSync).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith('[WxStorage] setItem error:', expect.any(TypeError))
  })

  it('每次调用都重新读取 globalThis.wx', () => {
    const first = installWxStorage({ k: 'one' })
    const backend = new WxStorageBackend()
    expect(backend.getItem('k')).toBe('one')

    delete (globalThis as { wx?: unknown }).wx
    installWxStorage({ k: 'two' })
    expect(backend.getItem('k')).toBe('two')
    expect(first.has('k')).toBe(true)
  })

  it('wx 缺失时三个方法都抛错并指出具体 API', () => {
    delete (globalThis as { wx?: unknown }).wx
    const backend = new WxStorageBackend()
    expect(() => backend.getItem('k')).toThrow('wx.getStorageSync')
    expect(() => backend.setItem('k', 'v')).toThrow('wx.setStorageSync')
    expect(() => backend.removeItem('k')).toThrow('wx.removeStorageSync')
  })

  it('wx 只提供部分方法时缺失的方法抛错', () => {
    ;(globalThis as { wx?: unknown }).wx = { getStorageSync: () => '' }
    const backend = new WxStorageBackend()
    expect(backend.getItem('k')).toBeNull()
    expect(() => backend.setItem('k', 'v')).toThrow('wx.setStorageSync')
    expect(() => backend.removeItem('k')).toThrow('wx.removeStorageSync')
  })

  it('方法不是函数时抛错（而不是静默跳过）', () => {
    ;(globalThis as { wx?: unknown }).wx = { getStorageSync: 'nope' }
    const backend = new WxStorageBackend()
    expect(() => backend.getItem('k')).toThrow('wx.getStorageSync 不可用')
  })

  it('底层方法抛错时记录并原样上抛', () => {
    ;(globalThis as { wx?: unknown }).wx = {
      getStorageSync: () => {
        throw new Error('wx boom')
      },
      setStorageSync() {},
      removeStorageSync() {},
    }
    const backend = new WxStorageBackend()
    expect(() => backend.getItem('k')).toThrow('wx boom')
    expect(console.error).toHaveBeenCalledWith('[WxStorage] getItem error:', expect.any(Error))
  })

  it('异步底层返回值被拒绝（get / set / remove 三处）', () => {
    ;(globalThis as { wx?: unknown }).wx = {
      getStorageSync: () => Promise.resolve('v'),
      setStorageSync: () => Promise.resolve(),
      removeStorageSync: () => Promise.resolve(),
    }
    const backend = new WxStorageBackend()
    expect(() => backend.getItem('k')).toThrow('wx.getStorageSync')
    expect(() => backend.setItem('k', 'v')).toThrow('wx.setStorageSync')
    expect(() => backend.removeItem('k')).toThrow('wx.removeStorageSync')
  })

  it('生产模式下底层错误不写 console，但仍上抛', async () => {
    const previousEnv = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production'
      jest.resetModules()
      const mod = await import('../../../src/plugins/WxStorageBackend.js')
      ;(globalThis as { wx?: unknown }).wx = {
        getStorageSync: () => Promise.resolve('v'),
        setStorageSync() {},
        removeStorageSync() {},
      }
      const backend = new mod.WxStorageBackend()
      expect(() => backend.getItem('k')).toThrow('仅支持同步存储后端')
      ;(globalThis as { wx?: unknown }).wx = {
        getStorageSync: () => {
          throw new Error('prod boom')
        },
        setStorageSync() {},
        removeStorageSync() {},
      }
      expect(() => backend.getItem('k')).toThrow('prod boom')
      expect(console.error).not.toHaveBeenCalled()
    } finally {
      process.env.NODE_ENV = previousEnv
      jest.resetModules()
    }
  })
})
