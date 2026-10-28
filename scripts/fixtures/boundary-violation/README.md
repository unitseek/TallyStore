# check-package-boundary 违规 fixture

CI 用该工程强制走一遍「主包引用分包」判定逻辑：脚本必须退出 1 并报出
`pages/index/index.js → packageA/store/cart.js`。示例工程（examples/miniprogram）未配置分包，
单独跑只会走「未配置分包」分支，无法拦截门禁回归。
