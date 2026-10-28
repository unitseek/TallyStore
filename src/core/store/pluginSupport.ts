/** Store 插件生命周期支持 */

import type { Plugin as PluginType } from '../../types/plugin.js'
import type { State } from '../../types/store.js'

/**
 * 创建插件卸载句柄。
 *
 * 代际校验：旧安装的句柄不得动到之后的重新安装。令牌必须非空且与映射一致，
 * 否则 undefined === undefined 会让句柄退化成「无校验卸载」。
 */
export function createPluginUninstaller<S extends State>(
  plugin: PluginType<S>,
  plugins: PluginType<S>[],
  uninstallFns: Map<PluginType<S>, (() => void) | undefined>,
  installations: Map<PluginType<S>, object>,
  installation: object | undefined,
): () => void {
  let consumed = false
  return () => {
    if (consumed) {
      return
    }
    consumed = true
    const current = installations.get(plugin)
    if (installation === undefined || current !== installation) {
      return
    }

    const index = plugins.indexOf(plugin)
    if (index !== -1) {
      plugins.splice(index, 1)
    }

    const uninstallFn = uninstallFns.get(plugin)
    // 先消费映射再执行清理：清理函数抛错时映射不会被二次读取
    uninstallFns.delete(plugin)
    installations.delete(plugin)
    // 清理函数异常按原样抛出：静默失败会把「清理没跑完」变成不可见的资源泄漏。
    // destroy() 自行兜底并 console.error；use() 返回的裸句柄由调用方负责
    if (typeof uninstallFn === 'function') {
      uninstallFn()
    }
  }
}
