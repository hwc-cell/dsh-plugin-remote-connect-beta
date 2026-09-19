/**
 * 隧道看护：把本机的公网入口端口送到服务器（ssh -R）、送上一个临时公网地址
 * （cloudflared），或直接用 tailscale funnel 发布（本机即出口）。
 *
 * 三种后端的看护模型不同，这里刻意分开：
 *  - ssh / cloudflared：长驻子进程，退出即指数退避重连。
 *  - tailscale funnel：`tailscale funnel --bg` 是一次性配置命令（配完由 tailscaled 常驻），
 *    所以启动后改为定时探测状态，停止时撤销该端口上的 funnel 映射。
 *
 * 状态只发 `code` + `params`（外加一份英文兜底 `detail`），由调用方按自己的语言渲染。
 *
 * @module dsh-plugin-remote-connect/core/tunnel
 */
import { spawn } from 'node:child_process'
import {
  classifyFunnelError,
  funnelOffArgv,
  funnelStatusArgv,
  funnelUpArgv,
  readSelfUrl,
  runOnce,
} from './tailscale.js'
import { translator } from './messages.js'

/** 英文兜底渲染：CLI / 日志在没有请求语言时用它。 */
const tEn = translator('en')

/**
 * @param {object} options
 * @param {'ssh'|'cloudflared'|'tailscale'} options.mode
 * @param {number} options.localPort 本机监听端口（代理的公网口）
 * @param {string} [options.user] ssh 账号（ssh 模式必填）
 * @param {string} [options.host] 服务器地址（ssh 模式必填）
 * @param {string} [options.keyPath] 私钥
 * @param {number} [options.remotePort] 服务器回环端口，默认与 localPort 相同
 * @param {number} [options.port=22] 服务器 sshd 端口
 * @param {string} [options.cloudflaredPath='cloudflared']
 * @param {string} [options.tailscalePath='tailscale']
 * @param {number} [options.tailscaleHttpsPort=443] funnel 对外端口
 * @param {number} [options.tailscaleProbeMs=60000] funnel 状态探测间隔
 * @param {(state: object) => void} [options.onState] 状态回调
 * @param {(line: string) => void} [options.log]
 */
export function createTunnel(options) {
  const localPort = options.localPort
  const remotePort = options.remotePort ?? localPort
  const sshPort = options.port ?? 22
  const tailscalePath = options.tailscalePath ?? 'tailscale'
  const tailscaleHttpsPort = options.tailscaleHttpsPort ?? 443
  const tailscaleProbeMs = options.tailscaleProbeMs ?? 60000
  const log = options.log ?? (() => {})
  const onState = options.onState ?? (() => {})

  let child = null
  let stopped = false
  let attempts = 0
  let restartTimer = null
  let healthTimer = null
  let state = { phase: 'idle', code: 'tunnel.idle', params: {}, detail: '', publicUrl: null, restarts: 0 }

  function setState(patch) {
    const next = { ...state, ...patch }
    // 兜底 detail：调用方没给语言时至少有一句英文，而不是空字符串
    if (patch.code !== undefined && patch.detail === undefined) {
      next.detail = tEn(patch.code, patch.params)
    }
    state = next
    onState(state)
  }

  function buildSshArgv() {
    const argv = [
      '-N',
      '-T',
      ...(sshPort === 22 ? [] : ['-p', String(sshPort)]),
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'StrictHostKeyChecking=yes',
    ]
    if (options.keyPath) argv.push('-i', options.keyPath)
    argv.push('-R', '127.0.0.1:' + String(remotePort) + ':127.0.0.1:' + String(localPort))
    argv.push(options.user + '@' + options.host)
    return argv
  }

  function buildCloudflaredArgv() {
    return [
      options.cloudflaredPath ?? 'cloudflared',
      'tunnel',
      '--no-autoupdate',
      '--url',
      'http://127.0.0.1:' + String(localPort),
    ]
  }

  function scheduleRestart(reason) {
    if (stopped) return
    attempts += 1
    const delay = Math.min(1000 * 2 ** Math.min(attempts, 5), 30000)
    setState({
      phase: 'reconnecting',
      code: 'tunnel.reconnecting',
      params: { reason, seconds: String(Math.round(delay / 1000)) },
      restarts: state.restarts + 1,
    })
    restartTimer = setTimeout(() => {
      restartTimer = null
      launch()
    }, delay)
  }

  function capturePublicUrl(text) {
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text)
    if (match === null || state.publicUrl === match[0]) return
    setState({ publicUrl: match[0] })
    log(tEn('tunnel.urlDiscovered', { url: match[0] }))
  }

  function launchProcess() {
    if (stopped) return
    const argv = options.mode === 'cloudflared' ? buildCloudflaredArgv() : ['ssh', ...buildSshArgv()]
    setState({ phase: 'connecting', code: 'tunnel.connecting', params: { command: argv[0] } })
    let spawned
    try {
      spawned = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      scheduleRestart(tEn('tunnel.spawnFailed', { command: argv[0], message: String(error?.message ?? error) }))
      return
    }
    child = spawned
    let stderr = ''
    spawned.stdout.on('data', (chunk) => {
      if (options.mode === 'cloudflared') capturePublicUrl(chunk.toString('utf8'))
    })
    spawned.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000)
      if (options.mode === 'cloudflared') capturePublicUrl(stderr)
    })
    spawned.on('error', (error) => {
      scheduleRestart(tEn('tunnel.spawnFailed', { command: argv[0], message: String(error?.message ?? error) }))
    })
    spawned.on('exit', (code, signal) => {
      if (child !== spawned) return
      child = null
      if (stopped) {
        setState({ phase: 'stopped', code: 'tunnel.stopped' })
        return
      }
      const tail = stderr.trim().split('\n').slice(-2).join(' | ')
      attempts = 0
      // 子进程自己的输出（ssh / cloudflared 的原文）不翻译，直接附在原因里
      scheduleRestart('exit ' + (signal ?? String(code)) + (tail ? ': ' + tail : ''))
    })
    // ssh 立刻退出（例如转发被拒）会走 exit 分支；稳定运行 10s 后清零退避
    setTimeout(() => {
      if (child === spawned) {
        attempts = 0
        setState({ phase: 'up', code: 'tunnel.up' })
      }
    }, 10000)
  }

  /** funnel 状态探测：tailscaled 掉线 / funnel 被撤销时要能发现。 */
  function startHealthProbe() {
    stopHealthProbe()
    healthTimer = setInterval(() => {
      void (async () => {
        if (stopped) return
        const status = await runOnce(funnelStatusArgv({ path: tailscalePath }), { timeoutMs: 15000 })
        if (stopped) return
        const text = (status.stderr || status.stdout).trim()
        if (status.error === undefined && status.code === 0) return
        stopHealthProbe()
        setState({
          phase: 'error',
          code: 'tunnel.funnelFailed',
          params: { output: (text || status.error || '-').split('\n').slice(-3).join(' | ') },
          hintCode: 'preflight.tailscale.failed.hint.' + classifyFunnelError(text || status.error),
        })
      })()
    }, tailscaleProbeMs)
    if (typeof healthTimer.unref === 'function') healthTimer.unref()
  }

  function stopHealthProbe() {
    if (healthTimer === null) return
    clearInterval(healthTimer)
    healthTimer = null
  }

  async function launchFunnel() {
    if (stopped) return
    const argv = funnelUpArgv({ path: tailscalePath, localPort, httpsPort: tailscaleHttpsPort })
    setState({ phase: 'connecting', code: 'tunnel.connecting', params: { command: argv[0] + ' funnel' } })
    const up = await runOnce(argv, { timeoutMs: 30000 })
    if (stopped) return
    if (up.error !== undefined || up.code !== 0) {
      const text = (up.stderr || up.stdout || up.error || '').trim()
      // 配置类失败（没装客户端 / 没登录 / 后台没开 Funnel）重试也不会好，交给用户
      setState({
        phase: 'error',
        code: 'tunnel.funnelFailed',
        params: { output: text.split('\n').slice(-3).join(' | ') || '-' },
        hintCode: 'preflight.tailscale.failed.hint.' + classifyFunnelError(text || up.error),
      })
      return
    }
    const self = await readSelfUrl({ path: tailscalePath })
    if (stopped) return
    setState({
      phase: 'up',
      code: 'tunnel.funnelUp',
      params: { url: self.ok ? self.url : '-' },
      publicUrl: self.ok ? self.url : null,
      ...(self.ok ? {} : { hintCode: 'preflight.tailscale.failed.hint.' + self.reason }),
    })
    startHealthProbe()
  }

  async function takeFunnelDown() {
    stopHealthProbe()
    const result = await runOnce(funnelOffArgv({ path: tailscalePath, httpsPort: tailscaleHttpsPort }), {
      timeoutMs: 20000,
    })
    if (result.code === 0) log(tEn('tunnel.funnelOff'))
  }

  function launch() {
    if (options.mode === 'tailscale') {
      void launchFunnel()
      return
    }
    launchProcess()
  }

  return {
    /** 启动隧道（失败会自动重连，不抛异常）。 */
    start() {
      stopped = false
      attempts = 0
      launch()
      return state
    },
    /** 停止并等待子进程退出（tailscale 模式会撤销 funnel 映射）。 */
    async stop() {
      stopped = true
      if (restartTimer !== null) {
        clearTimeout(restartTimer)
        restartTimer = null
      }
      if (options.mode === 'tailscale') {
        if (state.phase === 'up') await takeFunnelDown()
        else stopHealthProbe()
      }
      const current = child
      child = null
      if (current !== null) {
        current.kill('SIGTERM')
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            try {
              current.kill('SIGKILL')
            } catch {
              /* 已退出 */
            }
            resolve()
          }, 2000)
          current.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
      setState({ phase: 'stopped', code: 'tunnel.stopped' })
      return state
    },
    /** 当前状态快照。 */
    state() {
      return state
    },
  }
}
