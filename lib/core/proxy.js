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
 * @module dsh-plugin-remote-connect/core/proxy
 */
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

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
    allowedHosts: options.allowedHosts ?? [],
    gateTtlHours: options.gateTtlHours ?? 12,
    mobileAdaptation: options.mobileAdaptation !== false,
    log: options.log ?? (() => {}),
  }

  const explicitUpstreamPort = options.upstreamPort !== undefined && options.upstreamPort !== null
  const tokenProvider = typeof options.tokenProvider === 'function' ? options.tokenProvider : null
  let token = config.token
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

  function notFound(res) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('not found\n')
  }

  function hostAllowed(req) {
    if (config.allowedHosts.length === 0) return true
    const host = String(req.headers.host ?? '').split(':')[0].toLowerCase()
    return config.allowedHosts.some((entry) => entry.toLowerCase() === host)
  }

  /** @returns {'off'|'ok'|'grant'|'deny'} */
  function gate(req) {
    if (config.accessKey === '') return 'off'
    const raw = readCookie(req.headers.cookie, GATE_COOKIE)
    if (typeof raw === 'string' && raw.includes('.')) {
      const at = raw.lastIndexOf('.')
      const payload = raw.slice(0, at)
      const mac = raw.slice(at + 1)
      if (safeEqual(mac, sign(payload, config.accessKey))) {
        const expiresAt = Number(payload)
        if (Number.isFinite(expiresAt) && expiresAt > Date.now()) return 'ok'
      }
    }
    const query = new URL(req.url ?? '/', 'http://placeholder').searchParams.get('k')
    if (typeof query === 'string' && query !== '' && safeEqual(query, config.accessKey)) return 'grant'
    return 'deny'
  }

  function grantCookie(req, res) {
    const payload = String(Date.now() + config.gateTtlHours * 3600 * 1000)
    const value = payload + '.' + sign(payload, config.accessKey)
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

  function rewriteHeaders(headers, forIndex) {
    const next = { ...headers }
    next.host = authority
    if (next.origin !== undefined && next.origin !== null) next.origin = origin
    if (forIndex) {
      // 首页要注入，必须拿到未压缩的明文；条件请求会让 304 无法注入
      delete next['accept-encoding']
      delete next['if-none-match']
      delete next['if-modified-since']
    }
    return next
  }

  function wantsToken(req) {
    if (currentToken() === '') return false
    if (req.method !== 'GET') return false
    if ((req.url ?? '/').split('?')[0] !== '/') return false
    return !String(req.headers.cookie ?? '').includes('dsh-auth-')
  }

  function handleRequest(req, res) {
    const raw = req.url ?? '/'
    const pathname = raw.split('?')[0]

    if (pathname === MOBILE_CSS_PATH) {
      res.writeHead(200, {
        'content-type': 'text/css; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': String(Buffer.byteLength(MOBILE_CSS)),
      })
      res.end(req.method === 'HEAD' ? undefined : MOBILE_CSS)
      return
    }
    if (!hostAllowed(req)) {
      notFound(res)
      return
    }
    const decision = gate(req)
    if (decision === 'deny') {
      notFound(res)
      return
    }
    if (decision === 'grant') {
      grantCookie(req, res)
      return
    }

    const isIndex = pathname === '/' && req.method === 'GET'
    const target = wantsToken(req) ? '/?token=' + encodeURIComponent(token) : raw
    const upstream = http.request(
      {
        host: config.upstreamHost,
        port: upstreamPort,
        method: req.method,
        path: target,
        headers: rewriteHeaders(req.headers, isIndex),
        agent,
      },
      (up) => {
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
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      }
      res.end('remote-connect upstream error: ' + String(error?.message ?? error) + '\n')
    })
    req.pipe(upstream)
    res.on('close', () => upstream.destroy())
  }

  function handleUpgrade(req, socket, head) {
    const headers = rewriteHeaders(req.headers, false)
    const upstream = net.connect(upstreamPort, config.upstreamHost, () => {
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
      gate: config.accessKey !== '',
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
