/**
 * 共享出口的插件侧：主动拨出到出口（relay）的一条长连接，把公网请求
 * 代理到本机 Harness。
 *
 * 与 `./tunnel.js` 的区别：那里是 ssh / cloudflared / tailscale 三种子进程
 * 后端的看护；这里是**出口协议自带的隧道**（M2），拨的是一条 HTTPS 长连接，
 * 用 NDJSON 帧双向流式传数据。
 *
 * 形状刻意对齐 `./tunnel.js`：`start()` / `stop()` / `state()`，
 * `state()` 返回 `{phase, code, params, detail, publicUrl, restarts}`，
 * 断线用同一套指数退避（`nextBackoffDelay`）。
 *
 * 约束（写在文档与任务里的硬规矩）：
 *  - 只用 `node:https` / `node:http`，**不用 WebSocket，也不用 fetch**；
 *  - 转发时丢掉 `host`（换成 127.0.0.1:<localPort>）与逐跳头；
 *  - 响应逐块回成 `response-chunk`，不整体缓冲。
 *
 * @module dsh-plugin-remote-connect-beta/core/relayTunnel
 */
import http from 'node:http'
import https from 'node:https'
import { nextBackoffDelay } from './tunnel.js'
import { translator } from './messages.js'

/** 英文兜底渲染：没有请求语言时至少有一句能读的状态。 */
const tEn = translator('en')

/** 逐跳头：只在这段连接里有意义，不能透传给上游。 */
const HOP_BY_HOP = new Set([
  'connection',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'proxy-connection',
  'te',
  'trailer',
])

function stripHopByHop(headers) {
  const entries = Object.entries(headers ?? {})
  // RFC 7230：`Connection` 里点名的头同样是逐跳头，不能透传给上游。
  const connectionTokens = new Set()
  for (const [key, value] of entries) {
    if (key.toLowerCase() !== 'connection') continue
    for (const token of String(value).split(',')) {
      const name = token.trim().toLowerCase()
      if (name !== '') connectionTokens.add(name)
    }
  }
  const out = {}
  for (const [key, value] of entries) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (connectionTokens.has(lower)) continue
    out[key] = value
  }
  return out
}

/** 转发给本机上游时：去逐跳头、去 host，再把 host 指到回环上游。 */
function upstreamHeaders(headers, localPort) {
  const out = stripHopByHop(headers)
  delete out.Host
  delete out.host
  out.host = '127.0.0.1:' + String(localPort)
  return out
}

/**
 * @param {object} options
 * @param {string} options.url 出口基址（HTTPS 基址，如 https://exit.example.com）
 * @param {string} options.subdomain 出口签发的名字
 * @param {string} options.accessKey 出口签发的访问口令
 * @param {number} [options.localPort=8788] 本机 Harness 端口
 * @param {string} [options.publicUrl] 直接指定公网地址（不给就按出口域名推）
 * @param {(line: string) => void} [options.log]
 * @param {(url: string) => void} [options.onPublicUrl]
 * @param {(state: object) => void} [options.onState]
 * @param {number} [options.backoffBaseMs=5000]
 * @param {number} [options.backoffMaxMs=60000]
 * @param {number} [options.backoffJitter=0.25]
 */
export function createRelayTunnel(options = {}) {
  const rawUrl = String(options.url ?? '')
  const subdomain = String(options.subdomain ?? '').trim().toLowerCase()
  const accessKey = String(options.accessKey ?? '')
  const localPort = Number(options.localPort ?? 8788)
  const log = typeof options.log === 'function' ? options.log : () => {}
  const onState = typeof options.onState === 'function' ? options.onState : () => {}
  const onPublicUrl = typeof options.onPublicUrl === 'function' ? options.onPublicUrl : () => {}
  const backoffBaseMs = options.backoffBaseMs ?? 5000
  const backoffMaxMs = options.backoffMaxMs ?? 60000
  const backoffJitter = options.backoffJitter ?? 0.25
  // 「稳定」的判据：连上之后跑满这么久才算这次真通了，此时才清零退避计数。
  // 与 lib/core/tunnel.js 同一套语义（那边是 stableMs 定时器）—— 少了它，一次网络抖动
  // 就会把 attempts 永久推到上限，之后每次断线都按最大延迟重连（几秒的抖动换来几十秒的等待）。
  const stableMs = options.stableMs ?? 120000
  // 出口发来的一行（一帧）上限；防止一个坏/被入侵的出口用超大帧灌爆插件内存。
  const maxFrameBytes = Number.isInteger(options.maxFrameBytes) && options.maxFrameBytes > 0 ? options.maxFrameBytes : 4 * 1024 * 1024

  let stopped = true
  let fatal = false
  let attempts = 0
  let restartTimer = null
  let stableTimer = null
  let generation = 0
  /** 插件 → 出口 的请求（可写，用来发帧）。 */
  let socketReq = null
  /** 待回应的本机上游请求：id → http.ClientRequest。 */
  const pending = new Map()
  let state = { phase: 'idle', code: 'tunnel.idle', params: {}, detail: '', publicUrl: null, restarts: 0 }

  function setState(patch) {
    const next = { ...state, ...patch }
    if (patch.code !== undefined && patch.detail === undefined) {
      next.detail = tEn(patch.code, patch.params)
    }
    state = next
    onState(state)
  }

  /** 解析出口基址 → { module, host, port, path }。 */
  function target() {
    const parsed = new URL(rawUrl)
    const secure = parsed.protocol === 'https:'
    const basePath = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : ''
    const path =
      basePath + '/relay/tunnel?sub=' + encodeURIComponent(subdomain) + '&key=' + encodeURIComponent(accessKey)
    return {
      module: secure ? https : http,
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : secure ? 443 : 80,
      path,
    }
  }

  /** 出口上的公网地址：给了就用，否则按「出口域名前面加名字」推。IP / localhost 推不出来。 */
  function computePublicUrl() {
    if (typeof options.publicUrl === 'string' && options.publicUrl !== '') return options.publicUrl
    try {
      const host = new URL(rawUrl).hostname
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host === 'localhost') return null
      return 'https://' + subdomain + '.' + host + '/'
    } catch {
      return null
    }
  }

  function send(frame) {
    if (socketReq === null || socketReq.destroyed === true) return
    try {
      socketReq.write(JSON.stringify(frame) + '\n')
    } catch (error) {
      log('relay-tunnel: 写帧失败 ' + String(error?.message ?? error))
    }
  }

  function forgetPending() {
    for (const upstream of pending.values()) {
      try {
        upstream.destroy()
      } catch {
        /* 已关闭 */
      }
    }
    pending.clear()
  }

  function cleanupSocket() {
    const req = socketReq
    socketReq = null
    forgetPending()
    if (req !== null) {
      try {
        req.destroy()
      } catch {
        /* 已关闭 */
      }
    }
  }

  /** 断线：指数退避重连，restarts 累加。 */
  function drop(reason) {
    if (stopped || fatal) return
    generation += 1 // 让旧连接的其它事件失效，避免重复排重连
    if (stableTimer !== null) {
      clearTimeout(stableTimer)
      stableTimer = null
    }
    cleanupSocket()
    attempts += 1
    const delay = nextBackoffDelay(attempts, { baseMs: backoffBaseMs, maxMs: backoffMaxMs, jitter: backoffJitter })
    setState({
      phase: 'reconnecting',
      code: 'tunnel.reconnecting',
      params: { reason, seconds: String(Math.round(delay / 1000)), delayMs: String(delay) },
      restarts: state.restarts + 1,
    })
    restartTimer = setTimeout(() => {
      restartTimer = null
      connect()
    }, delay)
    if (typeof restartTimer.unref === 'function') restartTimer.unref()
  }

  /** 处理出口发来的一帧。 */
  function handleFrame(frame) {
    const type = frame?.type
    const id = Number(frame?.id)
    if (type === 'request') {
      if (Number.isFinite(id) === false) return
      // 出口是不可全信的中间人：请求行必须是干净的，绝不允许 CRLF/控制字符打穿到本机上游。
      const reqMethod = typeof frame.method === 'string' ? frame.method : 'GET'
      const reqPath = typeof frame.url === 'string' ? frame.url : '/'
      if (/[\r\n\u0000]/.test(reqMethod) || /[\r\n\u0000]/.test(reqPath)) {
        send({ type: 'response-error', id, message: '出口转来的请求行非法' })
        return
      }
      let upstream
      try {
        upstream = http.request({
          host: '127.0.0.1',
          port: localPort,
          method: reqMethod,
          path: reqPath,
          headers: upstreamHeaders(frame.headers, localPort),
        })
      } catch (error) {
        send({ type: 'response-error', id, message: String(error?.message ?? error) })
        return
      }
      pending.set(id, upstream)
      upstream.on('response', (upRes) => {
        send({ type: 'response-start', id, status: upRes.statusCode ?? 502, headers: stripHopByHop(upRes.headers) })
        upRes.on('data', (chunk) => send({ type: 'response-chunk', id, data: chunk.toString('base64') }))
        upRes.on('end', () => {
          pending.delete(id)
          send({ type: 'response-end', id })
        })
        upRes.on('error', (error) => {
          pending.delete(id)
          send({ type: 'response-error', id, message: String(error?.message ?? error) })
        })
      })
      upstream.on('error', (error) => {
        if (pending.delete(id)) send({ type: 'response-error', id, message: String(error?.message ?? error) })
      })
      if (typeof frame.body === 'string' && frame.body !== '') {
        upstream.write(Buffer.from(frame.body, 'base64'))
      }
      return
    }
    if (type === 'request-chunk') {
      const upstream = pending.get(id)
      if (upstream !== undefined) upstream.write(Buffer.from(String(frame.data ?? ''), 'base64'))
      return
    }
    if (type === 'request-end') {
      const upstream = pending.get(id)
      if (upstream !== undefined) upstream.end()
    }
  }

  /** 拨一条新连接。 */
  function connect() {
    if (stopped || fatal) return
    const t = target()
    setState({ phase: 'connecting', code: 'tunnel.connecting', params: { command: t.host + ':' + String(t.port) } })
    const gen = ++generation
    const isCurrent = () => gen === generation && stopped === false && fatal === false
    let req
    try {
      req = t.module.request({
        host: t.host,
        port: t.port,
        method: 'POST',
        path: t.path,
        headers: { 'content-type': 'application/x-ndjson', accept: 'application/x-ndjson' },
      })
    } catch (error) {
      drop(String(error?.message ?? error))
      return
    }
    socketReq = req
    let buffer = ''

    req.on('response', (res) => {
      if (isCurrent() === false) {
        res.destroy()
        return
      }
      if (res.statusCode !== 200) {
        // 鉴权 / 参数错：重试也不会好，直接报错停手（不刷退避）
        fatal = true
        socketReq = null
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text = (text + chunk).slice(-500)
        })
        res.on('end', () => {
          setState({
            phase: 'error',
            code: 'tunnel.relayRejected',
            detail: '出口拒绝了隧道（HTTP ' + String(res.statusCode) + '）：' + text.trim(),
          })
        })
        res.on('error', () => {
          setState({ phase: 'error', code: 'tunnel.relayRejected', detail: '出口拒绝了隧道（HTTP ' + String(res.statusCode) + '）' })
        })
        return
      }
      const url = computePublicUrl()
      setState({ phase: 'up', code: 'tunnel.up', publicUrl: url })
      // 连上先**不清零**退避计数：要稳定跑满 stableMs 才算"这次通了"。
      if (stableTimer !== null) clearTimeout(stableTimer)
      stableTimer = setTimeout(() => {
        stableTimer = null
        if (stopped === false && isCurrent()) attempts = 0
      }, stableMs)
      if (typeof stableTimer.unref === 'function') stableTimer.unref()
      if (url !== null) {
        onPublicUrl(url)
        log('relay-tunnel: 公网地址 ' + url)
      }
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        if (isCurrent() === false) return
        buffer += chunk
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line === '') continue
          let frame
          try {
            frame = JSON.parse(line)
          } catch {
            continue
          }
          handleFrame(frame)
        }
        // 一行（一帧）超过上限：出口在灌内存，断线重连，别把本进程拖死。
        if (buffer.length > maxFrameBytes) {
          log('relay-tunnel: 出口发来的单帧超过 ' + String(maxFrameBytes) + ' 字节，断开重连')
          drop('出口发来的帧超过上限')
        }
      })
      res.on('end', () => {
        if (isCurrent()) drop('出口关闭了隧道')
      })
      res.on('error', (error) => {
        if (isCurrent()) drop(String(error?.message ?? error))
      })
    })

    req.on('error', (error) => {
      if (isCurrent()) drop(String(error?.message ?? error))
    })

    // 请求体是 chunked，握手成功与否都用这一帧告诉出口「我准备好收请求了」
    send({ type: 'ready' })
  }

  return {
    /** 启动隧道（失败自动重连，不抛异常）。 */
    start() {
      stopped = false
      fatal = false
      attempts = 0
      connect()
      return state
    },
    /** 停止：断开长连接、清掉待代理的请求，不再重连。 */
    async stop() {
      stopped = true
      fatal = false
      generation += 1
      if (restartTimer !== null) {
        clearTimeout(restartTimer)
        restartTimer = null
      }
      cleanupSocket()
      setState({ phase: 'stopped', code: 'tunnel.stopped' })
      return state
    },
    /** 当前状态快照。 */
    state() {
      return state
    },
  }
}
