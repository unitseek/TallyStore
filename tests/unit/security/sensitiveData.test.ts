/**  / AS-12：敏感数据护栏——敏感键清单、持久化落盘审计、日志脱敏 */
import { createStore, isSensitiveKey, addSensitiveKeyPatterns, resetSensitiveKeyPatterns, maskSensitiveValue } from '../../../src/index.js'
import {
  SENSITIVE_KEY_CACHE_MAX_ENTRIES,
  SENSITIVE_KEY_CACHE_MAX_KEY_LENGTH,
  findSensitiveKeys,
  findSensitiveKeysDeep,
  maskForLog,
  sensitiveKeyCacheSize,
} from '../../../src/core/security/sensitiveKeys.js'
import { persistencePlugin } from '../../../src/plugins.js'
import { loggerPlugin } from '../../../src/plugins.js'
import type { StorageBackend } from '../../../src/plugins.js'

function memoryBackend(initial: Record<string, string> = {}) {
  const memory = new Map(Object.entries(initial))
  const calls: Array<{ op: string; key: string; value?: string }> = []
  const backend: StorageBackend = {
    getItem: (k) => {
      calls.push({ op: 'get', key: k })
      return memory.get(k) ?? null
    },
    setItem: (k, v) => {
      calls.push({ op: 'set', key: k, value: v })
      memory.set(k, v)
    },
    removeItem: (k) => {
      calls.push({ op: 'remove', key: k })
      memory.delete(k)
    },
  }
  return { backend, memory, calls }
}

afterEach(() => {
  resetSensitiveKeyPatterns()
  jest.restoreAllMocks()
})

describe(' 敏感键清单', () => {
  it('内置模式命中常见敏感键（大小写与命名风格不敏感）', () => {
    for (const key of [
      'phone',
      'userPhone',
      'mobile',
      'phoneNumber',
      'token',
      'accessToken',
      'refresh_token',
      'password',
      'pwd',
      'idCard',
      'idcardNo',
      'idNumber',
      'secret',
      'address',
      'bankCardNo',
      'cardNumber',
    ]) {
      expect(isSensitiveKey(key)).toBe(true)
    }
    for (const key of ['count', 'list', 'userName', 'theme', 'labels']) {
      expect(isSensitiveKey(key)).toBe(false)
    }
  })

  it('addSensitiveKeyPatterns 扩展清单且不影响非敏感字段', () => {
    expect(isSensitiveKey('employeeNo')).toBe(false)
    addSensitiveKeyPatterns(['employeeno'])
    expect(isSensitiveKey('employeeNo')).toBe(true)
    expect(isSensitiveKey('count')).toBe(false)
  })

  it('字符串模式按字面量转义：正则元字符不再是通配/不会抛 SyntaxError', () => {
    // 旧实现 new RegExp('employee(') 直接抛 SyntaxError，未捕获会打死应用
    addSensitiveKeyPatterns(['employee('])
    expect(isSensitiveKey('employee(42)')).toBe(true)
    expect(isSensitiveKey('employee')).toBe(false)
    // '.' 不再匹配任意字符
    addSensitiveKeyPatterns(['a.b'])
    expect(isSensitiveKey('xA.By')).toBe(true) // 大小写不敏感
    expect(isSensitiveKey('axb')).toBe(false)
  })

  it('RegExp 模式统一补 i、去掉 g/y：大小写与重复判定稳定', () => {
    // 键名判定先小写归一：/ENTRUST/ 不加 i 时旧实现永远不命中
    addSensitiveKeyPatterns([/ENTRUST/])
    expect(isSensitiveKey('myEntrust')).toBe(true)
    // g 的 lastIndex 状态不能影响后续判定（用内置清单不含的 "brandno" 隔离验证）
    addSensitiveKeyPatterns([/brandno/g])
    expect(isSensitiveKey('brandno')).toBe(true)
    expect(isSensitiveKey('x-brandno')).toBe(true) // 若保留 g，第二次 test 会从 lastIndex=7 起跳而漏检
    // y（sticky）会把匹配锚定在 lastIndex：去掉后按普通子串命中
    addSensitiveKeyPatterns([/entrustcode/y])
    expect(isSensitiveKey('myentrustcode')).toBe(true)
    // 已带 i 的 RegExp 直接复用（不重复拼接标志）
    addSensitiveKeyPatterns([/PREAPPROVED/i])
    expect(isSensitiveKey('myPreApproved')).toBe(true)
    resetSensitiveKeyPatterns()
    expect(isSensitiveKey('myentrust')).toBe(false)
  })

  it('非法模式显式抛 TypeError，且不留下部分生效的清单', () => {
    expect(() => addSensitiveKeyPatterns([''])).toThrow(TypeError)
    expect(() => addSensitiveKeyPatterns([42 as unknown as string])).toThrow(TypeError)
    expect(() => addSensitiveKeyPatterns([null as unknown as RegExp])).toThrow(TypeError)
    // 校验先于追加：同一批里的合法项不得生效
    expect(() => addSensitiveKeyPatterns(['zzz-unique', 42 as unknown as string])).toThrow(TypeError)
    expect(isSensitiveKey('zzz-unique')).toBe(false)
  })

  it('maskSensitiveValue 按长度收紧露出位数', () => {
    expect(maskSensitiveValue('')).toBe('***')
    expect(maskSensitiveValue('short')).toBe('***')
    expect(maskSensitiveValue('0123456789')).toBe('***') // 10 位全遮
    expect(maskSensitiveValue('13812345678')).toBe('1***78') // 11 位：首 1 + 尾 2
    expect(maskSensitiveValue('tk-abcdef123456')).toBe('t***56') // 14 位
    expect(maskSensitiveValue('abcdefghijklmnop')).toBe('abc***mnop') // 16 位：首 3 + 尾 4
    expect(maskSensitiveValue('abcdefghijklmnopqrst')).toBe('abc***qrst')
    expect(maskSensitiveValue(123456)).toBe('***')
    expect(maskSensitiveValue({ a: 1 })).toBe('***')
  })
})

describe(' 深层脱敏与深度上限（maskForLog）', () => {
  it('无敏感键时原样返回（零拷贝），原始值/非纯对象原样传递', () => {
    const clean = { count: 1, nested: { name: 'n' } }
    expect(maskForLog(clean)).toBe(clean)
    expect(maskForLog(null)).toBeNull()
    expect(maskForLog(42)).toBe(42)
    expect(maskForLog('text')).toBe('text')
    const date = new Date(0)
    expect(maskForLog(date)).toBe(date) // 类实例不遍历
  })

  it('嵌套对象/数组中的敏感键深度脱敏，非敏感字段保留', () => {
    const payload = { count: 1, profile: { nickname: 'n', phone: '13812345678' }, list: [{ token: 'tk-abcdef123456' }, 2] }
    const masked = maskForLog(payload) as {
      count: number
      profile: Record<string, unknown>
      list: unknown[]
    }
    expect(masked.count).toBe(1)
    expect(masked.profile.nickname).toBe('n')
    expect(masked.profile.phone).toBe('1***78')
    expect((masked.list[0] as Record<string, unknown>).token).toBe('t***56')
    expect(masked.list[1]).toBe(2)
  })

  it('深度上限内（第 4 层）的敏感键仍脱敏', () => {
    const masked = maskForLog({ a: { b: { c: { password: 'p@ssw0rd-long' } } } }) as {
      a: { b: { c: Record<string, unknown> } }
    }
    expect(masked.a.b.c.password).toBe('p***ng')
  })

  it('超过深度上限：子树返回 [MaxDepth] 占位，绝不原样输出', () => {
    // 第 5 层的敏感字段：旧实现会原样返回（fail-open）
    const deepSecret = maskForLog({ a: { b: { c: { d: { password: 'p@ssw0rd-long' } } } } }) as {
      a: { b: { c: { d: unknown } } }
    }
    expect(deepSecret.a.b.c.d).toBe('[MaxDepth]')
    // 深层“干净”对象同样截断：无法证明干净时按可能存在敏感值处理（fail-closed）
    const deepClean = maskForLog({ a: { b: { c: { d: { e: 1 } } } } }) as {
      a: { b: { c: { d: unknown } } }
    }
    expect(deepClean.a.b.c.d).toBe('[MaxDepth]')
  })

  it('自有 __proto__ 键写成自有属性，不污染原型', () => {
    const payload = JSON.parse('{"__proto__":{"polluted":"yes"},"password":"p@ssw0rd-long"}') as Record<string, unknown>
    const masked = maskForLog(payload) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(masked, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(masked)).toBe(Object.prototype)
    expect(masked.__proto__).toEqual({ polluted: 'yes' })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(masked.password).toBe('p***ng')
  })
})

describe(' 深层敏感键探测', () => {
  it('返回完整路径：嵌套对象 / 数组下标 / 深层嵌套', () => {
    expect(findSensitiveKeysDeep({ count: 0, profile: { phone: '13812345678' } })).toEqual(['profile.phone'])
    expect(
      findSensitiveKeysDeep({
        orders: [
          { id: 1, cardNo: '6222' },
          { id: 2, token: 'tk' },
        ],
      }),
    ).toEqual(['orders[0].cardNo', 'orders[1].token'])
    expect(findSensitiveKeysDeep({ auth: { sessions: [{ accessToken: 't' }] } })).toEqual(['auth.sessions[0].accessToken'])
    // 落盘审计不设深度上限：深层敏感字段同样要找到
    expect(findSensitiveKeysDeep({ a: { b: { c: { d: { e: { f: { g: { password: 'x' } } } } } } } })).toEqual(['a.b.c.d.e.f.g.password'])
  })

  it('干净载荷返回空数组；顶层敏感键保持短路径', () => {
    expect(findSensitiveKeysDeep({})).toEqual([])
    expect(findSensitiveKeysDeep({ count: 1, nested: { name: 'n' } })).toEqual([])
    expect(findSensitiveKeysDeep({ userPhone: '13812345678' })).toEqual(['userPhone'])
    // 根不是纯对象/数组
    expect(findSensitiveKeysDeep('13812345678')).toEqual([])
    expect(findSensitiveKeysDeep(null)).toEqual([])
    expect(findSensitiveKeysDeep(new Map([['token', 'tk']]))).toEqual([])
  })

  it('类实例按自有可枚举键展开（JSON.stringify 会把它们明文写入存储），循环引用只访问一次', () => {
    class UserRecord {
      phone = '13812345678'
    }
    expect(findSensitiveKeysDeep({ user: new UserRecord() })).toEqual(['user.phone'])

    // 与日志脱敏不同：Map/Set/Date/RegExp 序列化为 {} 或原始值，内容不会明文落盘，不展开
    expect(findSensitiveKeysDeep(new Map([['token', 'tk']]))).toEqual([])
    expect(findSensitiveKeysDeep({ m: new Map([['token', 'tk']]) })).toEqual([])
    expect(findSensitiveKeysDeep({ d: new Date(0), r: /token/ })).toEqual([])

    type Cyclic = { count: number; profile: { phone: string }; self?: Cyclic }
    const cyclic: Cyclic = { count: 1, profile: { phone: '13812345678' } }
    cyclic.self = cyclic
    expect(findSensitiveKeysDeep(cyclic)).toEqual(['profile.phone'])
  })

  it('迭代遍历：超深嵌套不栈溢出，命中路径与兄弟顺序稳定', () => {
    // 10k 层链式对象：递归实现会 RangeError；迭代实现应正常返回并给出完整路径
    const depth = 10_000
    const root: Record<string, unknown> = {}
    let cursor = root
    for (let i = 0; i < depth; i += 1) {
      const next: Record<string, unknown> = {}
      cursor.next = next
      cursor = next
    }
    cursor.password = 'p@ssw0rd-long'

    let hits: string[] = []
    expect(() => {
      hits = findSensitiveKeysDeep(root)
    }).not.toThrow()
    expect(hits).toHaveLength(1)
    expect(hits[0].endsWith('.password')).toBe(true)
    expect(hits[0].startsWith('next.next.')).toBe(true)

    // 兄弟顺序与递归先序一致（路径输出可断言，不受显式工作栈影响）
    expect(findSensitiveKeysDeep({ a: { token: 't' }, b: { phone: 'p' } })).toEqual(['a.token', 'b.phone'])
  })

  it('findSensitiveKeys 兼容入口与 deep 版结果一致', () => {
    const payload = { profile: { phone: '13812345678' }, orders: [{ token: 'tk' }] }
    expect(findSensitiveKeys(payload)).toEqual(findSensitiveKeysDeep(payload))
    expect(findSensitiveKeys({ count: 1 })).toEqual([])
  })

  it('数组上的非下标自有键：按字符串键参与路径探测（不按 length 遍历）', () => {
    const list = Object.assign([{ id: 1 }], { extra: { token: 'tk' } }) as unknown as unknown[]
    expect(findSensitiveKeysDeep({ list })).toEqual(['list.extra.token'])
  })

  it('数组自身直接挂的敏感键名也被检出', () => {
    const list = Object.assign([1], { accessToken: 'tk-abc' }) as unknown as unknown[]
    expect(findSensitiveKeysDeep(list)).toEqual(['accessToken'])
    expect(findSensitiveKeysDeep({ list })).toEqual(['list.accessToken'])
  })

  it('带 toJSON 的对象按其返回值审计（JSON.stringify 只序列化返回值）', () => {
    const envelope = { user: { toJSON: () => ({ phone: '13812345678' }) } }
    expect(JSON.stringify(envelope)).toContain('13812345678')
    expect(findSensitiveKeysDeep(envelope)).toEqual(['user.phone'])

    class UserRecord {
      toJSON() {
        return { phone: '13812345678' }
      }
    }
    expect(findSensitiveKeysDeep({ user: new UserRecord() })).toEqual(['user.phone'])

    // toJSON 返回干净值：不误报（即使自有字段名敏感，JSON.stringify 也不会写出它们）
    expect(findSensitiveKeysDeep({ user: { phone: 'x', toJSON: () => ({ id: 1 }) } })).toEqual([])
  })
})

describe(' 数组非下标键 / 符号键的日志脱敏同口径', () => {
  it('maskForLog 覆盖数组自身非下标敏感键：不再原样输出，数组结构保持', () => {
    const list = Object.assign([1, 2], { accessToken: 'tk-abcdef123456' }) as unknown as unknown[]
    const masked = maskForLog({ list }) as { list: unknown[] & Record<string, unknown> }
    expect(Array.isArray(masked.list)).toBe(true)
    expect(masked.list[0]).toBe(1)
    expect(masked.list.accessToken).toBe('t***56')
    expect(JSON.stringify(masked)).not.toContain('tk-abcdef123456')
  })

  it('符号键上的敏感值在对象/数组上同样脱敏，键本身保留', () => {
    const tokenSymbol = Symbol('accessToken')
    const payload: Record<string | symbol, unknown> = { count: 1 }
    payload[tokenSymbol] = 'tk-abcdef123456'
    const masked = maskForLog(payload) as Record<string | symbol, unknown>
    expect(masked[tokenSymbol]).toBe('t***56')
    expect(masked.count).toBe(1)

    const list: unknown[] & Record<symbol, unknown> = Object.assign([1], {}) as never
    ;(list as Record<symbol, unknown>)[tokenSymbol] = 'tk-abcdef123456'
    const maskedList = maskForLog({ list }) as { list: Array<unknown> & Record<symbol, unknown> }
    expect(maskedList.list[tokenSymbol]).toBe('t***56')
    expect(maskedList.list[0]).toBe(1)
  })

  it('符号键的值是对象时递归脱敏；不可枚举符号键不参与', () => {
    const metaSymbol = Symbol('meta')
    const payload: Record<string | symbol, unknown> = {}
    payload[metaSymbol] = { token: 'tk-abcdef123456', keep: 'ok' }
    const masked = maskForLog(payload) as Record<string | symbol, unknown>
    const maskedMeta = masked[metaSymbol] as Record<string, unknown>
    expect(maskedMeta.token).toBe('t***56')
    expect(maskedMeta.keep).toBe('ok')

    // 不可枚举符号键不会被 JSON/日志结构展开，不进脱敏遍历（保持零拷贝）
    const hiddenSymbol = Symbol('hidden')
    const hidden: Record<string, unknown> = { count: 1 }
    Object.defineProperty(hidden, hiddenSymbol, { value: { token: 'tk-abcdef123456' }, enumerable: false, configurable: true })
    expect(maskForLog(hidden)).toBe(hidden)

    // 枚举符号键但值不敏感：探测走完符号分支后判定干净，原样返回
    const benign: Record<string | symbol, unknown> = { count: 1 }
    benign[Symbol('note')] = 'hello'
    expect(maskForLog(benign)).toBe(benign)
  })

  it('干净数组（含稀疏/非下标普通键）原样返回：不误伤正常日志', () => {
    const sparse = [1, , 3] as unknown[]
    expect(maskForLog(sparse)).toBe(sparse)
    const withExtra = Object.assign([1], { note: 'hello' }) as unknown as unknown[]
    expect(maskForLog(withExtra)).toBe(withExtra)
  })

  it('干净纯对象原样返回（零拷贝契约； 分两段遍历后保持）', () => {
    const clean: Record<string, unknown> = { count: 1, nested: { name: 'n' } }
    expect(maskForLog(clean)).toBe(clean)
  })
})

describe(' 持久化落盘审计（ 嵌套探测）', () => {
  it('开发期：嵌套敏感字段命中即阻断本次落盘，消息含完整路径', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend, memory } = memoryBackend()
    const store = createStore({
      name: 'fr22-nested-block',
      state: () => ({ count: 0, profile: { phone: '13812345678', nickname: 'n' } }),
    })
    const errors: Array<{ message: string; source: string }> = []
    store.hooks.on('onError', (error, source) => {
      errors.push({ message: (error as Error).message, source: String(source ?? '') })
    })
    store.use(persistencePlugin({ storage: backend, key: 'k', filter: (state: never) => state }) as never)

    store.setState('count', 1)
    expect(memory.has('k')).toBe(false)
    expect(errors.some((e) => e.message.includes('profile.phone') && e.message.includes('敏感字段') && e.source === 'persistence')).toBe(true)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('profile.phone'))
    store.destroy()
  })

  it('开发期：数组内记录命中同样阻断并给出下标路径', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend, memory } = memoryBackend()
    const store = createStore({ name: 'fr22-array-block', state: () => ({ count: 0, orders: [{ token: 'tk-abc' }] }) })
    const errors: string[] = []
    store.hooks.on('onError', (error) => {
      errors.push((error as Error).message)
    })
    store.use(persistencePlugin({ storage: backend, key: 'k', filter: (state: never) => state }) as never)

    store.setState('count', 1)
    expect(memory.has('k')).toBe(false)
    expect(errors.some((message) => message.includes('orders[0].token'))).toBe(true)
    store.destroy()
  })

  it('filter 白名单排除嵌套敏感键后正常落盘', () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend, memory } = memoryBackend()
    const store = createStore({
      name: 'fr22-nested-safe',
      state: () => ({ count: 0, profile: { phone: '13812345678', nickname: 'n' } }),
    })
    store.use(
      persistencePlugin({
        storage: backend,
        key: 'k',
        // 只持久化 count：整个 profile 子树（含嵌套 phone）不进入落盘白名单
        filter: (state: { count: number; profile: { phone: string; nickname: string } }) => ({ count: state.count }),
      }),
    )
    store.setState('count', 2)
    expect(memory.get('k')).toContain('"count":2')
    expect(memory.get('k')).not.toContain('13812345678')
    store.destroy()
  })

  it('生产期：嵌套敏感字段命中即拒绝本次落盘并上报路径（安全优先）', async () => {
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const { createStore: createProd } = await import('../../../src/index.js')
      const { persistencePlugin: persistProd } = await import('../../../src/plugins.js')
      const { backend, memory } = memoryBackend()
      const store = createProd({
        name: 'fr22-prod-nested',
        state: () => ({ count: 0, profile: { phone: '13812345678', nickname: 'n' } }),
      })
      const onError = jest.fn()
      store.hooks.on('onError', onError)
      store.use(persistProd({ storage: backend, key: 'k', filter: (state: never) => state }))
      store.setState('count', 5)
      expect(memory.has('k')).toBe(false)
      const messages = onError.mock.calls.map((call) => (call[0] as Error).message)
      expect(messages.some((message) => message.includes('profile.phone'))).toBe(true)
      expect((onError.mock.calls[0][0] as { context?: { phase?: string } }).context?.phase).toBe('save')
      store.destroy()
    } finally {
      delete process.env.NODE_ENV
      jest.resetModules()
    }
  })

  it('生产期：顶层敏感字段同样拒绝落盘（不写任何含敏感值的载荷）', async () => {
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    try {
      const { createStore: createProd } = await import('../../../src/index.js')
      const { persistencePlugin: persistProd } = await import('../../../src/plugins.js')
      const { backend, memory } = memoryBackend()
      const store = createProd({ name: 'fr22-prod', state: () => ({ count: 0, idCardNo: '110101199001011234' }) })
      const onError = jest.fn()
      store.hooks.on('onError', onError)
      store.use(persistProd({ storage: backend, key: 'k', filter: (state: never) => state }))
      store.setState('count', 5)
      expect(memory.has('k')).toBe(false)
      expect((onError.mock.calls[0][0] as Error).message).toContain('idCardNo')
      store.destroy()
    } finally {
      delete process.env.NODE_ENV
      jest.resetModules()
    }
  })

  it('类实例嵌套字段（JSON.stringify 会写明文）命中同样拒绝落盘', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend, memory } = memoryBackend()
    class ProfileRecord {
      phone = '13812345678'
    }
    const store = createStore({ name: 'fr22-class-instance', state: () => ({ count: 0, profile: new ProfileRecord() }) })
    const errors: string[] = []
    store.hooks.on('onError', (error) => {
      errors.push((error as Error).message)
    })
    store.use(persistencePlugin({ storage: backend, key: 'k', filter: (state: never) => state }) as never)

    store.setState('count', 1)
    expect(memory.has('k')).toBe(false)
    expect(errors.some((message) => message.includes('profile.phone'))).toBe(true)
    store.destroy()
  })

  it('带 toJSON 的包装对象（JSON 会写明文）命中同样拒绝落盘', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend, memory } = memoryBackend()
    const store = createStore({ name: 'fr22-tojson', state: () => ({ count: 0, user: null as unknown }) })
    const errors: string[] = []
    store.hooks.on('onError', (error) => {
      errors.push((error as Error).message)
    })
    store.use(persistencePlugin({ storage: backend, key: 'k', filter: (state: never) => state }) as never)

    store.setState('user', { toJSON: () => ({ phone: '13812345678' }) } as never)
    expect(memory.has('k')).toBe(false)
    expect(errors.some((message) => message.includes('user.phone'))).toBe(true)
    store.destroy()
  })

  it('审计读取抛错（throwing getter）：fail-closed 拒绝落盘并经 onError 上报，异常不外溢', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const { backend, memory } = memoryBackend()
    const store = createStore({ name: 'fr22-audit-boom', state: () => ({ count: 0, evil: null as unknown }) })
    const errors: string[] = []
    store.hooks.on('onError', (error) => {
      errors.push((error as Error).message)
    })
    store.use(persistencePlugin({ storage: backend, key: 'k', filter: (state: never) => state }) as never)

    // 构造「读取即抛错」的嵌套值再触发通知：审计读取它时抛错，必须被 saveState 的错误边界接住
    const evil: Record<string, unknown> = {}
    Object.defineProperty(evil, 'leak', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('audit boom')
      },
    })
    expect(() => store.setState('evil', evil as never)).not.toThrow()
    expect(memory.has('k')).toBe(false)
    expect(errors.some((message) => message.includes('审计失败') && message.includes('audit boom'))).toBe(true)
    store.destroy()

    // 非 Error 抛出（JS 调用方/代理陷阱）：String(error) 兜底，同样 fail-closed
    const { backend: backend2, memory: memory2 } = memoryBackend()
    const store2 = createStore({ name: 'fr22-audit-string-boom', state: () => ({ count: 0, evil: null as unknown }) })
    const errors2: string[] = []
    store2.hooks.on('onError', (error) => {
      errors2.push((error as Error).message)
    })
    store2.use(persistencePlugin({ storage: backend2, key: 'k2', filter: (state: never) => state }) as never)
    const evil2: Record<string, unknown> = {}
    Object.defineProperty(evil2, 'leak', {
      enumerable: true,
      configurable: true,
      get() {
        throw 'audit string boom'
      },
    })
    expect(() => store2.setState('evil', evil2 as never)).not.toThrow()
    expect(memory2.has('k2')).toBe(false)
    expect(errors2.some((message) => message.includes('审计失败') && message.includes('audit string boom'))).toBe(true)
    store2.destroy()
  })

  it('生产期审计失败：不刷 console 但经 onError 上报并拒绝落盘', async () => {
    process.env.NODE_ENV = 'production'
    jest.resetModules()
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { createStore: createProd } = await import('../../../src/index.js')
      const { persistencePlugin: persistProd } = await import('../../../src/plugins.js')
      const { backend, memory } = memoryBackend()
      const store = createProd({ name: 'fr22-prod-audit-boom', state: () => ({ count: 0, evil: null as unknown }) })
      const onError = jest.fn()
      store.hooks.on('onError', onError)
      store.use(persistProd({ storage: backend, key: 'k', filter: (state: never) => state }))

      const evil: Record<string, unknown> = {}
      Object.defineProperty(evil, 'leak', {
        enumerable: true,
        configurable: true,
        get() {
          throw new Error('prod audit boom')
        },
      })
      expect(() => store.setState('evil', evil as never)).not.toThrow()
      expect(memory.has('k')).toBe(false)
      const messages = onError.mock.calls.map((call) => (call[0] as Error).message)
      expect(messages.some((message) => message.includes('审计失败') && message.includes('prod audit boom'))).toBe(true)
      expect(consoleError).not.toHaveBeenCalled()
      store.destroy()
    } finally {
      consoleError.mockRestore()
      delete process.env.NODE_ENV
      jest.resetModules()
    }
  })
})

describe(' 日志脱敏（AS-12 第 2 项）', () => {
  it('state 日志不输出完整手机号 / token；非敏感字段原样', () => {
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const store = createStore({
      name: 'fr22-log',
      state: () => ({
        count: 0,
        userPhone: '13812345678',
        token: 'tk-abcdef123456',
        nested: { address: '北京市海淀区知春路1号' },
      }),
    })
    store.use(loggerPlugin())
    store.setState('count', 1)
    store.setState('userPhone', '13812345678')

    const stateLog = consoleLog.mock.calls.find((call) => call[0] === '[TallyStore] State changed:')
    const logged = stateLog?.[1] as Record<string, unknown>
    expect(logged.count).toBe(1) // 同步通知：打印的是变更后状态
    expect(logged.userPhone).toBe('1***78')
    expect(logged.token).toBe('t***56')
    // 长字符串保留前缀+末位；完整地址不出现
    expect((logged.nested as Record<string, unknown>).address).toBe('北***1号')

    const setting = consoleLog.mock.calls.find((call) => call[0] === '[TallyStore] Setting state:' && call[1] === 'userPhone')
    expect(setting?.[3]).toBe('1***78')
    store.destroy()
  })
})

describe(' 敏感键判定缓存有界', () => {
  it('缓存命中语义不变：同一键重复判定结果一致且只占一条缓存', () => {
    resetSensitiveKeyPatterns()
    expect(sensitiveKeyCacheSize()).toBe(0)
    expect(isSensitiveKey('userPhone')).toBe(true)
    expect(isSensitiveKey('userPhone')).toBe(true)
    expect(isSensitiveKey('count')).toBe(false)
    expect(isSensitiveKey('count')).toBe(false)
    expect(sensitiveKeyCacheSize()).toBe(2)
  })

  it('超长键不进入缓存（长度边界内的键仍缓存）：结果仍按模式判定', () => {
    resetSensitiveKeyPatterns()
    const longSensitive = 'x'.repeat(SENSITIVE_KEY_CACHE_MAX_KEY_LENGTH) + 'phone'
    expect(isSensitiveKey(longSensitive)).toBe(true)
    expect(sensitiveKeyCacheSize()).toBe(0)

    const longClean = 'y'.repeat(SENSITIVE_KEY_CACHE_MAX_KEY_LENGTH + 10)
    expect(isSensitiveKey(longClean)).toBe(false)
    expect(sensitiveKeyCacheSize()).toBe(0)

    const boundaryKey = 'z'.repeat(SENSITIVE_KEY_CACHE_MAX_KEY_LENGTH)
    expect(isSensitiveKey(boundaryKey)).toBe(false)
    expect(sensitiveKeyCacheSize()).toBe(1)
  })

  it('缓存达到容量上限后清空重建：条目数有界、判定语义不受影响', () => {
    resetSensitiveKeyPatterns()
    for (let i = 0; i < SENSITIVE_KEY_CACHE_MAX_ENTRIES + 50; i += 1) {
      isSensitiveKey('cacheKey' + i)
    }
    expect(sensitiveKeyCacheSize()).toBeLessThanOrEqual(SENSITIVE_KEY_CACHE_MAX_ENTRIES)
    expect(sensitiveKeyCacheSize()).toBeGreaterThan(0)
    // 清空后按需重算，命中结果仍然正确
    expect(isSensitiveKey('cacheKey0')).toBe(false)
    expect(isSensitiveKey('myToken')).toBe(true)
    expect(sensitiveKeyCacheSize()).toBeLessThanOrEqual(SENSITIVE_KEY_CACHE_MAX_ENTRIES)
  })
})
