/**
 * DSH 插件（host 半）：把远程连接能力挂进 Harness 的宿主进程。
 *
 * 与"会话内动态插件"的关键区别：这里是真正的包，代理由**宿主进程内**直接运行
 * （不需要再 spawn 子进程），生命周期跟随 Cordis fiber，停止/升级时自动回收。
 *
 * 配置来自 cordis 组合里这一行的 config（没有导出 Config 时，Cordis 原样传入）：
 *
 *   - name: dsh-plugin-remote-connect-beta
 *     config:
 *       lan:    { port: 8787 }
 *       public:
 *         domain: dsh.example.com
 *         port: 8788
 *         tunnel: ssh
 *         ssh: { user: dshtunnel, host: dsh.example.com, keyPath: ~/.ssh/dsh_remote_tunnel }
 *       tenants:                      # 多租户：每个租户一个独立 Harness 实例
 *         enabled: true
 *         baseDir: ~/DSH-tenants      # 每个租户的 DSH_HOME 放这里
 *         registry: ~/.dsh-remote-connect/tenants.json
 *         harness: { bin: <dsh 入口>, node: /opt/homebrew/bin/node }
 *
 * 安全约定：面板的**开关**（启动/停止）只在宿主窗口（Host 为 loopback 且不带
 * 代理标记）可用；经代理进来的访客（无论局域网还是公网）只能读取状态。
 * 代理会强制覆写 `x-remote-connect-origin`，客户端无法伪造。
 *
 * @module dsh-plugin-remote-connect-beta
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createProxy, qrRows, defaultLogCandidates } from './core/proxy.js'
import { createTunnel } from './core/tunnel.js'
import { runPreflight } from './core/preflight.js'
import { normalizeLocale, resolveLocale, translator } from './core/messages.js'
import { createRegistry, defaultTenantBaseDir, generateAccessKey, normalizeTenant } from './core/tenant.js'
import { createKeyPool, fingerprintKey } from './core/keypool.js'
import { createTenancy } from './core/tenancy.js'
import { generatePassphrase, setupCommands as credentialSetupCommands } from './core/credential.js'
import { defaultGateSecretPath, defaultRegistryPath, loadOrCreateGateSecret, pluginStateDir } from './core/paths.js'
import {
  nginxServerBlock,
  caddySite,
  authorizedKeysLine,
  sshTunnelCommand,
  serverSetupSteps,
  NGINX_UPGRADE_MAP,
} from './core/snippets.js'


/** 只记一次的日志（避免每个请求刷一行）。 */
const loggedOnce = new Set()
function logOnce(line) {
  if (loggedOnce.has(line)) return
  loggedOnce.add(line)
}

/** 状态目录与注册表默认位置（实现见 core/paths.js，这里重新导出便于外部引用）。 */
export { defaultGateSecretPath, defaultRegistryPath, pluginStateDir }

/**
 * 访问口令的形态校验（用户自定义时用）。
 * 规则来自设计文档：长度 ≥12、拒绝常见弱口令、不接受空白与冒号（冒号是 Cookie 分隔符）。
 */
export function checkAccessKeyStrength(value) {
  const problems = []
  const text = String(value ?? '')
  if (text.length < 12) problems.push('口令太短：至少 12 位（推荐直接用生成的四到六词短句）')
  if (text.length > 128) problems.push('口令太长：最多 128 位')
  if (/[\s:]/.test(text)) problems.push('口令不能包含空格或冒号')
  const weak = ['123456', 'password', 'passw0rd', 'qwerty', 'admin', 'dsh', 'letmein', 'iloveyou']
  if (weak.includes(text.toLowerCase())) problems.push('这是最常见弱口令之一，换一个')
  if (/^(.)\1+$/.test(text)) problems.push('不要用重复字符')
  return problems
}

/**
 * 读访问口令状态；没有就用组合里的种子（或**从口令池**取一把全新的）。
 *
 * @param {string} file 状态文件
 * @param {string} [seed] 组合里的初始种子（`public.accessKey`，可空）
 * @param {object} [options]
 * @param {() => string} [options.generate] 口令生成器。默认是本模块自己的随机短句；
 *        插件装配时传入口令池的 `issue()`，这样本机口令和租户口令共享同一个命名空间。
 */
export function loadAccessKeyState(file, seed, options = {}) {
  const generate = typeof options.generate === 'function' ? options.generate : () => generatePassphrase().password
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof parsed?.accessKey === 'string' && parsed.accessKey.length >= 12) {
      return {
        file,
        accessKey: parsed.accessKey,
        epoch: Number.isFinite(Number(parsed.epoch)) ? Number(parsed.epoch) : 0,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : null,
        rotations: Number.isFinite(Number(parsed.rotations)) ? Number(parsed.rotations) : 0,
        generated: parsed.generated === true,
        history: Array.isArray(parsed.history) ? parsed.history.filter((item) => typeof item === 'string') : [],
      }
    }
  } catch {
    /* 首次运行或文件坏了：落到种子 */
  }
  // 关键（服务器侧确认书 要求①）：**先落盘再展示**，绝不显示一个还没持久化的值。
  // 否则重启/重连后 key 变了，用户手里的链接就变成"上一代"的。
  const seeded = typeof seed === 'string' && seed !== '' ? seed : generate()
  const fresh = {
    accessKey: seeded,
    epoch: 0,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    rotations: 0,
    generated: seed === '',
  }
  try {
    saveAccessKeyState(file, fresh)
  } catch {
    /* 落盘失败也要能用（内存里仍然一致），但下次启动会重新播种 */
  }
  return { file, ...fresh }
}

/** 原子写访问口令状态（0600）。 */
export function saveAccessKeyState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.tmp-' + String(process.pid)
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** 稳定插件名。 */
export const name = 'remote-connect'

/**
 * 插件配置的**严格校验**（Cordis 在插件启动前调用 `Config['~standard'].validate`）。
 *
 * 这里刻意**不依赖 `@deepseek-ai/schemastery`**：本插件装在各用户的 profile 目录下，
 * 那里解析不到 harness 自己的 node_modules，静态 import 会直接让插件装载失败。
 * Standard Schema 只要求 `{ '~standard': { version, vendor, validate } }` 这个形状，
 * loader 也只读 `'~standard'`，因此手写即可满足官方机制且零依赖。
 *
 * 校验边界：**格式非法**（端口越界、域名不像主机名、tunnel 取值未知）在装载时就报错——
 * 对应 AGENTS.md 的 "misconfiguration fails loud"；而"启用了公网但还没填域名"这类
 * **语义未就绪**不算非法配置，保留为面板警告 + 启动时的明确报错（不能因此把局域网一起弄挂）。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-plugin-remote-connect-beta',
    /**
     * @param {unknown} value 组合里这一行的 config
     * @returns {{ value: object } | { issues: Array<{ message: string }> }}
     */
    validate(value) {
      const problems = malformedConfigProblems(value)
      if (problems.length > 0) return { issues: problems.map((message) => ({ message })) }
      const { problems: _ignored, ...normalized } = normalizeConfig(value)
      return { value: normalized }
    },
  },
}

/**
 * 只判"格式非法"，不判"还没配好"。
 * @param {unknown} raw
 * @returns {string[]}
 */
function malformedConfigProblems(raw) {
  const problems = []
  const config = asRecord(raw)
  const lan = asRecord(config.lan)
  const publicBlock = asRecord(config.public)
  const ssh = asRecord(publicBlock.ssh)
  const upstream = asRecord(config.upstream)
  const badPort = (value) =>
    value !== undefined && (!Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535)
  if (badPort(lan.port)) problems.push('lan.port 必须是 1–65535 的整数')
  if (badPort(publicBlock.port)) problems.push('public.port 必须是 1–65535 的整数')
  if (badPort(ssh.port)) problems.push('public.ssh.port 必须是 1–65535 的整数')
  if (badPort(ssh.remotePort)) problems.push('public.ssh.remotePort 必须是 1–65535 的整数')
  // upstream.port = 0 是"自动探测"的哨兵值，不是非法输入
  if (
    upstream.port !== undefined &&
    (!Number.isSafeInteger(Number(upstream.port)) || Number(upstream.port) < 0 || Number(upstream.port) > 65535)
  ) {
    problems.push('upstream.port 必须是 0–65535 的整数（0 = 自动探测）')
  }
  const domain = asString(publicBlock.domain)
  if (domain !== '' && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) {
    problems.push('public.domain 不是合法主机名：' + JSON.stringify(domain))
  }
  const tunnelMode = asString(publicBlock.tunnel, 'ssh')
  if (!['ssh', 'cloudflared', 'tailscale', 'none'].includes(tunnelMode)) {
    problems.push('public.tunnel 只能是 ssh / cloudflared / tailscale / none，收到 ' + JSON.stringify(tunnelMode))
  }
  const tailscale = asRecord(publicBlock.tailscale)
  if (badPort(tailscale.httpsPort)) problems.push('public.tailscale.httpsPort 必须是 1–65535 的整数')
  if (
    tailscale.probeMs !== undefined &&
    (!Number.isSafeInteger(Number(tailscale.probeMs)) || Number(tailscale.probeMs) < 5000)
  ) {
    problems.push('public.tailscale.probeMs 必须是不小于 5000 的整数（毫秒）')
  }
  const key = asString(publicBlock.accessKey)
  if (key !== '' && !/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    problems.push('public.accessKey 需为 16–128 位的 URL 安全字符（[A-Za-z0-9_-]）')
  }
  if (config.mobileAdaptation !== undefined && typeof config.mobileAdaptation !== 'boolean') {
    problems.push('mobileAdaptation 必须是布尔值')
  }
  const tenants = asRecord(config.tenants)
  if (tenants.enabled !== undefined && typeof tenants.enabled !== 'boolean') {
    problems.push('tenants.enabled 必须是布尔值')
  }
  const tenantsHarness = asRecord(tenants.harness)
  for (const key of ['bin', 'node']) {
    if (tenantsHarness[key] !== undefined && typeof tenantsHarness[key] !== 'string') {
      problems.push('tenants.harness.' + key + ' 必须是路径字符串')
    }
  }
  if (tenantsHarness.extraArgs !== undefined && !Array.isArray(tenantsHarness.extraArgs)) {
    problems.push('tenants.harness.extraArgs 必须是字符串数组')
  }
  if (Array.isArray(tenants.harness?.extraArgs) && tenants.harness.extraArgs.some((item) => typeof item !== 'string')) {
    problems.push('tenants.harness.extraArgs 只能包含字符串')
  }
  if (Array.isArray(tenants.list)) {
    tenants.list.forEach((item, index) => {
      const { problems: itemProblems } = normalizeTenant(item)
      for (const problem of itemProblems) problems.push('tenants.list[' + String(index) + ']：' + problem)
    })
  }
  return problems
}

/**
 * 依赖 Web 服务（路由注册）。
 * `connection` 只作为可选依赖在运行时用 ctx.get 读取——它提供官方取令牌方式，
 * 但并非所有 profile 都有 Web 载体，因此不能声明为硬依赖。
 */
export const inject = ['webServer']

/** 面板 API 前缀。 */
const API_PREFIX = '/remote-connect/api'

/** 代理注入的来源标记头（客户端无法伪造：代理始终先删除再覆写）。 */
const ORIGIN_HEADER = 'x-remote-connect-origin'

/**
 * 日志/启动提示的语言：日志写在 Harness 日志文件里，没有"请求语言"可用，
 * 因此按进程环境推断（DSH_REMOTE_LANG > LC_ALL > LC_MESSAGES > LANG，兜底英文）。
 */
const tLog = translator(resolveLocale())

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function asPort(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback
}

/**
 * 归一化组合里的 config：不引第三方 schema，手写校验并把错误说人话。
 * @param {unknown} raw
 */
export function normalizeConfig(raw) {
  const config = asRecord(raw)
  const lan = asRecord(config.lan)
  const publicBlock = asRecord(config.public)
  const ssh = asRecord(publicBlock.ssh)
  const upstream = asRecord(config.upstream)
  const problems = []

  const domain = asString(publicBlock.domain)
  const sshUser = asString(ssh.user)
  const sshHost = asString(ssh.host, domain)
  const tunnelMode = asString(publicBlock.tunnel, 'ssh')
  if (publicBlock.enabled === true || domain !== '') {
    // 域名只有"自建服务器"这条路需要：cloudflared 给临时域名，tailscale 用节点自带的 ts.net 域名
    if (domain === '' && tunnelMode === 'ssh') problems.push('public.domain 必填（公网域名）')
    if (tunnelMode === 'ssh' && (sshUser === '' || sshHost === '')) {
      problems.push('public.tunnel=ssh 时需要 public.ssh.user 与 public.ssh.host')
    }
  }

  return {
    problems,
    lan: {
      enabled: lan.enabled === true,
      port: asPort(lan.port, 8787),
    },
    public: {
      enabled: publicBlock.enabled === true,
      domain,
      port: asPort(publicBlock.port, 8788),
      accessKey: asString(publicBlock.accessKey),
      gateTtlHours: Number.isFinite(Number(publicBlock.gateTtlHours))
        ? Number(publicBlock.gateTtlHours)
        : 12,
      tunnel: ['cloudflared', 'tailscale', 'none'].includes(tunnelMode) ? tunnelMode : 'ssh',
      tailscale: {
        path: asString(asRecord(publicBlock.tailscale).path, 'tailscale'),
        httpsPort: asPort(asRecord(publicBlock.tailscale).httpsPort, 443),
        probeMs: Number.isFinite(Number(asRecord(publicBlock.tailscale).probeMs))
          ? Number(asRecord(publicBlock.tailscale).probeMs)
          : 60000,
      },
      ssh: {
        user: sshUser,
        host: sshHost,
        keyPath: asString(ssh.keyPath, path.join(os.homedir(), '.ssh', 'dsh_remote_tunnel')),
        remotePort: asPort(ssh.remotePort, asPort(publicBlock.port, 8788)),
        // 服务器 sshd 端口：非 22 时必须显式配置，否则隧道拨不通
        port: asPort(ssh.port, 22),
      },
      // 去重：Config 校验后的对象会再归一化一次（apply 里），重复会让白名单越滚越长
      allowedHosts: [
        ...new Set(
          []
            .concat(asString(publicBlock.domain) === '' ? [] : [asString(publicBlock.domain)])
            .concat(
              Array.isArray(publicBlock.allowedHosts)
                ? publicBlock.allowedHosts.filter((item) => typeof item === 'string')
                : [],
            ),
        ),
      ],
    },
    tenants: {
      enabled: asRecord(config.tenants).enabled === true,
      // 注册表与租户 home 的落点：默认放在「插件状态目录」与「家目录/DSH-tenants」
      registry: asString(asRecord(config.tenants).registry, defaultRegistryPath()),
      baseDir: asString(asRecord(config.tenants).baseDir, defaultTenantBaseDir()),
      autostart: asRecord(config.tenants).autostart !== false,
      harness: {
        bin: asString(asRecord(asRecord(config.tenants).harness).bin),
        node: asString(asRecord(asRecord(config.tenants).harness).node),
        extraArgs: Array.isArray(asRecord(asRecord(config.tenants).harness).extraArgs)
          ? asRecord(asRecord(config.tenants).harness).extraArgs.filter((item) => typeof item === 'string')
          : [],
      },
      // 组合里可以直接预置租户（面板/CLI 增删的是注册表文件）
      list: Array.isArray(asRecord(config.tenants).list)
        ? asRecord(config.tenants).list.filter((item) => typeof item === 'object' && item !== null)
        : [],
    },
    upstream: {
      port: asPort(upstream.port, 0),
      token: asString(upstream.token),
      logPaths: [
        ...new Set(
          []
            .concat(Array.isArray(upstream.logPaths) ? upstream.logPaths.filter((item) => typeof item === 'string') : [])
            .concat(defaultLogCandidates()),
        ),
      ],
    },
    mobileAdaptation: config.mobileAdaptation !== false,
  }
}

/**
 * 注册插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = (message) => {
    if (ctx.logger?.info !== undefined) ctx.logger.info('[remote-connect] ' + message)
    else process.stdout.write('[remote-connect] ' + message + '\n')
  }

  // ── 口令池：本机唯一的口令命名空间 ──────────────────────────────
  // 这台机器上不止一把口令：本机访问口令 + 每个租户各一把。它们必须**两两不同**
  //（含已经退休的旧值），并且一把口令只指向一个上游 Harness —— 见 core/keypool.js。
  const auditFile = path.join(pluginStateDir(), 'audit.log')

  /** 本地审计：只记时间与事件，绝不记口令。 */
  function audit(event) {
    try {
      fs.mkdirSync(path.dirname(auditFile), { recursive: true, mode: 0o700 })
      fs.appendFileSync(auditFile, new Date().toISOString() + ' ' + event + '\n', { mode: 0o600 })
    } catch {
      /* 审计写不进去不影响主流程 */
    }
  }

  // keys-used.json（查重账本：只存指纹）与 access-key.json（当前口令 + 代次）分开。
  // reserved() 是**惰性**的：装配完成之前不会被调用，所以这里可以先引用还没赋值的变量。
  let tenancy = null
  let accessKey = ''
  const keyPool = createKeyPool({
    file: path.join(pluginStateDir(), 'keys-used.json'),
    log,
    generate: () => generateAccessKey(),
    reserved: () =>
      [accessKey].concat(tenancy === null ? [] : tenancy.registry.list().map((tenant) => tenant.accessKey)),
  })

  // 访问口令：**机器生成**，面板只能"一键换新"（手输那条路已删除，见 README）。
  // 组合里的 public.accessKey 只是"初始种子"，运行时的真值存在状态文件里，
  // 这样面板轮换不需要改用户的 cordis.patch.yml。
  const keyState = loadAccessKeyState(
    path.join(pluginStateDir(), 'access-key.json'),
    config.public.accessKey,
    { generate: () => keyPool.issue().value },
  )
  accessKey = keyState.accessKey
  let keyEpoch = keyState.epoch
  const generatedKey = keyState.generated
  // β2 → β3 迁移：旧状态文件里的口令历史搬进口令池；当前值也占位（活跃 = 已占用）
  keyPool.adopt(keyState.history)
  keyPool.remember(accessKey)

  /** 轮换串行化：查重与写入必须在同一把锁内，两个并发请求不能双双通过。 */
  let rotateChain = Promise.resolve()
  function withRotateLock(fn) {
    const run = rotateChain.then(fn, fn)
    rotateChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * 换一把访问口令：写盘 + 代次 +1（旧链接与旧 Cookie 立即失效）。
   *
   * 口令是**机器生成**的：这里没有"手输新口令"的参数，也没有"先验旧口令"的再认证 ——
   * 那条路已经删除（见 README「换一个新口令」）。理由：让人自己想一个口令，结局通常是
   * 弱口令；而这一步真正的破坏性（旧链接全失效）由面板的一键 + 显式确认承担，
   * 调用入口本身已经是"只有宿主窗口能动"（requireLocalControl）。
   * 旧值会进池子退休区：它不可能再被发给任何人。
   */
  function rotateAccessKey() {
    const value = keyPool.issue().value
    const problems = checkAccessKeyStrength(value)
    if (problems.length > 0) {
      // 理论上到不了：生成器给的是 32 位 URL 安全随机串。真到了说明生成器被换错了。
      const error = new Error('生成的口令没通过强度校验（生成器有问题）：' + problems.join('；'))
      error.problems = problems
      error.statusCode = 500
      throw error
    }
    if (value === accessKey || keyPool.isTaken(value)) {
      const error = new Error('这个口令已经被占用（本机不允许两处使用同一把口令，也不许复用旧口令），请再点一次')
      error.statusCode = 409
      throw error
    }
    keyPool.remember(accessKey) // 旧口令退休：永不再发
    keyPool.remember(value) // 新口令占位：活跃 = 已占用
    accessKey = value
    keyEpoch += 1
    keyState.rotations += 1
    keyState.updatedAt = new Date().toISOString()
    saveAccessKeyState(keyState.file, {
      accessKey,
      epoch: keyEpoch,
      createdAt: keyState.createdAt ?? new Date().toISOString(),
      updatedAt: keyState.updatedAt,
      rotations: keyState.rotations,
      generated: keyState.generated,
      // 兼容 β2 的字段：镜像口令池最近 50 条指纹（真值在 keys-used.json）
      history: keyPool.fingerprints().slice(-50),
    })
    return { accessKey, epoch: keyEpoch }
  }

  // ── 多租户：一个网关 + 每租户一个独立 Harness 实例 ──────────
  tenancy = createTenancy({
    config: config.tenants,
    log,
    keyPool,
    onState: () => {
      // 实例状态变化时不需要额外动作：面板每次 /state 都重新汇总
    },
  })
  const gateSecretFile = defaultGateSecretPath()
  const gateSecret = loadOrCreateGateSecret(gateSecretFile, logOnce).secret
  /** 路由表：proxy 只认 findById/findByKey 两个方法。 */
  const tenantRouter = config.tenants.enabled
    ? { findById: (id) => tenancy.handle(id), findByKey: (key) => tenancy.findByKey(key) }
    : null

  let lanProxy = null
  let publicProxy = null
  let tunnel = null
  let lastError = null
  let busy = false

  /**
   * 上游端口：优先取配置，其次问 webServer 服务（官方 Web 载体自己知道实际监听端口），
   * 都没有时交给 proxy 从日志发现。**不硬编码任何默认端口**——CLI 默认 3080、
   * DSH Desktop 是 43129，写死任何一个都会在一半用户的机器上连错。
   * @returns {number|undefined}
   */
  function resolveUpstreamPort() {
    if (config.upstream.port > 0) return config.upstream.port
    const port = ctx.webServer === undefined ? undefined : ctx.webServer.port
    return typeof port === 'number' && port > 0 ? port : undefined
  }

  /**
   * 浏览器会话令牌：优先用 connection 服务的 authenticatedUrl()（官方支持的取令牌方式，
   * dsh-web-app 自己就是这么拿的），失败再退回日志发现。
   * @param {number|undefined} port
   * @returns {string}
   */
  function resolveToken(port) {
    if (config.upstream.token !== '') return config.upstream.token
    const connection = ctx.get('connection')
    if (connection === undefined || typeof connection.authenticatedUrl !== 'function') return ''
    if (port === undefined) return ''
    try {
      const url = connection.authenticatedUrl('http://127.0.0.1:' + String(port))
      const token = new URL(url).searchParams.get('token')
      return typeof token === 'string' ? token : ''
    } catch (error) {
      log('从 connection 服务取令牌失败，回退到日志发现：' + String(error && error.message ? error.message : error))
      return ''
    }
  }

  function upstreamOptions() {
    const port = resolveUpstreamPort()
    const options = {
      // 不在这里同步取令牌：connection 服务可能还没挂载（官方也用 ctx.inject 等它），
      // 交给 proxy 在真正发请求时惰性解析。
      token: config.upstream.token,
      tokenProvider: () => resolveToken(port),
      logPaths: config.upstream.logPaths,
      mobileAdaptation: config.mobileAdaptation,
    }
    if (port !== undefined) options.upstreamPort = port
    return options
  }

  /**
   * 拼某个租户的入口地址。
   * 多租户下"入口"不是一条链接而是一人一条，所以这里按 (base, key) 组合。
   */
  function tenantEntry(base, key) {
    if (base === null) return null
    return key === '' ? base : base + '?k=' + encodeURIComponent(key)
  }

  /** 租户列表（含每人的局域网/公网链接），给面板与 CLI 用。 */
  function tenantList() {
    if (!config.tenants.enabled) return []
    const lanBase = lanProxy === null ? null : lanProxy.info().lanUrl
    const publicBase = config.public.domain === '' ? null : 'https://' + config.public.domain + '/'
    return tenancy.list().map((tenant) => ({
      ...tenant,
      lanEntry: tenantEntry(lanBase, tenant.accessKey),
      publicEntry: tenantEntry(publicBase, tenant.accessKey),
    }))
  }

  function lanState() {
    if (lanProxy === null) return { running: false, url: null, port: config.lan.port }
    const info = lanProxy.info()
    return { running: info.running, url: info.lanUrl, port: info.port, hasToken: info.hasToken }
  }

  /**
   * 隧道状态按请求语言渲染：状态本身只带 code + params（见 core/tunnel.js），
   * 语言由调用方（面板请求）决定，CLI 与日志用英文兜底。
   */
  function tunnelView(locale) {
    if (tunnel === null) return null
    const state = tunnel.state()
    const t = translator(locale)
    const view = { ...state, detail: t(state.code, state.params) }
    if (state.hintCode !== undefined) view.hint = t(state.hintCode)
    return view
  }

  function publicState(locale) {
    const info = publicProxy === null ? null : publicProxy.info()
    const base = config.public.domain === '' ? null : 'https://' + config.public.domain + '/'
    const entry = base === null ? null : base + (accessKey === '' ? '' : '?k=' + accessKey)
    return {
      running: info !== null && info.running,
      domain: config.public.domain,
      port: info === null ? config.public.port : info.port,
      entry,
      tunnel: tunnelView(locale),
      tunnelUrl: tunnel === null ? null : tunnel.state().publicUrl,
      accessKeyGenerated: generatedKey,
      // 面板默认只看到掩码；明文要单独调 /access-key/reveal（且只允许宿主窗口）
      accessKeyMasked: accessKey === '' ? null : accessKey.slice(0, 2) + '••••••' + accessKey.slice(-2),
      accessKeyUpdatedAt: keyState.updatedAt,
      // 让用户"一眼确认手上这条链接是不是当前这条"（确认书 要求①/④）
      // 指纹 = sha256 前 16 位，**不是**口令本身的一截：面板与 /_dsh/health 都会展示它，
      // 而这两个地方都不该泄露任何一位明文（"前 8 位 + 后 4 位"看着像指纹，其实是明文）。
      accessKeyFingerprint: fingerprintKey(accessKey),
      accessKeyCreatedAt: keyState.createdAt,
      accessKeyRotations: keyState.rotations,
      accessKeyExpiresAt: null,
      hasToken: info === null ? null : info.hasToken,
    }
  }

  /**
   * 上游来源自证：端口来自 config 还是 webServer，令牌来自 config / connection / 日志。
   * 面板与 doctor 都靠它证明"没有硬编码端口"。
   */
  function upstreamReport() {
    const configured = config.upstream.port > 0
    const wsPort = ctx.webServer === undefined ? undefined : ctx.webServer.port
    const hasWsPort = typeof wsPort === 'number' && wsPort > 0
    const port = configured ? config.upstream.port : hasWsPort ? wsPort : null
    const source = configured ? 'config' : hasWsPort ? 'webServer' : 'undiscovered'
    const info = lanProxy !== null ? lanProxy.info() : publicProxy !== null ? publicProxy.info() : null
    if (info !== null) {
      return {
        port: Number(String(info.upstream).split(':').pop()),
        // 代理只区分 explicit/log/default；explicit 的真实来源由这里给出
        source: info.upstreamSource === 'explicit' ? source : info.upstreamSource,
        hasToken: info.hasToken,
        tokenSource: info.tokenSource,
      }
    }
    const token = resolveToken(port === null ? undefined : port)
    return {
      port,
      source,
      hasToken: config.upstream.token !== '' || token !== '',
      tokenSource: config.upstream.token !== '' ? 'config' : token !== '' ? 'connection' : 'idle',
    }
  }

  function snapshot(canControl = true, locale) {
    return {
      ok: true,
      busy,
      canControl,
      upstream: upstreamReport(),
      config: {
        lanPort: config.lan.port,
        publicDomain: config.public.domain,
        publicPort: config.public.port,
        tunnel: config.public.tunnel,
        sshUser: config.public.ssh.user,
        sshHost: config.public.ssh.host,
        sshKeyPath: config.public.ssh.keyPath,
        sshPort: config.public.ssh.port,
        remotePort: config.public.ssh.remotePort,
        problems: config.problems,
      },
      tenants: {
        enabled: config.tenants.enabled,
        registry: config.tenants.registry,
        baseDir: config.tenants.baseDir,
        // 找不到 harness 入口时，面板要能直接说人话（而不是所有租户都起不来）
        harness: config.tenants.enabled ? tenancy.harness : null,
        list: tenantList(),
      },
      lan: lanState(),
      public: publicState(locale),
      qr: (() => {
        const url = lanState().url ?? publicState().entry
        return url === null ? null : qrRows(url)
      })(),
      error: lastError,
    }
  }

  async function startLan() {
    if (lanProxy !== null) return
    lanProxy = createProxy({
      ...upstreamOptions(),
      port: config.lan.port,
      listenHost: '0.0.0.0',
      // 局域网入口**不设口令**（同网段打开即用，设计如此）；多租户时按各自的 ?k= 路由。
      // ⚠️ 这里绝对不能接 accessKeyProvider：接了就等于给局域网整站加了密码，
      //    所有不带 ?k= 的请求（包括面板 API）都会变成 404。
      accessKey: '',
      gateSecret,
      tenants: tenantRouter,
    })
    try {
      await lanProxy.start()
      lastError = null
      log('局域网入口已启动：' + String(lanProxy.info().lanUrl))
      // 局域网口一开，租户实例也要在：否则访客拿到的是 503
      if (config.tenants.enabled) {
        const started = tenancy.startAutostart()
        if (started.length > 0) log('已拉起租户实例：' + started.join('、'))
      }
    } catch (error) {
      lastError = String(error?.message ?? error)
      lanProxy = null
      throw error
    }
  }

  async function stopLan() {
    const current = lanProxy
    lanProxy = null
    if (current !== null) await current.stop()
    // 入口关了就把租户实例一起收掉：否则一堆 Harness 在后台白跑
    if (config.tenants.enabled) await tenancy.stopAll()
  }

  async function startPublic() {
    if (config.public.domain === '' && config.public.tunnel === 'ssh') {
      throw new Error(tLog('host.error.needDomain'))
    }
    if (publicProxy === null) {
      publicProxy = createProxy({
        ...upstreamOptions(),
        port: config.public.port,
        listenHost: '127.0.0.1',
        accessKey: config.tenants.enabled ? '' : accessKey,
        accessKeyProvider: config.tenants.enabled ? null : () => accessKey,
        keyEpochProvider: () => keyEpoch,
        healthProvider: () => ({
          tunnel: tunnel === null ? 'down' : tunnel.state().phase,
          keyFingerprint: fingerprintKey(accessKey),
          keyCreatedAt: keyState.createdAt,
          keyRotations: keyState.rotations,
        }),
        gateSecret: config.tenants.enabled ? gateSecret : undefined,
        tenants: tenantRouter,
        allowedHosts: config.public.allowedHosts,
        gateTtlHours: config.public.gateTtlHours,
      })
      await publicProxy.start()
      log('公网监听已就绪：127.0.0.1:' + String(publicProxy.info().port) + '（仅回环，等待隧道）')
    }
    if (tunnel === null && config.public.tunnel !== 'none') {
      tunnel = createTunnel({
        mode: config.public.tunnel,
        localPort: publicProxy.info().port,
        remotePort: config.public.ssh.remotePort,
        port: config.public.ssh.port,
        user: config.public.ssh.user,
        host: config.public.ssh.host,
        keyPath: config.public.ssh.keyPath,
        tailscalePath: config.public.tailscale.path,
        tailscaleHttpsPort: config.public.tailscale.httpsPort,
        tailscaleProbeMs: config.public.tailscale.probeMs,
        log,
        onState: (state) => {
          if (state.phase === 'up') log(tLog(state.code, state.params))
          else if (state.phase === 'reconnecting' || state.phase === 'error') log(tLog(state.code, state.params))
        },
      })
      tunnel.start()
    }
    lastError = null
  }

  async function stopPublic() {
    const currentTunnel = tunnel
    const currentProxy = publicProxy
    tunnel = null
    publicProxy = null
    if (currentTunnel !== null) await currentTunnel.stop()
    if (currentProxy !== null) await currentProxy.stop()
  }

  function requireLocalControl(req, locale) {
    const origin = String(req.headers[ORIGIN_HEADER] ?? '')
    if (origin === 'public' || origin === 'lan') {
      const error = new Error(translator(locale)(origin === 'public' ? 'host.error.gate.public' : 'host.error.gate.lan'))
      error.statusCode = 403
      throw error
    }
  }

  /** 读 JSON 请求体（面板的租户管理接口用）；空体返回 {}。 */
  function readJsonBody(req, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        if (text === '') {
          resolve({})
          return
        }
        try {
          const parsed = JSON.parse(text)
          resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
        } catch (error) {
          reject(Object.assign(new Error('请求体不是合法 JSON：' + String(error?.message ?? error)), { statusCode: 400 }))
        }
      })
      req.on('error', reject)
    })
  }

  function sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(body.length),
    })
    res.end(body)
  }

  function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
    const body = Buffer.from(text, 'utf8')
    res.writeHead(status, {
      'content-type': contentType,
      'cache-control': 'no-store',
      'content-length': String(body.length),
    })
    res.end(body)
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://placeholder')
    const pathname = url.pathname
    const route = pathname.slice(API_PREFIX.length).replace(/\/+$/u, '') || '/'
    const method = req.method ?? 'GET'
    // 文案语言由请求方给（面板会带自己当前的语言），未知取值退回英文
    const locale = normalizeLocale(url.searchParams.get('locale'))
    const t = translator(locale)
    // 代理会强制覆写该头；宿主机窗口直连时不存在 → 允许控制
    const canControl = req.headers[ORIGIN_HEADER] === undefined
    try {
      if (route === '/' || route === '/state') {
        if (method !== 'GET') throw Object.assign(new Error(t('host.error.method', { method: 'GET' })), { statusCode: 405 })
        sendJson(res, 200, snapshot(canControl, locale))
        return
      }
      if (route === '/access-key') {
        if (method !== 'GET') throw Object.assign(new Error(t('host.error.method', { method: 'GET' })), { statusCode: 405 })
        sendJson(res, 200, {
          ok: true,
          masked: accessKey.slice(0, 2) + '••••••' + accessKey.slice(-2),
          updatedAt: keyState.updatedAt,
        })
        return
      }
      if (route === '/access-key/reveal') {
        // 明文只在宿主窗口给（远程访客即使猜到这个接口也拿不到）
        if (method !== 'POST') throw Object.assign(new Error(t('host.error.method', { method: 'POST' })), { statusCode: 405 })
        requireLocalControl(req, locale)
        sendJson(res, 200, { ok: true, accessKey })
        return
      }
      if (route === '/access-key/rotate') {
        // 唯一的改口令入口：**一键换新**。没有"手输新口令"，也不需要旧口令 ——
        // 口令是机器生成的一次性凭据，用户不该、也没法记住它（见 README）。
        if (method !== 'POST') throw Object.assign(new Error(t('host.error.method', { method: 'POST' })), { statusCode: 405 })
        requireLocalControl(req, locale)
        if (busy) throw Object.assign(new Error(t('host.error.busy')), { statusCode: 409 })
        busy = true
        let rotated
        try {
          const body = await readJsonBody(req)
          // 显式确认：这一步会让旧链接、旧 Cookie 立刻失效，值得多按一次
          if (body.acknowledge !== true) {
            throw Object.assign(new Error(t('host.error.keyRotateNeedsAck')), { statusCode: 400 })
          }
          rotated = await withRotateLock(() => rotateAccessKey())
        } catch (error) {
          lastError = String(error?.message ?? error)
          throw error
        } finally {
          busy = false
        }
        audit('access-key rotated (host window confirmed; value generated on the machine)')
        log('访问口令已轮换（旧链接与旧 Cookie 立即失效）')
        sendJson(res, 200, {
          ok: true,
          accessKey: rotated.accessKey,
          entry: config.public.domain === '' ? null : 'https://' + config.public.domain + '/?k=' + rotated.accessKey,
          epoch: rotated.epoch,
        })
        return
      }
      if (route === '/snippets') {
        if (method !== 'GET') throw Object.assign(new Error(t('host.error.method', { method: 'GET' })), { statusCode: 405 })
        const kind = url.searchParams.get('kind') ?? 'nginx'
        const domain = config.public.domain === '' ? 'dsh.example.com' : config.public.domain
        const targetPort = config.public.ssh.remotePort
        const sections = [
          serverSetupSteps({ targetPort, user: config.public.ssh.user || 'dshtunnel' }),
          '',
          '--- authorized_keys 限制行（公钥用 dsh-remote keygen 生成）---',
          authorizedKeysLine('<你的公钥>', targetPort),
          '',
          kind === 'caddy'
            ? caddySite({ domain, targetPort })
            : '# /etc/nginx/conf.d/upgrade-map.conf\n' + NGINX_UPGRADE_MAP + '\n\n' + nginxServerBlock({ domain, targetPort }),
          '',
          '--- 本机隧道命令 ---',
          sshTunnelCommand({
            user: config.public.ssh.user || 'dshtunnel',
            host: config.public.ssh.host || domain,
            keyPath: config.public.ssh.keyPath,
            port: config.public.ssh.port,
            localPort: targetPort,
            remotePort: targetPort,
          }),
        ]
        sendText(res, 200, sections.join('\n'))
        return
      }
      if (route === '/check') {
        if (method !== 'POST') throw Object.assign(new Error(t('host.error.method', { method: 'POST' })), { statusCode: 405 })
        const tailscaleMode = config.public.tunnel === 'tailscale'
        if (config.public.domain === '' && !tailscaleMode) {
          throw Object.assign(new Error(t('host.error.needDomainCheck')), { statusCode: 400 })
        }
        const results = await runPreflight({
          domain: config.public.domain,
          locale,
          tunnelMode: config.public.tunnel,
          tailscalePath: config.public.tailscale.path,
          sshUser: config.public.ssh.user,
          sshHost: config.public.ssh.host,
          sshKeyPath: config.public.ssh.keyPath,
          sshPort: config.public.ssh.port,
          localPort: config.public.ssh.remotePort,
          remotePort: config.public.ssh.remotePort,
        })
        sendJson(res, 200, { ok: true, results })
        return
      }
      if (route.startsWith('/tenants')) {
        if (config.tenants.enabled !== true) {
          throw Object.assign(new Error(t('host.error.tenantsOff')), { statusCode: 400 })
        }
        const action = route.slice('/tenants'.length).replace(/^\//u, '')
        if (action === '') {
          if (method !== 'GET') throw Object.assign(new Error(t('host.error.method', { method: 'GET' })), { statusCode: 405 })
          sendJson(res, 200, { ok: true, tenants: tenantList(), harness: tenancy.harness })
          return
        }
        if (action === 'qr') {
          if (method !== 'GET') throw Object.assign(new Error(t('host.error.method', { method: 'GET' })), { statusCode: 405 })
          const wanted = url.searchParams.get('id') ?? ''
          const tenant = tenantList().find((item) => item.id === wanted)
          if (tenant === undefined) {
            throw Object.assign(new Error(t('host.error.tenantUnknown', { id: wanted })), { statusCode: 404 })
          }
          // 二维码画的是"他拿到的那条链接"（局域网优先，因为它现在就能用）
          const link = tenant.lanEntry ?? tenant.publicEntry ?? null
          sendJson(res, 200, { ok: true, id: tenant.id, url: link, rows: link === null ? null : qrRows(link) })
          return
        }
        // 增删改与开关一样，只允许宿主机窗口操作：访客不能给自己或别人开租户
        if (method !== 'POST') throw Object.assign(new Error(t('host.error.method', { method: 'POST' })), { statusCode: 405 })
        requireLocalControl(req, locale)
        if (busy) throw Object.assign(new Error(t('host.error.busy')), { statusCode: 409 })
        busy = true
        try {
          const body = await readJsonBody(req)
          if (action === 'add') {
            const created = tenancy.add(body)
            sendJson(res, 200, { ok: true, tenant: tenancy.describe(created.tenant.id), tenants: tenantList() })
            return
          }
          const id = typeof body.id === 'string' ? body.id : ''
          if (id === '') throw Object.assign(new Error(t('host.error.tenantIdRequired')), { statusCode: 400 })
          if (tenancy.registry.get(id) === null) {
            throw Object.assign(new Error(t('host.error.tenantUnknown', { id })), { statusCode: 404 })
          }
          if (action === 'remove') await tenancy.remove(id)
          else if (action === 'rotate') tenancy.rotate(id)
          else if (action === 'start') tenancy.start(id)
          else if (action === 'stop') await tenancy.stop(id)
          else throw Object.assign(new Error(t('host.error.unknownRoute', { route })), { statusCode: 404 })
        } catch (error) {
          lastError = String(error?.message ?? error)
          throw error
        } finally {
          busy = false
        }
        sendJson(res, 200, { ok: true, tenants: tenantList() })
        return
      }
      if (route === '/lan/start' || route === '/lan/stop' || route === '/public/start' || route === '/public/stop') {
        if (method !== 'POST') throw Object.assign(new Error(t('host.error.method', { method: 'POST' })), { statusCode: 405 })
        requireLocalControl(req, locale)
        if (busy) throw Object.assign(new Error(t('host.error.busy')), { statusCode: 409 })
        busy = true
        try {
          if (route === '/lan/start') await startLan()
          else if (route === '/lan/stop') await stopLan()
          else if (route === '/public/start') await startPublic()
          else await stopPublic()
        } catch (error) {
          lastError = String(error?.message ?? error)
          throw error
        } finally {
          busy = false
        }
        sendJson(res, 200, snapshot())
        return
      }
      throw Object.assign(new Error(t('host.error.unknownRoute', { route })), { statusCode: 404 })
    } catch (error) {
      const status = Number.isSafeInteger(error?.statusCode) ? error.statusCode : 500
      if (status >= 500) lastError = String(error?.message ?? error)
      sendJson(res, status, { ok: false, error: String(error?.message ?? error) })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handle }),
    'remote-connect: panel api',
  )

  // 生命周期：fiber 停止/升级时把监听与隧道全部回收
  ctx.effect(
    () => () => {
      void stopPublic().catch(() => {})
      void tenancy.stopAll().catch(() => {})
      void stopLan().catch(() => {})
    },
    'remote-connect: teardown',
  )

  if (config.tenants.enabled) {
    const loaded = tenancy.load()
    log(
      '多租户已启用：注册表 ' +
        config.tenants.registry +
        '（' +
        String(loaded.total) +
        ' 个租户）' +
        (tenancy.harness.problem === null ? '' : '；' + tenancy.harness.problem),
    )
    if (config.lan.enabled || config.public.enabled) tenancy.startAutostart()
  }
  if (config.problems.length > 0) {
    log('配置有问题（面板会显示，公网入口暂时不可用）：' + config.problems.join('；'))
  }
  if (config.lan.enabled) {
    void startLan().catch((error) => log('局域网入口启动失败：' + String(error?.message ?? error)))
  }
  if (config.public.enabled) {
    void startPublic().catch((error) => log('公网入口启动失败：' + String(error?.message ?? error)))
  }
  log('插件已加载' + (config.lan.enabled ? '（局域网已自动开启）' : ''))
}
