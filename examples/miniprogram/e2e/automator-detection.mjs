/**
 * 「加载 miniprogram-automator 失败」的 SKIP 判定。
 *
 * 只有错误消息点名 miniprogram-automator 才算「包未安装」：Node 的模块解析错误消息一定带上
 * 被解析的 specifier。包已安装但其依赖缺失、包内文件损坏同样是 ERR_MODULE_NOT_FOUND，
 * 必须按失败处理（exit 1），否则「装坏了」会被静默当成「没装」而跳过 e2e。
 */
const MISSING_AUTOMATOR_PATTERN = /Cannot find (?:package|module) ['"]miniprogram-automator(?:['"]|[/\\])/i

/**
 * @param {unknown} error 动态 import('miniprogram-automator') 抛出的错误
 * @returns {boolean} true = 确定是「包未安装」，可以 SKIP；false = 其它加载失败，必须 FAIL
 */
export function shouldSkipMissingAutomator(error) {
  if (error === null || typeof error !== 'object') {
    return false
  }
  const code = error.code
  // 非「模块找不到」类错误（语法错误、加载期异常、包安装不完整时的其它错误）一律不 SKIP
  if (code !== undefined && code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
    return false
  }
  const message = typeof error.message === 'string' ? error.message : String(error)
  return MISSING_AUTOMATOR_PATTERN.test(message)
}
