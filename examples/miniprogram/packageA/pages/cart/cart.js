/**
 * 分包页面：packageA/pages/cart/cart（ 验收 1）
 *
 * 依赖方向是「分包 → 主包」（允许）：
 * - Store **实例**来源：getApp().globalData.store —— app.js 用 withAppStore 注册的主包 Store，
 *   本页不创建、不复制实例；
 * - Store **API** 来源：require('@unitseek/tallystore')，微信「构建 npm」后解析到主包根目录
 *   的 miniprogram_npm（与主包页面共享同一份发布产物字节）。
 */
const { withPageStore } = require('@unitseek/tallystore')

const app = getApp()
const store = app && app.globalData && app.globalData.store
if (!store) {
  throw new Error('[demo] 分包页面未取到主包 globalData.store：请确认 app.js 已通过 withAppStore 注册')
}

Page(
  withPageStore(store, {
    mapState: ['count'],
    mapGetters: ['doubled'],
    mapActions: { addOne: 'increment', removeOne: 'decrement' },
  })({
    data: {
      source: 'packageA/pages/cart/cart（分包）',
    },
    onLoad() {
      console.log('[demo] 分包页面 onLoad：复用主包 store，count =', this.data.count)
    },
  }),
)
