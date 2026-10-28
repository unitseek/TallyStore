#!/usr/bin/env node
/**
 * 隐私接口白名单校验：静态扫描 src/ 对微信 wx 全局的使用，
 * 只允许白名单内的同步存储与环境判定 API——库自身不得调用需要用户授权的
 * 隐私接口（位置、相册、剪贴板等）。
 *
 * 覆盖的访问形态：
 * - 字面量属性：wx.getLocation / wx?.getLocation
 * - 计算属性：wx['getLocation']
 * - globalThis：globalThis.wx.getLocation / globalThis['wx']['getLocation']
 * - 解构：const { getLocation } = wx（含重命名；rest 元素视为逃逸）
 * - 别名：const w = wx; w.getLocation()（含 = globalThis.wx、类型断言形式，
 *   以及「返回 wx 句柄的工具函数 / getter」派生的别名）
 * - 动态取用：wx[name] / 句柄变量 [name] —— 必须带显式白名单：
 *   代码注释 // privacy-api-allow: <理由>（同行或上一行），或登记在
 *   DYNAMIC_RESOLVE_ALLOWLIST（脚本内显式清单，新增需安全评审）
 *
 * 注释与字符串字面量中的 wx.* 文本不计入（模板字符串的 ${...} 插值仍按代码扫描）。
 * 已知局限：经任意函数转手/容器逃逸的 wx 句柄不做数据流追踪（静态扫描的最低保证）；
 * 正则字面量的识别是启发式的：依据上一个显著 token（并区分一元/二元 +/-、整体识别 ++/--）区分除法与正则，
 * 后缀自增后的除法与 JSX 闭合标签一律按除法处理，避免把真实代码抹白；`if (x) /re/.test(y)` 这类
 * 「语句位置紧跟 ) 的正则」仍可能被当作除法继续扫描——歧义时保守方向是只会多报、不会漏报。
 *
 * 用法：node scripts/check-privacy-api.mjs [srcDir]   （退出码 0 通过 / 1 违规）
 * srcDir 仅供测试夹具覆盖，默认 <repoRoot>/src
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { repoRoot } from './publish-entries.mjs'

/** 允许库使用的 wx 成员（同步存储三件套 + 环境判定；新增需安全评审并更新 SECURITY.md） */
const ALLOWED_WX_MEMBERS = new Set(['getStorageSync', 'setStorageSync', 'removeStorageSync', 'getAccountInfoSync'])

/**
 * 动态 resolve 点显式白名单：仅这些位置允许对 wx 句柄做「计算属性访问」
 * （动态成员名无法静态判定，必须人工确认调用面受控）。新增条目需写清理由并走安全评审。
 */
const DYNAMIC_RESOLVE_ALLOWLIST = [
  {
    file: /src[\\/]plugins[\\/]WxStorageBackend\.ts$/,
    code: 'api?.[name]',
    reason:
      'WxStorageBackend.resolve() 的唯一动态取用点：name 受 WxStorageApi 键约束，取出的成员先校验 callable，实际调用面仍是白名单三件套',
  },
]

const QUOTE_SQ = "'"
const QUOTE_DQ = '"'
const QUOTE_BQ = '\u0060'
/** 字符串字面量的引号字符类（单引号 / 双引号 / 反引号），用于拼装正则 */
const QUOTE_CLASS = '[' + QUOTE_SQ + QUOTE_DQ + QUOTE_BQ + ']'

/** 正则元字符转义（拼装处理器名模式用） */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 生成两份等长文本：
 * - commentsOnly：注释被替换为空格（字符串保持原样，用于读取别名/解构表达式）；
 * - code：注释 + 字符串静态片段（含模板字符串静态部分）替换为空格，用于结构匹配，
 *   模板字符串的插值表达式仍保留为代码。
 */
/** 正则字面量可以出现的「表达式起始」前一个 token 集合（其余位置按除法处理） */
const REGEX_START_TOKENS = new Set([
  '',
  '(',
  '[',
  '{',
  ',',
  ';',
  ':',
  '=',
  '!',
  '?',
  // 注意：只保留 tokenizer 实际会产出的单字符 token（多字符 && / || / => 不会被产出；
  // < / > 在 JSX 与比较语境会误吞代码，+/- 需按一元/二元区分，均不在本集合里）
  '*',
  '%',
  '&',
  '|',
  '^',
  '~',
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'case',
  'delete',
  'void',
  'yield',
  'await',
  'else',
  'do',
  'new',
  'throw',
])

function sanitize(source) {
  const commentsOnly = source.split('')
  const stringSpans = []
  const stack = [{ kind: 'code', braceDepth: 0 }]
  let lastToken = ''
  let secondLastToken = ''
  /** 更新 token 历史：lastToken 是判定正则起点的依据，secondLastToken 用于区分一元/二元 +/- */
  const setToken = (token) => {
    secondLastToken = lastToken
    lastToken = token
  }
  /** token 是否「可以结束一个表达式」（其后的 / 只能按除法解释） */
  const isValueLike = (token) =>
    token === 'value' || token === ')' || token === ']' || token === '}' || (/^[A-Za-z_$][\w$]*$/.test(token) && !REGEX_START_TOKENS.has(token))
  const isRegexStart = () => {
    if (REGEX_START_TOKENS.has(lastToken)) return true
    // 一元 +/- 之后才可能是正则；二元加减之后的 / 是除法（如 a + b / c）
    if (lastToken === '+' || lastToken === '-') return !isValueLike(secondLastToken)
    return false
  }
  let i = 0
  while (i < source.length) {
    const top = stack[stack.length - 1]
    const ch = source[i]
    if (top.kind === 'code') {
      if (ch === '/' && source[i + 1] === '/') {
        const newline = source.indexOf('\n', i)
        const end = newline === -1 ? source.length : newline
        for (let k = i; k < end; k++) commentsOnly[k] = ' '
        i = end
        continue
      }
      if (ch === '/' && source[i + 1] === '*') {
        const close = source.indexOf('*/', i + 2)
        const end = close === -1 ? source.length : close + 2
        for (let k = i; k < end; k++) {
          if (commentsOnly[k] !== '\n' && commentsOnly[k] !== '\r') commentsOnly[k] = ' '
        }
        i = end
        continue
      }
      if (ch === '/' && isRegexStart()) {
        // 正则字面量：跳过到未转义的闭合 /（字符类 [...] 内的 / 不结束正则），整段静态内容按字符串抹除；
        // 不做这一步时，正则里的引号 / 斜杠会破坏后续 tokenization 并可能隐藏真实的 wx 访问
        let j = i + 1
        let inCharacterClass = false
        let closed = false
        while (j < source.length) {
          const current = source[j]
          if (current === '\\') {
            j += 2
            continue
          }
          if (current === '[') {
            inCharacterClass = true
            j++
            continue
          }
          if (current === ']') {
            inCharacterClass = false
            j++
            continue
          }
          if (current === '/' && !inCharacterClass) {
            closed = true
            break
          }
          if (current === '\n') break
          j++
        }
        if (closed) {
          let k = j + 1
          while (k < source.length && /[A-Za-z]/.test(source[k])) k++
          stringSpans.push([i + 1, k])
          setToken('value')
          i = k
          continue
        }
        // 未闭合：回退为除法处理，避免过度吞掉后续代码
        setToken('/')
        i++
        continue
      }
      if (ch === QUOTE_SQ || ch === QUOTE_DQ) {
        let j = i + 1
        while (j < source.length) {
          if (source[j] === '\\') {
            j += 2
            continue
          }
          if (source[j] === ch) break
          if (source[j] === '\n') break
          j++
        }
        stringSpans.push([i + 1, Math.min(j, source.length)])
        i = Math.min(j + 1, source.length)
        setToken('value')
        continue
      }
      if (ch === QUOTE_BQ) {
        stack.push({ kind: 'template', staticStart: i + 1 })
        setToken('value')
        i++
        continue
      }
      if (ch === '{') {
        top.braceDepth++
        setToken('{')
        i++
        continue
      }
      if (ch === '}') {
        if (top.braceDepth === 0 && stack.length > 1) {
          stack.pop()
          i++
          const parent = stack[stack.length - 1]
          if (parent.kind === 'template') parent.staticStart = i
          setToken('')
          continue
        }
        top.braceDepth--
        setToken('}')
        i++
        continue
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i + 1
        while (j < source.length && /[\w$]/.test(source[j])) j++
        setToken(source.slice(i, j))
        i = j
        continue
      }
      if (/[0-9]/.test(ch)) {
        let j = i + 1
        while (j < source.length && /[0-9A-Za-z_$]/.test(source[j])) j++
        setToken('value')
        i = j
        continue
      }
      // ++/-- 必须作为整体 token：否则 loaded++ / total 会把后置自增后的除法误判为正则
      if ((ch === '+' || ch === '-') && source[i + 1] === ch) {
        setToken(ch + ch)
        i += 2
        continue
      }
      if (!/\s/.test(ch)) setToken(ch)
      i++
      continue
    }
    // 模板字符串静态部分
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '$' && source[i + 1] === '{') {
      stringSpans.push([top.staticStart, i])
      stack.push({ kind: 'code', braceDepth: 0 })
      setToken('')
      i += 2
      continue
    }
    if (ch === QUOTE_BQ) {
      stringSpans.push([top.staticStart, i])
      stack.pop()
      setToken('value')
      i++
      continue
    }
    i++
  }
  const code = commentsOnly.slice()
  for (const [from, to] of stringSpans) {
    for (let k = from; k < to; k++) {
      if (code[k] !== '\n' && code[k] !== '\r') code[k] = ' '
    }
  }
  return { code: code.join(''), commentsOnly: commentsOnly.join('') }
}

/** 读取指定位置的字符串字面量内容（模板字符串含插值视为动态，返回 null） */
function readStringLiteralAt(source, quoteIndex) {
  const quote = source[quoteIndex]
  if (quote !== QUOTE_SQ && quote !== QUOTE_DQ && quote !== QUOTE_BQ) return null
  let i = quoteIndex + 1
  let value = ''
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      value += source[i + 1] ?? ''
      i += 2
      continue
    }
    if (ch === quote) return value
    if (quote === QUOTE_BQ && ch === '$' && source[i + 1] === '{') return null
    value += ch
    i++
  }
  return null
}

/** 顶层（不跨括号/字符串）逗号切分：解构条目解析用 */
function splitTopLevel(text, delimiter) {
  const parts = []
  let current = ''
  let depth = 0
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote !== '') {
      current += ch
      if (ch === '\\') {
        current += text[i + 1] ?? ''
        i++
        continue
      }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === QUOTE_SQ || ch === QUOTE_DQ || ch === QUOTE_BQ) {
      quote = ch
      current += ch
      continue
    }
    if (ch === '{' || ch === '(' || ch === '[') depth++
    if (ch === '}' || ch === ')' || ch === ']') depth--
    if (ch === delimiter && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

/** 扫描单个源码文件，返回违规列表 */
function scanSource(relative, source) {
  const { code, commentsOnly } = sanitize(source)
  // 文件中没有任何 wx / globalThis 文本：无需做别名/成员分析
  if (!code.includes('wx') && !code.includes('globalThis')) return []

  const lines = source.split('\n')
  const lineStarts = [0]
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineStarts.push(i + 1)
  }
  const lineIndexOf = (offset) => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (lineStarts[mid] <= offset) low = mid
      else high = mid - 1
    }
    return low
  }
  const lineTextAt = (offset) => lines[lineIndexOf(offset)] ?? ''
  const hasAllowComment = (offset) => {
    const line = lineIndexOf(offset)
    return /privacy-api-allow/.test(lineTextAt(offset)) || (line > 0 && /privacy-api-allow/.test(lines[line - 1] ?? ''))
  }
  const isDynamicAllowlisted = (offset) => {
    const line = lineTextAt(offset)
    return DYNAMIC_RESOLVE_ALLOWLIST.some((entry) => entry.file.test(relative) && line.includes(entry.code))
  }

  const violations = []
  const report = (offset, label) => {
    violations.push(relative + ':' + (lineIndexOf(offset) + 1) + ' -> ' + label)
  }

  /**
   * 从函数体的开括号起做花括号配平，返回函数体文本。
   * 类型断言里的对象字面量（{ wx?: WxApi }）花括号是成对的，配平不会像非贪心 [^}]* 那样提前截断；
   * 也不再用「固定 400 字符窗口」——那会把紧邻函数/内部回调误算进来源判定。
   */
  const readBalancedBody = (text, openBraceIndex) => {
    let depth = 0
    for (let index = openBraceIndex; index < text.length; index += 1) {
      const current = text[index]
      if (current === '{') depth += 1
      else if (current === '}') {
        depth -= 1
        if (depth === 0) return text.slice(openBraceIndex + 1, index)
      }
    }
    return text.slice(openBraceIndex + 1)
  }

  // 返回 wx 句柄的工具函数 / getter（函数体直接读 globalThis.wx，或调用同类函数）
  const wxSourceFunctions = new Set()
  for (const match of code.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)[^{]*\{/g)) {
    const body = readBalancedBody(code, match.index + match[0].length - 1)
    if (/\bglobalThis\b/.test(body) && /\.\s*wx\b/.test(body)) {
      wxSourceFunctions.add(match[1])
    }
  }
  // 箭头函数来源：{...} 体按花括号配平，单表达式体取到行尾（内部回调的 => 不再触发截断）
  for (const match of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g)) {
    let cursor = match.index + match[0].length
    while (cursor < code.length && /\s/.test(code[cursor])) cursor += 1
    const body =
      code[cursor] === '{'
        ? readBalancedBody(code, cursor)
        : code.slice(cursor, (() => {
            const newline = code.indexOf('\n', cursor)
            return newline === -1 ? code.length : newline
          })())
    if (/\bglobalThis\b/.test(body) && /\.\s*wx\b/.test(body)) {
      wxSourceFunctions.add(match[1])
    }
  }
  const handleGetters = new Set()
  for (const match of code.matchAll(
    /(?:^|\n)[ \t]*(?:(?:private|public|protected|static|readonly)\s+)*get\s+([A-Za-z_$][\w$]*)\s*\(\s*\)\s*(?::[^{;]+)?\{/g,
  )) {
    const body = readBalancedBody(code, match.index + match[0].length - 1)
    const returnsWx =
      /\.\s*wx\b/.test(body) || [...wxSourceFunctions].some((name) => new RegExp('\\b' + escapeRegExp(name) + '\\s*\\(').test(body))
    if (returnsWx) handleGetters.add(match[1])
  }

  const aliases = new Set()
  /** 去掉最外层成对括号：(wx as WxApi) 这类写法先脱一层括号再判断 */
  const stripOuterParens = (text) => {
    let value = text
    while (value.length > 1 && value.startsWith('(') && value.endsWith(')')) {
      let depth = 0
      let wrapsWhole = true
      for (let index = 0; index < value.length; index += 1) {
        if (value[index] === '(') depth += 1
        else if (value[index] === ')') {
          depth -= 1
          if (depth === 0 && index !== value.length - 1) {
            wrapsWhole = false
            break
          }
        }
      }
      if (!wrapsWhole) break
      value = value.slice(1, -1).trim()
    }
    return value
  }
  const isHandleExpression = (expression) => {
    const trimmed = stripOuterParens(expression.trim())
    if (trimmed === '') return false
    // (globalThis as { wx?: WxApi }).wx 形态先判断：其尾部不是类型，不能被 as 断言规则吞掉
    if (/globalThis/.test(trimmed) && /\)\s*\.\s*wx$/.test(trimmed)) return true
    // 类型断言：尾部类型语法太多（对象类型、交叉类型、泛型、括号），
    // 不做逐字符白名单——只要含 " as " 就去掉尾部、递归判断前缀是否为句柄
    const asAssertion = /^([\s\S]+?)\s+as\s+[\s\S]+$/.exec(trimmed)
    if (asAssertion) return isHandleExpression(asAssertion[1])
    if (/^wx$/.test(trimmed)) return true
    if (/^globalThis\s*\.\s*wx$/.test(trimmed)) return true
    if (/^globalThis\s*\[\s*'wx'\s*\]$/.test(trimmed)) return true
    if (/^globalThis\s*\[\s*"wx"\s*\]$/.test(trimmed)) return true
    // 调用形态允许带参数：readWx(flag) 与零参 readWx() 同口径
    const call = /^([A-Za-z_$][\w$]*)\s*\([^()]*\)$/.exec(trimmed)
    if (call) return wxSourceFunctions.has(call[1])
    const getter = /^this\.([A-Za-z_$][\w$]*)$/.exec(trimmed)
    if (getter) return handleGetters.has(getter[1])
    if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return aliases.has(trimmed)
    return false
  }

  // 别名值传播到不动点：RHS 是 code 匹配的尾部，用 commentsOnly 的同区间还原字符串字面量
  let changed = true
  while (changed) {
    changed = false
    for (const match of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*([^;\n]+)/g)) {
      if (aliases.has(match[1])) continue
      const rhsStart = match.index + match[0].length - match[2].length
      const rhs = commentsOnly.slice(rhsStart, match.index + match[0].length)
      if (isHandleExpression(rhs)) {
        aliases.add(match[1])
        changed = true
      }
    }
  }

  // 解构：const { getLocation } = wx / const { getStorageSync: g } = globalThis.wx
  // 解构允许可选类型标注：例如 const { getLocation }: WxApi = wx
  for (const match of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*(?::[^=;\n]+)?=\s*([^;\n]+)/g)) {
    const rhsStart = match.index + match[0].length - match[2].length
    const rhs = commentsOnly.slice(rhsStart, match.index + match[0].length)
    if (!isHandleExpression(rhs)) continue
    const braceIndex = match.index + match[0].indexOf('{')
    const entriesText = commentsOnly.slice(braceIndex + 1, braceIndex + 1 + match[1].length)
    for (const rawEntry of splitTopLevel(entriesText, ',')) {
      const entry = rawEntry.trim()
      if (entry === '') continue
      if (entry.startsWith('...')) {
        if (!hasAllowComment(match.index)) report(match.index, 'wx 解构的 rest 元素（可绕过成员白名单）')
        continue
      }
      const propertyText = entry.split(':')[0].split('=')[0].trim()
      let member = propertyText
      if (propertyText.startsWith(QUOTE_SQ) || propertyText.startsWith(QUOTE_DQ) || propertyText.startsWith(QUOTE_BQ)) {
        member = readStringLiteralAt(propertyText, 0)
      }
      if (member === null) continue
      if (!ALLOWED_WX_MEMBERS.has(member) && !hasAllowComment(match.index)) {
        report(match.index, 'wx 解构 -> ' + member)
      }
    }
  }

  // 句柄表达式模式：裸 wx / 别名 / 返回 wx 的工具函数调用 / 返回 wx 的 getter。
  // 后两者是「直接访问」形态（readWxStorageSyncApi()?.chooseImage / this.wxApi.getLocation），
  // 旧实现只用它们推导别名、不校验直接访问，构成白名单绕过
  const handleMatchers = ['(?:' + ['wx', ...aliases].map(escapeRegExp).join('|') + ')']
  for (const sourceFunction of wxSourceFunctions) {
    // 允许带参数：来源函数声明本身就允许参数，直接访问模式需与之对齐
    handleMatchers.push(escapeRegExp(sourceFunction) + '\\s*\\([^()]*\\)')
  }
  for (const getterName of handleGetters) {
    handleMatchers.push('this\\.' + escapeRegExp(getterName))
  }
  const handlePattern = '(?:' + handleMatchers.join('|') + ')'
  const memberPattern = '\\b(' + handlePattern + ')\\s*(?:\\?\\.|\\.)\\s*([A-Za-z_$][\\w$]*)'

  // 字面量属性访问：wx.member / wx?.member（globalThis.wx.member 也含 wx.member 子串）
  for (const match of code.matchAll(new RegExp(memberPattern, 'g'))) {
    if (ALLOWED_WX_MEMBERS.has(match[2])) continue
    if (hasAllowComment(match.index)) continue
    report(match.index, match[1] + '.' + match[2])
  }

  // 计算属性（字面量）：wx['member'] / alias?.["member"]
  const bracketLiteralPattern = '\\b(' + handlePattern + ')\\s*(?:\\?\\.)?\\s*\\[\\s*' + QUOTE_CLASS
  for (const match of code.matchAll(new RegExp(bracketLiteralPattern, 'g'))) {
    const quoteIndex = match.index + match[0].length - 1
    const member = readStringLiteralAt(commentsOnly, quoteIndex)
    if (member === null) {
      if (!hasAllowComment(match.index) && !isDynamicAllowlisted(match.index)) {
        report(match.index, match[1] + '[dynamic]（动态成员访问，需显式白名单）')
      }
      continue
    }
    if (ALLOWED_WX_MEMBERS.has(member)) continue
    if (hasAllowComment(match.index)) continue
    report(match.index, match[1] + '[' + QUOTE_SQ + member + QUOTE_SQ + ']')
  }

  // 计算属性（动态）：wx[name] / alias?.[name]
  const bracketDynamicPattern = '\\b(' + handlePattern + ')\\s*(?:\\?\\.)?\\s*\\[\\s*(?!' + QUOTE_CLASS + ')'
  for (const match of code.matchAll(new RegExp(bracketDynamicPattern, 'g'))) {
    if (hasAllowComment(match.index) || isDynamicAllowlisted(match.index)) continue
    report(match.index, match[1] + '[dynamic]（动态成员访问，需显式白名单）')
  }

  // globalThis['wx'].member / globalThis['wx']['member'] / globalThis['wx'][dynamic]
  const globalThisBracketPattern = 'globalThis\\s*\\[\\s*' + QUOTE_CLASS
  for (const match of code.matchAll(new RegExp(globalThisBracketPattern, 'g'))) {
    const quoteIndex = match.index + match[0].length - 1
    const handleName = readStringLiteralAt(commentsOnly, quoteIndex)
    if (handleName !== 'wx') continue
    let cursor = quoteIndex + 1
    while (cursor < commentsOnly.length) {
      if (commentsOnly[cursor] === '\\') {
        cursor += 2
        continue
      }
      if (commentsOnly[cursor] === commentsOnly[quoteIndex]) break
      cursor++
    }
    cursor++
    while (cursor < commentsOnly.length && /\s/.test(commentsOnly[cursor])) cursor++
    if (commentsOnly[cursor] !== ']') continue
    cursor++
    const tail = code.slice(cursor)
    const member = /^\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/.exec(tail)
    if (member) {
      if (!ALLOWED_WX_MEMBERS.has(member[1]) && !hasAllowComment(match.index)) {
        report(match.index, 'globalThis["wx"].' + member[1])
      }
      continue
    }
    const bracketLiteral = new RegExp('^\\s*(?:\\?\\.)?\\s*\\[\\s*' + QUOTE_CLASS).exec(tail)
    if (bracketLiteral) {
      const quoteOffset = cursor + bracketLiteral[0].length - 1
      const literal = readStringLiteralAt(commentsOnly, quoteOffset)
      if (literal === null) {
        if (!hasAllowComment(match.index) && !isDynamicAllowlisted(match.index)) {
          report(match.index, 'globalThis["wx"][dynamic]（动态成员访问，需显式白名单）')
        }
        continue
      }
      if (!ALLOWED_WX_MEMBERS.has(literal) && !hasAllowComment(match.index)) {
        report(match.index, 'globalThis["wx"]["' + literal + '"]')
      }
      continue
    }
    const bracketDynamic = /^\s*(?:\?\.)?\s*\[/.exec(tail)
    if (bracketDynamic && !hasAllowComment(match.index) && !isDynamicAllowlisted(match.index)) {
      report(match.index, 'globalThis["wx"][dynamic]（动态成员访问，需显式白名单）')
    }
  }

  return violations
}

const srcDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repoRoot, 'src')

/**
 * 源码文件集合：覆盖实际可能被编译/发布的 TS/JS 全家族（.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs），
 * 避免新增 .tsx/.mjs 源文件绕过  隐私门禁
 */
const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/
const walk = (dir) => {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (SOURCE_FILE_PATTERN.test(entry.name)) out.push(full)
  }
  return out
}

let files
try {
  files = walk(srcDir)
} catch (error) {
  console.error('[check-privacy-api] 无法读取源码目录 ' + srcDir + '：' + (error instanceof Error ? error.message : String(error)))
  console.error('用法：node scripts/check-privacy-api.mjs [srcDir]（默认 <repoRoot>/src）')
  process.exit(1)
}

const violations = []
for (const file of files) {
  const relative = path.relative(repoRoot, file).split(path.sep).join('/')
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch (error) {
    // 单文件读取失败必须显式失败：半棵树扫描后输出「通过」是不可接受的误绿
    console.error('[check-privacy-api] 无法读取源文件 ' + relative + '：' + (error instanceof Error ? error.message : String(error)))
    process.exit(1)
  }
  violations.push(...scanSource(relative, source))
}

if (violations.length > 0) {
  console.error('[check-privacy-api] 库源码使用了白名单外的 wx 接口 ' + violations.length + ' 处：')
  for (const violation of violations) {
    console.error('  ' + violation)
  }
  console.error('库不得调用需要用户授权的隐私接口；如确需新增，先安全评审并更新本脚本白名单与 SECURITY.md')
  process.exit(1)
}

console.log(
  '[check-privacy-api] 通过：' + files.length + ' 个文件无白名单外的 wx 接口使用（白名单：' + [...ALLOWED_WX_MEMBERS].join(', ') + '）',
)
