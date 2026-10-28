/** 仓库配置卫生（low backlog 批）：prettier 忽略锚定、gitattributes 二进制规则、CI 门禁参数、jest/pnpm 配置 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '../../..')
const read = (relative: string): string => readFileSync(path.join(root, relative), 'utf8')

describe('仓库配置卫生（low backlog 批）', () => {
  it('.prettierignore：构建产物锚定到仓库根，源码 types 目录显式列出', () => {
    const lines = read('.prettierignore')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
    expect(lines).toEqual(
      expect.arrayContaining(['/dist-weapp', '/types', '/coverage', 'src/types', 'examples/**/miniprogram_npm', 'examples/**/project.private.config.json']),
    )
    // 未锚定的旧模式会把任意层级同名目录静默排除在格式门禁之外
    expect(lines).not.toContain('dist-weapp')
    expect(lines).not.toContain('coverage')
  })

  it('.gitattributes：二进制扩展与 Windows 脚本有显式规则', () => {
    const content = read('.gitattributes')
    expect(content).toMatch(/^\*\.png\s+binary$/m)
    expect(content).toMatch(/^\*\.zip\s+binary$/m)
    expect(content).toMatch(/^\*\.bat\s+text eol=crlf$/m)
    expect(content).toMatch(/^\*\.ps1\s+text eol=crlf$/m)
  })

  it('CI：仅 PR 取消旧运行；push 按 SHA 分组；SBOM 缺失必须让 job 失败', () => {
    const ci = read('.github/workflows/ci.yml')
    const lines = ci.split(/\r?\n/)
    const cancelLine = lines.find((line) => line.trim().startsWith('cancel-in-progress:')) ?? ''
    expect(cancelLine).toContain('github.event_name')
    expect(cancelLine).toContain('pull_request')
    const groupLine = lines.find((line) => line.trim().startsWith('group:')) ?? ''
    // 仅关 cancel-in-progress 不够：同组 pending 运行也会互相取消，push 必须按 SHA 分组
    expect(groupLine).toContain('github.sha')
    expect(groupLine).toContain('pull_request')
    expect(ci).toContain('if-no-files-found: error')
  })

  it('jest：移除无效 preset、isolatedModules 对齐 tsconfig、去掉重复排除项', () => {
    const jestConfig = read('jest.config.js')
    expect(jestConfig).not.toMatch(/^\s*preset:/m)
    expect(jestConfig).toContain('isolatedModules: true')
    expect(jestConfig).not.toContain("'!src/index.ts'")
  })

  it('pnpm-workspace：显式声明无子包', () => {
    expect(read('pnpm-workspace.yaml')).toMatch(/^packages: \[\]$/m)
  })
})
