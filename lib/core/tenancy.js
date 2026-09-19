/**
 * 多租户管理层：把「租户注册表」和「每租户一个 Harness 实例」拼在一起。
 *
 * 分工：
 *  - core/tenant.js   —— 租户定义与注册表（纯数据）
 *  - core/instance.js —— 单个实例的启动/看护（纯进程）
 *  - 本模块           —— 两者之间的编排：谁该起、谁在跑、路由句柄、增删改查
 *  - core/proxy.js    —— 按租户凭据把请求送到对应实例
 *
 * 路由句柄的形状（proxy 只认这三个字段）：
 *     { id, upstreamPort(): number, token(): string }
 * 实例没起来时返回 0 / ''，网关会回 503（"该租户的 Harness 还没起来"），而不是把人挡在门外。
 *
 * @module dsh-plugin-remote-connect/core/tenancy
 */
import path from 'node:path'
import { createRegistry, generateAccessKey, normalizeTenant, slugifyId } from './tenant.js'
import { createInstance, discoverHarnessBin, discoverRuntime } from './instance.js'
import { translator } from './messages.js'

const tEn = translator('en')

/**
 * @param {object} options
 * @param {object} options.config 归一化后的 `config.tenants`
 * @param {(line: string) => void} [options.log]
 * @param {(state: object) => void} [options.onState] 任一实例状态变化时回调（面板据此刷新）
 */
export function createTenancy(options) {
  const config = options.config
  const log = options.log ?? (() => {})
  const onState = options.onState ?? (() => {})

  const registry = createRegistry({
    file: config.registry,
    baseDir: config.baseDir,
    log,
  })

  const discovered = {
    bin: discoverHarnessBin({ configured: config.harness.bin }),
    runtime: discoverRuntime({ configured: config.harness.node }),
  }

  /** @type {Map<string, object>} 租户 id → 实例 */
  const instances = new Map()
  /** @type {Map<string, object>} 租户 id → 最近一次状态 */
  const states = new Map()

  function harnessProblem() {
    if (discovered.bin === null) {
      return '找不到 DSH Harness 入口：请在 tenants.harness.bin 指定 @deepseek-ai/dsh/lib/bin.js 的路径'
    }
    return null
  }

  function instanceFor(tenant) {
    const existing = instances.get(tenant.id)
    if (existing !== undefined) return existing
    if (harnessProblem() !== null) return null
    const instance = createInstance({
      tenant,
      harness: {
        bin: discovered.bin.bin,
        node: discovered.runtime.node,
        electron: discovered.runtime.electron,
        extraArgs: config.harness.extraArgs,
      },
      log,
      onState: (state) => {
        states.set(state.id, state)
        onState(state)
      },
    })
    instances.set(tenant.id, instance)
    return instance
  }

  /** 路由句柄：租户存在就给（哪怕实例没起来，交给网关回 503）。 */
  function handle(id) {
    const tenant = registry.get(id)
    if (tenant === null) return null
    const instance = instances.get(id)
    if (instance === undefined) {
      return { id, tenant, upstreamPort: () => 0, token: () => '' }
    }
    return {
      id,
      tenant,
      upstreamPort: () => instance.upstreamPort(),
      token: () => instance.token(),
      state: () => instance.state(),
    }
  }

  /** 面板/CLI 看的一份汇总：租户定义 + 运行状态 + 就绪信息。 */
  function describe(id) {
    const tenant = registry.get(id)
    if (tenant === null) return null
    const state = states.get(id) ?? {
      id,
      phase: 'idle',
      code: 'tenant.idle',
      params: { id },
      detail: tEn('tenant.idle'),
      port: tenant.port,
      hasToken: false,
      restarts: 0,
    }
    return {
      id: tenant.id,
      name: tenant.name,
      accessKey: tenant.accessKey,
      home: tenant.home,
      profile: tenant.profile,
      port: state.port ?? tenant.port,
      autostart: tenant.autostart,
      enabled: tenant.enabled,
      note: tenant.note,
      createdAt: tenant.createdAt,
      phase: state.phase,
      code: state.code,
      params: state.params,
      detail: state.detail,
      hint: state.hintCode === undefined ? undefined : tEn(state.hintCode),
      hasToken: state.hasToken === true,
      restarts: state.restarts ?? 0,
      pid: state.pid ?? null,
      running: state.phase === 'up',
    }
  }

  function list() {
    return registry.list().map((tenant) => describe(tenant.id))
  }

  /** 读注册表，并把组合里预置的租户补齐（组合是"种子"，注册表是运行时事实来源）。 */
  function load() {
    const result = registry.load()
    for (const seed of config.list) {
      const { problems, tenant } = normalizeTenant(seed, { baseDir: config.baseDir })
      if (problems.length > 0) {
        log('组合里预置的租户不合法，已跳过：' + problems.join('；'))
        continue
      }
      if (registry.get(tenant.id) !== null) continue
      try {
        registry.add({ ...tenant, accessKey: tenant.accessKey === '' ? generateAccessKey() : tenant.accessKey })
      } catch (error) {
        log('预置租户 ' + tenant.id + ' 未能写入注册表：' + String(error?.message ?? error))
      }
    }
    return { loaded: result.loaded, dropped: result.dropped, total: registry.size() }
  }

  function start(id) {
    const tenant = registry.get(id)
    if (tenant === null) throw new Error('租户不存在：' + String(id))
    if (harnessProblem() !== null) throw new Error(harnessProblem())
    const instance = instanceFor(tenant)
    instance.start()
    return describe(id)
  }

  async function stop(id) {
    const instance = instances.get(id)
    if (instance === undefined) return describe(id)
    await instance.stop()
    return describe(id)
  }

  /** 自动拉起所有 autostart 的租户（插件装载/局域网或公网入口启动时调用）。 */
  function startAutostart() {
    if (!config.enabled || config.autostart !== true) return []
    const started = []
    for (const tenant of registry.list()) {
      if (tenant.enabled !== true || tenant.autostart !== true) continue
      try {
        start(tenant.id)
        started.push(tenant.id)
      } catch (error) {
        log('租户 ' + tenant.id + ' 自动启动失败：' + String(error?.message ?? error))
      }
    }
    return started
  }

  async function stopAll() {
    const all = [...instances.values()]
    instances.clear()
    await Promise.all(all.map((instance) => instance.stop().catch(() => {})))
  }

  /**
   * 面板/CLI 新增租户：id 可由显示名自动收敛，访问密钥自动生成。
   * @returns {{ tenant: object, accessKey: string }}
   */
  function add(input = {}) {
    const requestedId = typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : ''
    const id = requestedId !== '' ? requestedId : slugifyId(input.name ?? '', 'u')
    const tenant = registry.add({
      id,
      name: typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : id,
      note: typeof input.note === 'string' ? input.note : '',
      accessKey: typeof input.accessKey === 'string' && input.accessKey !== '' ? input.accessKey : generateAccessKey(),
      home: typeof input.home === 'string' && input.home !== '' ? input.home : path.join(config.baseDir, id),
      port: input.port ?? 0,
      autostart: input.autostart !== false,
    })
    // 新增即拉起：多租户的意义是"给人一个链接就能用"
    if (tenant.enabled === true && tenant.autostart === true) {
      try {
        start(tenant.id)
      } catch (error) {
        log('租户 ' + tenant.id + ' 已写入注册表，但启动失败：' + String(error?.message ?? error))
      }
    }
    return { tenant, accessKey: tenant.accessKey }
  }

  /** 删除租户：先停实例，再从注册表移除（它的 home 目录保持原样，不替用户删数据）。 */
  async function remove(id) {
    const tenant = registry.get(id)
    if (tenant === null) return null
    await stop(id)
    instances.delete(id)
    states.delete(id)
    registry.remove(id)
    return tenant
  }

  function rotate(id) {
    const tenant = registry.rotateKey(id)
    // 旧 Cookie 立刻失效：gate 会按 id 查回租户，但 Cookie 里的签名密钥没变，
    // 真正让它失效的是"密钥换了 → 新链接用新密钥"，旧的 ?k= 直接 404。
    return tenant
  }

  return {
    enabled: config.enabled === true,
    registry,
    harness: {
      bin: discovered.bin === null ? null : discovered.bin.bin,
      binSource: discovered.bin === null ? null : discovered.bin.source,
      node: discovered.runtime.node,
      nodeSource: discovered.runtime.source,
      problem: harnessProblem(),
    },
    load,
    list,
    describe,
    handle,
    findByKey: (key) => {
      const tenant = registry.findByKey(key)
      return tenant === null ? null : handle(tenant.id)
    },
    add,
    remove,
    rotate,
    start,
    stop,
    startAutostart,
    stopAll,
    /** 仅测试用：某个租户的实例（拿令牌/端口）。 */
    instance: (id) => instances.get(id) ?? null,
  }
}
