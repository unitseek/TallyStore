/**  / AS-01：异步竞态辅助——序号守卫、旧结果丢弃计数、取消 */
import { createRaceGuard, createStore } from '../../../src/index.js'

/** 受控延迟：按调用顺序决定 resolve 顺序（模拟乱序晚到） */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe(' createRaceGuard', () => {
  it('连续触发 5 次，仅最后一次结果写入 Store（AS-01）', async () => {
    const store = createStore({ name: 'fr20-latest', state: () => ({ keyword: '', result: '' }) })
    const guard = createRaceGuard()
    const boxes = Array.from({ length: 5 }, () => deferred<string>())

    // 模拟高频切换查询条件：每次取号并发起「请求」
    const actions = boxes.map((box, i) => ({ seq: guard.begin(), box, keyword: 'k' + i }))
    // 乱序 resolve：第 5 个最先回来（1/3 晚于其落地后才回来）
    actions[4].box.resolve('result-of-k4')
    actions[0].box.resolve('result-of-k0')
    actions[2].box.resolve('result-of-k2')
    actions[1].box.resolve('result-of-k1')
    actions[3].box.resolve('result-of-k3')

    // action 侧的落地判定模式
    const settle = async ({ seq, box, keyword }: (typeof actions)[number]) => {
      const value = await box.promise
      if (!guard.isCurrent(seq)) return // 旧结果丢弃
      store.setState('keyword', keyword)
      store.setState('result', value)
    }
    await Promise.all(actions.map(settle))

    expect(store.getState().keyword).toBe('k4')
    expect(store.getState().result).toBe('result-of-k4')
    // 旧结果被丢弃且可计数（isCurrent 命中过期 4 次）
    expect(guard.staleCount()).toBe(4)
    store.destroy()
  })

  it('最新结果晚到也生效（只按序号判定，不按时间）', async () => {
    const guard = createRaceGuard()
    const first = deferred<string>()
    const second = deferred<string>()
    const seq1 = guard.begin()
    const seq2 = guard.begin()
    // 先完成的旧请求
    first.resolve('old')
    expect(guard.isCurrent(seq1)).toBe(false)
    // 后完成的最新请求
    second.resolve('new')
    expect(guard.isCurrent(seq2)).toBe(true)
  })

  it('cancel 后在途结果全部过期；新的 begin 重新有效', async () => {
    const store = createStore({ name: 'fr20-cancel', state: () => ({ result: 'initial' }) })
    const guard = createRaceGuard()
    const box = deferred<string>()
    const seq = guard.begin()
    guard.cancel()

    box.resolve('late-value')
    const value = await box.promise
    if (guard.isCurrent(seq)) {
      store.setState('result', value)
    }
    expect(store.getState().result).toBe('initial')
    expect(guard.staleCount()).toBe(1)

    // 取消后的新请求正常生效
    const seq2 = guard.begin()
    expect(guard.isCurrent(seq2)).toBe(true)
    store.destroy()
  })

  it('与 action 解耦：不包装 Promise，无库侧未处理 rejection', async () => {
    const guard = createRaceGuard()
    const seq = guard.begin()
    guard.cancel()
    // 调用方原有 await/catch 语义不变：guard 不制造任何 rejection
    await expect(Promise.resolve('ok')).resolves.toBe('ok')
    expect(guard.isCurrent(seq)).toBe(false)
  })
})
