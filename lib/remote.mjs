/**
 * Settings 面板 <-> Host 的 RPC 服务。
 * 客户端调用：ctx.connection.rpc.call('/api', 'contextKit/<method>', { args })
 */

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** 施加 Remote(name) 标记，兼容无装饰器的写法（与 dsh-memory-local 同款）。 */
export function markRemoteMethod(serviceClass, method, exportName = method) {
  const instance = Object.create(serviceClass.prototype)
  const decorate = Remote(exportName)
  decorate(undefined, {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    addInitializer(fn) {
      fn.call(instance)
    },
  })
}

export class ContextKitRemoteService extends TypertRemoteService {
  static inject = []

  constructor(ctx, config = {}) {
    super(ctx, 'contextKit')
    if (!config.kit) throw new Error('contextKit remote service requires a kit')
    this.kit = config.kit
  }

  status() {
    return this.kit.describe()
  }

  preview() {
    return { text: this.kit.preview() }
  }

  save(presetId, thresholdRatio, retainRatio, auto, group) {
    return this.kit.saveCompaction({ presetId, thresholdRatio, retainRatio, auto, group })
  }

  sync(force, mode) {
    return this.kit.sync({ force: force === true, mode: mode === 'replace' ? 'replace' : 'append' })
  }

  clear() {
    return this.kit.clear()
  }

  async report(days) {
    return this.kit.report({ days: Number(days) || 7 })
  }
}

for (const method of ['status', 'preview', 'save', 'sync', 'clear', 'report']) {
  markRemoteMethod(ContextKitRemoteService, method)
}
