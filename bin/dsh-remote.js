#!/usr/bin/env node
/**
 * dsh-remote —— 给 DSH Harness 开一条远程入口。
 *
 *   dsh-remote serve --public --key <密钥> --domain dsh.example.com --tunnel ssh --ssh-user dshtunnel --ssh-host dsh.example.com
 *   dsh-remote check --domain dsh.example.com --user dsh --password *** --ssh-user dshtunnel --ssh-host dsh.example.com
 *   dsh-remote snippets --domain dsh.example.com --kind nginx
 *   dsh-remote keygen
 *
 * 设计原则：不引入运行时依赖（qrcode 为可选），所有失败都给人话提示。
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createProxy, qrRows, defaultLogCandidates } from '../lib/core/proxy.js'
import { createTunnel } from '../lib/core/tunnel.js'
import { runPreflight } from '../lib/core/preflight.js'
import { normalizeLocale, resolveLocale, translator } from '../lib/core/messages.js'
import { buildServerSetupScript, buildServerUninstallScript } from '../lib/core/serversetup.js'
import {
  NGINX_UPGRADE_MAP,
  nginxServerBlock,
  caddySite,
  authorizedKeysLine,
  sshTunnelCommand,
  serverSetupSteps,
} from '../lib/core/snippets.js'

/** CLI 语言：`--lang` 覆盖环境变量（DSH_REMOTE_LANG / LC_ALL / LANG），兜底英文。 */
let lang = resolveLocale()
let t = translator(lang)

/** 当前语言标记：传给 runPreflight / doctor 渲染结果。 */
function currentLocale() {
  return lang
}

/** 供 `--help` 与用法错误使用。 */
function helpText() {
  return t('cli.help')
}

/**
 * 极简参数解析：支持 --flag、--flag value、--flag=value，位置参数进 `_`。
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const flags = {}
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) {
      rest.push(item)
      continue
    }
    const body = item.slice(2)
    const eq = body.indexOf('=')
    if (eq !== -1) {
      const key = body.slice(0, eq)
      const value = body.slice(eq + 1)
      if (key === 'domain') {
        flags.domain = [].concat(flags.domain ?? [], value)
      } else {
        flags[key] = value
      }
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[body] = true
      continue
    }
    index += 1
    if (body === 'domain') {
      flags.domain = [].concat(flags.domain ?? [], next)
    } else {
      flags[body] = next
    }
  }
  return { flags, rest }
}

function fail(message) {
  process.stderr.write('✖ ' + message + '\n')
  process.exit(1)
}

function printResult(result) {
  process.stdout.write(
    t('cli.result.line', { mark: result.ok ? '✔' : '✖', name: result.name, detail: result.detail }) + '\n',
  )
  if (!result.ok && result.hint) process.stdout.write(t('cli.result.hint', { hint: result.hint }) + '\n')
}

/** 未翻译部分的提示：英文环境下明确告知，而不是给一段看不懂的中文。 */
function noticeZhOnly() {
  const notice = t('cli.notice.zhOnly')
  if (notice !== '') process.stderr.write(notice + '\n')
}

function printQr(url) {
  const rows = qrRows(url)
  if (rows === null) return
  const size = rows.length
  const quiet = 2
  const lines = []
  const pad = ' '.repeat((size + quiet * 2) * 2)
  for (let index = 0; index < quiet; index += 1) lines.push(pad)
  for (let y = 0; y < size; y += 1) {
    let line = '  '.repeat(quiet)
    for (let x = 0; x < size; x += 1) line += rows[y][x] === '1' ? '██' : '  '
    line += '  '.repeat(quiet)
    lines.push(line)
  }
  for (let index = 0; index < quiet; index += 1) lines.push(pad)
  process.stdout.write(lines.join('\n') + '\n')
}

async function commandServe(flags) {
  const isPublic = flags.public === true
  const accessKey = typeof flags.key === 'string' ? flags.key : ''
  if (isPublic && accessKey === '' && flags['allow-no-key'] !== true) {
    fail(t('cli.error.needKey'))
  }
  if (isPublic && accessKey === '' && flags['allow-no-key'] === true) {
    process.stderr.write(t('cli.serve.noKeyWarning') + '\n')
  }
  const port = Number(flags.port ?? (isPublic ? 8788 : 8787))
  const upstreamPort = flags.upstream !== undefined ? Number(flags.upstream) : undefined
  const domains = [].concat(flags.domain ?? [])

  const proxy = createProxy({
    port,
    upstreamPort,
    listenHost: isPublic ? '127.0.0.1' : '0.0.0.0',
    token: typeof flags.token === 'string' ? flags.token : '',
    logPaths: defaultLogCandidates(),
    accessKey,
    allowedHosts: domains,
    mobileAdaptation: flags['no-mobile'] !== true,
    log: (line) => process.stderr.write('· ' + line + '\n'),
  })
  const info = await proxy.start()

  let tunnel = null
  if (typeof flags.tunnel === 'string') {
    if (!['ssh', 'cloudflared', 'tailscale', 'none'].includes(flags.tunnel)) {
      fail(t('cli.error.unknownTunnel', { mode: flags.tunnel }))
    }
    if (flags.tunnel === 'ssh' && (typeof flags['ssh-user'] !== 'string' || typeof flags['ssh-host'] !== 'string')) {
      fail(t('cli.error.needSshHost'))
    }
    tunnel = flags.tunnel === 'none' ? null : createTunnel({
      mode: flags.tunnel,
      localPort: info.port,
      remotePort: flags['remote-port'] !== undefined ? Number(flags['remote-port']) : undefined,
      user: flags['ssh-user'],
      host: flags['ssh-host'],
      keyPath: typeof flags['ssh-key'] === 'string' ? flags['ssh-key'] : undefined,
      port: flags['ssh-port'] !== undefined ? Number(flags['ssh-port']) : undefined,
      tailscalePath: typeof flags['tailscale'] === 'string' ? flags['tailscale'] : undefined,
      tailscaleHttpsPort: flags['tailscale-https-port'] !== undefined ? Number(flags['tailscale-https-port']) : undefined,
      log: (line) => process.stdout.write('· ' + line + '\n'),
      onState: (state) => {
        process.stderr.write('· ' + t(state.code, state.params) + '\n')
      },
    })
    tunnel.start()
  }

  const publicBase =
    tunnel !== null && tunnel.state().publicUrl !== null
      ? tunnel.state().publicUrl
      : isPublic && domains.length > 0
        ? 'https://' + domains[0] + '/'
        : null
  const payload = {
    ...info,
    tunnel: tunnel === null ? null : tunnel.state(),
    entry: publicBase ?? info.lanUrl,
    publicEntry: publicBase === null ? null : publicBase + (accessKey === '' ? '' : '?k=' + accessKey),
    accessKey: accessKey === '' ? null : accessKey,
  }

  if (flags.json === true) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  } else {
    process.stdout.write('\n' + t('cli.serve.started') + '\n')
    process.stdout.write(
      t('cli.serve.listen', { listenHost: info.listenHost, port: String(info.port), upstream: String(info.upstream) }) + '\n',
    )
    if (!info.loopbackOnly && info.lanUrl !== null) {
      process.stdout.write(t('cli.serve.lan', { url: info.lanUrl }) + '\n')
      printQr(info.lanUrl)
    }
    if (publicBase !== null) {
      const entryUrl = publicBase + (accessKey === '' ? '' : '?k=' + accessKey)
      process.stdout.write(t('cli.serve.public', { url: entryUrl }) + '\n')
      printQr(entryUrl)
    }
    if (tunnel !== null) {
      process.stdout.write(t('cli.serve.tunnel', { phase: t('phase.' + tunnel.state().phase) }) + '\n')
    }
    process.stdout.write(t('cli.serve.ctrlC') + '\n\n')
  }

  const shutdown = async () => {
    process.stdout.write('\n' + t('cli.serve.stopping') + '\n')
    if (tunnel !== null) await tunnel.stop()
    await proxy.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  await new Promise(() => {})
}

async function commandCheck(flags) {
  const domains = [].concat(flags.domain ?? [])
  if (domains.length === 0) fail(t('cli.error.needDomain', { command: 'check' }))
  const results = await runPreflight({
    domain: domains[0],
    locale: currentLocale(),
    expectIp: typeof flags['expect-ip'] === 'string' ? flags['expect-ip'] : undefined,
    user: typeof flags.user === 'string' ? flags.user : undefined,
    password: typeof flags.password === 'string' ? flags.password : undefined,
    sshUser: typeof flags['ssh-user'] === 'string' ? flags['ssh-user'] : undefined,
    sshHost: typeof flags['ssh-host'] === 'string' ? flags['ssh-host'] : undefined,
    sshKeyPath: typeof flags['ssh-key'] === 'string' ? flags['ssh-key'] : undefined,
    sshPort: flags['ssh-port'] !== undefined ? Number(flags['ssh-port']) : undefined,
    remotePort: flags['remote-port'] !== undefined ? Number(flags['remote-port']) : undefined,
    localPort: flags['local-port'] !== undefined ? Number(flags['local-port']) : undefined,
  })
  for (const result of results) printResult(result)
  const failed = results.filter((item) => !item.ok)
  process.stdout.write(
    '\n' + t('cli.result.summary', { passed: String(results.length - failed.length), total: String(results.length) }) + '\n',
  )
  if (failed.length > 0) process.exit(1)
}

function commandSnippets(flags) {
  const domains = [].concat(flags.domain ?? [])
  if (domains.length === 0) fail(t('cli.error.needDomain', { command: 'snippets' }))
  const domain = domains[0]
  const targetPort = flags['target-port'] !== undefined ? Number(flags['target-port']) : 8788
  const kind = typeof flags.kind === 'string' ? flags.kind : 'nginx'
  process.stdout.write('=== 1) 服务器一次性准备 ===\n\n')
  process.stdout.write(serverSetupSteps({ targetPort, user: typeof flags['ssh-user'] === 'string' ? flags['ssh-user'] : undefined }) + '\n\n')
  if (typeof flags['public-key'] === 'string') {
    process.stdout.write('=== 2) authorized_keys 限制行（贴进专用账号的 ~/.ssh/authorized_keys）===\n\n')
    process.stdout.write(authorizedKeysLine(flags['public-key'], targetPort) + '\n\n')
  }
  process.stdout.write('=== 3) 反向代理配置（' + kind + '）===\n\n')
  if (kind === 'caddy') {
    process.stdout.write(caddySite({ domain, targetPort }) + '\n\n')
  } else {
    process.stdout.write('# /etc/nginx/conf.d/upgrade-map.conf\n' + NGINX_UPGRADE_MAP + '\n\n')
    process.stdout.write(nginxServerBlock({ domain, targetPort }) + '\n\n')
  }
  process.stdout.write('=== 4) 本机要跑的隧道命令 ===\n\n')
  process.stdout.write(
    sshTunnelCommand({
      user: typeof flags['ssh-user'] === 'string' ? flags['ssh-user'] : 'dshtunnel',
      host: domain,
      keyPath: typeof flags['ssh-key'] === 'string' ? flags['ssh-key'] : '~/.ssh/dsh_remote_tunnel',
      port: flags['ssh-port'] !== undefined ? Number(flags['ssh-port']) : 22,
      localPort: targetPort,
      remotePort: targetPort,
    }) + '\n\n',
  )
  process.stdout.write('提示：`dsh-remote serve --public --key <密钥> --domain ' + domain + ' --tunnel ssh --ssh-user <账号> --ssh-host ' + domain + '`\n')
}

function commandSetupServer(flags) {
  if (currentLocale() !== 'zh') noticeZhOnly()
  const domains = [].concat(flags.domain ?? [])
  if (domains.length === 0) fail('setup-server 需要 --domain <域名>')
  const render = (builder) =>
    builder({
      domain: domains[0],
      remotePort: flags['remote-port'] !== undefined ? Number(flags['remote-port']) : 8788,
      tunnelUser: typeof flags['ssh-user'] === 'string' ? flags['ssh-user'] : 'dshtunnel',
      authUser: typeof flags['auth-user'] === 'string' ? flags['auth-user'] : 'dsh',
      authFile: typeof flags['auth-file'] === 'string' ? flags['auth-file'] : undefined,
      nginxConf: typeof flags['nginx-conf'] === 'string' ? flags['nginx-conf'] : undefined,
    })
  let text
  try {
    text = render(flags.uninstall === true ? buildServerUninstallScript : buildServerSetupScript)
  } catch (error) {
    fail(String(error && error.message ? error.message : error))
  }
  const out = typeof flags.out === 'string' ? flags.out : null
  if (out === null) {
    process.stdout.write(text)
    process.stderr.write(
      '\n· 这份脚本默认不会执行任何东西。用法：拷到服务器上先 `bash <脚本> probe` 看环境，' +
        '再 `bash <脚本> install --dry-run` 看计划，最后 `bash <脚本> install`。\n' +
        (flags.uninstall === true ? '' : '· 撤销：`bash <脚本> uninstall`（或 dsh-remote uninstall-server 产出的独立脚本）。\n'),
    )
    return
  }
  fs.writeFileSync(out, text, { mode: 0o755 })
  process.stdout.write('已写入 ' + out + '（' + String(text.length) + ' 字节，权限 755）\n')
  process.stdout.write(
    flags.uninstall === true
      ? '下一步：scp ' + out + ' <服务器>:/tmp/ && ssh <服务器> "sudo bash /tmp/' + path.basename(out) + ' [--purge-user]"\n'
      : '下一步：scp ' + out + ' <服务器>:/tmp/ && ssh <服务器> "sudo bash /tmp/' + path.basename(out) + ' probe"\n',
  )
}

async function commandDoctor(flags) {
  const domains = [].concat(flags.domain ?? [])
  if (domains.length === 0) fail(t('cli.error.needDomain', { command: 'doctor' }))
  // doctor 的详细报告暂时只有中文（见 CHANGELOG）：英文用户至少知道这件事
  if (currentLocale() !== 'zh') noticeZhOnly()
  const domain = domains[0]
  const results = []

  // 1) 上游与令牌来源：只构造不监听，避免打扰正在跑的服务
  const probe = createProxy({
    port: 0,
    listenHost: '127.0.0.1',
    upstreamPort: flags.upstream !== undefined ? Number(flags.upstream) : undefined,
    token: typeof flags.token === 'string' ? flags.token : '',
    mobileAdaptation: false,
  })
  const probeInfo = probe.info()
  results.push({
    name: '上游与令牌来源',
    ok: probeInfo.hasToken,
    detail:
      probeInfo.upstream + '（端口来源 ' + probeInfo.upstreamSource + '，令牌来源 ' + probeInfo.tokenSource + '）',
    hint: probeInfo.hasToken ? undefined : '没拿到令牌：Harness 可能没在跑；或显式给 --token / --upstream',
  })

  // 2) 局域网入口自测：绑 0 端口 → 请求 → 释放
  try {
    const info = await probe.start()
    const status = await fetch('http://127.0.0.1:' + String(info.port) + '/', { redirect: 'manual' }).then(
      (response) => response.status,
      () => 0,
    )
    await probe.stop()
    results.push({
      name: '代理自测（临时回环端口）',
      ok: status === 303 || status === 200,
      detail: '绑定 :' + String(info.port) + ' 并请求 / → HTTP ' + String(status),
      hint: status === 0 || status === 401 ? '上游拒绝或不可达：确认 Harness 在跑且令牌有效' : undefined,
    })
  } catch (error) {
    results.push({ name: '代理自测（临时回环端口）', ok: false, detail: String(error?.message ?? error) })
  }

  // 3) 公网四项
  const preflight = await runPreflight({
    domain,
    locale: currentLocale(),
    expectIp: typeof flags['expect-ip'] === 'string' ? flags['expect-ip'] : undefined,
    user: typeof flags.user === 'string' ? flags.user : undefined,
    password: typeof flags.password === 'string' ? flags.password : undefined,
    sshUser: typeof flags['ssh-user'] === 'string' ? flags['ssh-user'] : undefined,
    sshHost: typeof flags['ssh-host'] === 'string' ? flags['ssh-host'] : domains[0],
    sshKeyPath: typeof flags['ssh-key'] === 'string' ? flags['ssh-key'] : undefined,
    sshPort: flags['ssh-port'] !== undefined ? Number(flags['ssh-port']) : undefined,
    remotePort: flags['remote-port'] !== undefined ? Number(flags['remote-port']) : undefined,
    localPort: flags['remote-port'] !== undefined ? Number(flags['remote-port']) : undefined,
  })
  for (const item of preflight) results.push(item)

  // 4) 证书线上生效性（Mac 侧只能看到"线上发的那张"）
  const served = await servedCertificate(domain).catch(() => null)
  if (served !== null) {
    const days = Math.floor((served.expiresAt - Date.now()) / 86400000)
    results.push({
      name: '线上实际发出的证书',
      ok: days > 7,
      detail: 'notAfter=' + served.notAfter.toISOString().slice(0, 10) + '（剩 ' + String(days) + ' 天，SAN: ' + served.names + '）',
      hint:
        days > 7
          ? undefined
          : '快到期/已过期：在服务器上对比磁盘证书与线上证书，并确认 renew 后 reload（deploy hook）',
    })
    if (typeof flags['expect-cert-sha256'] === 'string') {
      const expected = flags['expect-cert-sha256'].replaceAll(':', '').toLowerCase()
      const matches = served.sha256 !== '' && served.sha256 === expected
      results.push({
        name: '证书生效性（线上指纹 == 服务器磁盘指纹）',
        ok: matches,
        detail: matches
          ? '线上发出的正是服务器上那张证书（sha256 ' + served.sha256.slice(0, 16) + '…）'
          : '线上 sha256 ' + (served.sha256 || '未知').slice(0, 16) + '… ≠ 期望 ' + expected.slice(0, 16) + '…',
        hint: matches
          ? undefined
          : 'nginx 仍在用内存里的旧证书：服务器上执行 nginx -t && systemctl reload nginx，并确认 /etc/letsencrypt/renewal-hooks/deploy/ 里装了 reload 钩子（安装脚本已默认装）',
      })
    }
    if (typeof flags['expect-expiry'] === 'string') {
      const expected = new Date(flags['expect-expiry'] + 'T00:00:00Z')
      const matches = Math.abs(expected.getTime() - served.notAfter.getTime()) < 86400000
      results.push({
        name: '证书生效性（磁盘 vs 线上）',
        ok: matches,
        detail: matches ? '线上证书与预期到期日一致（' + flags['expect-expiry'] + '）' : '线上到期日 ' + served.notAfter.toISOString().slice(0, 10) + ' ≠ 预期 ' + flags['expect-expiry'],
        hint: matches ? undefined : 'nginx 很可能还在用内存里的旧证书：服务器上执行 nginx -t && systemctl reload nginx，并补 /etc/letsencrypt/renewal-hooks/deploy/ 钩子',
      })
    }
  }

  // 5) 服务器侧需要人跑的检查（Mac 读不到对端日志）
  process.stdout.write('\n以下两项只能在服务器上跑（Mac 侧无法读取对端 /etc 与日志）：\n')
  process.stdout.write('  证书生效性：echo | openssl s_client -connect 127.0.0.1:443 -servername ' + domain + ' 2>/dev/null | openssl x509 -noout -enddate \\\n')
  process.stdout.write('              openssl x509 -in /etc/letsencrypt/live/<lineage>/fullchain.pem -noout -enddate   # 两者必须一致\n')
  process.stdout.write('  deploy 钩子：ls -l /etc/letsencrypt/renewal-hooks/deploy/   # 空 = 续签后不会 reload，线上会继续发旧证书\n')
  process.stdout.write('  日志泄漏：  grep -c "k=" /var/log/nginx/dsh-remote.access.log   # 期望 0\n')

  // 6) 本地侧：访问密钥不得出现在本机日志里
  if (typeof flags.key === 'string' && flags.key !== '') {
    const hits = defaultLogCandidates().filter((file) => {
      try {
        return fs.readFileSync(file, 'utf8').includes(flags.key)
      } catch {
        return false
      }
    })
    results.push({
      name: '本机日志未泄漏访问密钥',
      ok: hits.length === 0,
      detail: hits.length === 0 ? '本地候选日志中未出现 ?k= 的值' : '命中：' + hits.join(', '),
      hint: hits.length === 0 ? undefined : '换一个新密钥（面板可一键重新生成），并检查是谁把密钥写进了日志',
    })
  }

  if (flags.json === true) {
    process.stdout.write(JSON.stringify({ ok: results.every((item) => item.ok), results }, null, 2) + '\n')
  } else {
    for (const result of results) printResult(result)
    const failed = results.filter((item) => !item.ok)
    process.stdout.write('\n' + String(results.length - failed.length) + '/' + String(results.length) + ' 项通过\n')
  }
  if (results.some((item) => !item.ok)) process.exit(1)
}

/** 读取线上（443）实际发出的证书。 */
async function servedCertificate(domain) {
  const tls = await import('node:tls')
  return await new Promise((resolve, reject) => {
    const socket = tls.connect({ host: domain, port: 443, servername: domain, rejectUnauthorized: false, timeout: 8000 }, () => {
      const cert = socket.getPeerCertificate()
      socket.end()
      if (cert === null || Object.keys(cert).length === 0) {
        reject(new Error('未拿到证书'))
        return
      }
      resolve({
        notAfter: new Date(cert.valid_to),
        expiresAt: new Date(cert.valid_to).getTime(),
        names: String(cert.subjectaltname ?? '').split(',').map((item) => item.trim()).join(' '),
        sha256: String(cert.fingerprint256 ?? '').replaceAll(':', '').toLowerCase(),
      })
    })
    socket.on('timeout', () => { socket.destroy(); reject(new Error('超时')) })
    socket.on('error', reject)
  })
}

function commandKeygen(flags) {
  if (currentLocale() !== 'zh') noticeZhOnly()
  const outPath =
    typeof flags.out === 'string' ? flags.out : path.join(os.homedir(), '.ssh', 'dsh_remote_tunnel')
  if (fs.existsSync(outPath) && flags.force !== true) {
    fail(outPath + ' 已存在；确认要覆盖请加 --force')
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const result = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'dsh-mac-tunnel', '-f', outPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    fail('ssh-keygen 失败：' + result.stderr.toString('utf8').trim())
  }
  const publicKey = fs.readFileSync(outPath + '.pub', 'utf8').trim()
  const targetPort = flags['target-port'] !== undefined ? Number(flags['target-port']) : 8788
  process.stdout.write('私钥：' + outPath + '\n公钥：' + outPath + '.pub\n\n')
  process.stdout.write('把这一行贴到服务器专用账号的 ~/.ssh/authorized_keys：\n\n')
  process.stdout.write(authorizedKeysLine(publicKey, targetPort) + '\n')
}

async function main() {
  const argv = process.argv.slice(2)
  // `dsh-remote --help` 也要能用：首个参数是选项时按 help 处理
  const command = argv[0] === undefined || argv[0].startsWith('--') ? 'help' : argv[0]
  const { flags } = parseArgs(command === 'help' ? argv : argv.slice(1))
  // --lang 优先于环境变量；未知取值退回环境推断（不因为写错语言就让命令失败）
  const requested = normalizeLocale(flags.lang)
  if (requested !== undefined) {
    lang = requested
    t = translator(lang)
  }
  if (command === 'help' || flags.help === true) {
    process.stdout.write(helpText() + '\n')
    return
  }
  if (command === 'serve') return await commandServe(flags)
  if (command === 'check') return await commandCheck(flags)
  if (command === 'snippets') return commandSnippets(flags)
  if (command === 'keygen') return commandKeygen(flags)
  if (command === 'setup-server') return commandSetupServer(flags)
  if (command === 'uninstall-server') return commandSetupServer({ ...flags, uninstall: true })
  if (command === 'doctor') return await commandDoctor(flags)
  fail(t('cli.error.unknownCommand', { command }) + '\n\n' + helpText())
}

main().catch((error) => {
  fail(String(error?.stack ?? error))
})
