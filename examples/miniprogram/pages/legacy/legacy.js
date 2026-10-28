/**
 * 未迁移页面：pages/legacy/legacy（ 验收 3）
 *
 * 保留分包改造前的写法——直接读写 getApp().globalData，不经过 Store 集成层。
 * 用途：验证主包新增 subPackages 配置后，未迁移页面的 globalData 路径与行为不变，
 * 并且其写入与 Store 状态互不影响（新旧逻辑可长期共存）。
 */
const app = getApp()
if (!app || !app.globalData) {
  throw new Error('[demo] 未迁移页面未取到 App globalData')
}

Page({
  data: {
    legacyCount: 0,
    note: '未迁移页面：直接读写 globalData',
  },
  onLoad() {
    // 与接入 Store 之前完全一致：首次进入时初始化 globalData 字段
    if (typeof app.globalData.legacyCount !== 'number') {
      app.globalData.legacyCount = 0
    }
    this.setData({ legacyCount: app.globalData.legacyCount })
  },
  incLegacy() {
    app.globalData.legacyCount = (app.globalData.legacyCount || 0) + 1
    this.setData({ legacyCount: app.globalData.legacyCount })
  },
})
