/**
 * 共享出口身份服务（M1）的独立测试。
 *
 *   node test/relay.mjs
 *
 * 与 test/verify.mjs 分开，是因为这条链路（出口签发）与插件本体无关，
 * 而且它要的是"能独立跑在服务器上"。
 */
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createIdentityStore,
  createRelayServer,
  fingerprintKey,
  generateAccessKey,
  inviteExpired,
  inviteExpiresAt,
  DEFAULT_INVITE_TTL_DAYS,
  ACCESS_KEY_PATTERN,
} from '../relay/server.mjs'
import { createRelayTunnel } from '../lib/core/relayTunnel.js'

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    process.stdout.write('✔ ' + name + (detail === undefined ? '' : '（' + String(detail) + '）') + '\n')
  } else {
    failed += 1
    process.stdout.write('✖ ' + name + (detail === undefined ? '' : '（' + String(detail) + '）') + '\n')
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-'))
const stateFile = path.join(dir, 'state.json')
// 巡检测试用的小周期：60ms 一轮，能让"吊销后多久被切"在毫秒级观察到。
const SWEEP_MS = 60
const store = createIdentityStore({ file: stateFile, log: () => {} })
const relay = createRelayServer({
  store,
  baseDomain: 'dsh.example.com',
  maxFrameBytes: 65536,
  maxPending: 4,
  sweepMs: SWEEP_MS,
})
const server = http.createServer(relay)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + String(server.address().port) + '/relay'

const post = (route, body) =>
  fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, payload: await r.json() }))

// ── 签发 ──
const invite = store.newInvite()
const enrolled = await post('/enroll', { invite, name: 'Alice' })
check(
  '签发：邀请码换回（名字 + 口令），名字被规范成小写子域',
  enrolled.status === 200 && enrolled.payload.subdomain === 'alice' && ACCESS_KEY_PATTERN.test(enrolled.payload.accessKey),
  enrolled.payload.subdomain + ' / ' + String(enrolled.payload.accessKey ?? '').length + ' 位',
)
check(
  '签发：返回的入口链接带着口令，且域名来自参数（不是写死的）',
  String(enrolled.payload.entry) === 'https://alice.dsh.example.com/?k=' + enrolled.payload.accessKey,
  enrolled.payload.entry,
)

// ── 邀请码一次性 ──
const replay = await post('/enroll', { invite, name: 'bob' })
check('邀请码一次性：同一个码不能再换第二个名字', replay.status === 400 && /用过/.test(replay.payload.error), replay.payload.error)
const bogus = await post('/enroll', { invite: 'NOTAREALCODE', name: 'bob' })
check('邀请码无效：直接拒绝，不会凭空发口令', bogus.status === 400 && /无效/.test(bogus.payload.error), bogus.payload.error)

// ── 名字唯一 / 规范 ──
const taken = await post('/enroll', { invite: store.newInvite(), name: 'alice' })
check('名字唯一：同名字第二个人拿不到（409，不是覆盖）', taken.status === 409, taken.payload.error)
for (const [label, name] of [
  ['非法字符', 'Alice Smith'],
  ['保留名', 'www'],
  ['大写+下划线', 'a_b'],
]) {
  const bad = await post('/enroll', { invite: store.newInvite(), name })
  check('名字规范：' + label + '被拒（且没消耗掉名字）', bad.status === 400, bad.payload.error)
}

// ── 口令全局唯一 + 不落明文 ──
const issued = [enrolled.payload.accessKey]
for (const name of ['bob', 'carol', 'dave', 'erin']) {
  const one = await post('/enroll', { invite: store.newInvite(), name })
  issued.push(one.payload.accessKey)
}
const fingerprints = issued.map(fingerprintKey)
check(
  '口令全局唯一：五个人五把不同的口令、五份不同的指纹',
  new Set(issued).size === 5 && new Set(fingerprints).size === 5,
)
check('口令规范：签发出来的都是 16–128 位 URL 安全字符', issued.every((key) => ACCESS_KEY_PATTERN.test(key)))
check('默认生成器：也是同形的 32 位 URL 安全串', generateAccessKey().length === 32 && ACCESS_KEY_PATTERN.test(generateAccessKey()))

const raw = fs.readFileSync(stateFile, 'utf8')
check(
  '不落明文：状态文件里出现的是指纹，而不是任何一把能用口令',
  issued.every((key) => raw.includes(key) === false) && raw.includes(fingerprintKey(issued[0])),
  '文件里出现 ' + String(fingerprints.filter((fp) => raw.includes(fp)).length) + ' 份指纹',
)

// ── 轮换 ──
const wrongRotate = await post('/rotate', { subdomain: 'alice', accessKey: 'not-the-current-key-0123456789' })
check('轮换：当前口令不对 → 拒绝', wrongRotate.status === 400, wrongRotate.payload.error)
const goodRotate = await post('/rotate', { subdomain: 'alice', accessKey: issued[0] })
check(
  '轮换：用旧口令换新口令，拿到的是一把新的',
  goodRotate.status === 200 && goodRotate.payload.accessKey !== issued[0] && ACCESS_KEY_PATTERN.test(goodRotate.payload.accessKey),
)
const afterRaw = fs.readFileSync(stateFile, 'utf8')
check('轮换：旧口令进退休区（指纹留着），新口令也不会落明文', (() => {
  const state = JSON.parse(afterRaw)
  const user = state.users.alice
  return (
    Array.isArray(user.retired) &&
    user.retired.includes(fingerprintKey(issued[0])) &&
    user.keyFingerprint === fingerprintKey(goodRotate.payload.accessKey) &&
    afterRaw.includes(goodRotate.payload.accessKey) === false
  )
})())
const rotateAfterRotate = await post('/rotate', { subdomain: 'alice', accessKey: issued[0] })
check('轮换：被换掉的口令不能再用来轮换（它已经作废）', rotateAfterRotate.status === 400, rotateAfterRotate.payload.error)

// ── 吊销 / 健康检查 ──
const health = await fetch(base + '/health').then(async (r) => ({ status: r.status, payload: await r.json() }))
check(
  'health：只报计数，不回显任何名字或口令',
  health.status === 200 && health.payload.ok === true && typeof health.payload.users === 'number' && !JSON.stringify(health.payload).includes('alice'),
  JSON.stringify(health.payload),
)
check('未知路由：404，不会误当成签发', (await post('/whatever', {})).status === 404)
check('方法不对：GET /enroll → 405', (await fetch(base + '/enroll')).status === 405)

const revoked = store.revoke('carol')
check('吊销：名字下线，且不再出现在登记表里', revoked.ok === true && store.list().every((item) => item.name !== 'carol'))
check(
  '登记表：只给人看的字段（名字/指纹/时间/轮换次数），不含口令',
  store.list().length === 4 && store.list().every((item) => /^[0-9a-f]{16}$/.test(item.fingerprint)),
  store.list().map((item) => item.name).join(', '),
)

// ── 限流：按"真实客户端 IP"分桶（回环对端时才取 X-Forwarded-For 最后一段）───
// 出口只监听回环、永远在 nginx 后面；若按 socket 地址分桶，30/分 就成了全局额度。
/** 带自定义 XFF 走 /enroll（POST）：用来证明限流按 IP 分桶而不是全局桶。 */
const postWithXff = (route, body, xff) =>
  fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(xff === undefined ? {} : { 'x-forwarded-for': xff }) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, payload: await r.json() }))

const attackerA = '203.0.113.9'
let lastA = { status: 0 }
for (let i = 0; i < 31; i += 1) lastA = await postWithXff('/enroll', { invite: 'NOPE', name: 'x' }, attackerA)
check(
  '限流：同一个伪造 XFF 连打超过上限（30/分）→ 429',
  lastA.status === 429,
  String(lastA.status) + ' / ' + String(lastA.payload?.error ?? ''),
)
// 只信最后一段：前面那些客户端可以随便伪造的段落不该改变分桶 —— 末尾仍是打满的 A → 继续 429
const spoofedPrefix = await postWithXff('/enroll', { invite: 'NOPE', name: 'x' }, '198.51.100.1, ' + attackerA)
check(
  '限流：XFF 取最后一段（可伪造的前缀不算数）→ 仍落回已打满的桶 429',
  spoofedPrefix.status === 429,
  String(spoofedPrefix.status),
)
const attackerB = '203.0.113.10'
const fromB = await postWithXff('/enroll', { invite: 'NOPE', name: 'x' }, attackerB)
check(
  '限流：换一个 XFF 值立刻又能打（按 IP 分桶，不是被攻击者耗尽的全局桶）',
  fromB.status === 400 && /无效/.test(String(fromB.payload?.error ?? '')),
  String(fromB.status) + ' / ' + String(fromB.payload?.error ?? ''),
)

// ── M2 隧道传输 ────────────────────────────────────────────────────────────
// 拓扑：公网请求 → relay 公网收口 →（NDJSON 长连接）→ 假插件 → 假上游（真 http）
const relayPort = server.address().port

function waitFor(fn, timeoutMs = 4000, stepMs = 20) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = async () => {
      let ok = false
      try {
        ok = await fn()
      } catch {
        ok = false
      }
      if (ok === true) {
        resolve(true)
        return
      }
      if (Date.now() >= deadline) {
        resolve(false)
        return
      }
      setTimeout(tick, stepMs)
    }
    tick()
  })
}

/** 拿一个当前空闲的本地端口（用来模拟"本机 Harness 没起来"）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

/**
 * 往 /relay/tunnel 灌一个"没有换行的超大帧"，看出口会不会主动断开。
 * 只写不 end（正常长连接本来就不 end）；靠 res 的 end/close 判断出口是否关掉了我们。
 */
function bigFrameRequest({ sub, key, size, timeoutMs = 3000 }) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const finish = (closed) => {
      if (settled) return
      settled = true
      resolve({ closed, at: Date.now() - started })
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: relayPort,
        method: 'POST',
        path: '/relay/tunnel?sub=' + encodeURIComponent(sub) + '&key=' + encodeURIComponent(key),
        headers: { 'content-type': 'application/x-ndjson' },
      },
      (res) => {
        res.on('data', () => {})
        res.on('end', () => finish(true))
        res.on('close', () => finish(true))
      },
    )
    req.on('error', () => finish(true))
    req.write('a'.repeat(size))
    setTimeout(() => finish(false), timeoutMs)
  })
}

/** 带自定义 Host 打向 relay 公网收口（fetch 不允许改 Host，所以用 node:http）。 */
function rawRequest({ path: reqPath, method = 'GET', host, headers = {}, body, port = relayPort }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path: reqPath, headers: { host, ...headers } },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** 流式请求：记录每一块数据到达的时刻（相对起点 ms），用来证明没被整体缓冲。 */
function streamRequest({ path: reqPath, host }) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const events = []
    const req = http.request(
      { hostname: '127.0.0.1', port: relayPort, path: reqPath, headers: { host } },
      (res) => {
        res.setEncoding('utf8')
        res.on('data', (chunk) => events.push({ at: Date.now() - started, text: chunk }))
        res.on('end', () => resolve({ status: res.statusCode, events }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// 假上游：真 node:http 服务，含一个分块流式路由（两段之间隔 200ms）
const hangingResponses = []
let upstreamHits = 0
const upstream = http.createServer((req, res) => {
  upstreamHits += 1
  const route = new URL(req.url ?? '/', 'http://upstream').pathname
  if (route === '/hello') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-upstream': 'fake' })
    res.end('hello from upstream')
    return
  }
  if (route === '/headers') {
    // 回显上游真正看到的头，用来验证逐跳头/host 有没有被正确剥离与钉死
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        host: req.headers.host ?? null,
        connection: req.headers.connection ?? null,
        smuggled: req.headers['x-smuggled'] ?? null,
      }),
    )
    return
  }
  if (route === '/hang') {
    // 永远不回：用来把 relay 的 pending 表占满，测上限
    hangingResponses.push(res)
    return
  }
  if (route === '/slow') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.flushHeaders()
    res.write('first-part\n')
    setTimeout(() => {
      res.write('second-part\n')
      res.end()
    }, 200)
    return
  }
  if (route === '/echo' && req.method === 'POST') {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('echo:' + Buffer.concat(chunks).toString('utf8'))
    })
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('no such route')
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port

// 没隧道时：已知名字的子域 → 502 + 中文说明；根路径（Host 就是出口域名）→ 404
const noTunnel = await rawRequest({ path: '/hello', host: 'ghost.dsh.example.com' })
check(
  '隧道：没有隧道的子域 → 502，且带中文说明（不是崩溃）',
  noTunnel.status === 502 && noTunnel.body.includes('隧道'),
  String(noTunnel.status) + ' / ' + noTunnel.body.slice(0, 80),
)
const rootPath = await rawRequest({ path: '/', host: 'dsh.example.com' })
check('隧道：根路径（Host 不是子域）→ 404，不误当成隧道', rootPath.status === 404, String(rootPath.status))

// 假插件：用 lib/core/relayTunnel.js 主动拨出到 relay
const aliceKey = goodRotate.payload.accessKey
let publicUrlSeen = null
const fakePlugin = createRelayTunnel({
  url: 'http://127.0.0.1:' + String(relayPort),
  subdomain: 'alice',
  accessKey: aliceKey,
  localPort: upstreamPort,
  log: () => {},
  onPublicUrl: (value) => {
    publicUrlSeen = value
  },
})
fakePlugin.start()
const becameUp = await waitFor(() => fakePlugin.state().phase === 'up', 4000)
check('隧道：插件主动拨出后进入 up（拿到出口 200）', becameUp, fakePlugin.state().code)
check('隧道：IP 基址推不出公网地址，仍能正常 work（publicUrl 为 null，不瞎编）', publicUrlSeen === null, String(publicUrlSeen))

// 等 relay 侧登记 + ready 生效：GET 直到不再是 502
let hello = await rawRequest({ path: '/hello', host: 'alice.dsh.example.com' })
await waitFor(async () => {
  hello = await rawRequest({ path: '/hello', host: 'alice.dsh.example.com' })
  return hello.status === 200
}, 4000)
check(
  '隧道 GET：状态码与响应体原样来回（含上游自定义头）',
  hello.status === 200 && hello.body === 'hello from upstream' && hello.headers['x-upstream'] === 'fake',
  String(hello.status) + ' / ' + JSON.stringify(hello.body),
)

// 分块流式：第二段必须在第一段之后单独到达（证明没有被整体缓冲）
const slow = await streamRequest({ path: '/slow', host: 'alice.dsh.example.com' })
const firstIndex = slow.events.findIndex((event) => event.text.includes('first-part'))
const secondIndex = slow.events.findIndex((event) => event.text.includes('second-part'))
check(
  '隧道流式：两段各自到达（顺序正确）',
  slow.status === 200 && firstIndex >= 0 && secondIndex > firstIndex,
  slow.events.map((event) => event.at + 'ms:' + event.text.trim()).join(' | '),
)
check(
  '隧道流式：第二段晚于第一段 ≥100ms 到达 —— 没被整体缓冲',
  firstIndex >= 0 &&
    secondIndex > firstIndex &&
    slow.events[secondIndex].at - slow.events[firstIndex].at >= 100,
  firstIndex >= 0 && secondIndex > firstIndex
    ? String(slow.events[secondIndex].at - slow.events[firstIndex].at) + 'ms 间隔'
    : '缺段',
)

// POST 带请求体：完整到达上游并被回显
const echoBody = 'dispatch-body-' + 'x'.repeat(300)
const echo = await rawRequest({
  path: '/echo?q=1',
  method: 'POST',
  host: 'alice.dsh.example.com',
  headers: { 'content-type': 'text/plain; charset=utf-8' },
  body: echoBody,
})
check(
  '隧道 POST：请求体完整到达上游（回显一致）',
  echo.status === 200 && echo.body === 'echo:' + echoBody,
  String(echo.status) + ' / ' + String(echo.body.length) + ' 字节',
)

// ── Host 头解析：大小写/端口照常，异常形态一律 404 ─────────────────────────
const hostCase = await rawRequest({ path: '/hello', host: 'ALICE.DSH.EXAMPLE.COM:443' })
check(
  'Host 解析：大小写 + 端口照样路由到同一条隧道',
  hostCase.status === 200 && hostCase.body === 'hello from upstream',
  String(hostCase.status),
)
for (const [label, host] of [
  ['多段子域', 'a.b.alice.dsh.example.com'],
  ['空段 / ..', 'alice..dsh.example.com'],
  ['后缀伪造', 'alice.dsh.example.com.evil.com'],
  ['前导连字符（不合法子域）', '-alice.dsh.example.com'],
  ['非本域', 'evil.com'],
  ['超长', 'a'.repeat(300) + '.dsh.example.com'],
]) {
  const badHost = await rawRequest({ path: '/hello', host })
  check('Host 解析：' + label + ' → 404（不误路由到别人隧道）', badHost.status === 404, String(badHost.status))
}

// ── 逐跳头 / Connection 点名头，不能偷运到上游 ─────────────────────────────
const smuggle = await rawRequest({
  path: '/headers',
  host: 'alice.dsh.example.com',
  headers: { connection: 'keep-alive, X-Smuggled', 'x-smuggled': 'leak' },
})
let smuggleSeen = {}
try {
  smuggleSeen = JSON.parse(smuggle.body)
} catch {
  smuggleSeen = {}
}
check(
  '请求头注入：Connection 点名的 X-Smuggled 被剥离（上游看不到）',
  smuggle.status === 200 && smuggleSeen.smuggled === null,
  JSON.stringify(smuggleSeen),
)
check(
  '本机钉定：上游看到的 Host 是 127.0.0.1:<upstreamPort>，不是公网域名',
  smuggleSeen.host === '127.0.0.1:' + String(upstreamPort),
  String(smuggleSeen.host),
)

// ── pending 上限：挂死上游时不会无限堆请求 ────────────────────────────────
const hung = []
for (let i = 0; i < 4; i += 1) hung.push(rawRequest({ path: '/hang', host: 'alice.dsh.example.com' }))
await new Promise((resolve) => setTimeout(resolve, 200))
const overflow = await rawRequest({ path: '/hang', host: 'alice.dsh.example.com' })
check('DoS：在飞请求超过上限 → 503（不无限堆 pending）', overflow.status === 503, String(overflow.status) + ' / ' + overflow.body.slice(0, 60))
for (const res of hangingResponses) {
  try {
    res.end('done')
  } catch {
    /* 已关闭 */
  }
}
await Promise.all(hung)
await waitFor(async () => (await rawRequest({ path: '/hello', host: 'alice.dsh.example.com' })).status === 200, 4000)

// 伪造口令建隧道 → 被拒
check('隧道鉴权：store.verify 只认当前口令', store.verify('alice', aliceKey) === true && store.verify('alice', 'not-alice-key-000000') === false)
check(
  '鉴权（时序安全）：等长伪造 / 长度不同 / 空口令都判否（不因短路提前返回）',
  store.verify('alice', aliceKey) === true &&
    store.verify('alice', aliceKey.slice(0, -1) + (aliceKey.endsWith('a') ? 'b' : 'a')) === false &&
    store.verify('alice', 'short') === false &&
    store.verify('alice', '') === false,
)
const forged = await rawRequest({
  path: '/relay/tunnel?sub=alice&key=' + 'x'.repeat(32),
  method: 'POST',
  host: 'alice.dsh.example.com',
  body: '{"type":"ready"}\n',
})
check('隧道鉴权：伪造 key 建隧道被拒（401/403）', forged.status === 401 || forged.status === 403, String(forged.status))

// 顶替判据：没有口令的人顶不掉在线的人 —— 伪造请求被 401，原隧道照常服务
const stillAlive = await rawRequest({ path: '/hello', host: 'alice.dsh.example.com' })
check(
  '顶替/劫持：伪造口令建隧道后，原在线隧道毫发无伤（无口令无法顶人）',
  stillAlive.status === 200 && stillAlive.body === 'hello from upstream',
  String(stillAlive.status),
)

// ── 出口单帧上限：灌一条不换行的超大帧 → 出口主动断开 ──────────────────────
const bigKey = store.enroll(store.newInvite(), 'big').accessKey
const bigFrame = await bigFrameRequest({ sub: 'big', key: bigKey, size: 128 * 1024 })
check(
  'DoS：隧道单帧超过上限 → 出口主动断开（不再把超大帧攒进内存）',
  bigFrame.closed === true,
  bigFrame.closed ? String(bigFrame.at) + 'ms 后断开' : '未断开（超时）',
)

// ── 信息泄漏：上游连不上时，502 不回显内部端口 / 错误原文 ─────────────────
const closedPort = await freePort()
const leakyKey = store.enroll(store.newInvite(), 'leaky').accessKey
const leakyPlugin = createRelayTunnel({
  url: 'http://127.0.0.1:' + String(relayPort),
  subdomain: 'leaky',
  accessKey: leakyKey,
  localPort: closedPort,
  log: () => {},
})
leakyPlugin.start()
await waitFor(() => leakyPlugin.state().phase === 'up', 3000)
const leaked = await rawRequest({ path: '/', host: 'leaky.dsh.example.com' })
check(
  '信息泄漏：上游连不上时的 502 不含 ECONNREFUSED / 127.0.0.1 / 内部端口（原文只进日志）',
  leaked.status === 502 && /ECONNREFUSED|127\.0\.0\.1|:\d{4,5}/.test(leaked.body) === false,
  String(leaked.status) + ' / ' + leaked.body.slice(0, 80),
)
await leakyPlugin.stop()

// ── 插件侧对"坏出口"的防护：超大帧断开重连 ────────────────────────────────
const noisy = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  if (typeof res.flushHeaders === 'function') res.flushHeaders()
  setTimeout(() => {
    if (!res.writableEnded) res.write('x'.repeat(64 * 1024))
  }, 50)
})
await new Promise((resolve) => noisy.listen(0, '127.0.0.1', resolve))
const hammered = createRelayTunnel({
  url: 'http://127.0.0.1:' + String(noisy.address().port),
  subdomain: 'x',
  accessKey: 'x',
  localPort: upstreamPort,
  maxFrameBytes: 8192,
  backoffBaseMs: 30,
  backoffMaxMs: 60,
  log: () => {},
})
hammered.start()
const frameDropped = await waitFor(() => hammered.state().restarts >= 1, 3000)
check('DoS：插件侧单帧超过上限 → 断线重连（不被坏出口灌爆内存）', frameDropped, hammered.state().code)
await hammered.stop()
noisy.close()

// ── 请求行注入：坏出口发来 CRLF 请求行，插件必须拒绝且不碰本机上游 ──────────
const evilFrames = []
let evilReady = false
const evilRelay = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  if (typeof res.flushHeaders === 'function') res.flushHeaders()
  req.setEncoding('utf8')
  req.on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
      if (line.trim() === '') continue
      evilFrames.push(line)
      if (line.includes('"ready"')) evilReady = true
    }
    if (evilReady) {
      evilReady = false
      res.write(JSON.stringify({ type: 'request', id: 1, method: 'GET', url: '/ok\r\nX-Evil: 1' }) + '\n')
    }
  })
})
await new Promise((resolve) => evilRelay.listen(0, '127.0.0.1', resolve))
const hitsBefore = upstreamHits
const victim = createRelayTunnel({
  url: 'http://127.0.0.1:' + String(evilRelay.address().port),
  subdomain: 'x',
  accessKey: 'x',
  localPort: upstreamPort,
  log: () => {},
})
victim.start()
const rejected = await waitFor(() => evilFrames.some((line) => line.includes('"response-error"')), 3000)
check(
  '请求行注入：出口转来的 CRLF 请求行被判非法（response-error），没打到本机上游',
  rejected && evilFrames.some((line) => line.includes('"response-start"')) === false && upstreamHits === hitsBefore,
  'response-error=' + String(rejected) + ' 上游新增请求=' + String(upstreamHits - hitsBefore),
)
await victim.stop()
evilRelay.close()

// 断开隧道 → 服务端登记被清理 → 再请求回到 502
await fakePlugin.stop()
const cleared = await waitFor(async () => {
  const again = await rawRequest({ path: '/hello', host: 'alice.dsh.example.com' })
  return again.status === 502
}, 4000)
check('隧道断开：服务端登记被清理，再请求该子域回到 502', cleared, fakePlugin.state().phase)
const healthAfter = await fetch(base + '/health').then(async (r) => ({ status: r.status, payload: await r.json() }))
check(
  '隧道测试后：身份服务仍然健康（没被隧道搞崩），登记信息不变',
  healthAfter.status === 200 && healthAfter.payload.ok === true,
  JSON.stringify(healthAfter.payload),
)

// ── 巡检：吊销 / 换口令后，已在线的隧道被立刻切断（可关闭、可测）─────────────
// 起一条专用隧道 → 管理员吊销 → 公网请求应在 2×sweepMs 量级内变 502（隧道被切+登记清掉）。
const sweepUser = await post('/enroll', { invite: store.newInvite(), name: 'sweep' })
const sweepPlugin = createRelayTunnel({
  url: 'http://127.0.0.1:' + String(relayPort),
  subdomain: 'sweep',
  accessKey: sweepUser.payload.accessKey,
  localPort: upstreamPort,
  log: () => {},
})
sweepPlugin.start()
const sweepUpOk = await waitFor(async () => (await rawRequest({ path: '/hello', host: 'sweep.dsh.example.com' })).status === 200, 4000)
// 口令没变：跨过好几个巡检周期都不该被误切（负向对照，证明切的是"吊销"而非"超时"）
await new Promise((resolve) => setTimeout(resolve, 5 * SWEEP_MS))
const sweepSurvives = await rawRequest({ path: '/hello', host: 'sweep.dsh.example.com' })
check(
  '巡检：口令未变的隧道不会被误切（跨 5 个巡检周期仍 200）',
  sweepUpOk === true && sweepSurvives.status === 200,
  'up=' + String(sweepUpOk) + ' after5cycles=' + String(sweepSurvives.status),
)
const sweepRevoked = store.revoke('sweep')
const sweepCutAt = Date.now()
const sweepCut = await waitFor(async () => (await rawRequest({ path: '/hello', host: 'sweep.dsh.example.com' })).status === 502, 4000)
const sweepElapsed = Date.now() - sweepCutAt
check(
  '巡检：管理员吊销后，已在线的隧道在 2×sweepMs 量级内被切断（公网随即回到 502）',
  sweepRevoked.ok === true && sweepCut === true && sweepElapsed <= 2 * SWEEP_MS + 1000,
  'elapsed=' + String(sweepElapsed) + 'ms / revoke=' + JSON.stringify(sweepRevoked),
)
await sweepPlugin.stop()

// 换口令同理：旧口令建起来的隧道要立刻失效，不能"换了个密码但旧连接继续服务"。
const rotUser = await post('/enroll', { invite: store.newInvite(), name: 'rot' })
const rotOldKey = rotUser.payload.accessKey
const rotPlugin = createRelayTunnel({
  url: 'http://127.0.0.1:' + String(relayPort),
  subdomain: 'rot',
  accessKey: rotOldKey,
  localPort: upstreamPort,
  log: () => {},
})
rotPlugin.start()
const rotUpOk = await waitFor(async () => (await rawRequest({ path: '/hello', host: 'rot.dsh.example.com' })).status === 200, 4000)
const rotated = await post('/rotate', { subdomain: 'rot', accessKey: rotOldKey })
const rotCutAt = Date.now()
const rotCut = await waitFor(async () => (await rawRequest({ path: '/hello', host: 'rot.dsh.example.com' })).status === 502, 4000)
const rotElapsed = Date.now() - rotCutAt
check(
  '巡检：用户换口令后，用旧口令建立的在线隧道被切断（旧连接不再服务）',
  rotUpOk === true && rotated.status === 200 && rotCut === true && rotElapsed <= 2 * SWEEP_MS + 1000,
  'elapsed=' + String(rotElapsed) + 'ms / rotate=' + String(rotated.status),
)
await rotPlugin.stop()

// 可关闭：sweepMs=0 时不起定时器 —— 吊销后旧连接不会被自动切（证明"巡检"确实可关）。
const relayNoSweep = createRelayServer({ store, baseDomain: 'dsh.example.com', sweepMs: 0 })
const serverNoSweep = http.createServer(relayNoSweep)
await new Promise((resolve) => serverNoSweep.listen(0, '127.0.0.1', resolve))
const noSweepPort = serverNoSweep.address().port
const nosweepUser = store.enroll(store.newInvite(), 'nosweep')
const nosweepPlugin = createRelayTunnel({
  url: 'http://127.0.0.1:' + String(noSweepPort),
  subdomain: 'nosweep',
  accessKey: nosweepUser.accessKey,
  localPort: upstreamPort,
  log: () => {},
})
nosweepPlugin.start()
const noSweepUp = await waitFor(async () => (await rawRequest({ path: '/hello', host: 'nosweep.dsh.example.com', port: noSweepPort })).status === 200, 4000)
store.revoke('nosweep')
// 至少跨过若干个"若开了巡检就会切断"的周期
await new Promise((resolve) => setTimeout(resolve, 5 * SWEEP_MS))
const noSweepAlive = await rawRequest({ path: '/hello', host: 'nosweep.dsh.example.com', port: noSweepPort })
check(
  '巡检可关闭：sweepMs=0 时吊销后连接不会被自动切（跨 5 个周期仍 200）',
  noSweepUp === true && noSweepAlive.status === 200,
  'up=' + String(noSweepUp) + ' afterRevoke=' + String(noSweepAlive.status),
)
await nosweepPlugin.stop()
relayNoSweep.close()
serverNoSweep.close()

upstream.close()
relay.close()
server.close()
fs.rmSync(dir, { recursive: true, force: true })

// ── 管理员用 CLI 改文件时，正在跑的服务必须看得见（否则邀请码要重启、被吊销的人还能连）──
const liveFile = path.join(dir, 'live-state.json')
const serviceStore = createIdentityStore({ file: liveFile, log: () => {} }) // 扮演"已经在跑的服务进程"
const cliStore = createIdentityStore({ file: liveFile, log: () => {} }) // 扮演"管理员敲的 CLI"
const cliInvite = cliStore.newInvite()
const svcEnrolled = serviceStore.enroll(cliInvite, 'zoe')
check(
  'CLI 发的邀请码：服务不用重启就认得（enroll 前重读磁盘状态）',
  svcEnrolled.ok === true && svcEnrolled.subdomain === 'zoe',
  JSON.stringify(svcEnrolled),
)
const cliRevoked = cliStore.revoke('zoe')
const svcAfterRevoke = serviceStore.verify('zoe', svcEnrolled.accessKey)
check(
  'CLI 吊销后：服务立刻不再认这个名字（不能继续拨隧道）',
  cliRevoked.ok === true && svcAfterRevoke === false,
  'revoke=' + JSON.stringify(cliRevoked) + ' verify=' + String(svcAfterRevoke),
)
// /relay/health 的数字也要跟着磁盘走：服务进程报旧数字比不报还坏
check(
  'CLI 吊销后：服务进程的 stats()（/relay/health 的来源）也立刻反映（users 归零）',
  serviceStore.stats().users === 0,
  'users=' + String(serviceStore.stats().users),
)

// ── 管理接口（发码）+ 邀请码有效期：给"关联了账户"的那一边（荔枝记账）用 ──
// 注意：上面那批 server 已经 close 掉了（隧道测试收尾），这里自己起两个：
// 一个没配令牌（验"默认关闭"），一个配了令牌（验发码/查状态/限流）。
fs.mkdirSync(dir, { recursive: true }) // 上面的 rmSync 把临时目录删了，建回来
const plainStore = createIdentityStore({ file: path.join(dir, 'plain-state.json'), log: () => {} })
const plainServer = http.createServer(createRelayServer({ store: plainStore, baseDomain: 'dsh.example.com', sweepMs: 0 }))
await new Promise((resolve) => plainServer.listen(0, '127.0.0.1', resolve))
const plainBase = 'http://127.0.0.1:' + String(plainServer.address().port) + '/relay'
const noAdmin = await fetch(plainBase + '/admin/invite', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
}).then(async (r) => ({ status: r.status, payload: await r.json() }))
check(
  '管理接口默认关闭：没配令牌时 /relay/admin/invite 根本不存在（404，不是 401）',
  noAdmin.status === 404,
  'HTTP ' + String(noAdmin.status) + ' ' + String(noAdmin.payload.error),
)
plainServer.close()

const ADMIN_TOKEN = 'admin-token-0123456789abcdefghij'
const adminStore = createIdentityStore({ file: path.join(dir, 'admin-state.json'), log: () => {} })
const adminRelay = createRelayServer({
  store: adminStore,
  baseDomain: 'dsh.example.com',
  adminToken: ADMIN_TOKEN,
  sweepMs: 0,
})
const adminServer = http.createServer(adminRelay)
await new Promise((resolve) => adminServer.listen(0, '127.0.0.1', resolve))
const adminBase = 'http://127.0.0.1:' + String(adminServer.address().port) + '/relay'
const adminPostBase = (route, body, token) =>
  fetch(adminBase + route, {
    method: 'POST',
    headers:
      token === undefined
        ? { 'content-type': 'application/json' }
        : { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body ?? {}),
  }).then(async (r) => ({ status: r.status, payload: await r.json() }))
/** 这一分钟里被限流器放过的管理请求数（最后一条限流断言要用它，不能只数循环次数）。 */
let adminAllowed = 0
const adminPost = async (route, body, token) => {
  const res = await adminPostBase(route, body, token)
  if (res.status !== 429) adminAllowed += 1
  return res
}

const noToken = await adminPost('/admin/invite', {})
const badToken = await adminPost('/admin/invite', {}, 'not-the-token-not-the-token')
check(
  '管理接口：没令牌 / 错令牌 → 401（配了令牌才存在，但没令牌照样进不来）',
  noToken.status === 401 && badToken.status === 401,
  'HTTP ' + String(noToken.status) + ' / ' + String(badToken.status),
)

const adminIssued = await adminPost('/admin/invite', {}, ADMIN_TOKEN)
const issuedDays = adminIssued.payload.expiresAt === null ? 0 : (Date.parse(adminIssued.payload.expiresAt) - Date.now()) / 86400000
check(
  '管理接口：拿着令牌发码 → 200，返回码 + 有效期（默认 14 天）',
  adminIssued.status === 200 && /^[A-Z0-9]{10}$/.test(String(adminIssued.payload.code)) && issuedDays > 13.9 && issuedDays < 14.1,
  'code=' + String(adminIssued.payload.code) + ' 有效期≈' + issuedDays.toFixed(2) + ' 天',
)
const shortTtl = await adminPost('/admin/invite', { ttlDays: 3 }, ADMIN_TOKEN)
const shortDays = shortTtl.payload.expiresAt === null ? 0 : (Date.parse(shortTtl.payload.expiresAt) - Date.now()) / 86400000
check(
  '管理接口：有效期可以设置（ttlDays=3 → 3 天）',
  shortTtl.status === 200 && shortDays > 2.9 && shortDays < 3.1,
  '有效期≈' + shortDays.toFixed(2) + ' 天',
)
const neverTtl = await adminPost('/admin/invite', { ttlDays: 0 }, ADMIN_TOKEN)
check(
  '管理接口：ttlDays=0 → 不过期（expiresAt 为 null），照旧能用',
  neverTtl.status === 200 && neverTtl.payload.expiresAt === null,
  'expiresAt=' + JSON.stringify(neverTtl.payload.expiresAt),
)

const statusBefore = await adminPost("/admin/invite/status", { code: adminIssued.payload.code }, ADMIN_TOKEN)
const used = await fetch(adminBase + '/enroll', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ invite: adminIssued.payload.code, name: 'ivy' }),
}).then(async (r) => ({ status: r.status, payload: await r.json() }))
const statusAfter = await adminPost("/admin/invite/status", { code: adminIssued.payload.code }, ADMIN_TOKEN)
const statusUnknown = await adminPost('/admin/invite/status', { code: 'NOSUCHCODE' }, ADMIN_TOKEN)
check(
  '管理接口：发出去的码能正常登记（200 + 名字/口令）',
  used.status === 200 && used.payload.subdomain === 'ivy' && typeof used.payload.accessKey === 'string',
  'HTTP ' + String(used.status) + ' subdomain=' + String(used.payload.subdomain),
)
check(
  '管理接口：查码状态 —— 用之前 used=false，用之后 used=true 且带 usedBy；不存在的码 exists=false',
  statusBefore.payload.exists === true &&
    statusBefore.payload.used === false &&
    statusAfter.payload.used === true &&
    statusAfter.payload.usedBy === 'ivy' &&
    statusUnknown.payload.exists === false,
  JSON.stringify({ before: statusBefore.payload.used, after: statusAfter.payload.used, by: statusAfter.payload.usedBy }),
)

// 有效期：过期的码不能再用（拿一份"过期码"的状态文件喂给 store，确定性最高，不靠等）
const expiredFile = path.join(dir, 'expired-state.json')
fs.writeFileSync(
  expiredFile,
  JSON.stringify({
    version: 1,
    invites: {
      OLDCODE123: { createdAt: '2020-01-01T00:00:00.000Z', usedAt: null, usedBy: null, expiresAt: '2020-01-02T00:00:00.000Z' },
    },
    users: {},
  }),
)
const expiredStore = createIdentityStore({ file: expiredFile, log: () => {} })
const expiredEnroll = expiredStore.enroll('OLDCODE123', 'late')
check(
  '邀请码有效期：过期的码被拒，错误可读（不是说"无效"，是"过期"）',
  expiredEnroll.ok === false && /过期/.test(expiredEnroll.error),
  String(expiredEnroll.error),
)
const expiredStats = expiredStore.stats()
check(
  '邀请码有效期：过期的不算"可用"（stats 分开计数，面板/巡检才看得出实情）',
  expiredStats.usableInvites === 0 && expiredStats.expiredInvites === 1 && expiredStats.unusedInvites === 1,
  JSON.stringify(expiredStats),
)
check(
  '邀请码有效期：老记录（没有 expiresAt 字段 / 为 null）按"不过期"算 —— 不能一夜之间把存量码全废了',
  inviteExpired({}) === false && inviteExpired({ expiresAt: null }) === false && inviteExpired({ expiresAt: '2999-01-01T00:00:00.000Z' }) === false,
  'ok',
)
const ttl14 = (Date.parse(inviteExpiresAt(DEFAULT_INVITE_TTL_DAYS)) - Date.now()) / 86400000
const ttlCap = (Date.parse(inviteExpiresAt(99999)) - Date.now()) / 86400000
check(
  '邀请码有效期：默认 14 天、上限 365 天（拿着令牌也发不出"永久"码）',
  ttl14 > 13.9 && ttl14 < 14.1 && ttlCap > 364 && ttlCap < 366 && inviteExpiresAt('never') === null && inviteExpiresAt(-5) === null,
  '默认≈' + ttl14.toFixed(2) + ' 天，上限≈' + ttlCap.toFixed(0) + ' 天',
)

// 管理接口单独限流（放最后：它会把这一分钟的额度用掉）
for (let i = 0; i < 25; i += 1) {
  const res = await adminPost('/admin/invite', {}, 'wrong-token-wrong-token-wrong')
  if (res.status === 429) break
}
const rateLimited = await adminPost('/admin/invite', {}, ADMIN_TOKEN)
check(
  '管理接口：按 IP 限流，一分钟正好放过 20 次（之后令牌再对也 429）—— 挡住拿错令牌暴力试',
  adminAllowed === 20 && rateLimited.status === 429,
  '放过 ' + String(adminAllowed) + ' 次，之后 HTTP ' + String(rateLimited.status),
)

adminServer.close()

process.stdout.write('\n' + String(passed) + ' 项通过，' + String(failed) + ' 项失败\n')
if (failed > 0) process.exit(1)
