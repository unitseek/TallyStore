# 团队规范与 Code Review 清单

面向用 TallyStore 开发业务库 / 页面的团队。规范**可执行**：多数条目有对应的开发期报错、
CI 门禁或本文的 CR 勾选项兜底。定位与快速开始见 [README](../README.md)与[GUIDE](./GUIDE.md)。

## 本文内容

- [Store 命名与模块边界](#store-命名与模块边界)
- [全局状态准入](#全局状态准入)
- [持久化字段评审](#持久化字段评审)
- [日志与上报字段规范](#日志与上报字段规范)
- [反例清单](#反例清单)
- [Code Review 清单](#code-review-清单)
- [测试辅助等价方案](#测试辅助等价方案)

## Store 命名与模块边界

- **库 API 命名规约**：`create*` 立即产生实例（`createStore` / `createRaceGuard`）；
  `define*` 只登记工厂、延迟实例化（`defineStores`）——新增公开 API 按此归类命名；
- `name` 用**业务域小驼峰单数名词**（`user`、`cart`、`featureFlags`），不用页面名、
  组件名或临时用途命名——name 是日志前缀与持久化默认键，跨页面存在；
- 同一应用内 `name` 必须唯一（开发期构造抛错，全局注册表跨库副本共享检测）；
- **一个 Store 一个业务域**：单 Store 不承载全应用状态；预估超过 ~30 个顶层键或
  出现「A 页面只用 1 个字段却订阅了整树」时拆分；
- 模块间不形成循环依赖（`defineStores` 的 `dependsOn` 注册期检测）；共享状态抽到
  环外模块；
- 主包可注册基础 Store 供分包引用，反向由 `check:boundary` 静态拦截（见
  [MIGRATION](./MIGRATION.md)）。

## 全局状态准入

新增全局 Store 前，在 CR 中回答「为什么不能是页面私有状态」。满足任一条才准入：

1. 跨页面共享且需长期一致（会话、组织/租户、功能开关）；
2. 同一实体在多处展示且要求 ≤1 个渲染批次同步；
3. 多页面重复请求同一份数据，需要单一事实来源。

否则用页面 `data` 或组件 `properties`。页面临时 UI 态（弹窗、输入草稿）**不得**入全局 Store。

## 持久化字段评审

- 白名单**最小集**原则：只持久化「恢复体验必需」的字段（表单草稿、筛选条件、浏览位置）；
- 敏感字段（内置清单 + 业务扩展清单）**禁止**入白名单——开发期由敏感键审计阻断落盘；
- 白名单变更走评审：PR 描述列出新增/移除字段与理由，评审人对照
  [SECURITY 合规清单](../SECURITY.md)四项勾选；
- 需要跨版本的数据带 `schemaVersion` 与迁移钩子。

## 日志与上报字段规范

- 开发期日志由 `loggerPlugin` 输出且自动脱敏；**不要**在业务代码里 `console.log` 整棵
  state 或含敏感键的对象；
- 自定义 `LogSink` / 上报通道的字段表需标注「是否含个人信息」，白名单外的字段不得上报；
- 错误上报统一接 `onError(error, source)`，`source` 枚举见 [API](./API.md)——不要自行
  try/catch 后吞掉再打点。

## 反例清单

| 反例                                               | 后果                         | 正确做法                                       |
| -------------------------------------------------- | ---------------------------- | ---------------------------------------------- |
| 直接改 `store.state.x` / `getState().x`            | 开发期抛错；绕过写入口无通知 | action 内 `this.setState` / `$patch`           |
| 全量映射 `mapState: [...]` 拷整树                  | 无关变更也下发、载荷失控     | 只映射渲染需要的字段；大对象派生切片           |
| 敏感字段放进持久化 `filter`                        | 开发期阻断落盘；明文泄漏风险 | 不落盘 / 派生脱敏值（见 SECURITY 推荐路径）    |
| 无界订阅（onLoad 里手动 `store.subscribe` 不退订） | 泄漏 + 幽灵 setData          | 用集成层映射（自动解绑）；手动订阅必须配对退订 |
| action 里传原始字符串敏感实参                      | 日志无法按键脱敏             | 传对象并命名敏感键（`login({ password })`）    |
| 绕过 `defineStores` 私建跨包引用                   | 分包未加载时运行时找不到模块 | 主包聚合注册；`check:boundary` 接 CI           |

## Code Review 清单

评审 Store 相关 PR 时逐条勾选（复制到 PR 描述）：

```markdown
- [ ] Store `name` 唯一且符合业务域命名（无页面/组件名）
- [ ] 模块边界：无循环依赖；主/分包方向正确（check:boundary 通过）
- [ ] 新增全局 Store 已回答准入三问之一
- [ ] 映射只含渲染需要的字段；本地键与宿主 data/methods 无冲突（开发期已校验）
- [ ] 持久化白名单最小集；无敏感字段；白名单变更已在 PR 描述说明
- [ ] 日志/上报无敏感明文；自定义 sink 字段表已标注是否含个人信息
- [ ] 写路径全部经 action；无直接改 state / getState 引用外泄
- [ ] 异步 action 的竞态已考虑（参考 RECIPES / createRaceGuard）
- [ ] 测试：核心语义有单测；页面进出压测无订阅增长（模板见测试辅助）
```

## 测试辅助等价方案

库不内置 `createTestStore` —— `createStore` 本身即测试工厂（状态用工厂函数避免共享引用，
`destroy()` 即 `resetAll` 等价物）。可复制的等价方案：

```ts
// 每个用例独立 Store：工厂 state + 用例结束 destroy
function makeCounterStore() {
  return createStore({
    name: 'test-counter', // 用例内唯一即可（setup 会按用例隔离全局注册表）
    state: () => ({ count: 0 }), // 工厂写法：不共享引用
    actions: {
      inc(step = 1) {
        this.setState('count', this.getState().count + step)
      },
    },
  })
}
afterEach(() => store.destroy()) // destroy 幂等：清订阅/插件/注册表

// mock 宿主：tests/utils/host.ts 的 createHost（可记录 setData）；wx 存储见 installWxStorage
// 断言订阅无泄漏：store.getSubscriptionCount()（进出 N 次后应回到基线，见 lifecycleLeak.test.ts）
```

宿主模拟（`createHost` / `installWxStorage` / `trackSubscriptions`）在仓库 `tests/utils/host.ts`，
可直接复制到业务仓库使用。
