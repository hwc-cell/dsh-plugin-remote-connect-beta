/**
 * 宿主侧文案目录（CLI 与插件面板共用一份，避免同一句话写两遍）。
 *
 * 分工：
 *  - 这里放**宿主生成**的文案：前置检查（DNS/TLS/HTTPS/隧道）与 CLI 提示。
 *  - 面板自己的界面文案在 `lib/client.js` 的 zh/en 字典里（组件只通过 t() 取词）。
 *  - 隧道运行状态不发文案，只发 `code` + `params`，由调用方按自己的语言渲染。
 *
 * 键集事实来源是 `en`：新增键时先写 en，再补 zh，`npm test` 会检查两份键集一致。
 *
 * @module dsh-plugin-remote-connect/core/messages
 */

/** 支持的语言（与 harness 的 locale 服务一致）。 */
export const LOCALES = ['en', 'zh']

/** 兜底语言：键缺失或语言未知时用它。 */
export const DEFAULT_LOCALE = 'en'

/**
 * 把任意 BCP 47 风格的语言标记收敛到受支持的取值。
 * @param {unknown} value
 * @returns {'en'|'zh'|undefined} 无法识别时返回 undefined（交给调用方兜底）
 */
export function normalizeLocale(value) {
  if (typeof value !== 'string') return undefined
  const lower = value.trim().toLowerCase().replace(/_/g, '-')
  if (lower === '') return undefined
  const primary = lower.split('-')[0]
  return LOCALES.includes(primary) ? primary : undefined
}

/**
 * 从环境变量推断语言：显式覆盖 > LC_ALL > LC_MESSAGES > LANG。
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {'en'|'zh'} 从不返回 undefined —— CLI 需要一个确定的结果
 */
export function resolveLocale(env = process.env) {
  const candidates = [env.DSH_REMOTE_LANG, env.LC_ALL, env.LC_MESSAGES, env.LANG]
  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate)
    if (locale !== undefined) return locale
  }
  return DEFAULT_LOCALE
}

/** 英文文案（键集的事实来源）。 */
const en = {
  // ---- 前置检查：条目名 ----
  'check.dns.name': 'DNS',
  'check.tls.name': 'TLS certificate',
  'check.https.name': 'HTTPS and edge password',
  'check.tunnel.name': 'ssh reverse tunnel',
  'check.tailscale.name': 'tailscale funnel',
  'check.meta.name': 'Harness upstream',

  // ---- DNS ----
  'preflight.dns.ok': '{domain} -> {addresses}',
  'preflight.dns.none': '{domain} has no DNS records',
  'preflight.dns.none.hint': 'Add an A record at your DNS provider pointing at the server public IP',
  'preflight.dns.mismatch': '{domain} resolves to {addresses}, not the expected {expectIp}',
  'preflight.dns.mismatch.hint': 'Check the record; a CDN proxy would hide the origin (set DNS only first)',
  'preflight.dns.failed': 'Lookup of {domain} failed: {code}',
  'preflight.dns.failed.hint': 'The name may not be configured yet, or DNS has not propagated',

  // ---- TLS ----
  'preflight.tls.ok': 'Certificate valid until {date}',
  'preflight.tls.expiring.hint': 'The certificate expires within 7 days; renew it now',
  'preflight.tls.nocert': 'No certificate was presented',
  'preflight.tls.nocert.hint': 'The server has no certificate for this domain yet',
  'preflight.tls.uncovered': 'Certificate does not cover {domain} (SAN: {names})',
  'preflight.tls.uncovered.hint': 'Extend your existing certificate to include this domain, or use a covered one',
  'preflight.tls.chain': 'Certificate chain did not verify (self-signed or incomplete)',
  'preflight.tls.chain.hint': 'Reissue with certbot and install the full chain',
  'preflight.tls.timeout': 'Connection to {domain}:{port} timed out',
  'preflight.tls.timeout.hint': 'Make sure 443 is open inbound and not blocked by a firewall or cloud security group',
  'preflight.tls.failed': 'TLS connection failed: {code}',
  'preflight.tls.failed.hint': 'Check that 443 is open, a certificate is installed and DNS resolves',

  // ---- HTTPS / 边缘口令 ----
  'preflight.https.requestFailed': 'HTTPS request failed: {error}',
  'preflight.https.requestFailed.hint': 'Fix DNS / port 443 / certificate first',
  'preflight.https.noAuth': 'Without credentials the server returned {status}, expected 401 (edge password inactive)',
  'preflight.https.noAuth.hint': 'Check that nginx auth_basic or Caddy basic_auth was reloaded',
  'preflight.https.skipped': 'Without credentials: 401 (edge password works); no credentials given, skipping the authenticated check',
  'preflight.https.still401': 'Still 401 with credentials',
  'preflight.https.still401.hint': 'Wrong user or password, or the htpasswd path/permissions are wrong',
  'preflight.https.ok': 'With credentials: {status} (404 is normal; the local access key ?k= is still required)',

  // ---- ssh 反向隧道实连 ----
  'preflight.tunnel.spawnFailed': 'Could not start ssh: {message}',
  'preflight.tunnel.spawnFailed.hint': 'Make sure an ssh client is installed on this machine',
  'preflight.tunnel.notKept': 'The ssh tunnel did not stay up (exit {code}): {output}',
  'preflight.tunnel.notKept.hint.denied': 'The server rejected the key: check the authorized_keys content and its 600 permissions',
  'preflight.tunnel.notKept.hint.listen': 'The server refused that remote port: check permitlisten 127.0.0.1:{remotePort} in authorized_keys',
  'preflight.tunnel.notKept.hint.forwarding': 'sshd disabled forwarding on the server: AllowTcpForwarding yes is required',
  'preflight.tunnel.notKept.hint.generic': 'Check the network, the port and the sshd configuration',
  'preflight.tunnel.ok': 'ssh tunnel established and held for {seconds}s (remote port 127.0.0.1:{remotePort})',

  // ---- tailscale funnel 实连 ----
  'preflight.tailscale.ok': 'tailscale funnel is serving {url}',
  'preflight.tailscale.failed': 'tailscale funnel did not come up: {output}',
  'preflight.tailscale.failed.hint.missing': 'Install the tailscale client on this machine first',
  'preflight.tailscale.failed.hint.loggedout': 'Run `tailscale up` and sign in to your tailnet',
  'preflight.tailscale.failed.hint.disabled': 'Enable Funnel for this node in the Tailscale admin console (HTTPS certificates must be on)',
  'preflight.tailscale.failed.hint.generic': 'Run `tailscale funnel status` on this machine to see the full output',

  // ---- 隧道运行状态（host 发码，面板/CLI 按语言渲染）----
  'tunnel.idle': 'Not started',
  'tunnel.connecting': 'Starting {command}…',
  'tunnel.up': 'Tunnel connected',
  'tunnel.stopped': 'Stopped',
  'tunnel.reconnecting': 'Tunnel dropped ({reason}); reconnecting in {seconds}s',
  'tunnel.spawnFailed': 'Cannot execute {command}: {message}',
  'tunnel.urlDiscovered': 'Public address: {url}',
  'tunnel.funnelUp': 'Funnel is serving {url}',
  'tunnel.funnelFailed': 'tailscale funnel failed: {output}',
  'tunnel.funnelOff': 'Funnel mapping removed',

  // ---- 宿主侧接口错误（面板/CLI 都会看到，按请求语言渲染）----
  'host.error.needDomain': 'public.domain is not configured, so the public entry cannot start',
  'host.error.needDomainCheck': 'public.domain is not configured; nothing to check (tailscale mode needs no domain)',
  'host.error.gate.lan': 'LAN visitors cannot toggle services: use the DSH window on the host machine',
  'host.error.gate.public': 'Public visitors cannot toggle services: use the DSH window on the host machine',
  'host.error.busy': 'Another operation is in progress, please wait',
  'host.error.method': 'Only {method} is supported',
  'host.error.unknownRoute': 'Unknown endpoint: {route}',

  // ---- CLI ----
  'cli.usage.title': 'dsh-remote — LAN / public entry for the DSH Harness',
  'cli.usage.serve': '  serve --public --key <key> --domain dsh.example.com --tunnel ssh --ssh-user dshtunnel --ssh-host dsh.example.com',
  'cli.usage.check': '  dsh-remote check --domain dsh.example.com --user dsh --password *** --ssh-user dshtunnel --ssh-host dsh.example.com',
  'cli.usage.tunnel': '  --tunnel <ssh|cloudflared|tailscale|none>   also start a tunnel',
  'cli.result.line': '{mark} {name}: {detail}',
  'cli.result.hint': '   > {hint}',
  'cli.result.summary': '{passed}/{total} checks passed',
  'cli.error.needDomain': '{command} needs --domain <domain>',
  'cli.error.needKey': 'serve --public needs --key <access key> (refusing to expose the Harness without a key gate)',
  'cli.error.needSshHost': '--tunnel ssh needs --ssh-user and --ssh-host',
  'cli.error.unknownCommand': 'Unknown command: {command}',
  'cli.tunnel.started': 'Tunnel: {phase} (auto-reconnects if it drops)',
  'cli.tunnel.url': 'Public address: {url}',
  'cli.serve.started': 'Started.',
  'cli.serve.listen': '  Listening: {listenHost}:{port} (upstream {upstream})',
  'cli.serve.lan': '  LAN address: {url}',
  'cli.serve.public': '  Public entry: {url}',
  'cli.serve.tunnel': '  Tunnel: {phase} (auto-reconnects if it drops)',
  'cli.serve.ctrlC': '  Ctrl-C to stop.',
  'cli.serve.noKeyWarning': '! Access key gate disabled: the edge password is now the only protection — make sure nginx/Caddy auth is active.',
  'cli.serve.stopping': 'Stopping…',
  'cli.notice.zhOnly': 'Note: this command prints its detailed report in Chinese for now.',
  'cli.help': [
    'dsh-remote — a LAN / public entry for the DSH Harness',
    '',
    'Usage:',
    '  dsh-remote serve            [options]  start the proxy (optionally with a tunnel)',
    '  dsh-remote check            [options]  check DNS / certificate / edge password / ssh tunnel',
    '  dsh-remote snippets         [options]  print server config snippets (nginx / Caddy / authorized_keys)',
    '  dsh-remote keygen           [options]  create a tunnel-only key pair and print the restricted authorized_keys line',
    '  dsh-remote setup-server     [options]  render the server-side install script (prints only; never touches your server)',
    '  dsh-remote uninstall-server [options]  render a standalone uninstall script (removing files undoes everything)',
    '  dsh-remote doctor           [options]  one-shot health report: upstream/token source, LAN entry, public checks, live certificate',
    '',
    'serve options:',
    '  --public                 public mode: bind 127.0.0.1 only and enforce the access key gate',
    '  --key <key>              access key (required in public mode; becomes ...?k=<key>)',
    '  --allow-no-key           explicitly drop the key gate in public mode (not recommended)',
    '  --domain <domain>        only accept this Host (repeatable; recommended in public mode)',
    '  --port <port>            proxy port (LAN default 8787, public default 8788)',
    '  --upstream <port>        upstream Harness port (auto-discovered by default)',
    '  --token <token>          explicit launch token (otherwise discovered from the log)',
    '  --no-mobile              do not inject the mobile adaptation styles',
    '  --tunnel <ssh|cloudflared|tailscale|none>   also start a tunnel',
    '  --ssh-user / --ssh-host / --ssh-key / --ssh-port / --remote-port   tunnel parameters',
    '                           (ssh-port defaults to 22; set it if sshd moved)',
    '  --json                   print the readiness payload as JSON',
    '',
    'check options:',
    '  --domain <domain> --expect-ip <ip> --user <user> --password <password>',
    '  --expect-cert-sha256 <fingerprint>   output of `openssl x509 -fingerprint -sha256` on the server',
    '  --ssh-user <user> --ssh-host <host> --ssh-key <key> --ssh-port <port>',
    '',
    'snippets options:',
    '  --domain <domain> --kind <nginx|caddy> --target-port <port>',
    '  --public-key "<ssh-ed25519 AAAA...>"  also print the restricted authorized_keys line',
    '',
    'Global:',
    '  --lang <en|zh>           output language (default: DSH_REMOTE_LANG / LC_ALL / LANG, else English)',
  ].join('\n'),
}

/** 简体中文，键集与 en 一致。 */
const zh = {
  'check.dns.name': 'DNS 解析',
  'check.tls.name': 'TLS 证书',
  'check.https.name': 'HTTPS 与边缘口令',
  'check.tunnel.name': 'ssh 反向隧道',
  'check.tailscale.name': 'tailscale funnel',
  'check.meta.name': 'Harness 上游',

  'preflight.dns.ok': '{domain} -> {addresses}',
  'preflight.dns.none': '{domain} 没有解析结果',
  'preflight.dns.none.hint': '到 DNS 服务商添加 A 记录指向服务器公网 IP',
  'preflight.dns.mismatch': '{domain} 解析到 {addresses}，不是预期的 {expectIp}',
  'preflight.dns.mismatch.hint': '检查 DNS 记录，或注意是否开了 CDN 代理（建议先设 DNS only / 灰云）',
  'preflight.dns.failed': '{domain} 解析失败：{code}',
  'preflight.dns.failed.hint': '域名可能还没配置或还没生效（TTL 传播需要时间）',

  'preflight.tls.ok': '证书有效至 {date}',
  'preflight.tls.expiring.hint': '证书 7 天内过期，尽快续签',
  'preflight.tls.nocert': '未拿到证书',
  'preflight.tls.nocert.hint': '服务器上还没为该域名配置证书',
  'preflight.tls.uncovered': '证书不覆盖 {domain}（SAN: {names}）',
  'preflight.tls.uncovered.hint': '给现有证书扩签该域名，或改用一个被覆盖的域名',
  'preflight.tls.chain': '证书链校验未通过（可能是自签或链不全）',
  'preflight.tls.chain.hint': '用 certbot 等重新签发，确保 fullchain 完整',
  'preflight.tls.timeout': '连接 {domain}:{port} 超时',
  'preflight.tls.timeout.hint': '确认服务器 443 可入站、没被防火墙或云安全组挡住',
  'preflight.tls.failed': 'TLS 连接失败：{code}',
  'preflight.tls.failed.hint': '确认 443 端口开放、证书已配置、DNS 已生效',

  'preflight.https.requestFailed': 'HTTPS 请求失败：{error}',
  'preflight.https.requestFailed.hint': '先解决 DNS / 443 / 证书问题',
  'preflight.https.noAuth': '不带凭据返回 {status}，期望 401（说明边缘口令没生效）',
  'preflight.https.noAuth.hint': '检查 nginx 的 auth_basic / Caddy 的 basic_auth 是否已 reload',
  'preflight.https.skipped': '不带凭据 401（边缘口令已生效）；未提供凭据，跳过带凭据检查',
  'preflight.https.still401': '带凭据仍返回 401',
  'preflight.https.still401.hint': '用户名或口令不对，或 htpasswd 文件权限/路径不对',
  'preflight.https.ok': '带凭据返回 {status}（404 属正常：还需要本机侧的访问密钥 ?k=）',

  'preflight.tunnel.spawnFailed': 'ssh 启动失败：{message}',
  'preflight.tunnel.spawnFailed.hint': '确认本机有 ssh 客户端',
  'preflight.tunnel.notKept': 'ssh 隧道未能保持（exit {code}）：{output}',
  'preflight.tunnel.notKept.hint.denied': '公钥没被服务器接受：确认 authorized_keys 内容与权限（600）',
  'preflight.tunnel.notKept.hint.listen': '服务器拒绝了该远端口：检查 authorized_keys 的 permitlisten 是否含 127.0.0.1:{remotePort}',
  'preflight.tunnel.notKept.hint.forwarding': '服务器 sshd 关闭了转发：需要 AllowTcpForwarding yes',
  'preflight.tunnel.notKept.hint.generic': '检查网络、端口与 sshd 配置',
  'preflight.tunnel.ok': 'ssh 隧道已建立并保持 {seconds} 秒（远端口 127.0.0.1:{remotePort}）',

  'preflight.tailscale.ok': 'tailscale funnel 正在提供 {url}',
  'preflight.tailscale.failed': 'tailscale funnel 未能建立：{output}',
  'preflight.tailscale.failed.hint.missing': '先在本机安装 tailscale 客户端',
  'preflight.tailscale.failed.hint.loggedout': '先 `tailscale up` 登录你的 tailnet',
  'preflight.tailscale.failed.hint.disabled': '到 Tailscale 管理后台为这个节点启用 Funnel（需要打开 HTTPS 证书）',
  'preflight.tailscale.failed.hint.generic': '在本机跑 `tailscale funnel status` 看完整输出',

  'tunnel.idle': '未启动',
  'tunnel.connecting': '正在启动 {command}…',
  'tunnel.up': '隧道已连接',
  'tunnel.stopped': '已停止',
  'tunnel.reconnecting': '隧道退出（{reason}）；{seconds}s 后重连',
  'tunnel.spawnFailed': '无法执行 {command}：{message}',
  'tunnel.urlDiscovered': '公网地址：{url}',
  'tunnel.funnelUp': 'funnel 正在提供 {url}',
  'tunnel.funnelFailed': 'tailscale funnel 失败：{output}',
  'tunnel.funnelOff': '已撤销 funnel 映射',

  'host.error.needDomain': '未配置 public.domain，无法启动公网入口',
  'host.error.needDomainCheck': '未配置 public.domain，没有可检查的域名（tailscale 模式不需要域名）',
  'host.error.gate.lan': '局域网访客不能开关服务：请在宿主机的 DSH 窗口里操作',
  'host.error.gate.public': '公网访客不能开关服务：请在宿主机的 DSH 窗口里操作',
  'host.error.busy': '已有操作在进行，请稍候',
  'host.error.method': '只支持 {method}',
  'host.error.unknownRoute': '未知接口：{route}',

  'cli.usage.title': 'dsh-remote —— DSH Harness 的局域网 / 公网入口',
  'cli.usage.serve': '  serve --public --key <密钥> --domain dsh.example.com --tunnel ssh --ssh-user dshtunnel --ssh-host dsh.example.com',
  'cli.usage.check': '  dsh-remote check --domain dsh.example.com --user dsh --password *** --ssh-user dshtunnel --ssh-host dsh.example.com',
  'cli.usage.tunnel': '  --tunnel <ssh|cloudflared|tailscale|none>   同时起隧道',
  'cli.result.line': '{mark} {name}：{detail}',
  'cli.result.hint': '   ↳ {hint}',
  'cli.result.summary': '{passed}/{total} 项通过',
  'cli.error.needDomain': '{command} 需要 --domain <域名>',
  'cli.error.needKey': 'serve --public 需要 --key <访问密钥>（拒绝在没有密钥门的情况下暴露 Harness）',
  'cli.error.needSshHost': '--tunnel ssh 需要同时给出 --ssh-user 与 --ssh-host',
  'cli.error.unknownCommand': '未知命令：{command}',
  'cli.tunnel.started': '隧道：{phase}（掉线会自动重连）',
  'cli.tunnel.url': '公网地址：{url}',
  'cli.help': [
    'dsh-remote —— 给 DSH Harness 开一条局域网 / 公网入口',
    '',
    '用法：',
    '  dsh-remote serve     [选项]   启动代理（可选同时起隧道）',
    '  dsh-remote check     [选项]   检查域名 / 证书 / 边缘口令 / ssh 隧道',
    '  dsh-remote snippets  [选项]   打印服务器配置片段（nginx / Caddy / authorized_keys）',
    '  dsh-remote keygen    [选项]   生成隧道专用密钥并打印受限 authorized_keys 行',
    '  dsh-remote setup-server [选项]     生成服务器侧安装脚本（默认只打印，不碰你的服务器）',
    '  dsh-remote uninstall-server [选项] 生成独立卸载脚本（删文件即可撤销）',
    '  dsh-remote doctor    [选项]   一条命令体检：上游/令牌来源、局域网入口、公网四检、证书线上生效性',
    '',
    'serve 选项：',
    '  --public                 公网模式：只绑 127.0.0.1，并强制访问密钥门',
    '  --key <密钥>             访问密钥（公网模式必填；会拼成 ...?k=<密钥>）',
    '  --allow-no-key           公网模式下显式放弃密钥门（不推荐）',
    '  --domain <域名>          只接受该 Host（可重复；建议公网模式必填）',
    '  --port <端口>            代理监听端口（局域网默认 8787，公网默认 8788）',
    '  --upstream <端口>        上游 Harness 端口（默认自动发现）',
    '  --token <令牌>           显式指定启动令牌（默认从日志自动发现）',
    '  --no-mobile              不注入手机适配样式',
    '  --tunnel <ssh|cloudflared|tailscale|none>  同时起隧道',
    '  --ssh-user / --ssh-host / --ssh-key / --ssh-port / --remote-port   隧道参数',
    '                           （ssh-port 默认 22；服务器改了 sshd 端口就必须给）',
    '  --json                   以 JSON 打印就绪信息',
    '',
    'check 选项：',
    '  --domain <域名> --expect-ip <IP> --user <用户名> --password <口令>',
    '  --expect-cert-sha256 <指纹>   服务器上 `openssl x509 -fingerprint -sha256` 的输出（安装脚本会打印）',
    '  --ssh-user <账号> --ssh-host <地址> --ssh-key <私钥> --ssh-port <端口>',
    '',
    'snippets 选项：',
    '  --domain <域名> --kind <nginx|caddy> --target-port <端口>',
    '  --public-key "<ssh-ed25519 AAAA...>"  一并打印 authorized_keys 限制行',
    '',
    '全局：',
    '  --lang <en|zh>           输出语言（默认按 DSH_REMOTE_LANG / LC_ALL / LANG，兜底英文）',
  ].join('\n'),
  'cli.serve.started': '已启动。',
  'cli.serve.listen': '  监听：{listenHost}:{port}（上游 {upstream}）',
  'cli.serve.lan': '  局域网地址：{url}',
  'cli.serve.public': '  公网入口：{url}',
  'cli.serve.tunnel': '  隧道：{phase}（掉线会自动重连）',
  'cli.serve.ctrlC': '  Ctrl-C 停止。',
  'cli.serve.noKeyWarning': '⚠ 已放弃访问密钥门：边缘口令是唯一防线，请确认 nginx/Caddy 的 auth 已生效。',
  'cli.serve.stopping': '正在停止…',
  'cli.notice.zhOnly': '（此命令暂无英文输出）',
}

/** 全部语言目录，键集必须一致（测试会断言）。 */
export const CATALOG = { en, zh }

/**
 * 用 `{name}` 占位符做极简插值：缺失的参数原样保留，便于一眼看出漏传。
 * @param {string} template
 * @param {Record<string, unknown>} [params]
 */
export function interpolate(template, params) {
  if (params === undefined || params === null) return template
  return template.replace(/\{(\w+)\}/g, (whole, key) => {
    const value = params[key]
    return value === undefined || value === null ? whole : String(value)
  })
}

/**
 * 取一条文案：目标语言缺失时退回 en，两边都没有时返回键名（不抛异常，界面不会因为漏词崩掉）。
 * @param {'en'|'zh'} locale
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 */
export function translate(locale, key, params) {
  const table = CATALOG[locale] ?? CATALOG[DEFAULT_LOCALE]
  const template = table[key] ?? CATALOG[DEFAULT_LOCALE][key]
  if (template === undefined) return key
  return interpolate(template, params)
}

/**
 * 绑定一种语言，返回 `t(key, params)`。
 * @param {unknown} [locale] 未知或缺失时按 DEFAULT_LOCALE 处理
 */
export function translator(locale) {
  const resolved = normalizeLocale(locale) ?? DEFAULT_LOCALE
  return (key, params) => translate(resolved, key, params)
}
