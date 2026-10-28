/**  / AS-12 第 6 项：隐私接口白名单静态扫描——括号/解构/globalThis/别名/动态取用 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '../../..')
const script = path.join(repoRoot, 'scripts', 'check-privacy-api.mjs')

interface RunResult {
  status: number
  output: string
}

const run = (srcDir?: string): RunResult => {
  const args = srcDir === undefined ? [script] : [script, srcDir]
  try {
    const output = execFileSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8' })
    return { status: 0, output }
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failed.status ?? -1, output: (failed.stderr ?? '') + (failed.stdout ?? '') }
  }
}

/** 创建临时 src 目录；files 的键是 src/ 下的相对路径 */
function makeSrcDir(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'privacy-api-'))
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, 'src', relative)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return path.join(root, 'src')
}

function removeSrcDir(srcDir: string): void {
  rmSync(path.dirname(srcDir), { recursive: true, force: true })
}

describe(' 隐私接口白名单扫描', () => {
  it('仓库 src/ 全量扫描通过（零误报）', () => {
    const result = run()
    expect(result.status).toBe(0)
    expect(result.output).toContain('通过')
  })

  it('括号 / 解构 / globalThis / 别名 / 动态取用均可检出', () => {
    const srcDir = makeSrcDir({
      'bad.ts': [
        'const a = wx.getLocation()',
        "const b = wx['chooseImage']({})",
        'const { getUserProfile } = wx',
        'const c = globalThis.wx.openSetting()',
        "const c2 = globalThis['wx'].openSetting()",
        "const d = globalThis['wx']['getLocation']()",
        'const w = wx',
        'w.scanCode()',
        'const e = wx[apiName]()',
      ].join('\n'),
    })
    try {
      const result = run(srcDir)
      expect(result.status).toBe(1)
      expect(result.output).toContain('wx.getLocation')
      expect(result.output).toContain("wx['chooseImage']")
      expect(result.output).toContain('wx 解构 -> getUserProfile')
      expect(result.output).toContain('wx.openSetting')
      expect(result.output).toContain('globalThis["wx"].openSetting')
      expect(result.output).toContain('globalThis["wx"]["getLocation"]')
      expect(result.output).toContain('w.scanCode')
      expect(result.output).toContain('wx[dynamic]')
    } finally {
      removeSrcDir(srcDir)
    }
  })

  it('字符串字面量与注释中的 wx.* 不计入（模板字符串插值仍按代码扫描）', () => {
    const srcDir = makeSrcDir({
      'clean.ts': [
        "const message = 'wx.getLocation()'",
        '// wx.getLocation()',
        '/* globalThis.wx.chooseImage() */',
        "const allowed = wx.getStorageSync('key')",
        "const template = '说明：wx.getLocation 不可用'",
      ].join('\n'),
    })
    try {
      const result = run(srcDir)
      expect(result.status).toBe(0)
      expect(result.output).toContain('通过')
    } finally {
      removeSrcDir(srcDir)
    }

    // 模板字符串插值里的调用仍是代码
    const interpolationDir = makeSrcDir({ 'interpolated.ts': "const x = 'wx.' + 'x'\nconst y = 1\n" })
    try {
      const result = run(interpolationDir)
      expect(result.status).toBe(0)
    } finally {
      removeSrcDir(interpolationDir)
    }
  })

  it('动态 resolve 点必须带显式白名单注释', () => {
    const srcDir = makeSrcDir({
      'annotated.ts': ['const name = apiName()', '// privacy-api-allow: 测试夹具动态点，成员名受白名单约束', 'const value = wx[name]'].join('\n'),
    })
    try {
      const result = run(srcDir)
      expect(result.status).toBe(0)
      expect(result.output).toContain('通过')
    } finally {
      removeSrcDir(srcDir)
    }

    const missingAnnotationDir = makeSrcDir({ 'unannotated.ts': 'const value = wx[apiName()]\n' })
    try {
      expect(run(missingAnnotationDir).status).toBe(1)
    } finally {
      removeSrcDir(missingAnnotationDir)
    }
  })

  it('WxStorageBackend 的动态取用点由脚本内显式白名单放行，其它文件的同形态仍拦截', () => {
    const backendSource = [
      'export type WxStorageApi = { getStorageSync?: (key: string) => unknown }',
      'export function readWxStorageSyncApi(): WxStorageApi | undefined {',
      '  return (globalThis as { wx?: WxStorageApi }).wx',
      '}',
      'export class WxStorageBackend {',
      '  private get wxApi(): WxStorageApi | undefined {',
      '    return readWxStorageSyncApi()',
      '  }',
      '  resolve(name: keyof WxStorageApi) {',
      '    const api = this.wxApi',
      '    const fn = api?.[name]',
      '    return fn',
      '  }',
      '}',
      'const allowed = readWxStorageSyncApi()?.getStorageSync',
    ].join('\n')
    const onlyBackend = makeSrcDir({ 'plugins/WxStorageBackend.ts': backendSource })
    try {
      const result = run(onlyBackend)
      expect(result.status).toBe(0)
      expect(result.output).toContain('通过')
    } finally {
      removeSrcDir(onlyBackend)
    }

    // 同一份动态取用代码出现在其它文件：无白名单 → 必须拦截
    const withOther = makeSrcDir({ 'plugins/WxStorageBackend.ts': backendSource, 'other.ts': backendSource })
    try {
      const result = run(withOther)
      expect(result.status).toBe(1)
      expect(result.output).toContain('other.ts')
      expect(result.output).not.toContain('WxStorageBackend.ts')
    } finally {
      removeSrcDir(withOther)
    }
  })

  it('源码目录不存在：退出码 1 并给出用法', () => {
    const result = run(path.join(tmpdir(), 'privacy-api-missing-' + Date.now()))
    expect(result.status).toBe(1)
    expect(result.output).toContain('用法')
  })

  it('非 .ts 源文件（.tsx/.mjs 等）同样纳入扫描', () => {
    const srcDir = makeSrcDir({
      'components/picker.tsx': 'export const Picker = () => wx.chooseImage({ count: 1 })\n',
      'helper.mjs': "export const locate = () => wx.getLocation({ type: 'wgs84' })\n",
    })
    try {
      const result = run(srcDir)
      expect(result.status).toBe(1)
      expect(result.output).toContain('wx.chooseImage')
      expect(result.output).toContain('wx.getLocation')
      expect(result.output).toContain('picker.tsx')
      expect(result.output).toContain('helper.mjs')
    } finally {
      removeSrcDir(srcDir)
    }
  })

  it('正则字面量中的引号/斜杠不破坏 tokenization，其后的 wx 访问仍被扫描', () => {
    const srcDir = makeSrcDir({
      'regex.ts': ['const re = /[\'"]/', 'const u = /[//]/', 'const x = wx.getLocation()'].join('\n'),
    })
    try {
      const result = run(srcDir)
      expect(result.status).toBe(1)
      expect(result.output).toContain('wx.getLocation')
      expect(result.output).toContain('regex.ts:3')
    } finally {
      removeSrcDir(srcDir)
    }
  })

  it('带类型标注的解构与 as 断言别名同样被校验', () => {
    const typed = makeSrcDir({
      'typed.ts': ['type WxApi = { getLocation?: () => void }', 'declare const wx: WxApi', 'const { getLocation }: WxApi = wx'].join('\n'),
    })
    try {
      const result = run(typed)
      expect(result.status).toBe(1)
      expect(result.output).toContain('wx 解构 -> getLocation')
    } finally {
      removeSrcDir(typed)
    }

    const asserted = makeSrcDir({
      'asserted.ts': ['type WxApi = { chooseImage?: () => void }', 'declare const wx: WxApi', 'const api = wx as WxApi', 'api.chooseImage()'].join('\n'),
    })
    try {
      const result = run(asserted)
      expect(result.status).toBe(1)
      expect(result.output).toContain('api.chooseImage')
    } finally {
      removeSrcDir(asserted)
    }
  })

  it('返回 wx 的工具函数 / getter 的直接成员访问也要过白名单', () => {
    const srcDir = makeSrcDir({
      'direct.ts': [
        'function readWxStorageSyncApi() {',
        '  return (globalThis as { wx?: unknown }).wx',
        '}',
        'class Backend {',
        '  private get wxApi() {',
        '    return readWxStorageSyncApi()',
        '  }',
        '  run() {',
        '    return this.wxApi.getLocation()',
        '  }',
        '}',
        'const a = readWxStorageSyncApi()?.chooseImage()',
      ].join('\n'),
    })
    try {
      const result = run(srcDir)
      expect(result.status).toBe(1)
      expect(result.output).toContain('readWxStorageSyncApi().chooseImage')
      expect(result.output).toContain('this.wxApi.getLocation')
    } finally {
      removeSrcDir(srcDir)
    }
  })

  it('来源函数的识别窗口在下一个函数声明处截断，不会把紧邻函数误判为句柄来源', () => {
    const srcDir = makeSrcDir({
      'window.ts': [
        'function helper() { return 1 }',
        'function readWxStorageSyncApi() { return (globalThis as { wx?: unknown }).wx }',
        'const x = helper()',
        'const value = x.someRandomMember',
      ].join('\n'),
    })
    try {
      const result = run(srcDir)
      expect(result.status).toBe(0)
      expect(result.output).toContain('通过')
    } finally {
      removeSrcDir(srcDir)
    }
  })

  it('后缀自增后的除法与 JSX 闭合标签不再被误判为正则', () => {
    const division = makeSrcDir({
      'division.ts': ['const loaded = 1', 'const total = 2', 'const p = loaded++ / total + wx.getSystemInfoSync().width / 100'].join('\n'),
    })
    try {
      const result = run(division)
      expect(result.status).toBe(1)
      expect(result.output).toContain('wx.getSystemInfoSync')
    } finally {
      removeSrcDir(division)
    }

    const jsx = makeSrcDir({
      'component.tsx': 'export const C = () => <View>{wx.getLocation()}</View>\n',
    })
    try {
      const result = run(jsx)
      expect(result.status).toBe(1)
      expect(result.output).toContain('wx.getLocation')
    } finally {
      removeSrcDir(jsx)
    }
  })

  it('函数体内出现回调箭头不影响来源函数识别', () => {
    const srcDir = makeSrcDir({
      'callback.ts': [
        'function readWxApi(keys: string[]) {',
        '  const cleaned = keys.map((k) => k.trim())',
        '  return (globalThis as { wx?: unknown }).wx',
        '}',
        "const direct = readWxApi(['a'])?.chooseImage()",
      ].join('\n'),
    })
    try {
      const result = run(srcDir)
      expect(result.status).toBe(1)
      expect(result.output).toContain('readWxApi(')
      expect(result.output).toContain('.chooseImage')
    } finally {
      removeSrcDir(srcDir)
    }
  })

  it('带参数调用来源函数的直接访问同样过白名单', () => {
    const srcDir = makeSrcDir({
      'params.ts': [
        'function readWx(flag: number) {',
        '  return flag > 0 ? (globalThis as { wx?: unknown }).wx : undefined',
        '}',
        'const direct = readWx(1)?.getLocation()',
      ].join('\n'),
    })
    try {
      const result = run(srcDir)
      expect(result.status).toBe(1)
      expect(result.output).toContain('readWx(1).getLocation')
    } finally {
      removeSrcDir(srcDir)
    }
  })

  it('对象类型 / 交叉类型 / 括号包裹的 as 断言别名都被识别', () => {
    const srcDir = makeSrcDir({
      'asserts.ts': [
        'type WxApi = { getLocation?: () => void }',
        'type Extra = { extra?: number }',
        'declare const wx: unknown',
        'const a = wx as { getLocation?: () => void }',
        'a.getLocation()',
        'const b = wx as WxApi & Extra',
        'b.getLocation()',
        'const c = (wx as WxApi)',
        'c.getLocation()',
      ].join('\n'),
    })
    try {
      const result = run(srcDir)
      expect(result.status).toBe(1)
      expect(result.output).toContain('a.getLocation')
      expect(result.output).toContain('b.getLocation')
      expect(result.output).toContain('c.getLocation')
    } finally {
      removeSrcDir(srcDir)
    }
  })
})
