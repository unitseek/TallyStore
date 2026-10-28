# 从 globalData 迁移到 Store

面向把存量 `globalData` / 页面私有 `data` 逐步迁移到 TallyStore 的团队。配套的
[check-package-boundary](#分包边界检查) 脚本可在构建期拦截主包对分包 Store 的违规引用。

## 本文内容

- [何时该迁移](#何时该迁移)
- [迁移顺序](#迁移顺序)
- [globalData → Store 对照表](#globaldata-store-对照表)
- [回滚方式](#回滚方式)
- [持久化必须显式 filter（破坏性变更）](#持久化必须显式-filter破坏性变更)
- [分包边界检查](#分包边界检查)
- [分包与未迁移页面示例](#分包与未迁移页面示例)
- [常见问题](#常见问题)

## 何时该迁移

- **该迁移**：跨页面共享且需长期一致的状态（会话、组织/租户、功能开关、同一实体的多处展示）；
  多页面重复请求同一份数据；`globalData` + 事件总线 + 手工回写已经出现状态流向不可追踪。
- **不该迁移**：页面临时 UI 状态（弹窗开合、输入草稿）保留在页面 `data`；一次性传递的参数用路由参数。
  新增全局 Store 需说明「为什么不能是页面私有状态」（准入评审口径见 [RECIPES](./RECIPES.md)）。

## 迁移顺序

1. 选一个**低风险切片**起步（如功能开关）：定义 Store → 新页面接入 → 存量页面逐个切换；
2. 每个页面迁移后回归该页面的读路径（`getApp().globalData.x` → 映射字段或 `store.getState().x`）；
3. 写路径统一收敛到 action（原来的 `globalData.x = y` 全部落入 action 审计范围）；
4. 迁移完成的字段从 `globalData` 删除；未迁移页面与已迁移页面**长期共存**是设计支持的状态，不是中间态；
5. 全部页面迁移后，把 `globalData` 里仅剩的只读配置挪到 Store 或保留原地（二选一，团队约定一致即可）。

## globalData → Store 对照表

| globalData 写法                                   | TallyStore 写法                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| `app.globalData.user = {...}`                     | `userStore.setState('user', {...})` 或 action 内 `this.setState(...)` |
| `app.globalData.count++`                          | action：`this.setState('count', this.getState().count + 1)`           |
| 页面 `onLoad` 里读一次 `getApp().globalData.x`    | `mapState: ['x']` 映射（初始即交付，`onLoad` 内可读 `this.data.x`）   |
| 页面监听 globalData 变化（事件总线/手工回写）     | `mapState` / `mapGetters` 映射自动同步；无需事件总线                  |
| `onShow` 里手动刷新 `this.setData({x: global.x})` | 不需要：状态变化即下发（前后台策略见 [GUIDE](./GUIDE.md)）            |
| 多处写同一字段、时序难查                          | 写入口唯一 + `beforeSetState` / 日志插件可审计全部变更链              |

## 回滚方式

- 迁移是**页面粒度**的：撤掉某页面的 `withPageStore` 包装与映射即回滚该页面，其余页面不受影响；
- Store 与 `globalData` 可并存：回滚期间把 action 里的写入同步回写一份 `globalData`（过渡期双写），
  全部页面回滚完成后再删除双写；
- 库层面按版本回退 npm 包即可（无持久化数据格式耦合；启用了持久化插件时见 [API](./API.md) 的
  `key` / `clearOnUninstall`）。

## 持久化必须显式 filter（破坏性变更）

**变更**：`persistencePlugin` 不再默认全量落盘。`PersistenceOptions.filter` 必须显式提供：

- `filter: (state) => Partial<state>`：白名单，只落盘返回的键；
- `filter: false`：显式关闭持久化（不读 storage、不恢复、不订阅保存、不写盘/清理）。

**默认不落盘任何字段，禁止自动全量持久化**。缺省 filter 的后果：

- 开发期：`store.use(persistencePlugin(...))` 直接抛 `TallyStoreError(INVALID_CONFIG)`，消息指出必须
  显式提供 filter 白名单或 `filter: false`；
- 生产期：经 `onError(INVALID_CONFIG, 'persistence')` 上报后禁用持久化（不读/不写/不恢复），
  `getItem` / `setItem` / `removeItem` 零调用——不会再出现「静默把整棵状态树写进明文存储」。

**迁移步骤**：

1. 在每一处 `persistencePlugin({ ... })` 补 `filter`；只挑业务需要的非敏感、可 JSON 往返字段：

   ```ts
   store.use(
     persistencePlugin({
       key: 'cart',
       // 之前默认全量落盘的等价写法（不建议，除非状态本身全部可落盘且无敏感字段）：
       // filter: (state) => state,
       filter: (state) => ({ items: state.items, coupon: state.coupon }),
     }),
   )
   ```

2. 不需要持久化的 Store 显式写 `filter: false`（或干脆不安装插件）；
3. 有 `schemaVersion` / `migrations` 的项目同时检查白名单字段是否覆盖迁移所需数据；
4. 回归恢复路径：首次启动默认值正确、有存量数据时按白名单 `$patch` 合并。

**回滚**：回退 npm 包版本即可；但旧版本会重新按「缺省全量」落盘，且新版本因缺少 filter 已经不再
写盘——回退前请确认存储里的数据来自哪个版本，避免新白名单写出的部分状态被旧版本当作全量恢复。

## 分包边界检查

依赖方向约束：**主包可引用主包 Store，分包可引用主包与自身 Store；主包不得引用分包 Store**
（分包可能未加载，主包引用会在运行时找不到模块）。

```bash
node node_modules/@unitseek/tallystore/scripts/check-package-boundary.mjs <小程序工程根>
```

- 读取工程 `app.json` 的 `subPackages[].root`，扫描主包源文件的 `require` / `import`；
- 命中分包路径即失败并输出「引用文件 → 被引用路径（所属分包）」，退出码 1（可直接接 CI）；
- 违规修复方向：被引用模块上移主包，或主包聚合注册（`defineStores`）按需获取。

`project.config.json` 的 `packNpmManually` + `miniprogramNpmDistDir` 可把库产物放进分包：
**只调包额度，不减字节**（见 [PERFORMANCE](./PERFORMANCE.md) 体积预算）。

## 分包与未迁移页面示例

仓库的 [examples/miniprogram](../examples/miniprogram) 提供可直接运行的共存示例（`pnpm run build`

- `scripts/sync-lib.mjs` 后用开发者工具打开）：

* `app.json` 声明真实分包：`subPackages: [{ "root": "packageA", "pages": ["pages/cart/cart"] }]`；
* 分包页面 [packageA/pages/cart/cart.js](../examples/miniprogram/packageA/pages/cart/cart.js)
  只通过 `getApp().globalData.store` 取主包 Store，并做 `mapState` / `mapActions`；
  **不创建、不复制 Store 实例**，`require('@unitseek/tallystore')` 解析到主包根 `miniprogram_npm`；
* 未迁移页面 [pages/legacy/legacy.js](../examples/miniprogram/pages/legacy/legacy.js)
  保留迁移前的 `globalData` 读写，行为不变，且与 Store 状态互不影响（长期共存）；
* 自动化验证：
  - `node scripts/check-package-boundary.mjs examples/miniprogram`：主包不得引用分包，正向依赖合法；
  - `pnpm run e2e`：host-smoke 会加载上述真实 `app.json` / 页面配置，断言分包页读主包 Store、
    action 生效、未迁移页 `globalData` 路径不变。

## 常见问题

**迁移一半，新旧两种读法会不一致吗？** 不会——过渡期双写保证两边同值；映射字段的变化时序以
Store 为准（同 tick 内一致）。

**分包页面能映射主包 Store 吗？** 能，这是支持的依赖方向；只有反向（主包引用分包）被拦截。
