export default {
  // preset 已移除：ts-jest preset 只贡献 transform，会被下方显式 transform 完整覆盖
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        // 只做转译：类型检查由 tsconfig.json / tsconfig.tests.json 承担（CI 在 test 前有独立 typecheck 步骤，
        // 且 prepublishOnly 也先跑两步 typecheck）。开启 diagnostics 会把类型检查叠加进每个测试进程，
        // 并与 TS6 对 moduleResolution:node10 的弃用告警冲突，故维持转译模式（ 记录为设计取舍）。
        diagnostics: false,
        tsconfig: {
          target: 'ES2020',
          module: 'CommonJS',
          // ts-jest 变换必须输出 CJS；moduleResolution 沿用 node（与 tsconfig 的 nodenext 分歧仅影响本配置，
          // 真实类型解析由 tsc 项目配置保证）。isolatedModules 与 tsconfig 对齐，启用 ts-jest 的
          // transpileModule 快速路径。
          moduleResolution: 'node',
          isolatedModules: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          experimentalDecorators: false,
          verbatimModuleSyntax: false,
          types: ['jest', 'node'],
          lib: ['ES2020'],
        },
      },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // globstar 已匹配零层目录：!src/**/index.ts 覆盖 src/index.ts，无需重复项
  collectCoverageFrom: ['src/**/*.ts', '!src/**/index.ts', '!src/types/**'],
  coverageThreshold: {
    global: {
      branches: 98,
      functions: 98,
      lines: 98,
      statements: 98,
    },
  },
  coverageReporters: ['text-summary', 'text', 'json-summary'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testTimeout: 10000,
  verbose: false,
}
