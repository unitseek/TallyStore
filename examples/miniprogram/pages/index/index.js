/**
 * 首页：withPageStore 演示
 *
 * - mapState 数组形态：data.count
 * - mapGetters 数组形态：data.doubled（getter 每次通知重算）
 * - mapActions 对象形态：本地方法 inc / dec → action increment / decrement
 *
 * 持久化恢复发生在 App 启动时（插件安装即 restore），因此 onLoad 里第一次读到的
 * this.data.count 就是恢复后的值；先记进 restoredCount 再触发 action。
 *
 * Skyline：宿主实例 this.renderer === 'skyline' 时，集成层默认 schedule: 'auto' 会把同一 tick
 * 的多次映射写入合并为一次 setData；本页无需显式 schedule（要逐次同步时传 schedule: 'sync'）。
 */

const { withPageStore } = require('@unitseek/tallystore')

const app = getApp()
const store = app && app.globalData && app.globalData.store
if (!store) {
  // 模块被提前求值（预加载/分包异步/App 抛错）时给出可定位的显式错误
  throw new Error('[demo] globalData.store 未初始化：请确认 app.js 已通过 withAppStore 注册 store')
}

// 自动 +1 只在本次进程首次进入时执行，避免页面重入把持久化 count 持续累加；
// 结果用 try/catch 包住——映射缺失或 action 抛错不应让 onLoad 直接中断
let autoIncrementDone = false

Page(
  withPageStore(store, {
    mapState: ['count'],
    mapGetters: ['doubled'],
    mapActions: { inc: 'increment', dec: 'decrement' },
  })({
    data: {
      restoredCount: null,
    },
    onLoad() {
      // 页面上展示「本次启动恢复出来的值」
      this.setData({ restoredCount: this.data.count })
      if (!autoIncrementDone) {
        autoIncrementDone = true
        try {
          // 在生命周期里调用映射后的 action：首次进入自动 +1
          this.inc?.()
        } catch (error) {
          console.error('[demo] 自动 increment 调用失败：', error)
        }
      }
    },
    //  演示：分包页面只取主包 globalData.store（不复制实例）；未迁移页面保留 globalData 写法
    goCart() {
      wx.navigateTo({ url: '/packageA/pages/cart/cart' })
    },
    goLegacy() {
      wx.navigateTo({ url: '/pages/legacy/legacy' })
    },
  }),
)
