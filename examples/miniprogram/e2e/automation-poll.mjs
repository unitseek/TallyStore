/**
 * e2e 轮询工具（从 automator.mjs 抽出以便单测）：
 * - withTimeout：给无超时能力的 Promise 加超时——DevTools CLI 卡死时脚本不会永久挂起；
 * - waitUntil：有界轮询等待探针就绪，超时给可定位错误。
 *
 * 未就绪哨兵只用 undefined / null：0、''、false 都是可能的合法结果。
 * 每次 probe 自身也受超时约束：page.data() / page.$() 卡住正是 withTimeout 注释描述的场景，
 * 只检查轮询之间的 deadline 会让整个脚本永久挂起。
 */

/**
 * 给无超时能力的 Promise 加超时。
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @param {string} label 超时错误里的可定位标签
 * @returns {Promise<unknown>}
 */
export function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' 超时（' + ms + 'ms）')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 有界轮询：probe 返回 undefined / null 表示「未就绪」，其余值（含 0 / '' / false）即就绪结果。
 * @template T
 * @param {string} label 超时/探针超时错误里的可定位标签
 * @param {() => Promise<T | undefined | null>} probe
 * @param {number} [timeoutMs]
 * @param {number} [intervalMs]
 * @returns {Promise<T>}
 */
export async function waitUntil(label, probe, timeoutMs = 5000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    // 单次 probe 的预算取「剩余时间」，探针卡住时按同一 deadline 失败而不是永久挂起
    const remaining = Math.max(1, deadline - Date.now())
    const value = await withTimeout(probe(), remaining, label)
    // 真值判断会把合法的 0 / '' / false 当成「未就绪」，这里只认 undefined/null 哨兵
    if (value !== undefined && value !== null) {
      return value
    }
    if (Date.now() > deadline) {
      throw new Error('等待超时（' + timeoutMs + 'ms）：' + label)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
