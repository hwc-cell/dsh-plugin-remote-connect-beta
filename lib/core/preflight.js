/**
 * 前置检查：把"能上网但用不了"的失败提前变成一句人话。
 *
 * 每一项只返回**原因码 + 参数**（`{ ok, code, params, hintCode, hintParams }`），
 * 由调用方按自己的语言渲染（`renderCheck` / `runPreflight`）。
 * 这样面板、CLI、测试看到的是同一份结构化结果，文案集中在 core/messages.js。
 *
 * @module dsh-plugin-remote-connect/core/preflight
 */
import dns from 'node:dns/promises'
import tls from 'node:tls'
import https from 'node:https'
import { spawn } from 'node:child_process'
import { classifyFunnelError, funnelStatusArgv, runOnce } from './tailscale.js'
import { translator } from './messages.js'

/**
 * DNS：域名是否解析，以及是否指向预期 IP。
 * @param {string} domain
 * @param {string} [expectIp] 你的服务器公网 IP
 */
export async function checkDns(domain, expectIp) {
  try {
    const records = await dns.lookup(domain, { all: true })
    const addresses = records.map((item) => item.address)
    if (addresses.length === 0) {
      return { ok: false, code: 'preflight.dns.none', params: { domain }, hintCode: 'preflight.dns.none.hint' }
    }
    if (expectIp && !addresses.includes(expectIp)) {
      return {
        ok: false,
        code: 'preflight.dns.mismatch',
        params: { domain, addresses: addresses.join(', '), expectIp },
        hintCode: 'preflight.dns.mismatch.hint',
      }
    }
    return { ok: true, code: 'preflight.dns.ok', params: { domain, addresses: addresses.join(', ') } }
  } catch (error) {
    return {
      ok: false,
      code: 'preflight.dns.failed',
      params: { domain, code: String(error?.code ?? error) },
      hintCode: 'preflight.dns.failed.hint',
    }
  }
}

/**
 * TLS：能否握手成功，证书是否覆盖该域名、是否过期。
 * @param {string} domain
 * @param {number} [port=443]
 */
export async function checkTls(domain, port = 443) {
  return await new Promise((resolve) => {
    const socket = tls.connect(
      { host: domain, port, servername: domain, rejectUnauthorized: false, timeout: 8000 },
      () => {
        const cert = socket.getPeerCertificate()
        const authorized = socket.authorized
        const validTo = cert?.valid_to ? new Date(cert.valid_to) : null
        socket.end()
        if (!cert || Object.keys(cert).length === 0) {
          resolve({ ok: false, code: 'preflight.tls.nocert', hintCode: 'preflight.tls.nocert.hint' })
          return
        }
        const names = String(cert.subjectaltname ?? '')
          .split(',')
          .map((item) => item.trim().replace(/^DNS:/, ''))
          .filter(Boolean)
        const covered =
          names.includes(domain) ||
          names.some((name) => name.startsWith('*.') && domain.endsWith(name.slice(1)))
        const expiring = validTo !== null && validTo.getTime() - Date.now() < 7 * 24 * 3600 * 1000
        if (!covered) {
          resolve({
            ok: false,
            code: 'preflight.tls.uncovered',
            params: { domain, names: names.join(', ') },
            hintCode: 'preflight.tls.uncovered.hint',
          })
          return
        }
        if (!authorized) {
          resolve({ ok: false, code: 'preflight.tls.chain', hintCode: 'preflight.tls.chain.hint' })
          return
        }
        resolve({
          ok: !expiring,
          code: 'preflight.tls.ok',
          params: { date: validTo ? validTo.toISOString().slice(0, 10) : 'unknown' },
          hintCode: expiring ? 'preflight.tls.expiring.hint' : undefined,
        })
      },
    )
    socket.on('timeout', () => {
      socket.destroy()
      resolve({
        ok: false,
        code: 'preflight.tls.timeout',
        params: { domain, port: String(port) },
        hintCode: 'preflight.tls.timeout.hint',
      })
    })
    socket.on('error', (error) => {
      resolve({
        ok: false,
        code: 'preflight.tls.failed',
        params: { code: String(error?.code ?? error?.message ?? error) },
        hintCode: 'preflight.tls.failed.hint',
      })
    })
  })
}

/**
 * HTTPS 可达性：不带凭据应 401，带凭据应非 401。
 * @param {string} domain
 * @param {{ user?: string, password?: string }} [auth]
 */
export async function checkHttps(domain, auth = {}) {
  const request = (headers) =>
    new Promise((resolve) => {
      const req = https.request(
        { host: domain, port: 443, path: '/', method: 'GET', headers, timeout: 10000, rejectUnauthorized: false },
        (res) => {
          res.resume()
          resolve({ status: res.statusCode ?? 0 })
        },
      )
      req.on('timeout', () => {
        req.destroy()
        resolve({ status: 0, error: 'ETIMEDOUT' })
      })
      req.on('error', (error) => resolve({ status: 0, error: String(error?.code ?? error) }))
      req.end()
    })

  const anonymous = await request({})
  if (anonymous.status === 0) {
    return {
      ok: false,
      code: 'preflight.https.requestFailed',
      params: { error: String(anonymous.error) },
      hintCode: 'preflight.https.requestFailed.hint',
    }
  }
  if (anonymous.status !== 401) {
    return {
      ok: false,
      code: 'preflight.https.noAuth',
      params: { status: String(anonymous.status) },
      hintCode: 'preflight.https.noAuth.hint',
    }
  }
  if (!auth.user || !auth.password) {
    return { ok: true, code: 'preflight.https.skipped' }
  }
  const token = Buffer.from(auth.user + ':' + auth.password).toString('base64')
  const authorized = await request({ authorization: 'Basic ' + token })
  if (authorized.status === 401) {
    return { ok: false, code: 'preflight.https.still401', hintCode: 'preflight.https.still401.hint' }
  }
  return { ok: true, code: 'preflight.https.ok', params: { status: String(authorized.status) } }
}

/**
 * ssh 反向隧道实连测试：能不能建立，以及远端口是否被允许。
 * @param {object} options
 * @param {string} options.user
 * @param {string} options.host
 * @param {string} [options.keyPath]
 * @param {number} [options.localPort=8788]
 * @param {number} [options.remotePort=8788]
 * @param {number} [options.port=22] 服务器 sshd 端口
 * @param {number} [options.timeoutMs=12000]
 */
export async function checkSshTunnel(options) {
  const localPort = options.localPort ?? 8788
  const remotePort = options.remotePort ?? 8788
  const port = options.port ?? 22
  const argv = [
    '-N',
    '-T',
    ...(port === 22 ? [] : ['-p', String(port)]),
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=8',
  ]
  if (options.keyPath) argv.push('-i', options.keyPath)
  argv.push('-R', '127.0.0.1:' + String(remotePort) + ':127.0.0.1:' + String(localPort))
  argv.push(options.user + '@' + options.host)

  return await new Promise((resolve) => {
    const child = spawn('ssh', argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGTERM')
      } catch {
        /* 已退出 */
      }
      resolve(result)
    }
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) =>
      finish({
        ok: false,
        code: 'preflight.tunnel.spawnFailed',
        params: { message: String(error?.message ?? error) },
        hintCode: 'preflight.tunnel.spawnFailed.hint',
      }),
    )
    child.on('exit', (code) => {
      const text = stderr.trim().split('\n').slice(-3).join(' | ')
      if (code === 0) return
      const hintCode = text.includes('Permission denied')
        ? 'preflight.tunnel.notKept.hint.denied'
        : text.includes('remote port forwarding failed')
          ? 'preflight.tunnel.notKept.hint.listen'
          : text.includes('AllowTcpForwarding')
            ? 'preflight.tunnel.notKept.hint.forwarding'
            : 'preflight.tunnel.notKept.hint.generic'
      finish({
        ok: false,
        code: 'preflight.tunnel.notKept',
        params: { code: String(code), output: text || '-' },
        hintCode,
        hintParams: { remotePort: String(remotePort) },
      })
    })
    const holdMs = Math.min(options.timeoutMs ?? 3000, 15000)
    setTimeout(() => {
      if (child.exitCode === null) {
        finish({
          ok: true,
          code: 'preflight.tunnel.ok',
          params: { seconds: String(Math.round(holdMs / 1000)), remotePort: String(remotePort) },
        })
      }
    }, holdMs)
  })
}

/**
 * tailscale funnel 实连测试：本机有没有 tailscale、登录没有、funnel 是否已指向本端口。
 * @param {object} [options]
 * @param {string} [options.path]
 * @param {number} [options.localPort]
 * @param {typeof spawn} [options.spawnImpl]
 * @param {number} [options.timeoutMs]
 */
export async function checkTailscaleFunnel(options = {}) {
  const argv = funnelStatusArgv({ path: options.path })
  const result = await runOnce(argv, { spawnImpl: options.spawnImpl, timeoutMs: options.timeoutMs ?? 10000 })
  if (result.error !== undefined) {
    return {
      ok: false,
      code: 'preflight.tailscale.failed',
      params: { output: result.error },
      hintCode: 'preflight.tailscale.failed.hint.' + classifyFunnelError(result.error),
    }
  }
  const text = (result.stderr || result.stdout).trim()
  if (result.code !== 0) {
    return {
      ok: false,
      code: 'preflight.tailscale.failed',
      params: { output: text.split('\n').slice(-3).join(' | ') || '-' },
      hintCode: 'preflight.tailscale.failed.hint.' + classifyFunnelError(text),
    }
  }
  if (options.localPort !== undefined && !text.includes(String(options.localPort))) {
    return {
      ok: false,
      code: 'preflight.tailscale.failed',
      params: { output: text.split('\n').slice(0, 3).join(' | ') || '-' },
      hintCode: 'preflight.tailscale.failed.hint.generic',
    }
  }
  const url = /https:\/\/[A-Za-z0-9.-]+/.exec(text)
  return { ok: true, code: 'preflight.tailscale.ok', params: { url: url === null ? '-' : url[0] + '/' } }
}

/**
 * 把结构化结果渲染成可展示的行。
 * @param {object} result check* 的返回值
 * @param {string} id 条目 id（面板按它取自己的语言）
 * @param {(key: string, params?: object) => string} t
 */
export function renderCheck(result, id, t) {
  const rendered = {
    id,
    name: t('check.' + id + '.name'),
    ok: result.ok,
    code: result.code,
    params: result.params ?? {},
    detail: t(result.code, result.params),
  }
  if (result.hintCode !== undefined) rendered.hint = t(result.hintCode, result.hintParams)
  return rendered
}

/**
 * 一次跑完所有检查。
 * @param {object} options
 * @param {string} options.domain
 * @param {'en'|'zh'} [options.locale] 渲染语言；缺省时按英文渲染（CLI 会显式传入）
 * @returns {Promise<Array<{ id: string, name: string, ok: boolean, detail: string, hint?: string }>>}
 */
export async function runPreflight(options) {
  const t = translator(options.locale)
  const results = []

  // 域名三项只在有域名时才有意义：tailscale 用节点自带的 ts.net 域名，配置里没有 domain
  if (options.domain !== undefined && options.domain !== '') {
    const dnsResult = await checkDns(options.domain, options.expectIp)
    results.push(renderCheck(dnsResult, 'dns', t))

    const tlsResult = await checkTls(options.domain, options.httpsPort ?? 443)
    results.push(renderCheck(tlsResult, 'tls', t))

    const httpsResult = await checkHttps(options.domain, { user: options.user, password: options.password })
    results.push(renderCheck(httpsResult, 'https', t))
  }

  if (options.tunnelMode === 'tailscale') {
    const funnelResult = await checkTailscaleFunnel({
      path: options.tailscalePath,
      localPort: options.localPort,
      spawnImpl: options.spawnImpl,
    })
    results.push(renderCheck(funnelResult, 'tailscale', t))
  } else if (options.sshUser && options.sshHost) {
    const sshResult = await checkSshTunnel({
      user: options.sshUser,
      host: options.sshHost,
      keyPath: options.sshKeyPath,
      port: options.sshPort,
      localPort: options.localPort ?? 8788,
      remotePort: options.remotePort ?? 8788,
    })
    results.push(renderCheck(sshResult, 'tunnel', t))
  }
  return results
}
