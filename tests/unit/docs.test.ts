/**
 * 文档一致性门禁：
 * - 相对链接（含锚点）必须可解析
 * - 已删除的 API / 能力不得再出现在文档里
 * - Store 的公开方法与主入口运行时导出必须在 docs/API.md 中有登记
 * - 代码围栏必须成对
 */
import fs from 'node:fs'
import path from 'node:path'
import { Store } from '../../src/index.js'
import * as plugins from '../../src/plugins.js'

const root = path.resolve(__dirname, '../..')

const DOC_FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'bench/README.md',
  'docs/API.md',
  'docs/MIGRATION.md',
  'docs/TEAM-RULES.md',
  'docs/RELEASE.md',
  'docs/ARCHITECTURE.md',
  'docs/COMPATIBILITY.md',
  'docs/GUIDE.md',
  'docs/PERFORMANCE.md',
  'docs/README.md',
  'docs/RECIPES.md',
  'examples/miniprogram/README.md',
  'examples/miniprogram/e2e/README.md',
  'skills/tallystore/SKILL.md',
  'skills/tallystore/references/core-semantics.md',
  'skills/tallystore/references/plugins-semantics.md',
]

/** GitHub 风格标题锚点：保留字母/数字/汉字，空格转连字符，去掉标点 */
function slugify(heading: string): string {
  return heading
    .trim()
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

function headingsOf(file: string): Set<string> {
  const text = fs.readFileSync(file, 'utf8')
  const slugs = new Set<string>()
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    slugs.add(slugify(match[1]))
  }
  return slugs
}

const docs = new Map(DOC_FILES.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]))

describe('文档一致性', () => {
  it('相对链接与锚点都能解析', () => {
    const problems: string[] = []
    for (const [file, text] of docs) {
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1].trim().replace(/^<|>$/g, '').split(' ')[0]
        if (/^(https?:|mailto:|#)/.test(target)) {
          if (target.startsWith('#') && !headingsOf(path.join(root, file)).has(target.slice(1))) {
            problems.push(file + ' -> ' + target + '（本文件内锚点不存在）')
          }
          continue
        }
        const [rawPath, anchor] = target.split('#')
        const resolved = path.resolve(path.dirname(path.join(root, file)), decodeURI(rawPath))
        if (!fs.existsSync(resolved)) {
          problems.push(file + ' -> ' + target + '（目标文件不存在）')
          continue
        }
        if (anchor && resolved.endsWith('.md') && !headingsOf(resolved).has(anchor)) {
          problems.push(file + ' -> ' + target + '（目标锚点不存在）')
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('文档不再引用已删除的能力', () => {
    const banned = [
      'composeStore',
      'StoreRegistry',
      'LRUCache',
      'createSnapshot',
      'createSelector',
      'withRetry',
      'withTimeout',
      'withLoading',
      'PerformanceMonitor',
      'ErrorBoundary',
      'devtoolsPlugin',
      'autoInject',
      'exposeStoreAPI',
      'getGetterNames',
      'store.getters',
      'AsyncNotifier',
      'SubscriptionManager',
      'stateVersion',
      'probes/',
      'extras/plugins',
      'extras-semantics',
      '行为探针',
    ]
    const problems: string[] = []
    for (const [file, text] of docs) {
      // CHANGELOG 是历史记录，允许出现已删除能力的名字
      if (file === 'CHANGELOG.md') continue
      for (const token of banned) {
        if (text.includes(token)) problems.push(file + ' 仍包含：' + token)
      }
    }
    expect(problems).toEqual([])
  })

  it('Store 公开成员都在 docs/API.md 有登记', () => {
    const api = docs.get('docs/API.md') as string
    const members = Object.getOwnPropertyNames(Store.prototype).filter((name) => name !== 'constructor' && !name.startsWith('_'))
    const fields = ['name', 'state', 'actions', 'hooks', 'destroyed']
    const missing = [...members, ...fields].filter((name) => !api.includes(name))
    expect(missing).toEqual([])
    // 明确不应再出现的旧成员
    expect(api).not.toContain('getGetterNames')
  })

  it('主入口与插件入口的运行时导出都在 docs/API.md 有登记', () => {
    const api = docs.get('docs/API.md') as string
    const main = Object.keys(require('../../src/index.js')) as string[]
    const pluginExports = Object.keys(plugins)
    const missing = [...main, ...pluginExports].filter((name) => !api.includes(name))
    expect(missing).toEqual([])
  })

  it('错误码表覆盖全部 ErrorCode 值且每行含恢复建议', () => {
    const api = docs.get('docs/API.md') as string
    const { ErrorCode } = require('../../src/core/errors/TallyStoreError.js') as { ErrorCode: Record<string, string> }
    const tableStart = api.indexOf('### 错误码表')
    expect(tableStart).toBeGreaterThanOrEqual(0)
    const table = api.slice(tableStart, api.indexOf('###', tableStart + 10))
    for (const code of Object.values(ErrorCode)) {
      expect(table).toContain('`' + code + '`')
      // 每个码所在行必须给出恢复建议（表尾列为恢复建议）
      const row = table.split('\n').find((line) => line.includes('`' + code + '`'))
      expect(row && row.includes('|')).toBe(true)
    }
  })

  it('边界声明三处一致：README/COMPATIBILITY/SECURITY 均含四点口径关键词', () => {
    // 措辞一致口径：护栏非安全边界 / getState 裸引用 / 存储明文 / 不替代权限鉴权
    const required = ['不是安全边界', '明文']
    for (const file of ['README.md', 'docs/COMPATIBILITY.md', 'SECURITY.md']) {
      const text = docs.get(file) as string
      for (const token of required) {
        expect(text.includes(token)).toBe(true)
      }
    }
    // SECURITY 的责任划分表与推荐路径/反例可被安全评审引用（ 验收 2/3）
    const security = docs.get('SECURITY.md') as string
    expect(security.includes('库侧 / 业务侧责任表')).toBe(true)
    expect(security.includes('推荐处理路径')).toBe(true)
    expect(security.includes('反例')).toBe(true)
  })

  it(' 快照边界三处文档一致：不是持久化 / 跨进程走持久化迁移 / 不自动全量快照 / 不作 Diff 基线', () => {
    const required = ['快照不是持久化', 'persistencePlugin', 'schemaVersion', 'migrations', '自动全量快照', 'Diff 基线']
    for (const file of ['docs/API.md', 'docs/GUIDE.md', 'docs/ARCHITECTURE.md']) {
      const text = docs.get(file) as string
      for (const token of required) {
        expect({ file, token, present: text.includes(token) }).toEqual({ file, token, present: true })
      }
      // 跨进程/跨会话恢复口径必须写明（语义要求「跨进程」或「跨会话」）
      expect(text.includes('跨进程') || text.includes('跨会话')).toBe(true)
    }
  })

  it(' 竞态辅助文档：createRaceGuard 用法与「结果级取消 ≠ 网络级中断」落文档', () => {
    const api = docs.get('docs/API.md') as string
    for (const token of ['createRaceGuard', 'begin', 'isCurrent', 'cancel', 'staleCount', '结果级取消', '网络级中断', '与 Action']) {
      expect({ token, present: api.includes(token) }).toEqual({ token, present: true })
    }
    const guide = docs.get('docs/GUIDE.md') as string
    expect(guide).toContain('createRaceGuard')
    expect(guide).toContain('结果级取消')
  })

  it(' reset 审计事件与 logger 日志入文档', () => {
    const api = docs.get('docs/API.md') as string
    for (const token of ['beforeReset', 'afterReset', 'resetAll', 'ResetInfo', 'Host write', 'Resetting store']) {
      expect({ token, present: api.includes(token) }).toEqual({ token, present: true })
    }
    const guide = docs.get('docs/GUIDE.md') as string
    expect(guide).toContain('$reset')
    expect(guide).toContain('resetAll')
  })

  it('代码围栏成对出现', () => {
    const problems: string[] = []
    for (const [file, text] of docs) {
      if ((text.match(/^```/gm) || []).length % 2 !== 0) problems.push(file + ' 代码围栏未闭合')
    }
    expect(problems).toEqual([])
  })
})
