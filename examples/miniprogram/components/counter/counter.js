/**
 * counter 组件：withComponentStore 演示
 *
 * - mapState 对象形态：data.localCount ← store.count
 * - mapGetters 对象形态：data.localDoubled ← getter doubled
 * - mapActions 数组形态：methods.decrement ← action decrement（方法名不变）
 * - 生命周期必须写在 lifetimes 内（基础库 ≥ 3.15.0）；detached 时集成自动退订
 * - Skyline 宿主下默认 schedule: 'auto' 会合并同一 tick 的 setData，无需显式配置
 */

const { withComponentStore } = require('@unitseek/tallystore')

const app = getApp()
const store = app && app.globalData && app.globalData.store
if (!store) {
  // 模块被提前求值（预加载/分包异步/App 抛错）时给出可定位的显式错误，
  // 而不是在模块顶层抛 TypeError: Cannot read properties of undefined
  throw new Error('[demo] globalData.store 未初始化：请确认 app.js 已通过 withAppStore 注册 store')
}

Component(
  withComponentStore(store, {
    mapState: { localCount: 'count' },
    mapGetters: { localDoubled: 'doubled' },
    mapActions: ['decrement'],
  })({
    data: {
      tip: '组件与页面共享同一份 store',
    },
    lifetimes: {
      attached() {
        console.log('[demo] counter attached, localCount =', this.data.localCount)
      },
      detached() {
        console.log('[demo] counter detached（集成在这之后自动退订）')
      },
    },
    methods: {
      // 与映射进来的 decrement 共存的自定义方法
      resetTip() {
        this.setData({ tip: '自定义方法与映射 action 互不影响' })
      },
    },
  }),
)
