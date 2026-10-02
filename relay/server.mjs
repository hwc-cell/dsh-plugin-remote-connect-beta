#!/usr/bin/env node
/**
 * 共享出口 · 身份服务（M1）
 * ============================================================================
 * 出口这一侧的"发证机关"：发邀请码、签发（名字 + 访问口令）、轮换、登记。
 *
 * 设计上唯一要记住的一条：**这里不保管口令，只保管指纹。**
 *
 *   - 落盘的只有 sha256(口令) 的前 16 位，以及每个名字**换掉过的旧口令的指纹**；
 *     所以拿到这份状态文件也换不出任何一把能用的口令；
 *   - 全局唯一性（口令之间、名字之间）在**签发时**保证 —— 这正是
 *     lib/core/keypool.js 做不到的那件事：它只能保证"一台机器内"唯一。
 *
 * 代价写在文档里而不是藏起来：**签发那一刻本进程见过明文口令。**
 * 见 docs/relay.md（中英）§3/§4。
 *
 * 用法：
 *   node relay/server.mjs --state /var/lib/dsh-relay/state.json --port 8790 --base-domain dsh.example.com
 *   node relay/server.mjs --state <file> --new-invite     # 发一个邀请码
 *   node relay/server.mjs --state <file> --list           # 看登记表（不含口令）
 *   node relay/server.mjs --state <file> --revoke alice   # 吊销一个名字
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const ACCESS_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
export const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
/** 这些名字留给基础设施，不能给用户（正则会拦掉大部分，这里再挡一次） */
const RESERVED = new Set(['www', 'relay', 'api', 'admin', 'mail', 'ns', 'ns1', 'ns2', 'dns', 'ftp', 'smtp', 'exit'])
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去掉易混的 I/O/0/1

export function fingerprintKey(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

/**
 * 指纹的等值比较。指纹是固定 16 位十六进制，长度不等直接判否；
 * 长度相等时用 timingSafeEqual —— 别让 `===` 的短路时序泄漏"前几位对了"。
 * 注意：指纹是口令的 sha256 前缀，即便泄漏也还原不出口令，这里纯属纵深防御。
 */
function fingerprintEquals(a, b) {
  const left = Buffer.from(asString(a), 'utf8')
  const right = Buffer.from(asString(b), 'utf8')
  if (left.length === 0 || left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

/** 32 位 URL 安全随机串 ≈ 192 bit。与 lib/core/tenant.js 的 generateAccessKey 同形。 */
export function generateAccessKey() {
  return crypto.randomBytes(24).toString('base64url')
}

function generateInvite() {
  const bytes = crypto.randomBytes(10)
  let raw = ''
  for (const byte of bytes) raw += INVITE_ALPHABET[byte % INVITE_ALPHABET.length]
  return raw
}

function generateSubdomain() {
  return 'u' + crypto.randomBytes(6).toString('hex') // u + 12 hex
}

function asString(value) {
  return typeof value === 'string' ? value : ''
}

/** 读状态；坏数据不让服务起不来，只是从头开始（并留痕）。 */
function loadState(file, log) {
  const empty = { version: 1, invites: {}, users: {} }
  if (typeof file !== 'string' || file === '') return empty
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
    return {
      version: 1,
      invites: typeof parsed.invites === 'object' && parsed.invites !== null ? parsed.invites : {},
      users: typeof parsed.users === 'object' && parsed.users !== null ? parsed.users : {},
    }
  } catch (error) {
    if (error.code !== 'ENOENT') log('状态文件读不出来，按空表启动：' + String(error.message))
    return empty
  }
}

function saveState(file, state) {
  if (typeof file !== 'string' || file === '') return
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.tmp-' + String(process.pid)
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file) // 原子替换：并发请求不会读到半个文件
}

/**
 * 登记表。所有"唯一性"判断都在这里，且只对指纹做判断。
 * @param {{file?: string, log?: (m: string) => void}} options
 */
export function createIdentityStore(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const file = options.file
  let state = loadState(file, log)

  /** 已被占用的指纹 → 用它的名字（活跃 + 全部退休值）。命中也绝不回显是谁在用。 */
  function fingerprintOwner(fingerprint, exceptName) {
    for (const [name, user] of Object.entries(state.users)) {
      if (name === exceptName) continue
      if (user.keyFingerprint === fingerprint) return name
      if (Array.isArray(user.retired) && user.retired.includes(fingerprint)) return name
    }
    return null
  }

  /** 签发一把**全局没被用过**的口令。撞了就重发 —— 而不是把错误丢给调用方。 */
  function issueKey(exceptName) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const value = generateAccessKey()
      if (!ACCESS_KEY_PATTERN.test(value)) continue // 生成器坏了的话不该静默通过
      if (fingerprintOwner(fingerprintKey(value), exceptName) === null) return value
    }
    const error = new Error('签发不出唯一口令（连试 40 次都撞上，生成器有问题）')
    error.statusCode = 500
    throw error
  }

  function pickSubdomain(requested) {
    const wanted = asString(requested).trim().toLowerCase()
    if (wanted !== '') {
      if (!SUBDOMAIN_PATTERN.test(wanted) || RESERVED.has(wanted)) {
        const error = new Error('这个名字不可用（只能小写字母、数字、连字符，且不能是保留名）')
        error.statusCode = 400
        throw error
      }
      if (state.users[wanted] !== undefined) {
        const error = new Error('这个名字已经被占用了，换一个')
        error.statusCode = 409
        throw error
      }
      return wanted
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const candidate = generateSubdomain()
      if (state.users[candidate] === undefined) return candidate
    }
    const error = new Error('取不到空闲名字')
    error.statusCode = 500
    throw error
  }

  /**
   * 从磁盘重读状态。
   *
   * 为什么需要它：管理员是用 CLI 发邀请码 / 吊销名字的（`--new-invite` / `--revoke`），
   * 那会改文件，但**不会**通知这个已经在跑的服务进程 —— 服务的内存副本是启动那一刻的。
   * 不重读的话：新邀请码要等重启才生效，被吊销的名字还能继续连（2026-10-02 实测踩到）。
   * enroll / 鉴权都是低频动作，每次重读一个几 KB 的 JSON 可以忽略。
   */
  function reloadFromDisk() {
    if (typeof file !== 'string' || file === '') return
    state = loadState(file, log)
  }

  return {
    /** 管理员侧：发一个一次性邀请码。 */
    newInvite() {
      const code = generateInvite()
      state.invites[code] = { createdAt: new Date().toISOString(), usedAt: null, usedBy: null }
      saveState(file, state)
      return code
    },

    /** 管理员侧：吊销（名字连同它的口令一起作废；指纹进退休区，永不再发）。 */
    revoke(name) {
      reloadFromDisk()
      const key = asString(name).trim().toLowerCase()
      const user = state.users[key]
      if (user === undefined) return { ok: false, error: '没有这个名字' }
      delete state.users[key]
      state.invites = state.invites // 保持形状，顺带说明：邀请码与名字无关
      saveState(file, state)
      return { ok: true, name: key }
    },

    list() {
      reloadFromDisk()
      return Object.entries(state.users).map(([name, user]) => ({
        name,
        fingerprint: user.keyFingerprint,
        createdAt: user.createdAt,
        rotations: Number(user.rotations ?? 0),
        retiredCount: Array.isArray(user.retired) ? user.retired.length : 0,
      }))
    },

    /**
     * 用户侧：拿邀请码换（名字 + 口令）。邀请码一次性。
     * @returns {{ok: true, subdomain: string, accessKey: string} | {ok: false, error: string}}
     */
    enroll(invite, requestedName) {
      reloadFromDisk()
      const code = asString(invite).trim().toUpperCase()
      const record = state.invites[code]
      if (record === undefined) return { ok: false, error: '邀请码无效' }
      if (record.usedAt !== null) return { ok: false, error: '邀请码已经用过了（一个码只能给一个人）' }
      const subdomain = pickSubdomain(requestedName)
      const accessKey = issueKey(subdomain)
      state.users[subdomain] = {
        keyFingerprint: fingerprintKey(accessKey),
        createdAt: new Date().toISOString(),
        rotations: 0,
        retired: [],
      }
      record.usedAt = new Date().toISOString()
      record.usedBy = subdomain
      saveState(file, state)
      // 注意：这里**故意不打印口令** —— 它只出现在这一次 HTTP 响应里。
      log('enroll: ' + subdomain)
      return { ok: true, subdomain, accessKey }
    },

    /**
     * 用户侧：换一把新口令。要用**手上的那把**证明身份 ——
     * 登记表里只有指纹，所以这里比对指纹就够了，不需要存明文。
     */
    rotate(subdomain, currentKey) {
      const name = asString(subdomain).trim().toLowerCase()
      const user = state.users[name]
      if (user === undefined) return { ok: false, error: '没有这个名字' }
      const presented = fingerprintKey(asString(currentKey))
      if (fingerprintEquals(presented, user.keyFingerprint) === false) return { ok: false, error: '当前口令不正确' }
      const accessKey = issueKey(name)
      user.retired = (Array.isArray(user.retired) ? user.retired : []).concat([user.keyFingerprint]).slice(-50)
      user.keyFingerprint = fingerprintKey(accessKey)
      user.rotations = Number(user.rotations ?? 0) + 1
      user.updatedAt = new Date().toISOString()
      saveState(file, state)
      log('rotate: ' + name)
      return { ok: true, subdomain: name, accessKey }
    },

    /**
     * 隧道（M2）鉴权：拿明文口令比对登记表里的指纹。
     * 登记表只有指纹，所以这里天然是等值比较，不需要（也不能）还原口令。
     * @returns {boolean}
     */
    verify(subdomain, accessKey) {
      reloadFromDisk()
      const name = asString(subdomain).trim().toLowerCase()
      const user = state.users[name]
      if (user === undefined) return false
      return fingerprintEquals(fingerprintKey(asString(accessKey)), user.keyFingerprint)
    },

    stats() {
      return {
        users: Object.keys(state.users).length,
        invites: Object.keys(state.invites).length,
        unusedInvites: Object.values(state.invites).filter((item) => item.usedAt === null).length,
      }
    },
  }
}

/** 简单的按 IP 限流：邀请码虽然有 48 bit 熵，但没必要让人无限次试。 */
function createLimiter({ windowMs = 60_000, max = 30 } = {}) {
  const hits = new Map()
  return (ip) => {
    const now = Date.now()
    const list = (hits.get(ip) ?? []).filter((at) => now - at < windowMs)
    list.push(now)
    hits.set(ip, list)
    if (hits.size > 5000) hits.clear() // 别让这张表自己长成内存泄漏
    return list.length <= max
  }
}

/**
 * 限流分桶用的"真实客户端 IP"。
 *
 * 这个出口服务只监听回环，永远躲在本机 nginx 后面：所有请求的
 * `req.socket.remoteAddress` 都是 127.0.0.1。若直接拿它当 key，30 次/分钟
 * 就退化成**一个全局额度** —— 既限不住真正的攻击者，攻击者还能顺手把这个
 * 额度打满，把正常用户的 enroll 一起卡死。
 *
 * 所以：只有 **socket 对端是回环**（说明前面一定是本机反代）时才去看
 * `X-Forwarded-For`。取**最后一段**，因为 nginx 的 `$proxy_add_x_forwarded_for`
 * 是把每一跳依次追加在末尾的，最右那段才是 nginx 亲眼看到的对端 IP；
 * 前面的段落客户端可以随便伪造，信它们等于把限流权交给攻击者。对端不是回环
 * （直连出口，正常部署里不该出现）就只信 socket 地址，绝不看 XFF。
 *
 * XFF 缺失或为空 → 回落到 socket 地址。
 */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
function clientIpFor(req) {
  const socketIp = String(req.socket?.remoteAddress ?? '')
  if (LOOPBACK_ADDRESSES.has(socketIp) === false) return socketIp
  const header = req.headers?.['x-forwarded-for']
  const raw = Array.isArray(header) ? header[header.length - 1] : header
  const value = asString(raw)
  if (value === '') return socketIp
  const segments = value.split(',')
  const last = segments[segments.length - 1].trim()
  return last === '' ? socketIp : last
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('请求体太大'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** 逐跳头：只在这一段 TCP 里有意义，绝不能透传到另一端。 */
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
  // RFC 7230：`Connection` 里点名的头也是逐跳头，必须一并剥掉，
  // 否则 `Connection: keep-alive, X-Smuggled` + `X-Smuggled: ...` 能把定制头偷运过这一跳。
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

/**
 * HTTP 处理层。M1 的身份服务照旧；M2 的隧道挂在这个前缀下面：
 *
 *   - `POST /relay/tunnel?sub=<名字>&key=<口令>`：插件主动拨出的长连接，
 *     请求体与响应体都是 NDJSON 帧（双向流式）；
 *   - 其它非 `/relay/*` 路径按 `Host` 的子域找隧道，把公网请求喂过去，
 *     并把插件回应的每一块**边收边写**（不整体缓冲，否则 SSE/长连接全废）。
 *
 * @param {{store: object, baseDomain?: string, log?: Function, maxFrameBytes?: number, maxPending?: number, sweepMs?: number}} options
 */
export function createRelayServer(options) {
  const store = options.store
  const baseDomain = asString(options.baseDomain)
  const log = typeof options.log === 'function' ? options.log : () => {}
  // 单条 NDJSON 帧（一行）的上限：正常一块 HTTP chunk 远小于此，超了就是有人在灌内存。
  const maxFrameBytes = Number.isInteger(options.maxFrameBytes) && options.maxFrameBytes > 0 ? options.maxFrameBytes : 4 * 1024 * 1024
  // 单条隧道同时在飞（还没回完）的公网请求上限，防止一个访客把 pending 表撑爆。
  const maxPending = Number.isInteger(options.maxPending) && options.maxPending > 0 ? options.maxPending : 256
  const allow = createLimiter()
  /** 子域 → 隧道。只在内存里，进程重启即清空（连接本来就断了）。 */
  const tunnels = new Map()
  let nextRequestId = 0
  // 巡检周期：默认 30s 一轮；显式传 0 或 null 则关闭定时器（测试里可传小值）。
  const sweepMs = options.sweepMs === undefined ? 30_000 : Number(options.sweepMs)
  let sweepTimer = null
  const entryFor = (subdomain) =>
    baseDomain === '' ? 'https://' + subdomain + '/?k=<口令>' : 'https://' + subdomain + '.' + baseDomain + '/'

  /**
   * 从 Host 头取出子域：alice.dsh.example.com → alice。取不到返回 null。
   * 严格化：限长、拒控制字符/空白（CRLF 防御）、拒多段/`..`、且子域必须过 SUBDOMAIN_PATTERN。
   * 这样 `-alice.dsh...`、`alice..dsh...`、`a.b.dsh...` 之类一律 404，而不是继续往下走。
   */
  function subdomainFor(host) {
    const raw = String(host ?? '')
    if (raw.length === 0 || raw.length > 253) return null
    if (/[\u0000-\u0020\u007f]/.test(raw)) return null // 控制字符 / 空白 / CRLF 一律拒
    const name = raw.toLowerCase().split(':')[0]
    if (baseDomain === '' || name === '') return null
    const suffix = '.' + baseDomain
    if (name.endsWith(suffix) === false) return null
    const sub = name.slice(0, name.length - suffix.length)
    if (sub === '' || sub.includes('.')) return null
    if (SUBDOMAIN_PATTERN.test(sub) === false) return null
    return sub
  }

  /** 把一帧写给插件。还没 ready 就先攒着（连接已建立但插件还没说要收）。 */
  function writeFrame(tunnel, frame) {
    if (tunnel.dead) return
    if (tunnel.online === false) {
      tunnel.queue.push(frame)
      return
    }
    try {
      tunnel.out.write(JSON.stringify(frame) + '\n')
    } catch (error) {
      log('tunnel: 写帧失败 ' + String(error?.message ?? error))
      closeTunnel(tunnel, 'write-failed')
    }
  }

  function finishPending(tunnel, id) {
    const pending = tunnel.pending.get(id)
    if (pending === undefined) return undefined
    if (pending.timer !== null) clearTimeout(pending.timer)
    tunnel.pending.delete(id)
    return pending
  }

  /** 隧道断开：撤销登记；还没回完的公网请求一律 502，别让它们挂着。 */
  function closeTunnel(tunnel, reason) {
    if (tunnel.dead) return
    tunnel.dead = true
    if (tunnels.get(tunnel.sub) === tunnel) tunnels.delete(tunnel.sub)
    for (const pending of tunnel.pending.values()) {
      if (pending.timer !== null) clearTimeout(pending.timer)
      try {
        if (pending.res.headersSent === false) sendJson(pending.res, 502, { ok: false, error: '这个名字现在没有隧道在线' })
        else pending.res.end()
      } catch {
        /* 对端可能已经走了 */
      }
    }
    tunnel.pending.clear()
    tunnel.queue.length = 0
    try {
      tunnel.out.end()
    } catch {
      /* 已关闭 */
    }
    log('tunnel: 断开 ' + tunnel.sub + '（' + reason + '）')
  }

  /** 插件发来的一帧。 */
  function onPluginFrame(tunnel, frame) {
    const type = frame?.type
    if (type === 'ready') {
      tunnel.online = true
      const queued = tunnel.queue
      tunnel.queue = []
      for (const item of queued) writeFrame(tunnel, item)
      return
    }
    const id = Number(frame?.id)
    if (Number.isFinite(id) === false) return
    if (type === 'response-start') {
      const pending = tunnel.pending.get(id)
      if (pending === undefined) return
      const status = Number(frame.status)
      try {
        pending.res.writeHead(Number.isFinite(status) && status >= 100 ? status : 502, stripHopByHop(frame.headers))
        // 及时把状态行与头发出去，别等 body —— 否则流式响应会卡在头这一步
        if (typeof pending.res.flushHeaders === 'function') pending.res.flushHeaders()
      } catch (error) {
        log('tunnel: 写响应头失败 ' + String(error?.message ?? error))
        const gone = finishPending(tunnel, id)
        if (gone !== undefined) gone.res.destroy()
        return
      }
      pending.started = true
      return
    }
    if (type === 'response-chunk') {
      const pending = tunnel.pending.get(id)
      if (pending === undefined) return
      try {
        // 逐块写：这里绝不能缓存整段再写，否则 SSE 变成「憋到最后一次性吐」
        pending.res.write(Buffer.from(String(frame.data ?? ''), 'base64'))
      } catch (error) {
        log('tunnel: 写响应体失败 ' + String(error?.message ?? error))
      }
      return
    }
    if (type === 'response-end') {
      const pending = finishPending(tunnel, id)
      if (pending !== undefined) pending.res.end()
      return
    }
    if (type === 'response-error') {
      const pending = finishPending(tunnel, id)
      if (pending === undefined) return
      const detail = String(frame.message ?? '')
      // 上游错误的原文（可能带 127.0.0.1:<端口>、ECONNREFUSED 等）只进服务端日志，
      // 绝不能原样回给公网访客 —— 那是内部拓扑信息。
      if (detail !== '') log('tunnel: 上游错误 ' + tunnel.sub + '：' + detail)
      try {
        if (pending.res.headersSent === false) sendJson(pending.res, 502, { ok: false, error: '隧道上游出错' })
        else pending.res.end()
      } catch {
        /* 已关闭 */
      }
    }
  }

  /** 建立隧道：鉴权通过后，这条 HTTP 请求/响应就是一个双向帧通道。 */
  function openTunnel(req, res, sub, accessKey) {
    const existing = tunnels.get(sub)
    if (existing !== undefined) closeTunnel(existing, 'replaced')
    // 记下建隧道时用的口令：巡检要拿它重新 store.verify，好发现吊销/换口令。
    const tunnel = { sub, accessKey, out: res, online: false, queue: [], pending: new Map(), dead: false }
    tunnels.set(sub, tunnel)
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no', // 反代（nginx 等）看到这个才不会替我们把流攒起来
    })
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    log('tunnel: 建立 ' + sub)
    let buffer = ''
    req.on('data', (chunk) => {
      if (tunnel.dead) return
      buffer += chunk.toString('utf8')
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line === '') continue
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          log('tunnel: 丢弃坏帧')
          continue
        }
        if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) continue
        onPluginFrame(tunnel, frame)
      }
      // 一行（一帧）超过上限：这是有人在用不换行的超大帧灌内存，直接断开这条隧道。
      if (buffer.length > maxFrameBytes) {
        log('tunnel: 单帧超过 ' + String(maxFrameBytes) + ' 字节，断开 ' + sub)
        closeTunnel(tunnel, 'frame-too-large')
      }
    })
    const onGone = (reason) => closeTunnel(tunnel, reason)
    req.on('close', () => onGone('closed'))
    req.on('error', () => onGone('error'))
    res.on('close', () => onGone('res-close'))
  }

  /** 公网进来的请求：找到隧道就转成帧喂过去，响应逐块写回。 */
  function handlePublic(req, res) {
    const sub = subdomainFor(req.headers.host)
    if (sub === null) {
      sendJson(res, 404, { ok: false, error: '没有这个入口' })
      return
    }
    const tunnel = tunnels.get(sub)
    if (tunnel === undefined || tunnel.dead) {
      sendJson(res, 502, { ok: false, error: '这个名字现在没有隧道在线' })
      return
    }
    // 在飞请求上限：慢速/挂死上游时，避免一个访客把 pending 表堆成内存炸弹。
    if (tunnel.pending.size >= maxPending) {
      sendJson(res, 503, { ok: false, error: '隧道当前请求过多，稍后再试' })
      return
    }
    const id = (nextRequestId += 1)
    const pending = { id, res, started: false, timer: null }
    tunnel.pending.set(id, pending)
    // 兜底：隧道活着但插件迟迟不回，别让公网连接永远挂着
    pending.timer = setTimeout(() => {
      const gone = finishPending(tunnel, id)
      if (gone === undefined) return
      if (res.headersSent === false) sendJson(res, 504, { ok: false, error: '隧道上游超时' })
      else res.end()
    }, 120000)
    if (typeof pending.timer.unref === 'function') pending.timer.unref()

    writeFrame(tunnel, {
      type: 'request',
      id,
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: { ...req.headers },
    })
    req.on('data', (chunk) => writeFrame(tunnel, { type: 'request-chunk', id, data: chunk.toString('base64') }))
    req.on('end', () => writeFrame(tunnel, { type: 'request-end', id }))
    req.on('error', () => writeFrame(tunnel, { type: 'request-end', id }))
    // 公网客户端自己断了：撤掉这笔（协议里没有 cancel 帧，只能不再等它的回应）
    res.on('close', () => {
      if (res.writableEnded === true) return
      const gone = finishPending(tunnel, id)
      if (gone !== undefined) gone.res.destroy()
    })
  }

  /**
   * 一轮巡检：对每条在线隧道重新跑 store.verify（它内部会重读磁盘，所以管理员
   * 用 CLI `--revoke`、用户换口令都能被这个已经在跑的进程看见）。校验不过就主动
   * 切断并清登记 —— 否则那条隧道会一直服务到自然断开，等于"赶人不走"，公网也会
   * 一直有入口。
   */
  function sweepTunnels() {
    for (const tunnel of [...tunnels.values()]) {
      if (tunnel.dead) continue
      if (store.verify(tunnel.sub, tunnel.accessKey) === true) continue
      closeTunnel(tunnel, 'revoked')
    }
  }
  if (Number.isFinite(sweepMs) && sweepMs > 0) {
    sweepTimer = setInterval(sweepTunnels, sweepMs)
    // unref：巡检不该把进程钉住（生产靠 http server 撑着；测试即便忘了 close 也能退出）。
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://relay')
    const route = url.pathname
    try {
      if (route === '/relay/health') {
        sendJson(res, 200, { ok: true, ...store.stats() })
        return
      }
      const ip = clientIpFor(req)
      if (route === '/relay/enroll' || route === '/relay/rotate') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '请用 POST' })
          return
        }
        if (!allow(ip)) {
          sendJson(res, 429, { ok: false, error: '请求太频繁，稍后再试' })
          return
        }
        const body = JSON.parse((await readBody(req)) || '{}')
        const result =
          route === '/relay/enroll'
            ? store.enroll(body.invite, body.name)
            : store.rotate(body.subdomain, body.accessKey)
        if (result.ok !== true) {
          sendJson(res, 400, result)
          return
        }
        sendJson(res, 200, {
          ...result,
          entry: entryFor(result.subdomain) + (route === '/relay/enroll' ? '?k=' + result.accessKey : ''),
        })
        return
      }
      if (route === '/relay/tunnel') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '请用 POST' })
          return
        }
        const sub = asString(url.searchParams.get('sub')).trim().toLowerCase()
        const key = asString(url.searchParams.get('key'))
        if (sub === '' || SUBDOMAIN_PATTERN.test(sub) === false || store.verify(sub, key) !== true) {
          sendJson(res, 401, { ok: false, error: '口令不正确，或这个名字不存在' })
          return
        }
        openTunnel(req, res, sub, key)
        return
      }
      if (route.startsWith('/relay/')) {
        sendJson(res, 404, { ok: false, error: '没有这个接口' })
        return
      }
      // 剩下的路径都当公网入口：按 Host 的子域找隧道
      handlePublic(req, res)
    } catch (error) {
      const rawStatus = Number(error?.statusCode ?? 400)
      // 5xx 一律不外抛原文（可能含路径/内部细节），详情只进日志；4xx 的校验提示是给用户看的，保留。
      const status = rawStatus >= 400 && rawStatus < 500 ? rawStatus : 500
      if (status === 500) log('relay: 内部错误 ' + String(error?.stack ?? error?.message ?? error))
      const message = status === 500 ? '服务内部错误' : String(error?.message ?? error)
      if (res.headersSent === false) {
        sendJson(res, status, { ok: false, error: message })
      } else {
        try {
          res.end()
        } catch {
          /* 已关闭 */
        }
      }
    }
  }

  /**
   * 关停这个 handler：清掉巡检定时器，并切断所有在线隧道。
   * 测试里（尤其是小 sweepMs）必须调用，否则定时器会一轮轮转下去；生产里进程本来
   * 就要退，这一步主要是为了"可测 + 不留悬空定时器"。
   */
  handle.close = () => {
    if (sweepTimer !== null) {
      clearInterval(sweepTimer)
      sweepTimer = null
    }
    for (const tunnel of [...tunnels.values()]) closeTunnel(tunnel, 'shutdown')
  }

  return handle
}

// ── CLI ────────────────────────────────────────────────────────────────────
function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[key] = true
    else {
      flags[key] = next
      i += 1
    }
  }
  return flags
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))
if (isMain) {
  const flags = parseFlags(process.argv.slice(2))
  const log = (message) => process.stdout.write('[relay] ' + message + '\n')
  const file = typeof flags.state === 'string' ? flags.state : path.join(process.cwd(), 'relay-state.json')
  const store = createIdentityStore({ file, log })

  if (flags['new-invite'] === true) {
    process.stdout.write(store.newInvite() + '\n')
  } else if (flags.list === true) {
    for (const user of store.list()) {
      process.stdout.write(
        [user.name, user.fingerprint, user.createdAt, 'rotations=' + String(user.rotations), 'retired=' + String(user.retiredCount)].join('\t') + '\n',
      )
    }
    process.stdout.write(JSON.stringify(store.stats()) + '\n')
  } else if (typeof flags.revoke === 'string') {
    process.stdout.write(JSON.stringify(store.revoke(flags.revoke)) + '\n')
  } else {
    const port = Number(typeof flags.port === 'string' ? flags.port : 8790)
    const host = typeof flags.host === 'string' ? flags.host : '127.0.0.1' // 只给本机 nginx 用
    const server = http.createServer(
      createRelayServer({
        store,
        baseDomain: typeof flags['base-domain'] === 'string' ? flags['base-domain'] : '',
        log,
      }),
    )
    server.listen(port, host, () => {
      log('身份服务在 http://' + host + ':' + String(port) + '（state=' + file + '）')
    })
  }
}
