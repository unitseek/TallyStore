/**
 * 插件入口面：聚合入口与两个子入口的运行时导出恰好是策展清单
 */
import * as aggregate from '../../../src/plugins.js'
import * as persistenceEntry from '../../../src/plugins/persistence.js'
import * as loggerEntry from '../../../src/plugins/logger.js'
import { persistencePlugin as directPersistence } from '../../../src/plugins/persistence.js'
import { loggerPlugin as directLogger } from '../../../src/plugins/logger.js'
import { WxStorageBackend as directBackend } from '../../../src/plugins/WxStorageBackend.js'

describe('plugins 聚合入口', () => {
  it('运行时导出恰好是四个符号（类型导出不产生运行时键）', () => {
    expect(Object.keys(aggregate).sort()).toEqual(['WxStorageBackend', 'loggerPlugin', 'metricsPlugin', 'persistencePlugin'])
    expect(aggregate.persistencePlugin).toBe(directPersistence)
    expect(aggregate.loggerPlugin).toBe(directLogger)
    expect(aggregate.WxStorageBackend).toBe(directBackend)
  })

  it('插件既可作工厂调用，也可作 Plugin 对象安装', () => {
    const persistence = aggregate.persistencePlugin()
    expect(persistence.name).toBe('persistence')
    expect(typeof persistence.install).toBe('function')

    const logger = aggregate.loggerPlugin()
    expect(logger.name).toBe('logger')
    expect(typeof logger.install).toBe('function')

    expect(typeof new aggregate.WxStorageBackend().getItem).toBe('function')
  })
})

describe('plugins 子入口', () => {
  it('persistence 子入口只导出持久化相关符号', () => {
    expect(Object.keys(persistenceEntry).sort()).toEqual(['WxStorageBackend', 'persistencePlugin'])
    expect(persistenceEntry.persistencePlugin).toBe(directPersistence)
    expect(persistenceEntry.WxStorageBackend).toBe(directBackend)
  })

  it('logger 子入口只导出日志插件', () => {
    expect(Object.keys(loggerEntry)).toEqual(['loggerPlugin'])
    expect(loggerEntry.loggerPlugin).toBe(directLogger)
  })

  it('两个子入口与聚合入口指向同一份实现（跨入口单例）', () => {
    expect(persistenceEntry.persistencePlugin).toBe(aggregate.persistencePlugin)
    expect(loggerEntry.loggerPlugin).toBe(aggregate.loggerPlugin)
    expect(persistenceEntry.WxStorageBackend).toBe(aggregate.WxStorageBackend)
  })
})
