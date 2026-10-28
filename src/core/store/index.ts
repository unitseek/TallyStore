/** Store 模块导出（库内 barrel，不是包出口） */

export { Store } from './Store.js'
export { createStore } from './factory.js'

export { StateProxyManager } from './StateProxy.js'
export { StoreNotifier } from './StoreNotifier.js'
export { ActionManager, GetterManager } from './ActionManager.js'
export { BatchManager } from './BatchManager.js'

export type { StoreNotifierOptions, SubscriberEvictionInfo } from './StoreNotifier.js'
export type { ActionManagerOptions } from './ActionManager.js'
