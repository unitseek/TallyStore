/** 主入口：Store、小程序集成、插件契约与错误类型（原生微信小程序） */

export { Store } from './store/Store.js'
export { createStore } from './store/factory.js'
export { defineStores } from './store/registry.js'
export type { StoreModuleDeclaration, StoreModuleRegistry, TypedModuleRegistry, StoreModuleDeclarations, InferStoreMap } from './store/registry.js'

export { TallyStoreError, isTallyStoreError } from './errors/TallyStoreError.js'
export type { ErrorCode } from './errors/TallyStoreError.js'

export { HookSystem } from './hooks/index.js'
export type { Plugin, PluginHook, HookName, HookHandler, IHookSystem } from './hooks/index.js'

export { withPageStore, withComponentStore } from '../integrations/with-store.js'
export { withAppStore } from '../integrations/with-app-store.js'
export { unbindStore } from '../integrations/connect.js'
export {
  isSensitiveKey,
  addSensitiveKeyPatterns,
  resetSensitiveKeyPatterns,
  maskSensitiveValue,
  maskForLog,
  DEFAULT_SENSITIVE_KEY_PATTERNS,
} from './security/sensitiveKeys.js'
export { createRaceGuard } from './async/raceGuard.js'
export type { RaceGuard } from './async/raceGuard.js'
export type { AppOptions } from '../integrations/with-app-store.js'
export type {
  ConnectOptions,
  PageConfig,
  ComponentConfig,
  PageThis,
  ComponentThis,
  AppThis,
  ExtractPageData,
  WithPageThis,
  PageOwnMethods,
  ComponentOwnMethods,
  PageReservedKeys,
} from '../types/plugin.js'

export type {
  StoreOptions,
  State,
  Actions,
  Getters,
  StateListener,
  InferActionArgs,
  InferActionReturn,
  InferGetterReturn,
  ActionNames,
  StateProtectionOptions,
  SubscriptionOptions,
  NotifyOptions,
} from '../types/store.js'
