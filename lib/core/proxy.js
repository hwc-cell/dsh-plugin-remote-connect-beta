/**
 * 反向代理核心：把一个只监听 loopback 的 DSH Harness Web 服务，暴露到
 * 局域网（0.0.0.0）或公网入口（只绑 loopback，供 ssh -R / 隧道回注）。
 *
 * 三件事必须由它来做，缺一个就不能用：
 *  1. Host/Origin 改写为 127.0.0.1:<上游端口> —— Harness 的 /api 有防
 *     DNS-rebinding 围栏，只信 loopback 或受信 authority，直连公网域名会 403。
 *  2. 首次访问补 ?token=<本次进程令牌> —— Harness 的浏览器鉴权靠"启动令牌"
 *     换签名 Cookie；令牌只在插件/进程内使用，不进 URL 历史、不进日志。
 *  3. 首页注入同源样式表与极小 shim —— 让窄屏可用（侧栏改浮层抽屉、点遮罩关闭）。
 *
 * 公网模式下额外加一道访问密钥门（?k=），不通过一律 404（不返回 401，避免暴露存在性）。
 *
 * @module dsh-plugin-remote-connect-beta/core/proxy
 */
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { translator } from './messages.js'

/** 本地资源路径：手机适配样式表。 */
export const MOBILE_CSS_PATH = '/__rc/mobile.css'

const MOBILE_CSS = [
  '.dshRcScrim{position:fixed;inset:0;z-index:39;background:rgba(0,0,0,.42);opacity:0;pointer-events:none;transition:opacity .18s ease}',
  '@media (max-width: 820px){',
  '[class*="_frame"]:has(button[aria-label="收起侧边栏"]){grid-template-columns:minmax(0,1fr) 0px 0px !important}',
  '[class*="_frame"]:has(button[aria-label="收起侧边栏"]) [class*="_sidebarCol"]{position:fixed !important;left:0;top:0;bottom:0;width:min(88vw,340px) !important;z-index:40;box-shadow:0 0 30px rgba(0,0,0,.32)}',
  'body:has(button[aria-label="收起侧边栏"]) .dshRcScrim{opacity:1;pointer-events:auto}',
  '[class*="_rightbarCol"]{display:none !important}',
  '[class*="_heroWorkspaceRow"]{flex-wrap:wrap !important}',
  '[class*="_composerSeat"],[class*="_scrollBody"]{padding-bottom:env(safe-area-inset-bottom)}',
  '}',
].join('\n')

/**
 * 只做一件事：造一个遮罩 div，点它就转发点击给应用自己的「收起侧边栏」。
 * 遮罩显隐完全由 CSS（body:has(...)）决定，因此不存在状态不同步。
 * 注意：这段代码会被拼进 <script> 里，保持零反斜杠、零引号嵌套。
 */
const SHIM_SOURCE = [
  '(function(){',
  'function start(){',
  'var s=document.createElement("div");',
  's.className="dshRcScrim";',
  's.addEventListener("click",function(){',
  'var list=document.getElementsByTagName("button");',
  'for(var i=0;i<list.length;i+=1){',
  'if(list[i].getAttribute("aria-label")==="收起侧边栏"){list[i].click();return}',
  '}',
  '});',
  'document.body.appendChild(s);',
  '}',
  'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",start)}else{start()}',
  '})()',
].join('')

const GATE_COOKIE = 'dsh-rc-gate'

/** 桌面版默认日志位置（用于自动发现启动令牌与上游端口）。 */
export function defaultLogCandidates() {
  const home = os.homedir()
  return [
    path.join(home, 'Library/Logs/DSH Desktop/harness.log'),
    path.join(home, 'Library/Logs/dsh-desktop/harness.log'),
    path.join(home, 'Library/Application Support/dsh-desktop/logs/harness.log'),
    path.join(home, '.dsh', 'harness.log'),
    path.join(home, '.local', 'state', 'dsh', 'harness.log'),
  ]
}

/** 本机非回环 IPv4，优先 192.168/10 网段。 */
export function lanAddresses() {
  const result = []
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const item of interfaces[name] || []) {
      if (item.family !== 'IPv4' || item.internal) continue
      result.push({ name, address: item.address })
    }
  }
  result.sort((a, b) => {
    const rank = (item) =>
      item.address.startsWith('192.168.') ? 0 : item.address.startsWith('10.') ? 1 : 2
    return rank(a) - rank(b)
  })
  return result
}

/**
 * 从日志里发现令牌与上游端口。日志是跨启动追加的，所以取最后一个匹配行。
 *
 * `expectPort` 很关键：DSH Desktop 的日志里留着**另一个进程**的令牌，若无条件取用，
 * 就会把别的进程的令牌注入到本进程的请求上（表现为 401）。给出 expectPort 时只接受
 * 端口一致的行，即"同进程自证"。
 *
 * @param {string[]} files 候选日志文件
 * @param {number} [expectPort] 只接受该端口的启动行
 * @returns {{ token: string, upstreamPort: number|undefined, logPath: string|undefined }}
 */
export function discoverToken(files, expectPort) {
  let token = ''
  let upstreamPort
  let logPath
  for (const file of files) {
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const at = line.indexOf('dsh web: ')
      if (at === -1) continue
      const target = line.slice(at + 'dsh web: '.length).trim().split(/\s+/)[0]
      const portMatch = /:(\d+)/.exec(target)
      const port = portMatch === null ? undefined : Number(portMatch[1])
      if (expectPort !== undefined && port !== expectPort) continue
      const tokenMatch = /[?&]token=([A-Za-z0-9_-]+)/.exec(target)
      if (tokenMatch !== null) token = tokenMatch[1]
      if (port !== undefined) upstreamPort = port
      logPath = file
    }
  }
  return { token, upstreamPort, logPath }
}

/** 把 URL 转成二维码矩阵（0/1 字符串数组）；未安装 qrcode 时返回 null。 */
export function qrRows(text) {
  let factory = null
  try {
    factory = createRequire(import.meta.url)('qrcode')
  } catch {
    return null
  }
  try {
    const code = factory.create(text, { errorCorrectionLevel: 'M' })
    const size = code.modules.size
    if (size > 57) return null
    const rows = []
    for (let row = 0; row < size; row += 1) {
      let line = ''
      for (let column = 0; column < size; column += 1) line += code.modules.get(row, column) ? '1' : '0'
      rows.push(line)
    }
    return rows
  } catch {
    return null
  }
}

function sign(value, key) {
  return crypto.createHmac('sha256', key).update(value).digest('base64url')
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function readCookie(header, name) {
  if (typeof header !== 'string') return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

function injectMobileMarkup(html) {
  let out = html
  if (out.includes('name="viewport"')) {
    out = out.replace(
      /<meta\s+name="viewport"[^>]*>/i,
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    )
  }
  const extra =
    '<link rel="stylesheet" href="' +
    MOBILE_CSS_PATH +
    '"><script>' +
    SHIM_SOURCE +
    '</script><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes">'
  return out.includes('</head>') ? out.replace('</head>', extra + '</head>') : extra + out
}

/**
 * 建一个代理实例。
 *
 * @param {object} options
 * @param {number} [options.upstreamPort=43129] 上游 Harness Web 端口
 * @param {string} [options.upstreamHost='127.0.0.1']
 * @param {string} [options.listenHost='0.0.0.0'] 绑定地址；公网入口应传 127.0.0.1
 * @param {number} [options.port=8787] 首选端口（0 = 让系统分配，用于 doctor 自测），被占用依次 +1
 * @param {number} [options.portAttempts=20]
 * @param {string} [options.token=''] 显式令牌（最高优先级）
 * @param {() => string} [options.tokenProvider] 惰性令牌提供者（如从 connection 服务取）；优先于日志发现
 * @param {string[]} [options.logPaths] 令牌候选日志
 * @param {string} [options.accessKey=''] 非空即启用访问密钥门（公网入口必填）
 * @param {string} [options.gateSecret] Cookie 签名密钥；默认与 accessKey 相同。
 *        多租户时必须给一个**独立**密钥：否则谁换了自己的 accessKey 都会顺带把别人的 Cookie 弄失效。
 * @param {object} [options.tenants] 多租户路由表（见 core/tenant.js + core/server.js）：
 *        `{ findByKey(key) -> {id, upstreamPort(), token()} | null,
 *           findById(id)  -> {id, upstreamPort(), token()} | null }`。
 *        给了它以后：`?k=` 决定进哪个租户，Cookie 里带租户 id，请求只发往该租户自己的上游。
 * @param {string[]} [options.allowedHosts=[]] 非空即只接受这些 Host
 * @param {number} [options.gateTtlHours=12] 密钥门 Cookie 有效小时数
 * @param {boolean} [options.mobileAdaptation=true] 是否注入手机适配样式
 * @param {(line: string) => void} [options.log]
 */
export function createProxy(options = {}) {
  const config = {
    upstreamHost: options.upstreamHost ?? '127.0.0.1',
    upstreamPort: options.upstreamPort ?? 43129,
    listenHost: options.listenHost ?? '0.0.0.0',
    port: options.port ?? 8787,
    portAttempts: options.portAttempts ?? 20,
    token: options.token ?? '',
    logPaths: options.logPaths ?? defaultLogCandidates(),
    accessKey: options.accessKey ?? '',
    // 允许运行中替换访问密钥（面板"生成新的"）：给了 provider 就以它为准
    accessKeyProvider: typeof options.accessKeyProvider === 'function' ? options.accessKeyProvider : null,
    keyEpochProvider: typeof options.keyEpochProvider === 'function' ? options.keyEpochProvider : null,
    // 宿主半提供 tunnel 状态与 key 元数据（指纹/创建时间/轮换次数），供 /_dsh/health 使用
    healthProvider: typeof options.healthProvider === 'function' ? options.healthProvider : null,
    // 密钥"代次"：轮换时 +1，Cookie 里带着它 → 旧 Cookie 立刻失效
    keyEpoch: Number.isFinite(Number(options.keyEpoch)) ? Number(options.keyEpoch) : 0,
    gateSecret: options.gateSecret ?? options.accessKey ?? '',
    tenants: options.tenants ?? null,
    allowedHosts: options.allowedHosts ?? [],
    gateTtlHours: options.gateTtlHours ?? 12,
    mobileAdaptation: options.mobileAdaptation !== false,
    log: options.log ?? (() => {}),
  }

  const explicitUpstreamPort = options.upstreamPort !== undefined && options.upstreamPort !== null
  const tokenProvider = typeof options.tokenProvider === 'function' ? options.tokenProvider : null
  let token = config.token
  let tokenProviderCached = false
  let upstreamPort = config.upstreamPort
  let tokenSource = token === '' ? 'none' : 'config'
  let portSource = explicitUpstreamPort ? 'explicit' : 'default'
  if (!explicitUpstreamPort) {
    // 端口本身也可以从日志发现（此时按端口自证取最后一行）
    const found = discoverToken(config.logPaths)
    if (found.upstreamPort !== undefined) {
      upstreamPort = found.upstreamPort
      portSource = 'log:' + String(found.logPath)
    }
  }
  const effectiveAuthorityPort = explicitUpstreamPort ? config.upstreamPort : upstreamPort

  /**
   * 惰性取令牌。`connection` 服务是异步挂载的（官方也是用 ctx.inject(['connection']) 等它），
   * 启动时就读会读到 undefined，所以放到"要发请求时"再解析，成功后缓存。
   * @returns {string}
   */
  function currentToken() {
    if (token !== '') return token
    if (tokenProvider !== null) {
      try {
        const value = tokenProvider()
        if (typeof value === 'string' && value !== '') {
          token = value
          tokenSource = 'connection'
          tokenProviderCached = true
          return token
        }
      } catch (error) {
        config.log('取令牌失败：' + String(error && error.message ? error.message : error))
      }
    }
    // 兜底：只认端口与本进程一致的日志行，避免拿到别的进程的令牌
    const found = discoverToken(config.logPaths, effectiveAuthorityPort)
    if (found.token !== '') {
      token = found.token
      tokenSource = found.logPath === undefined ? 'none' : 'log:' + found.logPath
    }
    return token
  }

  const authority = config.upstreamHost + ':' + String(upstreamPort)
  const origin = 'http://' + authority
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 })
  let server = null
  let boundPort = null

  /**
   * 失败页：**三种原因各一张**（未带密钥 / 密钥不正确 / 密钥已失效），
   * 对外状态码仍然是 404（不暴露入口存在性），原因只放在 `X-DSH-Reason` 响应头里。
   * 页面里不回显用户发来的 key（否则就成了密钥校验器）。
   */
  function gatePage(res, req, reason) {
    const locale = /zh/i.test(String(req.headers['accept-language'] ?? '')) ? 'zh' : 'en'
    const t = translator(locale)
    const key = reason === 'bad-key' ? 'gate.bad' : reason === 'key-unusable' ? 'gate.unusable' : 'gate.nokey'
    const body = Buffer.from(
      '<!doctype html><meta charset="utf-8"><title>' +
        t(key + '.title') +
        '</title><style>body{font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:48px 20px;background:#f6f7f9;color:#18191c}main{max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:24px 28px}h1{font-size:17px;margin:0 0 12px}</style><main><h1>' +
        t(key + '.title') +
        '</h1><p>' +
        t(key + '.body') +
        '</p><p>' +
        t('gate.longLived') +
        '</p></main>\n',
      'utf8',
    )
    res.writeHead(404, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-dsh-reason': reason,
      'content-length': String(body.length),
    })
    res.end(body)
  }

  /**
   * `GET /_dsh/health` —— 不需要密钥，只回指纹与计数，绝不回 key 本身。
   * 手机打不开时访问它，一眼分辨"隧道掉线"还是"key 不匹配"。
   */
  function sendHealth(res) {
    const meta = typeof config.healthProvider === 'function' ? config.healthProvider() || {} : {}
    const cutoff = Date.now() - 24 * 3600 * 1000
    const failures = { 'no-key': 0, 'bad-key': 0, 'key-unusable': 0, 'tunnel-down': 0 }
    for (const item of observations.failures) {
      if (item.at >= cutoff && failures[item.reason] !== undefined) failures[item.reason] += 1
    }
    if (meta.tunnel !== 'up') failures['tunnel-down'] += 1
    const body = Buffer.from(
      JSON.stringify(
        {
          tunnel: meta.tunnel ?? 'unknown',
          key_fp8: typeof meta.keyFingerprint === 'string' ? meta.keyFingerprint : fingerprint(currentAccessKey()),
          key_created_at: meta.keyCreatedAt ?? null,
          key_rotations: Number.isFinite(Number(meta.keyRotations)) ? Number(meta.keyRotations) : 0,
          key_expires_at: null,
          last_ok_at: observations.lastOkAt === null ? null : new Date(observations.lastOkAt).toISOString(),
          failures_last_24h: failures,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(body.length),
    })
    res.end(body)
  }

  /** 隧道/上游不可达时的友好页（原因头 tunnel-down，供 nginx 之外的自诊断）。 */
  function upstreamDownPage(res, req) {
    const locale = /zh/i.test(String(req.headers['accept-language'] ?? '')) ? 'zh' : 'en'
    const t = translator(locale)
    const body = Buffer.from(
      '<!doctype html><meta charset="utf-8"><title>' +
        t('gate.down.title') +
        '</title><style>body{font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:48px 20px;background:#f6f7f9;color:#18191c}main{max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:24px 28px}h1{font-size:17px;margin:0 0 12px}</style><main><h1>' +
        t('gate.down.title') +
        '</h1><p>' +
        t('gate.down.body') +
        '</p></main>\n',
      'utf8',
    )
    res.writeHead(503, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-dsh-reason': 'tunnel-down',
      'content-length': String(body.length),
    })
    res.end(body)
  }

  function notFound(res, reason = 'no-key') {
    const body = Buffer.from('not found\n', 'utf8')
    res.writeHead(404, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-dsh-reason': reason,
      'content-length': String(body.length),
    })
    res.end(body)
  }

  function hostAllowed(req) {
    if (config.allowedHosts.length === 0) return true
    const host = String(req.headers.host ?? '').split(':')[0].toLowerCase()
    return config.allowedHosts.some((entry) => entry.toLowerCase() === host)
  }

  const multiTenant = config.tenants !== null
  /** 观察数据：给 /_dsh/health 用，也是"失败态可诊断"的数据来源。 */
  const observations = { lastOkAt: null, failures: [], maxFailures: 500 }

  /** 我们发出去的 key 长什么样（32 位十六进制）。用来区分"旧链接"与"写错了"。 */
  function looksLikeKey(value) {
    return /^[0-9a-f]{32}$/i.test(String(value ?? ''))
  }

  /** key 指纹：哈希前 8 位，**绝不记录明文**。 */
  function fingerprint(value) {
    if (typeof value !== 'string' || value === '') return null
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)
  }

  function noteFailure(req, reason, presented) {
    const entry = { reason, at: Date.now() }
    observations.failures.push(entry)
    if (observations.failures.length > observations.maxFailures) observations.failures.shift()
    // 插件自己的日志：原因 + 指纹 + 长度；不含明文 key
    config.log(
      'gate denied reason=' +
        reason +
        ' key_len=' +
        String(typeof presented === 'string' ? presented.length : 0) +
        ' key_fp8=' +
        String(fingerprint(presented) ?? '-') +
        ' ip=' +
        String(req.socket?.remoteAddress ?? '-') +
        ' ua=' +
        String(req.headers['user-agent'] ?? '-').slice(0, 60),
    )
  }
  /** 当前访问密钥（可能是运行中被轮换过的新值）。 */
  function currentAccessKey() {
    if (config.accessKeyProvider !== null) {
      const value = config.accessKeyProvider()
      if (typeof value === 'string') return value
    }
    return config.accessKey
  }
  /** 当前密钥代次（轮换后旧 Cookie 立即失效）。 */
  function currentEpoch() {
    if (config.accessKeyProvider !== null && typeof config.keyEpochProvider === 'function') {
      return Number(config.keyEpochProvider()) || 0
    }
    return config.keyEpoch
  }

  /**
   * 密钥门。单租户与多租户共用一套 Cookie 机制，区别只在 Cookie 里有没有租户 id：
   *   payload = `<过期时间戳>`（单租户）或 `<过期时间戳>:<租户 id>`（多租户）
   * 用 `:` 而不是 `.`，因为 `.` 已经是 payload 与签名的分隔符。
   * @returns {{ status: 'off'|'ok'|'grant'|'deny', tenantId?: string }}
   */
  function gate(req) {
    if (!multiTenant && currentAccessKey() === '') return { status: 'off' }
    const raw = readCookie(req.headers.cookie, GATE_COOKIE)
    if (typeof raw === 'string' && raw.includes('.')) {
      const at = raw.lastIndexOf('.')
      const payload = raw.slice(0, at)
      const mac = raw.slice(at + 1)
      if (safeEqual(mac, sign(payload, config.gateSecret))) {
        // payload: `<expiresAt>:<epoch>`（单租户）或 `<expiresAt>:<epoch>:<tenantId>`（多租户）
        const parts = payload.split(':')
        const expiresAt = Number(parts[0])
        const epoch = Number(parts[1])
        const tenantId = parts.length > 2 ? parts.slice(2).join(':') : undefined
        // 代次对不上 = 密钥轮换过 → 旧 Cookie 失配（用户重新用新口令进一次即可）
        if (epoch !== currentEpoch()) return denyAfterCookie()
        if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
          if (tenantId === undefined) {
            if (!multiTenant) return { status: 'ok' }
          } else if (multiTenant && config.tenants.findById(tenantId) !== null) {
            return { status: 'ok', tenantId }
          }
        }
      }
    }
    const query = new URL(req.url ?? '/', 'http://placeholder').searchParams.get('k')
    if (typeof query === 'string' && query !== '') {
      if (multiTenant) {
        const tenant = config.tenants.findByKey(query)
        if (tenant !== null) return { status: 'grant', tenantId: tenant.id }
        return { status: 'deny', reason: looksLikeKey(query) ? 'key-unusable' : 'bad-key', presented: query }
      }
      if (currentAccessKey() !== '' && safeEqual(query, currentAccessKey())) {
        return { status: 'grant' }
      }
      // 形如"我们发出去的 key"（32 位十六进制）但不是当前值 → 多半是轮换过的旧链接；
      // 其它形态（短串、手输错）→ 直接算"密钥不正确"。两者要能区分，现场才不用猜。
      return { status: 'deny', reason: looksLikeKey(query) ? 'key-unusable' : 'bad-key', presented: query }
    }
    return { status: 'deny', reason: 'no-key' }
  }

  /** Cookie 里的代次已过期（密钥被轮换过）→ 当作没带凭据处理。 */
  function denyAfterCookie() {
    return { status: 'deny' }
  }

  /** 本次请求要发往哪个上游（含该租户自己的令牌解析）。 */
  function resolveRoute(tenantId) {
    if (multiTenant) {
      if (tenantId === undefined) return null
      const instance = config.tenants.findById(tenantId)
      if (instance === null) return null
      return { tenantId, upstreamPort: instance.upstreamPort(), currentToken: () => instance.token() }
    }
    return { tenantId: undefined, upstreamPort, currentToken }
  }

  /** 租户实例还没起来时给一句人话，而不是一个莫名其妙的 404。 */
  function notReady(res, tenantId) {
    const body = Buffer.from(
      tEn('gateway.tenantNotReady', { id: String(tenantId) }) + '\n',
      'utf8',
    )
    res.writeHead(503, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '5',
      'content-length': String(body.length),
    })
    res.end(body)
  }

  function grantCookie(req, res, tenantId) {
    const payload =
      String(Date.now() + config.gateTtlHours * 3600 * 1000) +
      ':' + String(currentEpoch()) +
      (tenantId === undefined ? '' : ':' + tenantId)
    const value = payload + '.' + sign(payload, config.gateSecret)
    const clean = (req.url ?? '/').split('?')[0] || '/'
    res.writeHead(303, {
      location: clean,
      'cache-control': 'no-store',
      'set-cookie':
        GATE_COOKIE +
        '=' +
        value +
        '; Path=/; Max-Age=' +
        String(Math.floor(config.gateTtlHours * 3600)) +
        '; HttpOnly; SameSite=Lax',
    })
    res.end()
  }

  function rewriteHeaders(headers, forIndex, route) {
    const next = { ...headers }
    next.host = config.upstreamHost + ':' + String(route.upstreamPort)
    if (next.origin !== undefined && next.origin !== null) {
      next.origin = 'http://' + next.host
    }
    if (forIndex) {
      // 首页要注入，必须拿到未压缩的明文；条件请求会让 304 无法注入
      delete next['accept-encoding']
      delete next['if-none-match']
      delete next['if-modified-since']
    }
    return next
  }

  /**
   * 是否给这次请求注入启动令牌。
   *
   * 这里踩过两个方向相反的坑，最终规则必须同时满足：
   *  - 只有首页 GET 才注入（其余路径注入没意义）；
   *  - 请求里**已经带 token** 时原样转发：Harness 对 `/?token=…` 一律回 303 → `/`，
   *    再注入就会变成 303 死循环（浏览器报"不能正确地重定向"）；
   *  - 浏览器已经有 `dsh-auth-*` Cookie 时不注入：否则每次访问首页都会被再重定向一次，
   *    同样是死循环。**但**这个 Cookie 可能已经失效（Harness 重启过）→ 那种情况由
   *    上面的 401 分支补一次令牌重定向，而不是每回合都注入。
   */
  function wantsToken(req, route) {
    if (route.currentToken() === '') return false
    if (req.method !== 'GET') return false
    const url = new URL(req.url ?? '/', 'http://placeholder')
    if (url.pathname !== '/') return false
    if (url.searchParams.has('token')) return false
    return !String(req.headers.cookie ?? '').includes('dsh-auth-')
  }

  /**
   * 令牌可能过期（Harness 重启后会换一把）：丢掉缓存，下次 `currentToken()` 重新解析。
   *
   * 这里踩过大坑：原实现"有 tokenProvider 就直接 return"，等于永不刷新 ——
   * Harness 重启后插件一直注旧令牌，浏览器拿到旧 Cookie → 401 → 又被重定向回令牌页 →
   * 死循环（用户看到"不能正确地重定向"）。显式配置的 `--token` 才不允许刷新。
   */
  function refreshToken() {
    if (config.token !== '') return
    token = ''
    tokenSource = 'none'
    if (tokenProviderCached === true) tokenProviderCached = false
  }

  function handleRequest(req, res) {
    const raw = req.url ?? '/'
    const pathname = raw.split('?')[0]
    let retried = false
  /**
   * 用启动令牌在**服务端内部**完成一次登录，再把结果（含 Set-Cookie）转给浏览器。
   * 这样令牌不会出现在浏览器地址栏、历史或 Referer 里（规范 §5 要求）。
   */
    function relayTokenLogin(res, route, token) {
      const upstream = http.request(
        {
          host: config.upstreamHost,
          port: route.upstreamPort,
          method: 'GET',
          path: '/?token=' + encodeURIComponent(token),
          headers: rewriteHeaders({ host: config.upstreamHost + ':' + String(route.upstreamPort) }, true, route),
          agent,
        },
        (up) => {
          const chunks = []
          up.on('data', (chunk) => chunks.push(chunk))
          up.on('end', () => {
            const received = Buffer.concat(chunks)
            const isHtml = String(up.headers['content-type'] ?? '').includes('text/html')
            const body =
              isHtml && config.mobileAdaptation
                ? Buffer.from(injectMobileMarkup(received.toString('utf8')), 'utf8')
                : received
            const headers = { ...up.headers }
            delete headers['transfer-encoding']
            delete headers['content-encoding']
            // 上游的 Location 指向 /?token=…：改回 /，否则浏览器又拿到令牌
            if (typeof headers.location === 'string' && headers.location.includes('token=')) headers.location = '/'
            headers['content-length'] = String(body.length)
            headers['cache-control'] = 'no-store'
            res.writeHead(up.statusCode ?? 502, headers)
            res.end(body)
          })
          up.on('error', () => {
            if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('remote-connect upstream error\n')
          })
        },
      )
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('remote-connect upstream error\n')
      })
      upstream.end()
    }

  /** 令牌刷新后的重试：方法/请求体/头部都按原样再来一次（只重试首页 GET）。 */
    function retryRequest(freshToken) {
      const upstream = http.request(
        {
          host: config.upstreamHost,
          port: route.upstreamPort,
          method: req.method,
          path: '/?token=' + encodeURIComponent(freshToken),
          headers: rewriteHeaders(req.headers, true, route),
          agent,
        },
        (up) => {
          const chunks = []
          up.on('data', (chunk) => chunks.push(chunk))
          up.on('end', () => {
            const received = Buffer.concat(chunks)
            const isHtml = String(up.headers['content-type'] ?? '').includes('text/html')
            const body =
              isHtml && config.mobileAdaptation
                ? Buffer.from(injectMobileMarkup(received.toString('utf8')), 'utf8')
                : received
            const headers = { ...up.headers }
            delete headers['transfer-encoding']
            delete headers['content-encoding']
            headers['content-length'] = String(body.length)
            headers['cache-control'] = 'no-store'
            res.writeHead(up.statusCode ?? 502, headers)
            res.end(body)
          })
          up.on('error', () => res.destroy())
        },
      )
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('remote-connect upstream error\n')
      })
      upstream.end()
    }

    if (pathname === MOBILE_CSS_PATH) {
      res.writeHead(200, {
        'content-type': 'text/css; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': String(Buffer.byteLength(MOBILE_CSS)),
      })
      res.end(req.method === 'HEAD' ? undefined : MOBILE_CSS)
      return
    }
    // 自诊断端点：不需要密钥，也不泄漏密钥（只回指纹与计数）
    if (pathname === '/_dsh/health') {
      sendHealth(res)
      return
    }
    if (!hostAllowed(req)) {
      notFound(res, 'host-not-allowed')
      return
    }
    const decision = gate(req)
    if (decision.status === 'deny') {
      const reason = decision.reason ?? 'bad-key'
      noteFailure(req, reason, decision.presented)
      // 完全没带凭据的请求只给裸 404（不暴露入口是否存在）；带了的才给有文案的失败页
      if (reason === 'no-key' && !raw.includes('k=')) {
        notFound(res, 'no-key')
        return
      }
      gatePage(res, req, reason)
      return
    }
    if (decision.status === 'grant') {
      observations.lastOkAt = Date.now()
      grantCookie(req, res, decision.tenantId)
      return
    }
    const route = resolveRoute(decision.tenantId)
    if (route === null) {
      notFound(res)
      return
    }
    if (!(route.upstreamPort > 0)) {
      notReady(res, route.tenantId)
      return
    }

    const isIndex = pathname === '/' && req.method === 'GET'
    const injected = wantsToken(req, route)
    const target = injected ? '/?token=' + encodeURIComponent(route.currentToken()) : raw
    const upstream = http.request(
      {
        host: config.upstreamHost,
        port: route.upstreamPort,
        method: req.method,
        path: target,
        headers: rewriteHeaders(req.headers, isIndex, route),
        agent,
      },
      (up) => {
        // 注入了令牌却拿到 401：说明缓存的令牌已过期（Harness 重启过）。
        // 丢掉缓存、重读日志里的新令牌，原地重试一次，避免"页面能开但没会话"。
        // 浏览器 Cookie 失效（Harness 重启过）：用当前令牌重定向一次，
        // 让浏览器重新拿到 Cookie。只做一次 —— 目标 URL 自带 token，不会再来一轮。
        const alreadyHasToken = new URL(req.url ?? '/', 'http://placeholder').searchParams.has('token')
        if (up.statusCode === 401 && isIndex && retried === false && !alreadyHasToken) {
          retried = true
          up.resume()
          const previous = route.currentToken()
          refreshToken()
          const fresh = route.currentToken() === '' ? previous : route.currentToken()
          if (fresh !== '') {
            // 内部中继：我们替浏览器带着令牌请求一次，把 Set-Cookie 与页面转给它。
            // 这样启动令牌**不会出现在浏览器地址栏/历史里**（规范 §5）。
            config.log('浏览器会话已失效，用启动令牌在服务端内部重新登录')
            relayTokenLogin(res, route, fresh)
            return
          }
        }
        if (injected && up.statusCode === 401 && retried === false) {
          retried = true
          up.resume()
          const previous = route.currentToken()
          refreshToken()
          const fresh = route.currentToken()
          if (fresh !== '' && fresh !== previous) {
            config.log('注入的启动令牌已过期，已重新发现并重试')
            retryRequest(fresh)
            return
          }
        }
        if (isIndex) {
          const chunks = []
          up.on('data', (chunk) => chunks.push(chunk))
          up.on('end', () => {
            const received = Buffer.concat(chunks)
            const contentType = String(up.headers['content-type'] ?? '')
            const isHtml = contentType.includes('text/html')
            const body =
              isHtml && config.mobileAdaptation
                ? Buffer.from(injectMobileMarkup(received.toString('utf8')), 'utf8')
                : received
            const headers = { ...up.headers }
            delete headers['transfer-encoding']
            delete headers['content-encoding']
            headers['content-length'] = String(body.length)
            headers['cache-control'] = 'no-store'
            res.writeHead(up.statusCode ?? 502, headers)
            res.end(body)
          })
          up.on('error', () => res.destroy())
          return
        }
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on('error', (error) => {
      // 上游连不上 = 隧道掉了或 Harness 没起来。给一页人话 + 原因头，别丢裸 502。
      if (!res.headersSent) upstreamDownPage(res, req)
      else res.end()
      void error
    })
    req.pipe(upstream)
    res.on('close', () => upstream.destroy())
  }

  function handleUpgrade(req, socket, head) {
    // WebSocket 也要过密钥门与租户路由：否则升级请求会绕过门直达某个上游
    const decision = gate(req)
    // 'off' = 没有密钥门（局域网入口就是这样）→ 必须放行；
    // 'ok' = Cookie 有效 → 放行；'grant'（还没换 Cookie）与 'deny' 不放行。
    if (decision.status === 'deny' || decision.status === 'grant') {
      socket.destroy()
      return
    }
    const route = resolveRoute(decision.tenantId)
    if (route === null || !(route.upstreamPort > 0)) {
      socket.destroy()
      return
    }
    const headers = rewriteHeaders(req.headers, false, route)
    const upstream = net.connect(route.upstreamPort, config.upstreamHost, () => {
      let raw = req.method + ' ' + (req.url ?? '/') + ' HTTP/1.1\r\n'
      for (const key of Object.keys(headers)) {
        const value = headers[key]
        if (Array.isArray(value)) {
          for (const item of value) raw += key + ': ' + item + '\r\n'
        } else if (value !== undefined) {
          raw += key + ': ' + value + '\r\n'
        }
      }
      raw += '\r\n'
      upstream.write(raw)
      if (head && head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  }

  /** 当前状态快照（可 JSON 序列化）。 */
  function info() {
    const loopbackOnly = config.listenHost === '127.0.0.1' || config.listenHost === '::1'
    const addresses = loopbackOnly ? [] : lanAddresses()
    const lanIp = addresses.length > 0 ? addresses[0].address : null
    const port = boundPort ?? config.port
    const lanUrl = lanIp === null ? null : 'http://' + lanIp + ':' + String(port) + '/'
    return {
      running: server !== null,
      port,
      listenHost: config.listenHost,
      loopbackOnly,
      addresses,
      upstream: authority,
      upstreamSource: portSource,
      tokenSource: token !== '' ? tokenSource : currentToken() === '' ? tokenSource : tokenSource,
      hasToken: currentToken() !== '',
      lanUrl,
      gate: multiTenant || currentAccessKey() !== '',
      tenants: multiTenant ? 'registry' : null,
    }
  }

  /** 启动并返回就绪信息；端口被占用时依次尝试后续端口。 */
  async function start() {
    if (server !== null) return info()
    const created = http.createServer(handleRequest)
    created.on('upgrade', handleUpgrade)
    let attempt = 0
    let port = config.port
    for (;;) {
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            created.removeListener('listening', onListening)
            reject(error)
          }
          const onListening = () => {
            created.removeListener('error', onError)
            resolve()
          }
          created.once('error', onError)
          created.once('listening', onListening)
          created.listen(port, config.listenHost)
        })
        break
      } catch (error) {
        if (error?.code === 'EADDRINUSE' && attempt < config.portAttempts) {
          attempt += 1
          port += 1
          continue
        }
        throw error
      }
    }
    server = created
    const address = created.address()
    boundPort = typeof address === 'object' && address !== null ? address.port : port
    if (token === '') config.log('未发现 Harness 启动令牌：远程浏览器可能无法自动登录（可用 --token 指定）')
    return info()
  }

  /** 停止监听。 */
  async function stop() {
    const current = server
    server = null
    boundPort = null
    agent.destroy()
    if (current === null) return
    await new Promise((resolve) => {
      current.closeAllConnections?.()
      current.close(() => resolve())
    })
  }

  return { start, stop, info, config: { ...config, upstreamPort, token } }
}
