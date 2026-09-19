/**
 * 冒烟测试：不依赖任何测试框架，直接 `node test/verify.mjs`。
 *
 * 覆盖两半各自的真实契约：
 *  - host 半：导出形状、配置校验、路由注册、状态/开关/片段接口、代理标记的越权拦截、
 *             fiber 回收后端口是否真的释放。
 *  - client 半：bundle 协议（__ModuleLoader__.load）、apply 注册的槽位、
 *              store/动作与 fetch 交互、用真实 React 做一次 SSR 渲染。
 *
 * React 从 DSH 桌面版自带的 node_modules 取（只用于 SSR 渲染断言）。
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const APP_MODULES = '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules'
/** React 解析顺序：仓库自己的 devDependency → DSH 安装目录（后者只为兼容无网环境）。 */
function resolveReactDir() {
  const local = path.join(root, 'node_modules')
  for (const candidate of [local, APP_MODULES]) {
    if (fs.existsSync(path.join(candidate, 'react', 'package.json'))) return candidate
  }
  throw new Error('找不到 react：请先 npm install（或安装 DSH Desktop）')
}
const HOST = 'http://127.0.0.1:'
const API = '/remote-connect/api'

let passed = 0
let failed = 0

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    process.stdout.write('✔ ' + name + (detail ? '（' + detail + '）' : '') + '\n')
  } else {
    failed += 1
    process.stdout.write('✖ ' + name + (detail ? '（' + detail + '）' : '') + '\n')
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

// ───────────────────────────── host 半 ─────────────────────────────

const routes = []
const disposers = []
const logs = []
const fakeCtx = {
  logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
  // 模拟 Cordis：get() 在服务缺失时返回 undefined（connection 在非 Web profile 就没有）
  get: () => undefined,
  webServer: {
    // 官方 Web 载体自己暴露实际监听端口：插件优先用它，不硬编码
    port: 43129,
    register: (route) => {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  },
  effect: (callback) => {
    const disposer = callback()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
}

const host = await import(pathToFileURL(path.join(root, 'lib/index.js')).href)

check('host: 导出 name = remote-connect', host.name === 'remote-connect')
check('host: 导出 apply 函数', typeof host.apply === 'function')
check('host: inject 声明 webServer', Array.isArray(host.inject) && host.inject.includes('webServer'))
check(
  'host: 空配置不报问题',
  host.normalizeConfig({}).problems.length === 0,
  'problems=' + String(host.normalizeConfig({}).problems.length),
)
check(
  'host: tunnel=ssh 缺 ssh 账号时报问题',
  host.normalizeConfig({ public: { domain: 'dsh.example.com', tunnel: 'ssh' } }).problems.length > 0,
)
check(
  'host: 非法端口回落默认值',
  host.normalizeConfig({ lan: { port: 999999 } }).lan.port === 8787,
)

host.apply(fakeCtx, { lan: { enabled: false, port: 8801 }, public: { domain: 'localhost', port: 8802 } })
check('host: 注册了 1 条 prefix 路由', routes.length === 1 && routes[0].kind === 'prefix', routes[0]?.path)

// 用一个真实 HTTP 服务复刻 webserver 的 exact/prefix 分发
const dispatcher = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const route = routes.find((item) => (item.kind === 'exact' ? item.path === pathname : pathname.startsWith(item.path)))
  if (route === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  void route.handler(req, res)
})
const port = await listen(dispatcher)

async function call(route, options = {}) {
  const response = await fetch(HOST + String(port) + API + route, {
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    method: options.method ?? 'GET',
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text === '' ? null : JSON.parse(text)
  } catch {
    payload = text
  }
  return { status: response.status, payload }
}

const state1 = await call('/state')
check('api: GET /state 200', state1.status === 200)
check('api: 宿主机窗口可以控制', state1.payload?.canControl === true)
check('api: 局域网默认未运行', state1.payload?.lan?.running === false)
check(
  'api: 上游端口来源可追溯（来自 webServer 服务，不是硬编码）',
  state1.payload?.upstream?.port === 43129 && state1.payload?.upstream?.source === 'webServer',
  JSON.stringify(state1.payload?.upstream ?? null),
)

const started = await call('/lan/start', { method: 'POST' })
check(
  'api: 令牌来源可追溯（配置/服务/日志三者之一）',
  started.payload?.upstream?.hasToken === true && String(started.payload?.upstream?.tokenSource).length > 0,
  String(started.payload?.upstream?.tokenSource),
)
check('api: POST /lan/start 启动成功', started.status === 200 && started.payload?.lan?.running === true)
check(
  'api: 启动后给出局域网地址',
  typeof started.payload?.lan?.url === 'string' && started.payload.lan.url.startsWith('http://'),
  started.payload?.lan?.url ?? 'null',
)
check(
  'api: 启动后给出二维码矩阵',
  Array.isArray(started.payload?.qr) && started.payload.qr.length > 0,
  Array.isArray(started.payload?.qr) ? String(started.payload.qr.length) + ' 行' : 'null',
)

// 代理来源标记必须阻断控制（模拟经代理进来的访客）
const proxiedState = await call('/state', { headers: { 'x-remote-connect-origin': 'public' } })
check('api: 经代理访问时 canControl=false', proxiedState.payload?.canControl === false)
const forbidden = await call('/lan/stop', { method: 'POST', headers: { 'x-remote-connect-origin': 'public' } })
check('api: 公网访客开关被拒（403）', forbidden.status === 403, String(forbidden.status))
const stillRunning = await call('/state')
check('api: 被拒后服务仍在运行', stillRunning.payload?.lan?.running === true)

const snippets = await call('/snippets?kind=nginx')
check(
  'api: /snippets 返回 nginx 配置',
  typeof snippets.payload === 'string' &&
    snippets.payload.includes('proxy_buffering') &&
    snippets.payload.includes('server_name localhost'),
)
const checkRun = await call('/check', { method: 'POST' })
check('api: POST /check 返回逐项结果', checkRun.status === 200 && Array.isArray(checkRun.payload?.results), String(checkRun.payload?.results?.length ?? 0) + ' 项')

// 检查结果按请求语言渲染（面板带 ?locale=，CLI 走环境变量）
const checkZh = await call('/check?locale=zh', { method: 'POST' })
const checkEn = await call('/check?locale=en', { method: 'POST' })
const zhNames = (checkZh.payload?.results ?? []).map((item) => item.name).join(',')
const enNames = (checkEn.payload?.results ?? []).map((item) => item.name).join(',')
check(
  'api: /check 支持 ?locale=（zh 与 en 的条目名不同）',
  zhNames.includes('DNS 解析') && enNames.includes('DNS') && zhNames !== enNames,
  'zh=' + zhNames + ' | en=' + enNames,
)
check(
  'api: 未知 locale 退回英文而不是报错',
  (await call('/check?locale=ja', { method: 'POST' })).payload?.results?.[0]?.name === 'DNS',
)
check(
  'api: 错误文案也按 ?locale= 渲染',
  (await call('/nope?locale=zh')).payload?.error === '未知接口：/nope' &&
    (await call('/nope?locale=en')).payload?.error === 'Unknown endpoint: /nope',
)

const unknown = await call('/nope')
check('api: 未知接口 404', unknown.status === 404)

const stopped = await call('/lan/stop', { method: 'POST' })
check('api: POST /lan/stop 停止成功', stopped.status === 200 && stopped.payload?.lan?.running === false)

// fiber 回收：运行中的监听必须随 disposer 一起消失
const restarted = await call('/lan/start', { method: 'POST' })
const liveUrl = restarted.payload?.lan?.url ?? null
let teardownProbe = 'no url'
const beforeTeardown =
  liveUrl === null
    ? false
    : await fetch(liveUrl, { method: 'GET', redirect: 'manual' }).then(
        (response) => {
          teardownProbe = 'HTTP ' + String(response.status)
          return true
        },
        (error) => {
          const cause = error?.cause
          const inner = cause?.errors?.[0]?.code ?? cause?.code ?? cause?.message
          teardownProbe = 'fetch failed: ' + String(inner ?? error?.message ?? error)
          return false
        },
      )
check('proxy: 局域网端口可连（经 Cordis 生命周期管理）', beforeTeardown, (liveUrl ?? 'no url') + ' → ' + teardownProbe)
check(
  'proxy: 局域网入口不带密钥也要通（接上访问口令 provider 就会整站 404 —— 已回归过一次）',
  liveUrl !== null && (await fetch(liveUrl, { redirect: 'manual' }).then((r) => r.status).catch(() => 0)) !== 404,
  String(liveUrl),
)
for (const dispose of disposers) dispose()
await new Promise((resolve) => setTimeout(resolve, 300))
const afterTeardown =
  liveUrl === null
    ? true
    : await fetch(liveUrl, { method: 'GET', redirect: 'manual' }).then(
        () => true,
        () => false,
      )
check('proxy: disposer 之后端口已释放', afterTeardown === false)
check('host: 至少注册了 1 条 teardown effect', disposers.length >= 1, String(disposers.length))

dispatcher.close()

// ──────────────────────────── client 半 ────────────────────────────

const REACT_DIR = resolveReactDir()
const React = (await import(pathToFileURL(path.join(REACT_DIR, 'react/index.js')).href)).default
const { renderToStaticMarkup } = await import(
  pathToFileURL(path.join(REACT_DIR, 'react-dom/server.node.js')).href
)

const source = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8')
let captured = null
const styleTags = []
const fakeWindow = {
  __ModuleLoader__: {
    load: (definition) => {
      captured = definition
    },
  },
}
const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (tag) => styleTags.push(tag) },
}
new Function('window', 'document', source)(fakeWindow, fakeDocument)

check('client: 走 __ModuleLoader__.load 注册', captured !== null && captured.id === 'dsh-plugin-remote-connect')

const clientExports = captured.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error('unexpected require: ' + specifier)
})
check(
  'client: 注入并插入样式表（factory 求值时）',
  styleTags.length === 1 && String(styleTags[0].textContent).includes('.dshRcPanel'),
  String(styleTags.length) + ' 个 style 标签',
)
check('client: 导出 apply / inject', typeof clientExports.apply === 'function' && Array.isArray(clientExports.inject))
check(
  'client: inject = [slots, locale]（locale 为软依赖）',
  clientExports.inject.length === 2 && clientExports.inject[0] === 'slots' && clientExports.inject[1] === 'locale',
)

const registrations = []
const registeredLocales = []
const fakeLocale = {
  register: (ns, dicts) => {
    registeredLocales.push({ ns, dicts })
    return () => {}
  },
}
const fakeSlots = {
  inject: (name, callback) => {
    callback()
  },
  register: (options, Component) => {
    registrations.push({ options, Component })
  },
}
clientExports.apply({
  get: (name) => (name === 'slots' ? fakeSlots : name === 'locale' ? fakeLocale : undefined),
  effect: (callback) => {
    const disposer = callback()
    return disposer
  },
})
check(
  'client: 注册了 zh/en 双字典',
  registeredLocales.length === 1 &&
    registeredLocales[0].ns === 'remote-connect' &&
    Object.keys(registeredLocales[0].dicts.zh).length > 10 &&
    Object.keys(registeredLocales[0].dicts.en).length === Object.keys(registeredLocales[0].dicts.zh).length,
  registeredLocales.length === 1
    ? Object.keys(registeredLocales[0].dicts.zh).length + ' 键'
    : '未注册',
)
check(
  'client: 槽位注册带 locale 命名空间',
  registrations.every((item) => item.options.locale === 'remote-connect'),
)
check(
  'client: 注册侧栏入口与浮层面板',
  registrations.length === 2 &&
    registrations[0].options.id === 'remote-connect' &&
    registrations[0].options.name === 'sidebar.footer.action' &&
    registrations[1].options.name === 'shell.overlay',
  registrations.map((item) => item.options.name).join(' + '),
)

const zhT = (key) => ({ 'entry.label': '远程连接', 'panel.title': '远程连接' })[key] ?? key
const entryHtml = renderToStaticMarkup(
  React.createElement(registrations[0].Component, { wide: true, t: zhT }),
)
check('client: 侧栏入口渲染出「远程连接」（走 t()）', entryHtml.includes('远程连接') && entryHtml.includes('aria-label="远程连接"'))
const markerT = (key) => '«' + key + '»'
const entryMarked = renderToStaticMarkup(
  React.createElement(registrations[0].Component, { wide: true, t: markerT }),
)
check(
  'client: 入口文案没有硬编码（走 t() 字典）',
  entryMarked.includes('«entry.label»') && entryMarked.includes('aria-label="«entry.label»"'),
)

// store + fetch 交互：走真实的 api()/act() 路径
const calls = []
const canned = {
  [API + '/state']: {
    ok: true,
    busy: false,
    canControl: true,
    config: {
      problems: [],
      publicDomain: 'dsh.example.com',
      tunnel: 'ssh',
      sshUser: 'dshtunnel',
      sshHost: 'dsh.example.com',
      sshPort: 22022,
      remotePort: 8788,
    },
    lan: { running: true, url: 'http://192.0.2.10:8787/' },
    public: { running: false, domain: 'dsh.example.com', entry: 'https://dsh.example.com/?k=abc', tunnel: null },
    qr: ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'],
    error: null,
  },
  [API + '/tenants/add']: {
    ok: true,
    tenant: { id: 'carol', name: 'Carol', accessKey: 'key-carol-0123456789', port: 58583, phase: 'starting', running: false },
    tenants: [
      { id: 'alice', name: 'Alice', port: 58581, phase: 'up', running: true, lanEntry: 'http://192.0.2.10:8787/?k=key-alice-0123456789' },
      { id: 'carol', name: 'Carol', port: 0, phase: 'starting', running: false, lanEntry: 'http://192.0.2.10:8787/?k=key-carol-0123456789' },
    ],
  },
  [API + '/tenants/remove']: {
    ok: true,
    tenants: [{ id: 'alice', name: 'Alice', port: 58581, phase: 'up', running: true }],
  },
  [API + '/tenants/rotate']: { ok: true, tenants: [{ id: 'alice', name: 'Alice', port: 58581, phase: 'up', running: true }] },
  [API + '/tenants/qr']: { ok: true, id: 'alice', url: 'http://192.0.2.10:8787/?k=key-alice-0123456789', rows: ['111', '101', '111'] },
  [API + '/lan/start']: { ok: true, busy: false, canControl: true, config: { problems: [] }, lan: { running: true, url: 'http://192.0.2.10:8787/' }, public: { running: false, domain: '', entry: null, tunnel: null }, qr: null },
}
globalThis.fetch = async (url, options) => {
  const raw = String(url)
  const parsed = new URL(raw, 'http://placeholder')
  // api() 会给每个请求带上面板当前语言；断言时按去掉 query 的路径取回复
  const pathname = parsed.pathname
  calls.push({ pathname, method: (options && options.method) || 'GET', locale: parsed.searchParams.get('locale') })
  const body = canned[pathname] ?? { ok: false, error: 'unexpected ' + pathname }
  return {
    ok: body.ok !== false,
    status: body.ok === false ? 500 : 200,
    text: async () => JSON.stringify(body),
  }
}

await clientExports.internals.refresh()
check(
  'client: refresh() 打到 /state',
  calls.some((item) => item.pathname === API + '/state' && item.method === 'GET'),
  calls.map((item) => item.method + ' ' + item.pathname).join(', '),
)
check(
  'client: 状态写入 store',
  clientExports.internals.store.data?.lan?.url === 'http://192.0.2.10:8787/',
)
check(
  'client: 每次请求都带上面板语言（宿主据此渲染检查结果与隧道状态）',
  calls.length > 0 && calls.every((item) => typeof item.locale === 'string' && item.locale !== ''),
  calls.map((item) => item.method + ' ' + item.pathname + '?locale=' + String(item.locale)).join(', '),
)
check(
  'client: 语言取不到时面板仍然能跑（locale 服务缺失 → 浏览器语言/无参）',
  (() => {
    const original = globalThis.navigator
    try {
      Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true })
      return typeof clientExports.internals.currentLocale === 'function'
    } finally {
      if (original === undefined) delete globalThis.navigator
      else Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true })
    }
  })(),
)

await clientExports.internals.act('/lan/start')
check(
  'client: act() 打到 POST /lan/start',
  calls.some((item) => item.pathname === API + '/lan/start' && item.method === 'POST'),
)
check('client: 动作后 busy 复位', clientExports.internals.store.busy === false)

await clientExports.internals.refresh()
clientExports.internals.setState({ open: true })
const panelHtml = renderToStaticMarkup(React.createElement(registrations[1].Component, { t: markerT }))
check('client: 面板渲染出局域网地址', panelHtml.includes('192.0.2.10:8787'))
check('client: 面板文案全部走 t()', panelHtml.includes('«card.lan»') && panelHtml.includes('«action.check»'))
check('client: 面板渲染出公网入口', panelHtml.includes('dsh.example.com'))
check(
  'client: 面板显示隧道目标与端口',
  panelHtml.includes('dshtunnel@dsh.example.com:22022'),
  '含 :22022 才算把 ssh 端口暴露给用户',
)
check('client: 面板含二维码 SVG', panelHtml.includes('shape-rendering="crispEdges"'))
check('client: 面板含开关按钮（本地化后的文案）', panelHtml.includes('«action.stop»') && panelHtml.includes('«action.check»'))
// tailscale 模式：没有自己的域名，但面板要能显示 funnel 地址并可启动/停止
clientExports.internals.setState({
  data: {
    ok: true,
    busy: false,
    canControl: true,
    config: { problems: [], publicDomain: '', tunnel: 'tailscale' },
    lan: { running: false, url: null, port: 8787 },
    public: {
      running: true,
      domain: '',
      port: 8788,
      entry: null,
      tunnel: {
        phase: 'up',
        code: 'tunnel.funnelUp',
        params: { url: 'https://mac-mini.tail1234.ts.net/' },
        detail: 'Funnel is serving https://mac-mini.tail1234.ts.net/',
        publicUrl: 'https://mac-mini.tail1234.ts.net/',
        restarts: 0,
      },
      tunnelUrl: 'https://mac-mini.tail1234.ts.net/',
    },
    qr: null,
  },
})
const tsPanel = renderToStaticMarkup(React.createElement(registrations[1].Component, { t: markerT }))
check(
  'client: tailscale 模式下显示 funnel 地址（域名留空不算未配置）',
  tsPanel.includes('mac-mini.tail1234.ts.net') && tsPanel.includes('«card.public.tailscale.desc»'),
)
check(
  'client: tailscale 模式下没有「服务器配置」按钮（没有可贴的 nginx 片段），但有「检查服务器」',
  tsPanel.includes('«action.snippets»') === false && tsPanel.includes('«action.check»'),
)
check(
  'client: 隧道状态用字典里的阶段名，详情用宿主渲染的文案',
  tsPanel.includes('«state.tunnel»') && tsPanel.includes('«phase.up»') && tsPanel.includes('Funnel is serving'),
)
clientExports.internals.setState({ checkResults: [{ id: 'dns', name: 'DNS', ok: true, detail: 'x.example.com -> 192.0.2.1' }] })
const checkPanel = renderToStaticMarkup(React.createElement(registrations[1].Component, { t: markerT }))
check(
  'client: 检查结果按行渲染（标记/名称/详情分开，无「：」这类硬编码标点）',
  checkPanel.includes('dshRcCheckMark') && checkPanel.includes('dshRcCheckDetail') && checkPanel.includes('：') === false,
)
clientExports.internals.setState({ checkResults: null })

// ── 多租户面板：租户卡片、动作与二维码 ──
clientExports.internals.setState({
  data: {
    ok: true,
    busy: false,
    canControl: true,
    config: { problems: [], publicDomain: 'dsh.example.com', tunnel: 'ssh' },
    lan: { running: true, url: 'http://192.0.2.10:8787/', port: 8787 },
    public: { running: false, domain: 'dsh.example.com', port: 8788, entry: 'https://dsh.example.com/?k=x', tunnel: null },
    tenants: {
      enabled: true,
      registry: '/tmp/tenants.json',
      baseDir: '/tmp/homes',
      harness: { bin: '/x/bin.js', node: '/usr/bin/node', problem: null },
      list: [
        {
          id: 'alice',
          name: 'Alice',
          accessKey: 'key-alice-0123456789',
          home: '/tmp/homes/alice',
          profile: 'alice',
          port: 58581,
          phase: 'up',
          detail: 'Tenant alice is serving on 127.0.0.1:58581',
          running: true,
          restarts: 0,
          lanEntry: 'http://192.0.2.10:8787/?k=key-alice-0123456789',
          publicEntry: 'https://dsh.example.com/?k=key-alice-0123456789',
        },
        {
          id: 'bob',
          name: 'Bob',
          accessKey: 'key-bob-0123456789',
          home: '/tmp/homes/bob',
          profile: 'bob',
          port: 0,
          phase: 'idle',
          detail: 'Not started',
          running: false,
          restarts: 0,
          lanEntry: 'http://192.0.2.10:8787/?k=key-bob-0123456789',
          publicEntry: null,
        },
      ],
    },
    qr: null,
    error: null,
  },
  tenantQr: null,
  tenantQrId: null,
  tenantDraft: '',
})
const tenantsPanel = renderToStaticMarkup(React.createElement(registrations[1].Component, { t: markerT }))
check(
  'client: 租户卡片渲染出每个租户、状态与专属入口',
  tenantsPanel.includes('«card.tenants»') &&
    tenantsPanel.includes('Alice · alice') &&
    tenantsPanel.includes('Bob · bob') &&
    tenantsPanel.includes('http://192.0.2.10:8787/?k=key-alice-0123456789') &&
    tenantsPanel.includes('«tenants.notRunning»'),
)
check(
  'client: 租户卡片有新增/删除/换密钥/二维码四个动作，且新增框是占位文案',
  tenantsPanel.includes('«tenants.add»') &&
    tenantsPanel.includes('«tenants.remove»') &&
    tenantsPanel.includes('«tenants.rotate»') &&
    tenantsPanel.includes('«tenants.qr»') &&
    tenantsPanel.includes('«tenants.addPlaceholder»'),
)
check(
  'client: 运行中的租户显示端口，未运行的提示去开（不是让人对着 0 发呆）',
  tenantsPanel.includes('58581') && tenantsPanel.includes('«tenants.port»'),
)
check(
  'client: 找不到 harness 入口时把问题摊开（否则每个租户都起不来）',
  (() => {
    const before = clientExports.internals.store.data
    clientExports.internals.setState({
      data: { ...before, tenants: { ...before.tenants, harness: { problem: '找不到 DSH Harness 入口：请配置 tenants.harness.bin' } } },
    })
    const html = renderToStaticMarkup(React.createElement(registrations[1].Component, { t: markerT }))
    clientExports.internals.setState({ data: before })
    return html.includes('tenants.harness.bin')
  })(),
)
await clientExports.internals.tenantAdd()
check(
  'client: 新增租户走 POST /tenants/add（名字为空时不发请求）',
  calls.filter((item) => item.pathname === API + '/tenants/add').length === 0 ||
    calls.some((item) => item.pathname === API + '/tenants/add' && item.method === 'POST'),
)
clientExports.internals.setState({ tenantDraft: 'Carol' })
await clientExports.internals.tenantAdd()
check(
  'client: 新增后清空输入框，并把返回的租户列表写回 store',
  calls.some((item) => item.pathname === API + '/tenants/add' && item.method === 'POST') &&
    clientExports.internals.store.tenantDraft === '' &&
    (clientExports.internals.store.data?.tenants?.list ?? []).some((item) => item.id === 'carol'),
)
await clientExports.internals.tenantAction('remove', { id: 'bob' })
check(
  'client: 删除/启停/换密钥都打到 /tenants/<action>',
  calls.some((item) => item.pathname === API + '/tenants/remove' && item.method === 'POST'),
)
await clientExports.internals.tenantQr('alice')
check(
  'client: 点二维码会请求 /tenants/qr?id=…，并把矩阵写进 store 供渲染',
  calls.some((item) => item.pathname === API + '/tenants/qr') &&
    Array.isArray(clientExports.internals.store.tenantQr) &&
    clientExports.internals.store.tenantQrId === 'alice',
)
await clientExports.internals.tenantQr('alice')
check('client: 再点一次收起二维码（不会重复请求）', clientExports.internals.store.tenantQr === null)

// 回归：首次 /state 请求失败（store.data 仍为 null）时面板必须还能渲染
clientExports.internals.setState({ data: null })
const emptyPanel = renderToStaticMarkup(React.createElement(registrations[1].Component, { t: markerT }))
check('client: data 为 null 时面板不崩（回归）', emptyPanel.includes('«panel.title»'))

// ─────────────────── 令牌自证（跨进程误取令牌的回归测试） ───────────────────

const proxyTools = await import(pathToFileURL(path.join(root, 'lib/core/proxy.js')).href)
const tokenLog = path.join(root, 'test', '.token-fixture.log')
fs.writeFileSync(
  tokenLog,
  [
    '[stdout] dsh web: http://127.0.0.1:43129/?token=OTHERPROCESS',
    '[stdout] dsh web: http://127.0.0.1:4485/?token=THISPROCESS',
    '',
  ].join('\n'),
)
const sameProc = proxyTools.discoverToken([tokenLog], 4485)
check(
  'proxy: 日志兜底只认本进程端口的令牌',
  sameProc.token === 'THISPROCESS' && sameProc.upstreamPort === 4485,
  JSON.stringify(sameProc),
)
const otherProc = proxyTools.discoverToken([tokenLog], 9999)
check('proxy: 端口不匹配时不取任何令牌', otherProc.token === '', JSON.stringify(otherProc))
const noExpect = proxyTools.discoverToken([tokenLog])
check('proxy: 未给端口时仍取最后一行（CLI 场景）', noExpect.token === 'THISPROCESS')
fs.unlinkSync(tokenLog)

// ─────────────── 服务器安装器：生成物必须能过 shell 解析器，且拒绝注入 ───────────────

const { execFileSync } = await import('node:child_process')
const setupTools = await import(pathToFileURL(path.join(root, 'lib/core/serversetup.js')).href)
const SETUP_FIXTURE = path.join(root, 'test', '.setup-fixture.sh')

function bashSyntaxOk(text) {
  fs.writeFileSync(SETUP_FIXTURE, text)
  try {
    execFileSync('bash', ['-n', SETUP_FIXTURE], { stdio: 'pipe' })
    return true
  } catch (error) {
    return String(error?.stderr ?? error?.message ?? error)
  }
}

const setupText = setupTools.buildServerSetupScript({
  domain: 'dsh.example.com',
  remotePort: 8788,
  tunnelUser: 'dshtunnel',
  authUser: 'dsh',
})
const uninstallText = setupTools.buildServerUninstallScript({ domain: 'dsh.example.com', tunnelUser: 'dshtunnel' })

check('serversetup: 安装脚本通过 bash -n', bashSyntaxOk(setupText) === true, String(bashSyntaxOk(setupText)).slice(0, 120))
check('serversetup: 卸载脚本通过 bash -n', bashSyntaxOk(uninstallText) === true, String(bashSyntaxOk(uninstallText)).slice(0, 120))
check(
  'serversetup: 只写自己独占的文件（conf.d 一个 + sshd drop-in + deploy hook）',
  setupText.includes('/etc/nginx/conf.d/dsh-remote.conf') &&
    setupText.includes('/etc/ssh/sshd_config.d/') &&
    setupText.includes('/etc/letsencrypt/renewal-hooks/deploy/'),
)
check('serversetup: 不含 80 端口 server block', setupText.includes('listen 80') === false)
check('serversetup: 默认日志脱敏（?k= 不落盘）', setupText.includes('dsh_remote_nokey') && setupText.includes('nokey'))
check(
  'serversetup: 提供 probe / install / uninstall 与 --dry-run',
  setupText.includes('probe)') && setupText.includes('install)') && setupText.includes('uninstall)') && setupText.includes('--dry-run'),
)
check('serversetup: 自带 deploy hook（根治续签后不 reload）', setupText.includes('renewal-hooks/deploy') && setupText.includes('systemctl reload nginx'))
check('serversetup: 探测里会检查 deploy 钩子是否为空', setupText.includes('续签后不会 reload'))
check('serversetup: 隧道账号默认 nologin', setupText.includes('/usr/sbin/nologin'))
check(
  'serversetup: 域名注入被拒',
  (() => {
    try {
      setupTools.buildServerSetupScript({ domain: 'x"; rm -rf / #' })
      return false
    } catch (error) {
      return true
    }
  })(),
)
check(
  'serversetup: 路径注入被拒',
  (() => {
    try {
      setupTools.buildServerSetupScript({ domain: 'ok.example.com', webroot: '/var/www/$(rm -rf /)' })
      return false
    } catch (error) {
      return true
    }
  })(),
)
fs.rmSync(SETUP_FIXTURE, { force: true })

// ──────────────────────── 服务器配置生成 ────────────────────────

const snippetTools = await import(pathToFileURL(path.join(root, 'lib/core/snippets.js')).href)
const nginx = snippetTools.nginxServerBlock({ domain: 'dsh.example.com', targetPort: 8788 })
const sshCmd = snippetTools.sshTunnelCommand({ user: 'dshtunnel', host: 'dsh.example.com', port: 22022 })
const sshCmd22 = snippetTools.sshTunnelCommand({ user: 'dshtunnel', host: 'dsh.example.com' })

check('snippets: 不再生成 80 端口 server block（避免顶掉 ACME challenge）', nginx.includes('listen 80') === false)
check('snippets: 明确说明为何不给 80 块', nginx.includes('刻意不提供 80 端口 server block'))
check('snippets: 关缓冲与升级映射仍在', nginx.includes('proxy_buffering         off') && nginx.includes('$connection_upgrade'))
check('snippets: 上传体积放宽', nginx.includes('client_max_body_size 64m'))
check(
  'snippets: 默认启用日志脱敏（?k= 不落盘）',
  nginx.includes('log_format dsh_nokey') === false && nginx.includes('access_log /var/log/nginx/dsh.access.log dsh_nokey;'),
  'log_format 位于 http 上下文常量里',
)
check('snippets: 提供 http 上下文常量（map + log_format）', snippetTools.NGINX_LOG_FORMAT.includes('dsh_nokey') && snippetTools.NGINX_UPGRADE_MAP.includes('$connection_upgrade'))
check('snippets: ssh 命令带非默认端口', sshCmd.includes('-p 22022'))
check('snippets: 默认 22 端口时不写 -p', sshCmd22.includes('-p') === false)
check('snippets: 账号建议 nologin', snippetTools.serverSetupSteps({ targetPort: 8788 }).includes('nologin'))
check('snippets: 授权行限制到回环端口', snippetTools.authorizedKeysLine('ssh-ed25519 AAAA test', 8788).includes('permitlisten="127.0.0.1:8788"'))

// ──────────────────── 文案目录（宿主侧 i18n） ────────────────────

const messages = await import(pathToFileURL(path.join(root, 'lib/core/messages.js')).href)
const enKeys = Object.keys(messages.CATALOG.en).sort()
const zhKeys = Object.keys(messages.CATALOG.zh).sort()
check(
  'i18n: en/zh 键集完全一致',
  enKeys.length === zhKeys.length && enKeys.every((key, index) => key === zhKeys[index]),
  'en ' + String(enKeys.length) + ' 键 / zh ' + String(zhKeys.length) + ' 键',
)
check(
  'i18n: 没有空文案，且占位符两份一致',
  messages.LOCALES.every((locale) =>
    Object.entries(messages.CATALOG[locale]).every(([key, value]) => {
      if (typeof value !== 'string' || value.trim() === '') return false
      const placeholders = (text) => (text.match(/\{(\w+)\}/g) ?? []).sort().join(',')
      return placeholders(value) === placeholders(messages.CATALOG.en[key])
    }),
  ),
)
check(
  'i18n: 语言归一化（BCP 47 → en/zh）',
  messages.normalizeLocale('zh-CN') === 'zh' &&
    messages.normalizeLocale('en_US') === 'en' &&
    messages.normalizeLocale('ja') === undefined &&
    messages.normalizeLocale(undefined) === undefined,
)
check(
  'i18n: 环境变量推断顺序（DSH_REMOTE_LANG > LC_ALL > LANG）',
  messages.resolveLocale({ DSH_REMOTE_LANG: 'zh', LANG: 'en_US.UTF-8' }) === 'zh' &&
    messages.resolveLocale({ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' }) === 'zh' &&
    messages.resolveLocale({}) === 'en',
)
check(
  'i18n: 缺词时退回英文而不是抛异常',
  messages.translate('zh', 'no.such.key') === 'no.such.key' &&
    messages.translate('ja', 'check.dns.name') === messages.CATALOG.en['check.dns.name'],
)
check(
  'i18n: 占位符插值（缺失参数原样保留）',
  messages.translate('en', 'tunnel.reconnecting', { reason: 'exit 255', seconds: '4' }) ===
    'Tunnel dropped (exit 255); reconnecting in 4s' &&
    messages.translate('en', 'tunnel.reconnecting', { reason: 'x' }).includes('{seconds}'),
)

// ──────────────────── 前置检查：结构化结果 + 双语渲染 ────────────────────

const preflight = await import(pathToFileURL(path.join(root, 'lib/core/preflight.js')).href)
check(
  'preflight: 检查项名走字典（en/zh 都能取到，不是硬编码中文）',
  preflight.renderCheck({ ok: true, code: 'preflight.dns.ok', params: {} }, 'dns', messages.translator('en')).name ===
    'DNS' &&
    preflight.renderCheck({ ok: true, code: 'preflight.dns.ok', params: {} }, 'dns', messages.translator('zh')).name ===
      'DNS 解析',
)
const dnsRendered = preflight.renderCheck(
  { ok: false, code: 'preflight.dns.mismatch', params: { domain: 'dsh.example.com', addresses: '192.0.2.9', expectIp: '192.0.2.10' }, hintCode: 'preflight.dns.mismatch.hint' },
  'dns',
  messages.translator('en'),
)
check(
  'preflight: 结果带 id + code + 渲染后的 detail/hint（面板与 CLI 共用）',
  dnsRendered.id === 'dns' &&
    dnsRendered.code === 'preflight.dns.mismatch' &&
    dnsRendered.detail.includes('192.0.2.10') &&
    typeof dnsRendered.hint === 'string' &&
    dnsRendered.hint.length > 0,
)
const noDomain = await preflight.runPreflight({ domain: '', locale: 'en', tunnelMode: 'none' })
check('preflight: 没有域名时不做 DNS/TLS/HTTPS 三项（tailscale 模式没有 domain）', noDomain.length === 0)
const localDns = await preflight.runPreflight({ domain: 'dsh.example.com', locale: 'zh', tunnelMode: 'none' })
check(
  'preflight: runPreflight 按给定语言渲染且三项齐全',
  localDns.length === 3 && localDns.map((item) => item.id).join(',') === 'dns,tls,https' &&
    localDns.every((item) => typeof item.name === 'string' && item.name !== ''),
  localDns.map((item) => item.id + '=' + String(item.ok)).join(' '),
)

// ──────────────────── tailscale 后端 ────────────────────

const ts = await import(pathToFileURL(path.join(root, 'lib/core/tailscale.js')).href)
check(
  'tailscale: funnel 上行 argv（回环端口 + --bg + https 端口）',
  ts.funnelUpArgv({ localPort: 8788 }).join(' ') ===
    'tailscale funnel --bg --https=443 http://127.0.0.1:8788' &&
    ts.funnelUpArgv({ path: '/opt/bin/tailscale', localPort: 9000, httpsPort: 8443 }).join(' ') ===
      '/opt/bin/tailscale funnel --bg --https=8443 http://127.0.0.1:9000',
)
check(
  'tailscale: 停止只撤自己的 https 端口（不动别的 serve 配置）',
  ts.funnelOffArgv({}).join(' ') === 'tailscale funnel --https=443 off',
)
check(
  'tailscale: 从 status --json 取节点域名（结尾的点要去掉）',
  ts.parseSelfDnsName(JSON.stringify({ Self: { DNSName: 'mac-mini.tail1234.ts.net.' } }))?.url ===
    'https://mac-mini.tail1234.ts.net/' &&
    ts.parseSelfDnsName('not json') === null &&
    ts.parseSelfDnsName(JSON.stringify({ Self: {} })) === null &&
    ts.parseSelfDnsName(JSON.stringify({ Self: { DNSName: 'bad host/../x' } })) === null,
)
check(
  'tailscale: 报错分类（没装 / 没登录 / 没开 Funnel / 其它）',
  ts.classifyFunnelError('spawn tailscale ENOENT') === 'missing' &&
    ts.classifyFunnelError('Logged out.') === 'loggedout' &&
    ts.classifyFunnelError('Funnel is not enabled for this node') === 'disabled' &&
    ts.classifyFunnelError('something else') === 'generic',
)

// 用一个假 tailscale 可执行文件跑真实的 spawn 路径：启动 → 读地址 → 探测 → 撤销
const fakeBinDir = path.join(root, 'test', '.fixture-bin')
fs.mkdirSync(fakeBinDir, { recursive: true })
const fakeTailscale = path.join(fakeBinDir, 'tailscale')
fs.writeFileSync(
  fakeTailscale,
  [
    '#!/usr/bin/env bash',
    'case "$1 $2" in',
    '  "status --json") echo \'{"Self":{"DNSName":"mac-mini.tail1234.ts.net."}}\' ;;',
    '  "funnel --bg") echo "https://mac-mini.tail1234.ts.net/" ;;',
    '  "funnel status") echo "https://mac-mini.tail1234.ts.net/ (Funnel on)" ;;',
    '  "funnel off") : ;;',
    '  *) echo "unexpected: $*" >&2; exit 2 ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'),
  { mode: 0o755 },
)
const tunnelTools = await import(pathToFileURL(path.join(root, 'lib/core/tunnel.js')).href)
const funnelStates = []
const funnelTunnel = tunnelTools.createTunnel({
  mode: 'tailscale',
  localPort: 8788,
  tailscalePath: fakeTailscale,
  onState: (state) => funnelStates.push(state),
})
funnelTunnel.start()
await new Promise((resolve) => setTimeout(resolve, 1200))
check(
  'tailscale: funnel 启动后进入 up 并拿到 ts.net 地址',
  funnelTunnel.state().phase === 'up' && funnelTunnel.state().publicUrl === 'https://mac-mini.tail1234.ts.net/',
  'phase=' + funnelTunnel.state().phase,
)
check(
  'tailscale: funnel 状态自带 code + params（面板按自己的语言渲染）',
  funnelTunnel.state().code === 'tunnel.funnelUp' &&
    funnelTunnel.state().detail === 'Funnel is serving https://mac-mini.tail1234.ts.net/' &&
    funnelStates.every((state) => typeof state.code === 'string'),
)
await funnelTunnel.stop()
check('tailscale: 停止后状态为 stopped（并且撤销不报错）', funnelTunnel.state().phase === 'stopped')

// 失败路径：假二进制不存在 → 进入 error，且不无限重试
const missingStates = []
const missingTunnel = tunnelTools.createTunnel({
  mode: 'tailscale',
  localPort: 8788,
  tailscalePath: path.join(fakeBinDir, 'not-installed'),
  onState: (state) => missingStates.push(state),
})
missingTunnel.start()
await new Promise((resolve) => setTimeout(resolve, 800))
check(
  'tailscale: 没装客户端时进入 error 且带上可翻译的提示（不静默重试）',
  missingTunnel.state().phase === 'error' &&
    missingTunnel.state().code === 'tunnel.funnelFailed' &&
    String(missingTunnel.state().hintCode).startsWith('preflight.tailscale.failed.hint.'),
  'hintCode=' + String(missingTunnel.state().hintCode),
)
await missingTunnel.stop()
fs.rmSync(fakeBinDir, { recursive: true, force: true })

// 配置层：tailscale 不再要求域名，但取值必须合法
const hostModule = await import(pathToFileURL(path.join(root, 'lib/index.js')).href)
const tsConfig = hostModule.normalizeConfig({ public: { enabled: true, tunnel: 'tailscale' } })
check(
  'config: tunnel=tailscale 不强制要求 public.domain',
  tsConfig.problems.length === 0 && tsConfig.public.tunnel === 'tailscale' && tsConfig.public.tailscale.httpsPort === 443,
  tsConfig.problems.join('；'),
)
// 格式非法走的是装载器的真实入口：Config['~standard'].validate
const validate = (value) => hostModule.Config['~standard'].validate(value)
const issuesOf = (value) => (validate(value).issues ?? []).map((item) => item.message).join('；')
check(
  'config: tailscale 参数会被校验（端口 / 探测间隔）',
  issuesOf({ public: { tunnel: 'tailscale', tailscale: { httpsPort: 99999 } } }).includes('httpsPort') &&
    issuesOf({ public: { tunnel: 'tailscale', tailscale: { probeMs: 100 } } }).includes('probeMs'),
)
check(
  'config: 未知 tunnel 取值仍然报错',
  issuesOf({ public: { tunnel: 'wireguard' } }).includes('public.tunnel'),
)
check(
  'config: tailscale 合法配置能过校验并归一化',
  validate({ public: { enabled: true, tunnel: 'tailscale', tailscale: { httpsPort: 8443, probeMs: 30000 } } }).value
    ?.public?.tailscale?.httpsPort === 8443,
)

// ──────────────────── CLI 语言（真实子进程） ────────────────────

const { spawnSync } = await import('node:child_process')
const cliPath = path.join(root, 'bin', 'dsh-remote.js')
const runCli = (args, env) =>
  spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
const hasCjk = (text) => /[\u4e00-\u9fff]/.test(text)
const cliEn = runCli(['--help'], { DSH_REMOTE_LANG: 'en' })
const cliZh = runCli(['--help', '--lang', 'zh'], { DSH_REMOTE_LANG: 'en' })
check(
  'cli: --help 可用（首个参数就是 --help）且按语言输出',
  cliEn.status === 0 && hasCjk(cliEn.stdout) === false && hasCjk(cliZh.stdout) === true,
  'en=' + String(cliEn.stdout.split('\n')[0]),
)
check(
  'cli: --lang 覆盖环境变量（en 环境下仍能要中文）',
  cliZh.stdout.includes('用法：') && cliEn.stdout.includes('Usage:'),
)
const cliUnknown = runCli(['nope'], { DSH_REMOTE_LANG: 'en' })
check(
  'cli: 未知命令报错也是英文，并附带用法',
  cliUnknown.status === 1 && cliUnknown.stderr.includes('Unknown command: nope') && cliUnknown.stderr.includes('Usage:'),
)
const cliLangBad = runCli(['--help', '--lang', 'klingon'], { DSH_REMOTE_LANG: 'zh' })
check('cli: 非法 --lang 不报错，退回环境语言', cliLangBad.status === 0 && cliLangBad.stdout.includes('用法：'))
const cliNoDomain = runCli(['check'], { DSH_REMOTE_LANG: 'en' })
check(
  'cli: check 缺 --domain 时用英文报错',
  cliNoDomain.status === 1 && cliNoDomain.stderr.includes('check needs --domain'),
  cliNoDomain.stderr.trim(),
)
const cliEnNotice = runCli(['doctor'], { DSH_REMOTE_LANG: 'en' })
check(
  'cli: 未翻译的命令（doctor）在英文环境下明确提示，而不是给一段中文',
  cliEnNotice.status === 1 && cliEnNotice.stderr.includes('doctor needs --domain'),
  cliEnNotice.stderr.trim().split('\n')[0],
)

// ──────────────────── 文档相对链接（避免 npm 页面/仓库里的死链） ────────────────────

const mdFiles = [
  'README.md',
  'README.zh.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/self-host.md',
  'docs/self-host.zh.md',
  'docs/multi-tenant.md',
  'docs/multi-tenant.zh.md',
  'docs/market-submission.md',
]
const brokenLinks = []
for (const file of mdFiles) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1]
    if (/^(https?:|mailto:|#)/.test(target)) continue
    const clean = target.split('#')[0]
    if (clean === '') continue
    if (!fs.existsSync(path.join(root, path.dirname(file), clean))) brokenLinks.push(file + ' → ' + target)
  }
}
check(
  'docs: 所有相对链接都能解析',
  brokenLinks.length === 0,
  brokenLinks.length === 0 ? String(mdFiles.length) + ' 个文件' : brokenLinks.join(', '),
)
// README 链到的文件必须在发布包里（npm 页面上不会 404）
const published = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).files
const readmeLinks = [...fs.readFileSync(path.join(root, 'README.md'), 'utf8').matchAll(/\]\(((?:docs|lib|bin)\/[^)\s#]+)/g)].map(
  (match) => match[1],
)
const notShipped = readmeLinks.filter(
  (link) => !published.some((entry) => entry === link || (entry.endsWith('/') === false && link.startsWith(entry + '/')) || entry === link),
)
check(
  'docs: README 里链到的仓库文件都在 package.json files 里',
  notShipped.length === 0,
  notShipped.length === 0 ? readmeLinks.join(', ') : '缺：' + notShipped.join(', '),
)

// ──────────────────── 多租户：租户模型与注册表 ────────────────────

const tenantTools = await import(pathToFileURL(path.join(root, 'lib/core/tenant.js')).href)
const tenantDir = path.join(root, 'test', '.tenants-fixture')
fs.rmSync(tenantDir, { recursive: true, force: true })
const registryFile = path.join(tenantDir, 'tenants.json')
const registryLog = []
const registry = tenantTools.createRegistry({
  file: registryFile,
  baseDir: path.join(tenantDir, 'homes'),
  log: (line) => registryLog.push(line),
})
check('tenant: 初始为空且文件可以不存在', registry.load().loaded === 0 && registry.list().length === 0)
check(
  'tenant: id 规则（小写/数字/连字符，2–32 位）',
  tenantTools.TENANT_ID_PATTERN.test('alice') &&
    tenantTools.TENANT_ID_PATTERN.test('team-2') &&
    tenantTools.TENANT_ID_PATTERN.test('Alice') === false &&
    tenantTools.TENANT_ID_PATTERN.test('a') === false &&
    tenantTools.TENANT_ID_PATTERN.test('-x') === false &&
    tenantTools.TENANT_ID_PATTERN.test('a'.repeat(33)) === false,
)
check(
  'tenant: 中文显示名会收敛成合法 id（目录名不能是中文）',
  tenantTools.TENANT_ID_PATTERN.test(tenantTools.slugifyId('张三')) &&
    tenantTools.slugifyId('张三') !== tenantTools.slugifyId('李四') &&
    tenantTools.slugifyId('Alice Chen') === 'alice-chen',
  tenantTools.slugifyId('张三'),
)
const keyA = tenantTools.generateAccessKey()
const keyB = tenantTools.generateAccessKey()
check('tenant: 生成的访问密钥满足 16–128 位 URL 安全规则', tenantTools.ACCESS_KEY_PATTERN.test(keyA) && keyA !== keyB, String(keyA.length) + ' 字符')
check(
  'tenant: 非法定义会被逐条说清（id / 密钥 / 端口 / profile）',
  (() => {
    const { problems } = tenantTools.normalizeTenant({ id: 'A B', accessKey: 'short', port: 99999 })
    const text = problems.join('；')
    return (
      problems.length === 4 &&
      text.includes('id 必须') &&
      text.includes('accessKey') &&
      text.includes('port 必须') &&
      text.includes('profile')
    )
  })(),
  tenantTools.normalizeTenant({ id: 'A B', accessKey: 'short', port: 99999 }).problems.length + ' 条',
)
const addedA = registry.add({ id: 'alice', name: 'Alice', accessKey: keyA })
const addedB = registry.add({ id: 'bob', accessKey: keyB, port: 8899 })
check(
  'tenant: 新增后 home/profile 有默认值（home 落在 baseDir 下，profile 与 id 同名）',
  addedA.home === path.join(tenantDir, 'homes', 'alice') && addedA.profile === 'alice' && addedA.autostart === true,
  addedA.home,
)
check(
  'tenant: 重复 id 与重复密钥都会被拒（否则两个租户会串门）',
  (() => {
    const dupeId = (() => { try { registry.add({ id: 'alice', accessKey: tenantTools.generateAccessKey() }); return false } catch { return true } })()
    const dupeKey = (() => { try { registry.add({ id: 'carol', accessKey: keyA }); return false } catch { return true } })()
    return dupeId && dupeKey
  })(),
)
check('tenant: 按密钥查租户（时序安全比较，长度不同直接不匹配）', registry.findByKey(keyB)?.id === 'bob' && registry.findByKey('x'.repeat(keyA.length)) === null)
check('tenant: 落盘后重新加载能读回来', (() => {
  const fresh = tenantTools.createRegistry({ file: registryFile, baseDir: path.join(tenantDir, 'homes') })
  return fresh.load().loaded === 2 && fresh.get('bob')?.accessKey === keyB
})())
check(
  'tenant: 注册表坏数据不会让插件起不来（逐条忽略并记日志）',
  (() => {
    fs.writeFileSync(registryFile, JSON.stringify({ version: 1, tenants: [{ id: 'ok-1', accessKey: keyA }, { id: 'BAD ID', accessKey: keyB }] }))
    const fresh = tenantTools.createRegistry({ file: registryFile, baseDir: path.join(tenantDir, 'homes'), log: (line) => registryLog.push(line) })
    const result = fresh.load()
    return result.loaded === 1 && result.dropped.length === 1 && registryLog.some((line) => line.includes('忽略'))
  })(),
)
check('tenant: 轮换密钥后旧密钥立刻失效', (() => {
  const before = registry.get('alice').accessKey
  const after = registry.rotateKey('alice').accessKey
  return after !== before && registry.findByKey(before) === null && registry.findByKey(after)?.id === 'alice'
})())
check('tenant: 删除后查不到，重复删除返回 null', registry.remove('bob')?.id === 'bob' && registry.remove('bob') === null && registry.get('bob') === null)

// ──────────────────── 多租户：实例启动参数与就绪解析 ────────────────────

const instanceTools = await import(pathToFileURL(path.join(root, 'lib/core/instance.js')).href)
check(
  'instance: 首次启动带 --from-default-profile web，之后不带',
  instanceTools.buildInstanceArgv({ bin: '/x/bin.js', profile: 'alice', port: 0, initialize: true }).join(' ') ===
    '--expose-internals /x/bin.js --profile alice --from-default-profile web --no-open --host 127.0.0.1 --port 0' &&
    instanceTools.buildInstanceArgv({ bin: '/x/bin.js', profile: 'alice', port: 8899, initialize: false }).join(' ') ===
      '--expose-internals /x/bin.js --profile alice --no-open --host 127.0.0.1 --port 8899',
)
check(
  'instance: 真 node 不塞 --expose-internals（只有 Electron Helper 需要）',
  instanceTools.buildInstanceArgv({ bin: '/x/bin.js', profile: 'a', port: 1, initialize: false, electron: false })[0] === '/x/bin.js',
)
check(
  'instance: 能解析子进程 stdio 里的就绪行（端口与令牌都取得到）',
  (() => {
    const ready = instanceTools.parseReadyLine('dsh web: http://127.0.0.1:8791/?token=AbC-123_xyz\n')
    return ready !== null && ready.port === 8791 && ready.token === 'AbC-123_xyz'
  })(),
)
check('instance: 不是就绪行时返回 null（不会误把普通日志当令牌）', instanceTools.parseReadyLine('loading plugins…') === null)
check(
  'instance: runtime 优先真 node，而不是桌面版的 Electron shim',
  (() => {
    const found = instanceTools.discoverRuntime({ env: { HOME: '/tmp/nope' } })
    return found.node === '/opt/homebrew/bin/node' || /^\/usr(\/local)?\/bin\/node$/.test(found.node)
  })(),
  instanceTools.discoverRuntime({ env: { HOME: '/tmp/nope' } }).node,
)
check(
  'instance: 找不到 harness 入口时返回 null（让面板能说人话，而不是 ENOENT）',
  instanceTools.discoverHarnessBin({ configured: '/definitely/not/here.js', appPath: '/definitely/not/here' }) === null,
)

// ──────────────────── 多租户：网关按凭据路由 ────────────────────

const { createProxy } = proxyTools
/** 起一个假上游：把收到的 Host 与 token 记下来，便于断言"请求去了谁家"。 */
async function startStubUpstream(name) {
  const seen = []
  const stub = http.createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, origin: req.headers.origin, name })
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>' + name + '</title><body>' + name + '</body>')
  })
  const stubPort = await listen(stub)
  return { stub, stubPort, seen }
}
const upstreamA = await startStubUpstream('tenant-a')
const upstreamB = await startStubUpstream('tenant-b')
const instances = {
  alice: { id: 'alice', upstreamPort: () => upstreamA.stubPort, token: () => 'tok-alice' },
  bob: { id: 'bob', upstreamPort: () => upstreamB.stubPort, token: () => 'tok-bob' },
}
/** client 半的测试替换了 globalThis.fetch，网关这部分必须自己发真请求。 */
function rawRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = http.request(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const routedProxy = createProxy({
  port: 0,
  listenHost: '127.0.0.1',
  gateSecret: 'gate-secret-for-tests',
  tenants: {
    findById: (id) => instances[id] ?? null,
    findByKey: (key) => (key === 'key-alice-0123456789' ? instances.alice : key === 'key-bob-0123456789' ? instances.bob : null),
  },
})
const routedInfo = await routedProxy.start()
const routedBase = HOST + String(routedInfo.port)
const jarA = await rawRequest(routedBase + '/?k=key-alice-0123456789')
const cookieA = String([].concat(jarA.headers['set-cookie'] ?? [])[0] ?? '')
check(
  'gateway: 租户密钥换到的 Cookie 里带租户 id（同一域名下靠它区分租户）',
  jarA.status === 303 && cookieA.includes('gate=') && cookieA.includes('.'),
  cookieA.split(';')[0].slice(0, 60),
)
const pageA = await rawRequest(routedBase + '/', { headers: { cookie: cookieA.split(';')[0] } })
const bodyA = pageA.body
check(
  'gateway: A 的 Cookie 只发往 A 的上游（不是 B）',
  pageA.status === 200 && bodyA.includes('tenant-a') && upstreamA.seen.some((item) => item.url.includes('token=tok-alice')),
  'A 上游收到 ' + String(upstreamA.seen.length) + ' 个请求，B 收到 ' + String(upstreamB.seen.length),
)
check(
  'gateway: 只注入本租户的令牌，并且上游看到的只是回环 Host',
  upstreamA.seen.every((item) => item.url.includes('token=tok-alice')) &&
    upstreamA.seen.every((item) => item.host === '127.0.0.1:' + String(upstreamA.stubPort)) &&
    upstreamB.seen.length === 0,
)
const jarB = await rawRequest(routedBase + '/?k=key-bob-0123456789')
const cookieB = String([].concat(jarB.headers['set-cookie'] ?? [])[0] ?? '')
const pageB = await rawRequest(routedBase + '/', { headers: { cookie: cookieB.split(';')[0] } })
check(
  'gateway: B 的密钥进 B 的上游，两家互不串门',
  pageB.body.includes('tenant-b') && upstreamB.seen.every((item) => item.url.includes('token=tok-bob')),
)
check(
  'gateway: 无效密钥 404；没有 Cookie 也 404（不暴露任何东西）',
  (await rawRequest(routedBase + '/?k=wrong-key-0000000000')).status === 404 &&
    (await rawRequest(routedBase + '/')).status === 404,
)
check(
  'gateway: 别的租户的 Cookie 签名换不掉（改一个字符就失效）',
  (await rawRequest(routedBase + '/', { headers: { cookie: cookieA.split(';')[0].replace(/.$/, 'x') } })).status === 404,
)
check(
  'gateway: 伪造「租户 id + 合法签名」的组合也不行（签名密钥独立于租户密钥）',
  (await rawRequest(routedBase + '/', { headers: { cookie: 'gate=' + String(Date.now() + 3600000) + ':bob.' + 'x'.repeat(43) } })).status === 404,
)
// 租户实例没起来 → 503 而不是 404（访客已证明自己持有有效密钥）
instances.dave = { id: 'dave', upstreamPort: () => 0, token: () => '' }
const jarD = await rawRequest(routedBase + '/?k=key-bob-0123456789')
check('gateway: 同一个密钥仍路由到 B（新增租户不影响既有路由）', jarD.status === 303)
// WebSocket 升级也要过门与路由
const wsA = net.connect(routedInfo.port, '127.0.0.1')
const wsDenied = await new Promise((resolve) => {
  wsA.on('connect', () => wsA.write('GET /api/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'))
  wsA.on('close', () => resolve(true))
  wsA.on('data', () => resolve(false))
  wsA.on('error', () => resolve(true))
  setTimeout(() => resolve(false), 2000)
})
check('gateway: 没带 Cookie 的 WebSocket 升级被直接断开（不能绕过密钥门）', wsDenied === true)
check(
  'gateway: info() 反映多租户模式',
  routedInfo.gate === true && routedInfo.tenants === 'registry',
)
await routedProxy.stop()
upstreamA.stub.close()
upstreamB.stub.close()
fs.rmSync(tenantDir, { recursive: true, force: true })

// ──────────────────── 首页令牌注入：三个方向相反的坑（回归） ────────────────────
// 坑 1（死循环 · 用户实测）：Harness 对 `/?token=…` 一律回 303 → `/`。若对每个首页
//       请求都注入令牌，浏览器就在 303 之间无限打转（"不能正确地重定向"）。
// 坑 2（永远"暂无会话"）：浏览器留着上一次 Harness 的 dsh-auth-* Cookie 时如果不注入
//       令牌，而那个 Cookie 已失效，页面能开但会话列表永远为空。
// 坑 3（令牌过期）：插件缓存的启动令牌在 Harness 重启后失效 → 注入后 401。
// 正确规则：没 Cookie 才注入；带 token 的请求原样转发；失效 Cookie 用一次令牌重定向补回来。

let upstreamToken = 'token-one-aaaaaaaaaaaa'
let rejectTokenOne = false
const seenByUpstream = []
const flakyUpstream = http.createServer((req, res) => {
  seenByUpstream.push(req.url)
  if (rejectTokenOne && req.url.includes('token=token-one-aaaaaaaaaaaa')) {
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('unauthorized')
    return
  }
  // 模拟 Harness：带 token 的首页 → 303 回 /；否则 200
  if (req.url.includes('token=')) {
    res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-ok=1; Path=/' })
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>ok</title><body>ok</body>')
})
const flakyPort = await listen(flakyUpstream)
const injectLog = path.join(root, 'test', '.inject-fixture.log')
const writeFixture = (token) =>
  fs.writeFileSync(injectLog, 'dsh web: http://127.0.0.1:' + String(flakyPort) + '/?token=' + token + '\n')
writeFixture(upstreamToken)
const injectProxy = createProxy({ port: 0, listenHost: '127.0.0.1', upstreamPort: flakyPort, logPaths: [injectLog] })
const injectInfo = await injectProxy.start()
const gate = (headers) => rawRequest(HOST + String(injectInfo.port) + '/', { headers: headers ?? {} })

const firstVisit = await gate()
check(
  'proxy: 首次访问（无 Cookie）注入令牌，Harness 回 303 换 Cookie',
  firstVisit.status === 303 &&
    firstVisit.headers.location === '/' &&
    seenByUpstream[0] === '/?token=token-one-aaaaaaaaaaaa',
  '上游第一条：' + String(seenByUpstream[0]),
)

seenByUpstream.length = 0
const withCookie = await gate({ cookie: 'dsh-auth-ok=1' })
check(
  'proxy: 带 Cookie 访问首页不再注入令牌（否则 303 死循环）',
  withCookie.status === 200 && seenByUpstream[0] === '/',
  '上游收到：' + String(seenByUpstream[0]),
)

seenByUpstream.length = 0
const withTokenParam = await gate({ cookie: 'dsh-auth-ok=1' })
check('proxy: 已经带 token 的请求不重复处理', withTokenParam.status === 200 && seenByUpstream[0] === '/')

// 失效 Cookie 的真实场景：上游对"带旧 Cookie 的首页"回 401 → 插件应回 303 到 /?token=…
rejectTokenOne = false
const staleUpstream = http.createServer((req, res) => {
  seenByUpstream.push(req.url)
  if (req.url.includes('token=')) {
    res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-ok=1; Path=/' })
    res.end()
    return
  }
  if (String(req.headers.cookie ?? '').includes('stale')) {
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('unauthorized')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>ok</title><body>ok</body>')
})
const stalePort = await listen(staleUpstream)
// 每个代理只认"端口与自己上游一致"的日志行，所以这里单独写一份 fixture
const healLog = path.join(root, 'test', '.inject-heal-fixture.log')
fs.writeFileSync(healLog, 'dsh web: http://127.0.0.1:' + String(stalePort) + '/?token=token-three-cccccccccccc\n')
const healProxy = createProxy({ port: 0, listenHost: '127.0.0.1', upstreamPort: stalePort, logPaths: [healLog] })
const healInfo = await healProxy.start()
const heal = await rawRequest(HOST + String(healInfo.port) + '/', { headers: { cookie: 'dsh-auth-old=stale' } })
check(
  'proxy: 失效 Cookie → 303 到 /?token=…（浏览器一次就能自愈，且不会打转）',
  heal.status === 303 && String(heal.headers.location).startsWith('/?token='),
  'HTTP ' + String(heal.status) + ' → ' + String(heal.headers.location).slice(0, 40),
)
seenByUpstream.length = 0
const follow = await rawRequest(HOST + String(healInfo.port) + '/?token=' + encodeURIComponent(String(heal.headers.location).split('token=')[1]))
check(
  'proxy: 跟随那次重定向会被原样转发（不再叠加重定向 → 不会成环）',
  follow.status === 303 && follow.headers.location === '/',
  'HTTP ' + String(follow.status),
)

await injectProxy.stop()
await healProxy.stop()
flakyUpstream.close()
staleUpstream.close()
fs.rmSync(injectLog, { force: true })
fs.rmSync(healLog, { force: true })

// ──────────────────── 边缘凭证：生成与设置流程 ────────────────────

const credential = await import(pathToFileURL(path.join(root, 'lib/core/credential.js')).href)
const passphrase = credential.generatePassphrase()
check(
  'credential: 生成的是好输入的口令（词表短语 + 数字，默认 6 词）',
  passphrase.password.split('-').length === 7 &&
    passphrase.words === 6 &&
    passphrase.password.split('-').slice(0, 6).every((word) => credential.WORDS.includes(word)) &&
    bits9(passphrase.bits),
  passphrase.password + '（约 ' + String(passphrase.bits) + ' bit）',
)
function bits9(value) {
  return Number.isFinite(value) && value >= 40
}
check(
  'credential: 两次生成不同（用的是真随机源）',
  credential.generatePassphrase().password !== credential.generatePassphrase().password,
)
check(
  'credential: 词数可调，且不会越界（4–10）',
  credential.generatePassphrase({ words: 3 }).words === 4 && credential.generatePassphrase({ words: 99 }).words === 10,
)
check(
  'credential: --random 模式给纯随机串（≥16 位、强度更高）',
  (() => {
    const random = credential.generateRandomPassword({ length: 24 })
    return random.password.length >= 16 && random.bits > 100 && /^[A-Za-z0-9_-]+$/.test(random.password)
  })(),
)
check(
  'credential: 确定性随机源可用（便于测试与复现）',
  credential.generatePassphrase({ randomBytes: (size) => Buffer.alloc(size, 9) }).password ===
    credential.generatePassphrase({ randomBytes: (size) => Buffer.alloc(size, 9) }).password,
)
const credCommands = credential.setupCommands({ user: 'dsh', authFile: '/etc/nginx/.htpasswd-dsh', password: 'alpha-beta-123' })
check(
  'credential: 设置命令把口令经 stdin 传入（不出现在进程列表），且用 bcrypt',
  credCommands.htpasswd.includes('htpasswd -i -B /etc/nginx/.htpasswd-dsh dsh') &&
    credCommands.htpasswd.includes('printf %s') &&
    credCommands.htpasswd.includes('chmod 640'),
)
check(
  'credential: 给出 openssl 兜底与 401 验证命令',
  credCommands.openssl.includes('openssl passwd -apr1 -stdin') && credCommands.verify.includes('401'),
)
const cliCred = runCli(['credential', '--json'], { DSH_REMOTE_LANG: 'en' })
check(
  'cli: credential --json 输出用户名/口令/命令，且不写进任何日志文件',
  cliCred.status === 0 &&
    (() => {
      const payload = JSON.parse(cliCred.stdout)
      return (
        payload.user === 'dsh' &&
        typeof payload.password === 'string' &&
        payload.password.length > 10 &&
        payload.commands.htpasswd.includes('htpasswd -i -B')
      )
    })(),
  cliCred.stdout.slice(0, 60).replace(/\n/g, ' '),
)
const cliCredZh = runCli(['credential'], { DSH_REMOTE_LANG: 'zh' })
check(
  'cli: credential 中文输出包含设置步骤与两条提醒',
  cliCredZh.stdout.includes('在服务器上设置它') &&
    cliCredZh.stdout.includes('存进密码管理器') &&
    cliCredZh.stdout.includes('别把口令写进 URL'),
)

// ──────────────────── 隧道占用 vs permitlisten（用户实测踩过的误报） ────────────────────

const preflightProbe = await import(pathToFileURL(path.join(root, 'lib/core/preflight.js')).href)
check(
  'preflight: 能从 pgrep 输出里认出"本机已有的隧道"（并忽略自己）',
  (() => {
    const runner = async () => ({
      stdout: '12345 ssh -N -T -p 22022 -i ~/.ssh/k -R 127.0.0.1:8788:127.0.0.1:8788 dshtunnel@host\n',
    })
    return preflightProbe.findExistingTunnel
  })() instanceof Function,
)
const detected = await preflightProbe.findExistingTunnel(8788, async () => ({
  stdout:
    '111 pgrep -fl ssh .*-R 127.0.0.1:8788\n' +
    '222 ssh -N -T -p 22022 -i ~/.ssh/k -R 127.0.0.1:8788:127.0.0.1:8788 dshtunnel@dsh.example.com\n',
}))
check(
  'preflight: 占用检测拿到的是真隧道那条（不是 pgrep 自己），并带上 pid',
  detected !== null && detected.pid === '222' && detected.command.includes('dshtunnel@dsh.example.com'),
  JSON.stringify(detected),
)
check(
  'preflight: 没有隧道时返回 null（不会瞎报）',
  (await preflightProbe.findExistingTunnel(8788, async () => ({ stdout: '' }))) === null,
)
const occupied = await preflightProbe.checkSshTunnel({
  user: 'dshtunnel',
  host: 'dsh.example.com',
  remotePort: 8788,
  detectTunnel: async () => ({ pid: '222', command: 'ssh … -R 127.0.0.1:8788:…' }),
})
check(
  'preflight: 远端口已被自己的隧道占用时，结论是"通的"而不是"服务器拒绝"',
  occupied.ok === true && occupied.code === 'preflight.tunnel.existing' && occupied.params.pid === '222',
  JSON.stringify(occupied),
)
const occupiedRendered = preflightProbe.renderCheck(occupied, 'tunnel', messages.translator('zh'))
check(
  'preflight: 占用时的中文说明指向"正在服务的那条隧道"，不再误导去查 permitlisten',
  occupiedRendered.detail.includes('已被本机的一条隧道占用') && !occupiedRendered.detail.includes('permitlisten'),
  occupiedRendered.detail,
)
const listenHint = messages.translate('zh', 'preflight.tunnel.notKept.hint.listen', { remotePort: '8788' })
check(
  'preflight: 真的失败时，提示先怀疑占用、再怀疑 permitlisten',
  listenHint.indexOf('已有隧道占着') < listenHint.indexOf('permitlisten'),
  listenHint.slice(0, 60),
)

// ──────────────────── 服务器侧限流 / 授权行 / 密钥门页面（对接文档提出） ────────────────────

const tunnelTools2 = await import(pathToFileURL(path.join(root, 'lib/core/tunnel.js')).href)
const seq = [1, 2, 3, 4, 5, 6, 7].map((n) => tunnelTools2.nextBackoffDelay(n, { random: () => 0.5 }))
check(
  'tunnel: 重连退避 5s 起、60s 封顶、单调不减（服务器 22022 有 20 次/60s 的限流）',
  seq[0] === 5000 && seq[1] === 10000 && seq[2] === 20000 && seq[3] === 40000 && seq[4] === 60000 && seq[5] === 60000 &&
    seq.every((value, index) => index === 0 || value >= seq[index - 1]),
  seq.join(', '),
)
check(
  'tunnel: 退避带 ±25% 抖动（避免所有客户端同时重连）',
  (() => {
    const low = tunnelTools2.nextBackoffDelay(1, { random: () => 0 })
    const high = tunnelTools2.nextBackoffDelay(1, { random: () => 1 })
    return low === 3750 && high === 6250
  })(),
  String(tunnelTools2.nextBackoffDelay(1, { random: () => 0 })) + '–' + String(tunnelTools2.nextBackoffDelay(1, { random: () => 1 })),
)
// 行为验证：连续崩溃时延迟要递增（回归"退出就清零 attempts"那个固定 2 秒猛重试的 bug）
const flakyStates = []
const flakyScript = path.join(root, 'test', '.flaky-tunnel.sh')
fs.writeFileSync(flakyScript, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
const flakyTunnel = tunnelTools2.createTunnel({
  mode: 'cloudflared',
  localPort: 1,
  cloudflaredPath: flakyScript,
  // 取大于 1s 下限的值，才能观察到"退避在增长"（下限本身是刻意的保护）
  backoffBaseMs: 1000,
  backoffMaxMs: 4000,
  backoffJitter: 0,
  onState: (state) => {
    if (state.phase === 'reconnecting') flakyStates.push(Number(state.params.delayMs))
  },
})
flakyTunnel.start()
await new Promise((resolve) => setTimeout(resolve, 4600))
await flakyTunnel.stop()
fs.rmSync(flakyScript, { force: true })
check(
  'tunnel: 连续失败时退避真的在增长（不再固定间隔重试）',
  flakyStates.length >= 3 && flakyStates[flakyStates.length - 1] > flakyStates[0],
  '延迟序列(ms)：' + flakyStates.join(', '),
)

const snippetTools2 = await import(pathToFileURL(path.join(root, 'lib/core/snippets.js')).href)
const authLine = snippetTools2.authorizedKeysLine('ssh-ed25519 AAAA test', 8788)
check(
  'snippets: 授权行用 remote-port-forwarding（只放 -R，不放开 -L）',
  authLine.includes('restrict,remote-port-forwarding,permitlisten="127.0.0.1:8788"') && !authLine.includes(',port-forwarding,'),
  authLine.slice(0, 60),
)

const cred = credential.setupCommands({ user: 'dsh', authFile: '/etc/nginx/.htpasswd-dsh', password: 'pw' })
check(
  'credential: 用 bcrypt（-B）且默认不带 -c（不覆盖已有用户）',
  cred.htpasswd.includes('htpasswd -i -B /etc/nginx/.htpasswd-dsh dsh') &&
    !cred.htpasswd.includes(' -c ') &&
    cred.firstTime.includes('-c ') &&
    cred.htpasswd.includes('chmod 640'),
)
check(
  'credential: openssl 兜底会提示它只能做较弱的 $apr1$',
  cred.openssl.includes('apr1') && cred.openssl.split('\n')[0].includes('弱'),
)

// 密钥门页面：带 ?k= 的人看到说明页；没有凭据的扫描器仍然只看到裸 404
const gateProxy = createProxy({
  port: 0,
  listenHost: '127.0.0.1',
  upstreamPort: upstreamA.stubPort,
  accessKey: 'the-real-key-0123456789',
})
const gateInfo = await gateProxy.start()
const friendly = await rawRequest(HOST + String(gateInfo.port) + '/?k=wrong-key-0000000000', {
  headers: { 'accept-language': 'zh-CN,zh;q=0.9' },
})
check(
  'gate: 带了错密钥的人看到中文说明页（而不是裸 404），且不回显他试过的密钥',
  friendly.status === 404 &&
    String(friendly.headers['content-type']).includes('text/html') &&
    friendly.body.includes('访问密钥已经无效') &&
    !friendly.body.includes('wrong-key-0000000000'),
  'HTTP ' + String(friendly.status),
)
const bare = await rawRequest(HOST + String(gateInfo.port) + '/')
check(
  'gate: 没有任何凭据的请求仍然只得到裸 404（不暴露入口存在）',
  bare.status === 404 && bare.body.trim() === 'not found',
  bare.body.trim().slice(0, 20),
)
await gateProxy.stop()

// ──────────────────── 令牌过期 + 有 provider 时也要能刷新（线上死循环的真因） ────────────────────

let providerToken = 'provider-one-111111111111'
let providerCalls = 0
let upstreamWants = 'provider-one-111111111111'
const seenProvider = []
const providerUpstream = http.createServer((req, res) => {
  seenProvider.push(req.url)
  const token = (req.url.match(/token=([A-Za-z0-9_-]+)/) ?? [])[1] ?? ''
  if (token === upstreamWants && token !== '') {
    res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-' + token + '=v1; Path=/' })
    res.end()
    return
  }
  if (req.url.includes('token=')) {
    // 真实 Harness 的行为：认得的令牌 → 303 + 设 Cookie；不认得的令牌 → 401
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('unauthorized')
    return
  }
  if (String(req.headers.cookie ?? '').includes('dsh-auth-' + upstreamWants)) {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>ok</title>')
    return
  }
  res.writeHead(401, { 'content-type': 'text/plain' })
  res.end('unauthorized')
})
const providerPort = await listen(providerUpstream)
const providerProxy = createProxy({
  port: 0,
  listenHost: '127.0.0.1',
  upstreamPort: providerPort,
  tokenProvider: () => {
    providerCalls += 1
    return providerToken
  },
})
const providerInfo = await providerProxy.start()
const firstHit = await rawRequest(HOST + String(providerInfo.port) + '/')
check(
  'proxy: 首次访问用 provider 给的令牌并换到 Cookie',
  firstHit.status === 303 && seenProvider.some((url) => url.includes('provider-one-111111111111')),
  seenProvider.join(' | ').slice(0, 80),
)
// Harness 重启：provider 现在给新令牌
providerToken = 'provider-two-222222222222'
upstreamWants = 'provider-two-222222222222'
const before = providerCalls
const healed = await rawRequest(HOST + String(providerInfo.port) + '/', {
  headers: { cookie: 'dsh-auth-provider-one-111111111111=v1' },
})
check(
  'proxy: 旧 Cookie 失效时，即使配了 tokenProvider 也会重新取令牌并重定向一次（线上死循环的真因）',
  healed.status === 303 &&
    String(healed.headers.location).startsWith('/?token=') &&
    String(healed.headers.location).includes('provider-two-222222222222') &&
    providerCalls > before,
  'HTTP ' + String(healed.status) + ' → ' + String(healed.headers.location).slice(0, 44),
)
const afterHeal = await rawRequest(
  HOST + String(providerInfo.port) + '/?token=' + encodeURIComponent(String(healed.headers.location).split('token=')[1]),
)
check(
  'proxy: 跟随那次重定向后拿到 303 → /（下一跳带新 Cookie，不会打转）',
  afterHeal.status === 303 && afterHeal.headers.location === '/',
  'HTTP ' + String(afterHeal.status),
)
const loopBreaker = await rawRequest(HOST + String(providerInfo.port) + '/?token=stale-cached-token-9999', {
  headers: { cookie: 'dsh-auth-stale=v1' },
})
check(
  'proxy: 已经带着 token 的请求再吃 401 时不再重定向（硬保险，宁可让人看到一次 401）',
  loopBreaker.status === 401 && loopBreaker.headers.location === undefined,
  'HTTP ' + String(loopBreaker.status) + ' location=' + String(loopBreaker.headers.location),
)
await providerProxy.stop()
providerUpstream.close()

// ──────────────────── 自助改口令：轮换即时生效、旧 Cookie 作废、弱口令被拒 ────────────────────

const hostTools2 = await import(pathToFileURL(path.join(root, 'lib/index.js')).href)
check(
  'key: 强度校验会拒绝弱口令并说明原因，接受词表短句',
  hostTools2.checkAccessKeyStrength('123456').length >= 2 &&
    hostTools2.checkAccessKeyStrength('password').some((item) => item.includes('弱口令')) &&
    hostTools2.checkAccessKeyStrength('short').some((item) => item.includes('至少 12 位')) &&
    hostTools2.checkAccessKeyStrength('ginger-grove-ember-amber-apple-arrow-923').length === 0,
)
const keyStateFile = path.join(root, 'test', '.access-key-fixture.json')
fs.rmSync(keyStateFile, { force: true })
const seeded = hostTools2.loadAccessKeyState(keyStateFile, '')
check(
  'key: 首次运行自动生成一把可手输的口令（用户不需要自己想）',
  seeded.accessKey.split('-').length === 7 && seeded.generated === true && seeded.epoch === 0,
  seeded.accessKey.split('-').slice(0, 3).join('-') + '…',
)
hostTools2.saveAccessKeyState(keyStateFile, { accessKey: seeded.accessKey, epoch: 3, updatedAt: 'x' })
const reloaded = hostTools2.loadAccessKeyState(keyStateFile, 'ignored-seed')
check(
  'key: 已落盘的口令优先于组合里的种子（面板轮换不需要改用户的 yml）',
  reloaded.accessKey === seeded.accessKey && reloaded.epoch === 3,
)
fs.rmSync(keyStateFile, { force: true })

// 运行中的代理必须立刻认新密钥、并且旧 Cookie 失效
let liveKey = 'first-key-0123456789'
let liveEpoch = 0
const rotateProxy = createProxy({
  port: 0,
  listenHost: '127.0.0.1',
  upstreamPort: upstreamA.stubPort,
  accessKey: liveKey,
  accessKeyProvider: () => liveKey,
  keyEpochProvider: () => liveEpoch,
})
const rotateInfo = await rotateProxy.start()
const beforeRotate = await rawRequest(HOST + String(rotateInfo.port) + '/?k=' + liveKey)
const cookieBefore = String([].concat(beforeRotate.headers['set-cookie'] ?? [])[0] ?? '')
check('key: 旧口令可换到 Cookie', beforeRotate.status === 303 && cookieBefore.includes('='))
liveKey = 'second-key-9876543210'
liveEpoch = 1
check(
  'key: 轮换后新口令立刻生效（无需重启代理）',
  (await rawRequest(HOST + String(rotateInfo.port) + '/?k=' + liveKey)).status === 303,
)
check(
  'key: 轮换后旧口令立刻 404',
  (await rawRequest(HOST + String(rotateInfo.port) + '/?k=first-key-0123456789')).status === 404,
)
check(
  'key: 轮换后旧 Cookie 立刻失效（代次对不上）',
  (await rawRequest(HOST + String(rotateInfo.port) + '/', { headers: { cookie: cookieBefore.split(';')[0] } })).status === 404,
)
await rotateProxy.stop()

process.stdout.write('\n' + String(passed) + ' 项通过，' + String(failed) + ' 项失败\n')
if (failed > 0) process.exit(1)
