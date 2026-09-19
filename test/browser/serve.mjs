/**
 * 客户端 bundle 的真浏览器预览：把 client.js 当成页面脚本加载（和 client-modules
 * 装载方式一致），用真实 React 渲染出侧栏入口与面板，并喂入一份假状态。
 *
 * 用途：在没有重启 Harness 的前提下，验证 bundle 协议、组件渲染与样式观感。
 *
 *   node test/browser/serve.mjs           # 起在 127.0.0.1:8899
 *   浏览器打开 http://127.0.0.1:8899/
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const LOCAL_MODULES = path.join(root, 'node_modules')
const APP_MODULES = fs.existsSync(path.join(LOCAL_MODULES, 'react/package.json'))
  ? LOCAL_MODULES
  : '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules'
const PORT = Number(process.env.PREVIEW_PORT ?? 8899)

const { qrRows } = await import(pathToFileURL(path.join(root, 'lib/core/proxy.js')).href)

/** ssh 自建服务器模式（默认预览）。 */
const STATE = {
  ok: true,
  busy: false,
  canControl: true,
  config: { problems: [], publicDomain: 'dsh.example.com', tunnel: 'ssh' },
  lan: { running: true, url: 'http://192.0.2.10:8787/', port: 8787, hasToken: true },
  public: {
    running: true,
    domain: 'dsh.example.com',
    port: 8788,
    entry: 'https://dsh.example.com/?k=9f2c41ab77e34d0e',
    tunnel: {
      phase: 'up',
      code: 'tunnel.up',
      params: {},
      detail: 'Tunnel connected',
      publicUrl: null,
      restarts: 0,
    },
    accessKeyGenerated: true,
    hasToken: true,
  },
  qr: qrRows('https://dsh.example.com/?k=9f2c41ab77e34d0e'),
  error: null,
}

/** 隧道掉线（状态灯应为红）。 */
const STATE_DOWN = {
  ok: true, busy: false, canControl: true,
  config: { problems: [], publicDomain: 'dsh.example.com', tunnel: 'ssh' },
  lan: { running: false, url: null, port: 8787 },
  public: {
    running: true, domain: 'dsh.example.com', port: 8788,
    entry: 'https://dsh.example.com/?k=9f2c41ab77e34d0e',
    tunnel: { phase: 'reconnecting', code: 'tunnel.reconnecting', params: { reason: 'exit 255', seconds: '35' }, detail: 'Tunnel dropped (exit 255); reconnecting in 35s', publicUrl: null, restarts: 4 },
    accessKeyGenerated: true, hasToken: true,
  },
  qr: null, error: null,
}

/** 两个入口都没开（状态灯应为橙）。 */
const STATE_OFF = {
  ok: true, busy: false, canControl: true,
  config: { problems: [], publicDomain: 'dsh.example.com', tunnel: 'ssh' },
  lan: { running: false, url: null, port: 8787 },
  public: { running: false, domain: 'dsh.example.com', port: 8788, entry: null, tunnel: null, accessKeyGenerated: true, hasToken: true },
  qr: null, error: null,
}

/** 多租户：一张卡片里三个人，两个在跑、一个起不来、一个还没开。 */
const STATE_TENANTS = {
  ok: true,
  busy: false,
  canControl: true,
  config: { problems: [], publicDomain: 'dsh.example.com', tunnel: 'ssh' },
  lan: { running: true, url: 'http://192.0.2.10:8787/', port: 8787, hasToken: true },
  public: {
    running: true,
    domain: 'dsh.example.com',
    port: 8788,
    entry: 'https://dsh.example.com/?k=9f2c41ab77e34d0e',
    tunnel: { phase: 'up', code: 'tunnel.up', params: {}, detail: 'Tunnel connected', publicUrl: null, restarts: 0 },
    accessKeyGenerated: true,
    hasToken: true,
  },
  tenants: {
    enabled: true,
    registry: '~/.dsh/remote-connect/tenants.json',
    baseDir: '~/DSH-tenants',
    harness: { bin: '/Applications/DSH/…/@deepseek-ai/dsh/lib/bin.js', node: '/opt/homebrew/bin/node', problem: null },
    list: [
      {
        id: 'alice',
        name: 'Alice',
        accessKey: 'demo-alice-0123456789',
        home: '~/DSH-tenants/alice',
        profile: 'alice',
        port: 58581,
        phase: 'up',
        detail: 'Tenant alice is serving on 127.0.0.1:58581',
        running: true,
        restarts: 0,
        lanEntry: 'http://192.0.2.10:8787/?k=demo-alice-0123456789',
        publicEntry: 'https://dsh.example.com/?k=demo-alice-0123456789',
      },
      {
        id: 'bob',
        name: 'Bob',
        accessKey: 'demo-bob-0123456789',
        home: '~/DSH-tenants/bob',
        profile: 'bob',
        port: 58582,
        phase: 'restarting',
        detail: 'Tenant bob exited (exit 1); restarting in 4s',
        running: false,
        restarts: 3,
        lanEntry: 'http://192.0.2.10:8787/?k=demo-bob-0123456789',
        publicEntry: null,
      },
      {
        id: 'carol',
        name: 'Carol',
        accessKey: 'demo-carol-0123456789',
        home: '~/DSH-tenants/carol',
        profile: 'carol',
        port: 0,
        phase: 'error',
        detail: 'Tenant carol kept crashing (exit 1); giving up — fix it, then start it again',
        hint: 'Install the tailscale client on this machine first',
        running: false,
        restarts: 5,
        lanEntry: 'http://192.0.2.10:8787/?k=demo-carol-0123456789',
        publicEntry: null,
      },
    ],
  },
  qr: qrRows('http://192.0.2.10:8787/'),
  error: null,
}

/** tailscale 零交付模式：没有自己的域名，地址来自 funnel。 */
const STATE_TAILSCALE = {
  ok: true,
  busy: false,
  canControl: true,
  config: { problems: [], publicDomain: '', tunnel: 'tailscale' },
  lan: { running: false, url: null, port: 8787, hasToken: true },
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
    accessKeyGenerated: true,
    hasToken: true,
  },
  qr: qrRows('https://mac-mini.tail1234.ts.net/'),
  error: null,
}

const PAGE = (stateJson, frameHeight, shotMode, zoom, dark) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>remote-connect client preview</title>
<style>
  html{zoom:${zoom}}
  ${dark ? 'html{color-scheme:dark}body{background:#101114!important;color:#e8e8ea}' : ''}
  body{margin:0;background:#eceef1;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18191c}
  .stage{display:flex;gap:24px;padding:24px}
  /* 模拟 Harness 的 .frame：position:relative + 一个确定尺寸的容器 */
  /* shot 模式：面板改为静态布局、不裁剪，方便截一张完整的面板图 */
  ${shotMode ? 'html,body{width:404px!important;overflow:visible!important}.stage{display:block!important;padding:16px 12px!important}.frame{position:static!important;height:auto!important;overflow:visible!important;box-shadow:none!important;border-radius:0!important;width:380px!important}.note{display:none!important}.dshRcPanel{position:static!important;max-height:none!important;width:380px!important;max-width:380px!important}.dshRcLayer{position:static!important}' : ''}
  .frame{position:relative;width:360px;height:${frameHeight}px;background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.12);overflow:hidden}
  .sidebar{position:absolute;inset:auto 0 0 0;padding:8px 12px 12px}
  .note{max-width:420px}
  .note code{background:#fff;padding:2px 5px;border-radius:4px}
</style></head>
<body>
<div class="stage">
  <div class="frame" id="frame">
    <div class="sidebar" id="host"></div>
  </div>
  <div class="note">
    <h3>client 半真浏览器预览</h3>
    <p>左侧是模拟的侧栏底部：先渲染「远程连接」入口，再打开面板（数据是假的，扫码链接也是假的）。</p>
    <p>换后端预览：<a href="/">ssh 自建服务器</a> · <a href="/?mode=tailscale">tailscale 零交付</a> · <a href="/?mode=tenants">多租户</a> · <a href="/?mode=down">隧道掉线（红灯）</a> · <a href="/?mode=off">未开启服务（橙灯）</a> · <a href="/?dark=1">深色模式</a></p>
    <p>这份页面按 client-modules 的方式装载 bundle：先 <code>window.__ModuleLoader__.load({id, factory})</code>，
       再用真实 React 渲染 <code>apply()</code> 注册进槽位的组件。</p>
    <p id="status">…</p>
  </div>
</div>
<script src="/vendor/react.js"></script>
<script src="/vendor/react-dom.js"></script>
<script>
  window.__PREVIEW_STATE__ = ${stateJson};
  window.__loaded = null;
  window.__ModuleLoader__ = { load: function (definition) { window.__loaded = definition } };
</script>
<script src="/client.js"></script>
<script>
  (function () {
    var React = window.React;
    var ReactDOM = window.ReactDOM;
    var definition = window.__loaded;
    var status = document.getElementById('status');
    if (definition === null) { status.textContent = '✖ bundle 没有调用 __ModuleLoader__.load'; return; }
    if (definition.id !== 'dsh-plugin-remote-connect-beta') { status.textContent = '✖ bundle id 不对：' + definition.id; return; }
    var clientExports = definition.factory(function (specifier) {
      if (specifier === 'react') return React;
      throw new Error('unexpected require: ' + specifier);
    });
    var registered = [];
    var slots = { inject: function (name, callback) { callback(); }, register: function (options, Component) { registered.push({ options: options, Component: Component }); } };
    var dicts = { zh: {}, en: {} };
    var locale = { register: function (ns, value) { dicts = value; return function () {}; } };
    clientExports.apply({
      get: function (name) { return name === 'slots' ? slots : name === 'locale' ? locale : undefined; },
      effect: function (callback) { return callback(); },
    });
    window.__dicts = dicts;
    // /check 返回一批假的检查结果，用来预览排版（真值来自宿主，且已按当前语言渲染）
    var CHECK_RESULTS = {
      ok: true,
      results: [
        { id: 'dns', name: 'DNS', ok: true, detail: 'dsh.example.com -> 192.0.2.10', code: 'preflight.dns.ok' },
        { id: 'tls', name: 'TLS certificate', ok: true, detail: 'Certificate valid until 2026-12-14', code: 'preflight.tls.ok' },
        { id: 'https', name: 'HTTPS and edge password', ok: false, detail: 'Without credentials the server returned 200, expected 401 (edge password inactive)', hint: 'Check that nginx auth_basic or Caddy basic_auth was reloaded', code: 'preflight.https.noAuth' },
      ],
    };
    var TENANT_QR = { ok: true, id: 'alice', url: 'http://192.0.2.10:8787/?k=demo-alice-0123456789' };
    window.fetch = function (url) {
      var target = String(url);
      var body = target.indexOf('/check') !== -1
        ? CHECK_RESULTS
        : target.indexOf('/tenants/qr') !== -1
          ? TENANT_QR
          : window.__PREVIEW_STATE__;
      return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(JSON.stringify(body)); } });
    };
    var lang = 'zh';
    var root = ReactDOM.createRoot(document.getElementById('host'));
    function translate(key) {
      var table = window.__dicts[lang] || {};
      return table[key] === undefined ? key : table[key];
    }
    function renderAll() {
      root.render(
        React.createElement('div', null,
          React.createElement(registered[0].Component, { wide: true, t: translate }),
          React.createElement(registered[1].Component, { t: translate })
        )
      );
    }
    window.__switchLang = function (next) { lang = next; renderAll(); return lang; };
    clientExports.internals.setState({ open: true });
    clientExports.internals.refresh().then(function () { return clientExports.internals.runCheck(); }).then(function () {
      renderAll();
      status.textContent = '✔ 注册槽位：' + registered.map(function (r) { return r.options.name; }).join(' + ')
        + '　| 字典键数 zh=' + Object.keys(dicts.zh).length + ' en=' + Object.keys(dicts.en).length;
    });
  })();
</script>
</body></html>`

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const pathname = url.pathname
  const send = (contentType, body) => {
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
    res.end(body)
  }
  if (pathname === '/')
    return send(
      'text/html; charset=utf-8',
      PAGE(
        JSON.stringify(
          url.searchParams.get('mode') === 'tailscale'
            ? STATE_TAILSCALE
            : url.searchParams.get('mode') === 'tenants'
              ? STATE_TENANTS
              : url.searchParams.get('mode') === 'down'
                ? STATE_DOWN
                : url.searchParams.get('mode') === 'off'
                  ? STATE_OFF
                  : STATE,
        ),
        // 截图用：把模拟 frame 拉高，面板就不会被 overflow 裁掉
        url.searchParams.get('frame') ?? '720',
        url.searchParams.get('shot') === '1',
        // 截图用：整体缩放，让完整面板能落进一个视口
        url.searchParams.get('zoom') ?? '1',
        url.searchParams.get('dark') === '1',
      ),
    )
  if (pathname === '/client.js') return send('text/javascript; charset=utf-8', fs.readFileSync(path.join(root, 'lib/client.js')))
  if (pathname === '/vendor/react.js')
    return send('text/javascript; charset=utf-8', fs.readFileSync(path.join(APP_MODULES, 'react/umd/react.development.js')))
  if (pathname === '/vendor/react-dom.js')
    return send('text/javascript; charset=utf-8', fs.readFileSync(path.join(APP_MODULES, 'react-dom/umd/react-dom.development.js')))
  res.writeHead(404)
  res.end('not found')
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('client 预览：http://127.0.0.1:' + String(PORT) + '/\n')
})
