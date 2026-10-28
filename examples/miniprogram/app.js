/**
 * TallyStore 原生小程序 demo —— App 入口
 *
 * 演示四件事：
 * 1. createStore 创建全局 store（count + actions + getters）
 * 2. persistencePlugin + WxStorageBackend：显式同步存储 + 100ms 写入防抖
 * 3. loggerPlugin：开发期打印状态变更与 action（生产模式自动静默）
 * 4. withAppStore：mapState / mapGetters 映射进 globalData，mapActions 绑定成 App 实例方法
 *
 * store 实例放在 globalData.store，供页面 / 组件模块直接取用，避免各建一份实例。
 */

const { createStore, withAppStore } = require('@unitseek/tallystore')
const { loggerPlugin, persistencePlugin, WxStorageBackend } = require('@unitseek/tallystore/plugins')

const store = createStore({
  name: 'demo-counter',
  state: () => ({ count: 0 }),
  actions: {
    increment() {
      this.setState('count', this.getState().count + 1)
    },
    decrement() {
      this.setState('count', this.getState().count - 1)
    },
  },
  getters: {
    doubled: (state) => state.count * 2,
  },
})

// 持久化失败（恢复 JSON 损坏 / 写盘失败 / 配额超限）只经 hooks.onError 上报：
// logger 不订阅 onError，不接这个钩子 demo 会静默丢数据
store.hooks.on('onError', (error) => {
  console.error('[demo] store error:', error)
})

// 持久化：显式传 WxStorageBackend，并把写入防抖到 100ms（小程序同步写是阻塞 I/O）
// 配置抽成常量，供 onShow 重装时复用（重装必须改 restore，见 onShow 注释）
const persistenceOptions = {
  key: 'tallystore_demo_count',
  storage: new WxStorageBackend(),
  debounce: 100,
  filter: (state) => ({ count: state.count }),
}
const persistence = persistencePlugin(persistenceOptions)
// 卸载句柄用于 onHide 时 flush 防抖窗口内的最后一次写入：
// 小程序进后台可能在 100ms 内被杀/冻结，只靠卸载补写会丢最后一次 increment
let uninstallPersistence = store.use(persistence)

// 日志：开发期打印状态与 action；生产模式自动静默
store.use(loggerPlugin())

App(
  withAppStore(store, {
    // 数组形态：globalData.count
    mapState: ['count'],
    // 对象形态：globalData.doubledText ← getter doubled
    mapGetters: { doubledText: 'doubled' },
    // 对象形态：App 实例方法 inc / dec → action increment / decrement
    mapActions: { inc: 'increment', dec: 'decrement' },
  })({
    globalData: {
      // 供页面 / 组件模块取用；集成只往 globalData 写映射键，不会覆盖这个字段
      store,
    },
    onLaunch() {
      console.log('[demo] App launched. globalData.count =', this.globalData.count, '; typeof this.inc =', typeof this.inc)
    },
    onHide() {
      // 卸载插件会清定时器并同步补写 pendingState（含末次状态），相当于一次强制 flush
      if (uninstallPersistence) {
        uninstallPersistence()
        uninstallPersistence = undefined
      }
    },
    onShow() {
      // 回前台重新安装持久化；同一插件实例重复安装前必须先卸载（Store.use 对同实例幂等）
      if (!uninstallPersistence) {
        // 重装必须关掉 restore——插件的安装期恢复会用「onHide 时落盘的值」$patch
        // 覆盖内存状态；后台期间插件已卸载、写入不再持久化，期间的变更会在回前台时被静默回滚。
        // 恢复只在首次安装（onLaunch 前）做一次，回前台只恢复「变更→落盘」链路。
        uninstallPersistence = store.use(persistencePlugin({ ...persistenceOptions, restore: false }))
      }
    },
  }),
)
