/**
 * DSH 插件（host 半）：把远程连接能力挂进 Harness 的宿主进程。
 *
 * 与"会话内动态插件"的关键区别：这里是真正的包，代理由**宿主进程内**直接运行
 * （不需要再 spawn 子进程），生命周期跟随 Cordis fiber，停止/升级时自动回收。
 *
 * 配置来自 cordis 组合里这一行的 config（没有导出 Config 时，Cordis 原样传入）：
 *
 *   - name: dsh-plugin-remote-connect
 *     config:
 *       lan:    { port: 8787 }
 *       public:
 *         domain: dsh.example.com
 *         port: 8788
 *         tunnel: ssh
 *         ssh: { user: dshtunnel, host: dsh.example.com, keyPath: ~/.ssh/dsh_remote_tunnel }
 *
 * 安全约定：面板的**开关**（启动/停止）只在宿主窗口（Host 为 loopback 且不带
 * 代理标记）可用；经代理进来的访客（无论局域网还是公网）只能读取状态。
 * 代理会强制覆写 `x-remote-connect-origin`，客户端无法伪造。
 *
 * @module dsh-plugin-remote-connect
 */
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createProxy, qrRows, defaultLogCandidates } from './core/proxy.js'
import { createTunnel } from './core/tunnel.js'
import { runPreflight } from './core/preflight.js'
import { normalizeLocale, resolveLocale, translator } from './core/messages.js'
import {
  nginxServerBlock,
  caddySite,
  authorizedKeysLine,
  sshTunnelCommand,
  serverSetupSteps,
  NGINX_UPGRADE_MAP,
} from './core/snippets.js'

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
    vendor: 'dsh-plugin-remote-connect',
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

  /** 进程内访问密钥：未配置时随机生成（重启即变，配置里固定则长期有效）。 */
  const accessKey =
    config.public.accessKey !== '' ? config.public.accessKey : crypto.randomBytes(16).toString('hex')
  const generatedKey = config.public.accessKey === ''

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
      accessKey: '',
    })
    try {
      await lanProxy.start()
      lastError = null
      log('局域网入口已启动：' + String(lanProxy.info().lanUrl))
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
        accessKey,
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
      void stopLan().catch(() => {})
    },
    'remote-connect: teardown',
  )

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
