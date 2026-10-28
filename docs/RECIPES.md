# 配方

可直接复制的片段，均只使用当前公开 API。插件一律从 `@unitseek/tallystore/plugins` 引入。

## 本文内容

- [1. 多 Store 拆分](#1-多-store-拆分)
- [2. 长列表分页 + 单页面订阅](#2-长列表分页-单页面订阅)
- [3. 把 miniprogram_npm 放进分包](#3-把-miniprogramnpm-放进分包)
- [4. 持久化数据版本迁移](#4-持久化数据版本迁移)
- [5. Map/Set → setData 派生](#5-mapset-setdata-派生)
- [6. 错误上报接 onError](#6-错误上报接-onerror)
- [7. 在 jest 中测页面映射](#7-在-jest-中测页面映射)
- [8. 在 Skyline 页面接入](#8-在-skyline-页面接入)
- [相关文档](#相关文档)

## 1. 多 Store 拆分

按业务域各建一个 Store，页面只绑定自己域内的那个；跨域**读**用对方 `getState()`，跨域**写**调用
对方 action，不要直接改对方状态。

```ts
// stores/user.ts
import { createStore } from '@unitseek/tallystore'

export const userStore = createStore({
  name: 'user',
  state: () => ({ id: '', name: '' }),
  actions: {
    login(id: string, name: string) {
      this.$patch({ id, name })
    },
  },
})

// stores/cart.ts
import { userStore } from './user'

export const cartStore = createStore({
  name: 'cart',
  state: () => ({ items: [] as Array<{ sku: string; qty: number }> }),
  actions: {
    add(sku: string) {
      this.$patch({ items: [...this.getState().items, { sku, qty: 1 }] })
    },
    checkout() {
      const user = userStore.getState()
      if (!user.id) throw new Error('请先登录')
      return { items: this.getState().items, userId: user.id }
    },
  },
})

// pages/cart/index.ts
import { withPageStore } from '@unitseek/tallystore'
import { cartStore } from '../../stores/cart'

Page(
  withPageStore(cartStore, {
    mapState: ['items'],
    mapActions: ['add', 'checkout'],
  })({
    data: {},
    onCheckoutTap() {
      this.checkout()
    },
  }),
)
```

**要点**：一个域一个 Store；页面级绑定只绑定主域，其它域通过 import 读取或在 action 内组合；App 级
共享状态用 `withAppStore` 绑到 `globalData`。

## 2. 长列表分页 + 单页面订阅

列表状态放在 Store，页面只保留**一条**订阅；分页、加载态、是否还有更多都由 action 维护，列表项组件
保持无状态。

```ts
import { createStore } from '@unitseek/tallystore'

interface Row {
  id: string
  title: string
}

const feedStore = createStore({
  name: 'feed',
  state: () => ({
    rows: [] as Row[],
    page: 0,
    loading: false,
    hasMore: true,
  }),
  actions: {
    async loadMore() {
      const { loading, hasMore, page, rows } = this.getState()
      if (loading || !hasMore) return
      this.setState('loading', true)
      try {
        const next = await api.list(page + 1)
        this.$patch({
          rows: [...rows, ...next.rows],
          page: page + 1,
          hasMore: next.hasMore,
        })
      } finally {
        this.setState('loading', false)
      }
    },
  },
})

Page(
  withPageStore(feedStore, {
    mapState: ['rows', 'loading', 'hasMore'],
    mapActions: ['loadMore'],
  })({
    data: {},
    onReachBottom() {
      this.loadMore()
    },
  }),
)
```

**要点**：整页一条订阅，避免每个列表项组件各订阅一次（会快速耗尽 `maxSubscribers`）；一次 `$patch`
合并本轮新数据；列表项只接收普通数据；`api.list` 换成你的请求层。

## 3. 把 miniprogram_npm 放进分包

在 `project.config.json` 打开手动构建 npm，并用 `packNpmRelationList` 指定输出到分包目录：

```json
{
  "setting": {
    "packNpmManually": true,
    "packNpmRelationList": [
      {
        "packageJsonPath": "./package.json",
        "miniprogramNpmDistDir": "./packageA"
      }
    ]
  }
}
```

**要点**：配置后在开发者工具里重新执行「构建 npm」，确认 `miniprogram_npm` 落在目标分包；这只改变
**包额度**，不改变字节总量（整目录拷贝的字节照付）。库自身的体积模型见 [README](../README.md)。

## 4. 持久化数据版本迁移

在状态里放 `schemaVersion`，用 `filter` 控制落盘字段、`validate` 挡住未知版本；恢复后用 action 做
迁移。恢复发生在 `use()` 安装时，所以迁移要排在安装之后。

```ts
import { createStore } from '@unitseek/tallystore'
import { persistencePlugin } from '@unitseek/tallystore/plugins'

const CURRENT_VERSION = 2

interface AppState {
  schemaVersion: number
  profile: { name: string }
  settings: { theme: 'light' | 'dark' }
}

const appStore = createStore({
  name: 'app',
  state: (): AppState => ({
    schemaVersion: CURRENT_VERSION,
    profile: { name: '' },
    settings: { theme: 'light' },
  }),
  actions: {
    migrate() {
      const state = this.getState()
      if (state.schemaVersion >= CURRENT_VERSION) return
      if (state.schemaVersion === 1) {
        // v1 → v2：新增 settings.theme，其余字段保持不变
        this.setState('settings', { theme: 'light' })
      }
      this.setState('schemaVersion', CURRENT_VERSION)
    },
  },
})

appStore.use(
  persistencePlugin<AppState>({
    key: 'app-state',
    debounce: 200,
    // 只持久化需要跨启动保留的字段
    filter: (state) => ({ schemaVersion: state.schemaVersion, profile: state.profile }),
    // 只接受可识别的版本；返回 false 时跳过恢复、保留默认状态
    validate: (raw): raw is AppState => {
      if (typeof raw !== 'object' || raw === null) return false
      const version = (raw as { schemaVersion?: unknown }).schemaVersion
      return typeof version === 'number' && version >= 1 && version <= CURRENT_VERSION
    },
  }),
)

// app.onLaunch 中调用；此时恢复已经完成
appStore.dispatch('migrate')
```

**要点**：`filter` 只落盘必要字段；`validate` 收到的是 `filter` 落盘后的子集，按子集字段判断即可；
迁移逻辑放在 action 里可测试；未来加字段时保留旧字段默认值，迁移只做增量补齐。

## 5. Map/Set → setData 派生

Map / Set 不是可序列化数据，且 `store.state.map` 是保护代理。在 action 里派生普通数组，把普通字段
映射给页面。

```ts
import { createStore } from '@unitseek/tallystore'

const tagStore = createStore({
  name: 'tags',
  state: () => ({
    tags: new Map<string, string>(),
    tagNames: [] as string[],
  }),
  actions: {
    addTag(id: string, name: string) {
      this.state.tags.set(id, name) // action 内可直接写；Map 变异受追踪
      this.setState('tagNames', Array.from(this.getState().tags.values()))
    },
    removeTag(id: string) {
      this.state.tags.delete(id)
      this.setState('tagNames', Array.from(this.getState().tags.values()))
    },
  },
})

Page(
  withPageStore(tagStore, {
    mapState: ['tagNames'],
    mapActions: ['addTag', 'removeTag'],
  })({ data: {} }),
)
```

**要点**：传给 `setData` 的永远是普通数组/对象；需要键值对时派生 `[{ id, name }]`；不要在映射字段
里放 Map / Set。

## 6. 错误上报接 onError

用一个插件把 `onError` 接到自定义上报；`source` 一起带上，便于区分订阅驱逐、持久化失败等环节。

```ts
import { createStore, isTallyStoreError } from '@unitseek/tallystore'
import type { Plugin } from '@unitseek/tallystore'

function report(error: unknown, source?: string) {
  const code = isTallyStoreError(error) ? error.code : 'UNKNOWN'
  // 换成你自己的上报通道：wx.reportError / 第三方监控 / 日志平台
  console.error('[tallystore]', source, code, error)
}

const errorReporter: Plugin = {
  name: 'error-reporter',
  install(store) {
    return store.hooks.on('onError', (error, source) => report(error, source))
  },
}

const store = createStore({
  name: 'app',
  state: () => ({ ready: false }),
})

const uninstall = store.use(errorReporter)
```

**要点**：`onError` 覆盖监听器异常、订阅驱逐（`source` 为 `'subscribe'`）与持久化失败
（`source` 为 `'persistence'`）等通道；生产环境控制台静默，不接这条通道就会丢现场。

## 7. 在 jest 中测页面映射

仓库自身用 jest + ts-jest 跑 `tests/unit/**`；测试从 `src` 导入（相对路径按目录深度调整）。用一个带
`data` / `setData` 的假页面实例调用集成后的生命周期即可。

```ts
// tests/unit/integrations/page-mapping.test.ts
import { createStore, withPageStore } from '../../../src/index.js'

interface PageHost {
  data: Record<string, unknown>
  setData(patch: Record<string, unknown>): void
}

function createPageHost(): PageHost {
  const host: PageHost = {
    data: {},
    setData(patch) {
      Object.assign(host.data, patch)
    },
  }
  return host
}

const store = createStore({
  name: 'page-mapping-test',
  state: () => ({ count: 0 }),
  actions: {
    add(n = 1) {
      this.setState('count', this.getState().count + n)
    },
  },
})

const pageConfig = withPageStore(store, {
  mapState: ['count'],
  mapActions: ['add'],
})({
  data: {},
  onLoad() {
    this.add(1)
  },
})

// 集成层在运行时注入 onUnload；配置字面量类型里只有你写过的生命周期
const lifecycle = pageConfig as unknown as {
  onLoad: (this: PageHost) => void
  onUnload: (this: PageHost) => void
}

it('映射 state 与 action，并在 onUnload 后退订', () => {
  const page = createPageHost()
  lifecycle.onLoad.call(page)
  expect(page.data.count).toBe(1) // onLoad 里的 add(1) 经由 mapActions 调用

  store.setState('count', 42)
  expect(page.data.count).toBe(42) // 脏键命中，同步 setData

  lifecycle.onUnload.call(page)
  store.setState('count', 43)
  expect(page.data.count).toBe(42) // 已退订，不再 setData
  store.destroy()
})
```

**要点**：假实例只需提供 `data` 与 `setData`；用 `call(page)` 把 `this` 指过去；断言 `data` 而不是
内部实现；`onUnload` 后再写一次状态验证退订。

## 8. 在 Skyline 页面接入

Skyline 需要按官方要求开启渲染器与 glass-easel，并用 `scroll-view` 承载滚动；集成层在 Skyline 实例上
默认把同一 tick 的多次映射写入合并为一次 `setData`，页面代码通常不需要额外配置。

`app.json`（三项必需配置 + `rendererOptions`）：

```json
{
  "renderer": "skyline",
  "componentFramework": "glass-easel",
  "lazyCodeLoading": "requiredComponents",
  "rendererOptions": {
    "skyline": {
      "defaultDisplayBlock": true,
      "defaultContentBox": true,
      "tagNameStyleIsolation": "legacy",
      "enableScrollViewAutoSize": true,
      "disableABTest": true
    }
  }
}
```

页面 `json`：Skyline 不支持原生导航栏，页面滚动交给 `scroll-view`：

```json
{
  "navigationStyle": "custom",
  "disableScroll": true,
  "usingComponents": {}
}
```

页面 `wxml`：`scroll-view` 局部滚动，纯文本放进 `<text>`：

```xml
<scroll-view scroll-y class="page">
  <text class="title">{{title}}</text>
  <text class="count">{{count}}</text>
  <view class="btn" bindtap="increment">+1</view>
</scroll-view>
```

页面 JS：默认 `schedule: 'auto'`，Skyline 下自动合并，无需显式传；初始映射在 `onLoad` 前同步交付。

```ts
import { createStore, withPageStore } from '@unitseek/tallystore'

const counter = createStore({
  name: 'counter',
  state: () => ({ title: 'TallyStore × Skyline', count: 0 }),
  actions: {
    increment() {
      this.setState('count', this.getState().count + 1)
    },
  },
})

Page(
  withPageStore(counter, {
    mapState: ['title', 'count'],
    mapActions: ['increment'],
  })({
    data: {},
    onLoad() {
      // 初始映射已同步交付，这里立即读得到
      console.log(this.data.count)
    },
  }),
)
```

调度策略（`ConnectOptions.schedule?: 'auto' | 'sync' | 'microtask'`）：

- `'auto'`（默认）：页面/组件实例 `renderer === 'skyline'` 时，把同一 tick 的多次映射写入合并为一次
  `setData`；其余宿主逐次同步写入。
- `'sync'`：始终逐次同步——需要每次写入后立刻在 `this.data` 读到新值时用。
- `'microtask'`：始终用 Promise 微任务合并——非 Skyline 宿主也想合并时用。

```ts
// 需要逐次同步
withPageStore(counter, { mapState: ['count'], mapActions: ['increment'], schedule: 'sync' })

// 非 Skyline 宿主也显式合并
withPageStore(counter, { mapState: ['count'], mapActions: ['increment'], schedule: 'microtask' })
```

- 合并只改变写入时机，不改变映射字段、脏键过滤与值；同一 tick 的多次写入只发一次 `setData`。
- 初始映射始终同步交付，`onLoad` / `attached` 内即可读到映射后的 `data`。
- 卸载、重入与 `detached` 会丢弃尚未交付的合并写入；集成层写入失败时开发期 `console.error`，
  同时 `onError(error, 'withPageStore' | 'withComponentStore' | 'withAppStore')`，生产期不打印 console
  但仍上报。App 集成同样支持 `schedule`（默认 `sync`，显式 `microtask` 可合并）。

**版本与限制**：Android/iOS 微信 8.0.40+、基础库 3.0.2+；HarmonyOS 微信 1.0.10+、基础库 3.11.3+。
本库的组件自动退订仍要求基础库 ≥3.15.0，整体建议 ≥3.15.0。Skyline 不支持 `web-view`、页面级全局滚动
与原生导航栏。完整支持矩阵见 [COMPATIBILITY](./COMPATIBILITY.md)，可对照已切换 Skyline 的
[examples/miniprogram](../examples/miniprogram)。

## 相关文档

- [API](./API.md)：签名与默认值
- [GUIDE](./GUIDE.md)：概念与用法
- [COMPATIBILITY](./COMPATIBILITY.md)：支持矩阵、Skyline 配置与限制
- [PERFORMANCE](./PERFORMANCE.md)：成本模型与开关
- [文档索引](./README.md)：全部文档
