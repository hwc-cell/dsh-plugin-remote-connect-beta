/**
 * tailscale funnel 后端：自己机器就是出口，服务器侧零交付。
 *
 * 为什么单独一个模块：
 *  - `tailscale funnel --bg` 是**一次性配置命令**（配完就退出，由 tailscaled 常驻），
 *    与 ssh / cloudflared 那种"长驻子进程"看护模型不同，需要单独处理启动、探测与撤销。
 *  - argv 构造与输出解析都是纯函数，便于在没有 tailscale 的机器上测试。
 *
 * 用到的命令都只影响本机 tailscaled，不写任何系统服务、不改 sshd。
 *
 * @module dsh-plugin-remote-connect/core/tailscale
 */
import { spawn } from 'node:child_process'

/** funnel 默认对外暴露的 HTTPS 端口（由 tailscaled 提供证书）。 */
export const DEFAULT_HTTPS_PORT = 443

/**
 * 建立 funnel 映射：把本机回环端口发布为 `https://<node>.<tailnet>.ts.net/`。
 * @param {object} options
 * @param {string} [options.path='tailscale']
 * @param {number} options.localPort 本机回环端口
 * @param {number} [options.httpsPort=443]
 */
export function funnelUpArgv(options) {
  const httpsPort = options.httpsPort ?? DEFAULT_HTTPS_PORT
  return [
    options.path ?? 'tailscale',
    'funnel',
    '--bg',
    '--https=' + String(httpsPort),
    'http://127.0.0.1:' + String(options.localPort),
  ]
}

/**
 * 撤销 funnel 映射（只撤这一个 https 端口，不碰其它 serve 配置）。
 * @param {object} options
 * @param {string} [options.path='tailscale']
 * @param {number} [options.httpsPort=443]
 */
export function funnelOffArgv(options = {}) {
  const httpsPort = options.httpsPort ?? DEFAULT_HTTPS_PORT
  return [options.path ?? 'tailscale', 'funnel', '--https=' + String(httpsPort), 'off']
}

/** `tailscale status --json`：拿本节点的 DNSName（funnel 对外域名）。 */
export function statusArgv(options = {}) {
  return [options.path ?? 'tailscale', 'status', '--json']
}

/** `tailscale funnel status`：给人看的当前 funnel 配置。 */
export function funnelStatusArgv(options = {}) {
  return [options.path ?? 'tailscale', 'funnel', 'status']
}

/**
 * 从 `tailscale status --json` 输出里取本节点域名。
 * @param {string} text
 * @returns {{ host: string, url: string } | null} 解析不出时返回 null
 */
export function parseSelfDnsName(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const name = parsed !== null && typeof parsed === 'object' ? parsed.Self?.DNSName : undefined
  if (typeof name !== 'string' || name.trim() === '') return null
  // DNSName 带结尾的点（FQDN），去掉才能拼 URL
  const host = name.trim().replace(/\.$/, '')
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return null
  return { host, url: 'https://' + host + '/' }
}

/**
 * 把 tailscale 的报错收敛成几个可翻译的原因码。
 * @param {string} text stderr / stdout
 * @returns {'missing'|'loggedout'|'disabled'|'generic'}
 */
export function classifyFunnelError(text) {
  const lower = String(text ?? '').toLowerCase()
  if (lower.includes('enoent') || lower.includes('executable file not found') || lower.includes('command not found')) {
    return 'missing'
  }
  if (lower.includes('logged out') || lower.includes('not logged in') || lower.includes('needs login')) return 'loggedout'
  if (lower.includes('funnel is not enabled') || lower.includes('not enabled') || lower.includes('access denied')) {
    return 'disabled'
  }
  return 'generic'
}

/**
 * 跑一条一次性命令，收齐输出。
 * @param {string[]} argv
 * @param {object} [options]
 * @param {number} [options.timeoutMs=10000]
 * @param {typeof spawn} [options.spawnImpl]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, error?: string }>}
 */
export async function runOnce(argv, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn
  const timeoutMs = options.timeoutMs ?? 10000
  return await new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error: String(error?.message ?? error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
      finish({ code: null, stdout, stderr, error: 'timeout' })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-8000)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8000)
    })
    child.on('error', (error) => finish({ code: null, stdout, stderr, error: String(error?.message ?? error) }))
    child.on('exit', (code) => finish({ code, stdout, stderr }))
  })
}

/**
 * 读本节点对外地址（funnel 的域名来自节点名，不来自配置）。
 * @param {object} [options]
 * @param {string} [options.path]
 * @param {typeof spawn} [options.spawnImpl]
 * @returns {Promise<{ ok: boolean, host?: string, url?: string, detail?: string, reason?: string }>}
 */
export async function readSelfUrl(options = {}) {
  const result = await runOnce(statusArgv({ path: options.path }), { spawnImpl: options.spawnImpl })
  if (result.error !== undefined) return { ok: false, detail: result.error, reason: classifyFunnelError(result.error) }
  if (result.code !== 0) {
    const text = (result.stderr || result.stdout).trim()
    return { ok: false, detail: text, reason: classifyFunnelError(text) }
  }
  const parsed = parseSelfDnsName(result.stdout)
  if (parsed === null) return { ok: false, detail: 'no Self.DNSName in status output', reason: 'generic' }
  return { ok: true, host: parsed.host, url: parsed.url }
}
