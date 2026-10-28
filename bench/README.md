# TallyStore 内部性能基准

仓库内部使用的性能基准套件，用于观察改动对关键路径的影响；**不发布 npm**（package.json 的
files 只含 dist-weapp 与 types，bench/ 天然不进包）。

## 本文内容

- [为什么测 dist-weapp 而不是 src](#为什么测-dist-weapp-而不是-src)
- [前置](#前置)
- [用法](#用法)
- [输出](#输出)
- [方法论](#方法论)
- [如何加 case](#如何加-case)
- [基线比较](#基线比较)
- [已知局限（为什么不进 CI 门禁）](#已知局限为什么不进-ci-门禁)
- [目录](#目录)
- [相关文档](#相关文档)
- [发布 RUNBOOK（固定硬件 / 受控发布）](./RUNBOOK.md)

## 为什么测 dist-weapp 而不是 src

微信「构建 npm」按 package.json.miniprogram 把 dist-weapp **整目录**拷进小程序包，库内代码最终以
这份 CJS 产物运行。因此：

- 基准加载的就是 dist-weapp 的真实字节：整目录复制到 os.tmpdir()、单独声明
  `{"type":"commonjs"}`、用 createRequire 加载（与 examples/miniprogram/e2e/host-smoke.mjs 同法）；
- 测量结果包含产物形态带来的真实差异（CJS 包装、转译后的代码形状），而不是为测试另建一套 ESM
  入口；
- 改造 src 后必须先 `pnpm run build` 再跑基准，否则测到的是上一次构建。

## 前置

```bash
# 仓库根：生成 dist-weapp/
pnpm run build
```

Node >= 22，无第三方依赖。

## 用法

```bash
node bench/run.mjs                      # 全部 suite（默认 3 轮，单样本目标 >=50ms）
node bench/run.mjs --quick              # 快速模式（单样本目标 >=10ms，迭代上限下调）
node bench/run.mjs --suite=proxy,store  # 只跑指定 suite（可重复 --suite）
node bench/run.mjs --json               # 纯 JSON 输出（含环境信息与 cases）
node bench/run.mjs --save bench/baseline.json
node bench/run.mjs --compare bench/baseline.json --tolerance=25
node bench/run.mjs --help
```

可选调参：--rounds=<n>、--warmup=<n>、--target-ms=<n>。抖动大时优先增加轮数/单样本时长，而不是
放宽 --tolerance。

### suite

- **proxy**：保护代理的读开销（裸对象基线 / protection on-off / 深度 3 / 数组 / Map），action 写入
  （顶层、嵌套、数组 push、Map.set、delete），小状态与 100 键 / 10000 元素大状态
- **store**：createStore/destroy（含 2 插件）、setState、$patch 浅/深、$replaceState、batch 嵌套、
  dispatch 同步/异步、getter、$snapshot 小/大、$restore、1 vs 50 只读监听者、可写监听者的载荷克隆
  小/大、notify.async 100 次写入合并、subscribe/unsubscribe churn
- **integrations**：withPageStore onLoad（5/50 键）、setState 触发一次 setData、未映射键的脏键跳过、
  Skyline 同 tick 两次映射写入合并为一次 setData（对照：WebView 宿主逐次写入）、onLoad+onUnload、
  映射 action、withComponentStore attached/detached、withAppStore onLaunch
- **plugins**：persistence 安装后无写入开销、debounce=0 小/大状态写入、从 JSON 恢复小/大、卸载补写
  （pending debounce）、logger noop sink 写入开销、persistence+logger 同时安装

## 输出

表格按 suite 聚合，每行一个 case：ops/s 越高越好、ns/op 越低越好。

```text
suite         case                                     ops/s    ns/op
------------  ---------------------------------------  -------  --------
proxy         read: raw object property (baseline)     33.20M   30.1 ns
store         setState: single key                     8.10M    123.5 ns
```

--json 结构：

```json
{
  "meta": {
    "node": "v22.x",
    "platform": "win32",
    "arch": "x64",
    "cpuModel": "...",
    "cpuCount": 16,
    "runMode": "full",
    "dist": { "files": 30, "bytes": 0 },
    "durationMs": 0,
    "probeNsPerOp": 61.2
  },
  "cases": [
    {
      "suite": "store",
      "name": "setState: single key",
      "iterations": 123,
      "nsPerOp": 123.5,
      "opsPerSec": 8100000,
      "samples": [122.1, 124.0, 123.5],
      "isAsync": false
    }
  ],
  "failures": [],
  "comparison": {
    "regressions": [],
    "missing": [],
    "added": [],
    "retryRounds": 0,
    "retriedCases": [],
    "probeNsPerOpUsed": 61.2
  }
}
```

## 方法论

- **校准迭代次数**：先跑 1 次迭代，按实测耗时把迭代次数放大到单样本 >= targetMs（默认 50ms，
  --quick 为 10ms），迭代上限随 targetMs 调整（防极快操作把次数推到无意义量级）。
- **预热**：默认 2 轮不计入统计，让 JIT 进入稳态。
- **取中位数与自适应样本**：默认 3 轮，每轮算 ns/op 取中位数；轮间让出事件循环消化上一轮 GC/调度
  残留。为保证噪声下的稳定性会自动加样本：校准后估算 <50ns 提到 7 轮、<5us 提到 5 轮；采样相对
  离散度 >12% 时继续补到最多 7 轮（--rounds 显式指定时不自动调整）。
- **每个 case 独立 store/宿主**：setup 建、teardown destroy；插件 case 在 fn 内创建并销毁，避免
  遗留定时器与未处理 Promise。
- **屏蔽业务日志**：基准期间 console.log/warn/error 被替换为 noop（插件安装日志、集成告警会干扰
  --json 输出），输出统一走原始 console。
- **异步 case**：fn 返回 thenable 时按异步测量（每次迭代 await），覆盖 dispatch 的 settle 补发与
  notify.async 的微任务合并。
- **机器漂移探针**：运行前后各测一次固定标量循环，作为本次运行的机器速度；compare 用它归一
  （见「基线比较」）。

## 如何加 case

在对应 bench/\*.bench.mjs 的 cases 数组追加一项：

```js
export const cases = [
  // ...
  {
    name: 'setState: 10 keys in one batch',
    setup() {
      const store = lib.createStore({ state: () => ({ a: 0, b: 0 }) })
      return { store, counter: 0 }
    },
    fn(context) {
      context.counter += 1
      context.store.batch(() => {
        context.store.setState('a', context.counter)
        context.store.setState('b', context.counter)
      })
    },
    teardown(context) {
      context.store.destroy()
    },
  },
]
```

- setup 里建**全新** store/宿主并把上下文返回给 fn/teardown；
- fn 里只做被测操作（不要在 fn 里做断言/日志）；
- teardown 必须 destroy store、清理定时器/订阅；需要校验语义的断言放 setup/teardown（失败会让该
  case 标红）；
- 新增 suite 时同步更新 run.mjs 的 SUITE_FILES 与 lib.mjs 的 ALL_SUITES；
- **新增/重命名 case 会让 `--compare` 报 `added` / `missing`（只提示、不判失败）**：这属于基线未覆盖，
  不是回退；需要在**固定硬件**上按发布流程重锚基线（`bench:save`），**禁止手改 `bench/baseline.json`
  的数值**。重锚与归档要求见 [RUNBOOK](./RUNBOOK.md)。

## 基线比较

--save 保存一份本机基线，--compare 对同名 case 比较 ns/op：candidate 比 baseline 慢超过
--tolerance（默认 25%）时逐条打印 REGRESSION 并 exit 1；无回退 exit 0。缺失/新增 case（added/missing）
只提示、不判失败——说明入库基线尚未覆盖该 case，需在参考机重锚（见 [RUNBOOK](./RUNBOOK.md)），
**不要手改基线数值**；发布/固定硬件上的完整执行、报告归档与判定口径见 RUNBOOK。

**机器漂移归一**：每次运行前后各测一次与库无关的固定标量循环（约 0.15s），把均值写入 JSON 的
meta.probeNsPerOp；--compare 时先按 candidate/baseline 探针比值把 candidate 的 ns/op 缩放到
「基线机器速度」再判回退。共享宿主/热降频导致的整机变慢不会再被误报成代码回退；探针与库代码无关，
真实的库内回退仍会被逐条报出。基线缺少探针时退化为直接比较（兼容旧基线）。

- **稳健统计**：compare 对基线与本次运行的 samples 分别取「较低半区」中位数（best-half median）
  再比较——GC 尖峰/邻接负载只会抬高少数轮，低半区代表不被干扰时的 best-case；真实回退会整体抬高
  分布，仍会被判出。表格展示的仍是全样本中位数 nsPerOp。
- **回退复测**：首次被判回退的 case 会立即复测（最多 2 轮、仅复测仍回退的 case），复测窗口前再测
  一次机器探针并重新归一；瞬态争用噪声不会留下假回退，真实回退复测仍会复现。输出会多一行
  「已复测 N 次回退 case（M 轮）」。

```bash
node bench/run.mjs --save bench/baseline.json
node bench/run.mjs --compare bench/baseline.json        # 同机两次运行，抖动应低于 25%
node bench/run.mjs --compare bench/baseline.json --tolerance=30   # 仅在确认噪声来源后放宽
```

## 已知局限（为什么不进 CI 门禁）

1. **测的是 Node 的 V8，不是小程序运行时**：微信逻辑层与 Node 的 V8 版本、JIT 策略、内存上限都
   不同，绝对数字不可跨宿主搬运；bench 只用于同机、同构建下的相对比较。
2. **GC 与 JIT 噪声**：短样本受 JIT 编译、GC 时机影响；已用预热 + 多轮中位数 + 亚微秒 case 加样本
   压低，但无法消除。compare 已用机器探针抵消整机漂移，个别 case 仍可能超过 25%，所以比较接口是
   「人工触发的回归检测」而不是硬门禁。
3. **机器与负载差异**：CPU 频率、共享 CI 容器、后台进程都会改变 ops/s；不同机器上的 --save 基线
   不可互比。
4. **异步与定时器成本**：异步 action / notify.async 的 case 包含 Promise 微任务成本；persistence 的
   debounce=0 与卸载补写包含同步 I/O 与 JSON.stringify，属于真实成本，但受状态体量与宿主存储实现
   影响。
5. **只测稳态路径**：不覆盖首次加载、冷启动、极端状态规模；不替代功能测试与覆盖率。
6. **不建议进 CI**：共享 CI 机器的抖动会让「慢 25%」判定产生大量假红；如要防止性能回退，应在固定
   硬件上按发布节奏手动运行并归档基线。

## 目录

```text
bench/
  lib.mjs                加载 dist-weapp、计时/统计、表格/JSON、参数解析
  run.mjs                CLI 入口（suite 调度、--json/--save/--compare）
  proxy.bench.mjs        代理层
  store.bench.mjs        Store 核心
  integrations.bench.mjs 小程序集成
  plugins.bench.mjs      持久化/日志插件
  README.md              本文件
  RUNBOOK.md             固定硬件/受控发布的执行、判定与归档手册
```

## 相关文档

- [`examples/miniprogram/e2e/host-smoke.mjs`](../examples/miniprogram/e2e/host-smoke.mjs)：宿主模拟 e2e（CI）
- [`docs/PERFORMANCE.md`](../docs/PERFORMANCE.md)：使用侧成本模型、开关与发布性能门禁
- [`scripts/bench-report.mjs`](../scripts/bench-report.mjs)：发布时生成可归档的 `bench/report.json`
- [RUNBOOK](./RUNBOOK.md)：固定硬件 / 受控发布任务的执行、判定与归档手册
