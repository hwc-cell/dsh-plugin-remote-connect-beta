/**
 * 租户实例看护：为每个租户拉起一个**独立** Harness 进程（独立 DSH_HOME、独立端口、独立令牌）。
 *
 * 隔离靠进程边界 + home 边界，不靠约定：
 *  - `DSH_HOME=<租户目录>`：会话、凭据、设置、storages 全在租户自己的目录里；
 *  - `--host 127.0.0.1 --port <p>`：只监听回环，公网/局域网只能经网关进来；
 *  - 启动令牌由子进程 **stdout** 打印（`dsh web: http://127.0.0.1:<port>/?token=…`），
 *    每个实例只认自己的令牌 —— 实测拿 A 的令牌访问 B 的端口是 401。
 *
 * 启动方式与 DSH Desktop 自己拉起 Harness 的方式保持一致（见桌面应用 main 进程）：
 *
 *     <runtime> --expose-internals <dsh 入口> --profile <id> [--from-default-profile web] \
 *               --no-open --host 127.0.0.1 --port <p>
 *
 * `--from-default-profile web` 只在租户 home 里还没有该 profile 时加（首次启动时初始化）。
 *
 * @module dsh-plugin-remote-connect/core/instance
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { translator } from './messages.js'

const tEn = translator('en')

/** 子进程 stdout 里的就绪行：`dsh web: http://127.0.0.1:8791/?token=…` */
const READY_PATTERN = /dsh web:\s*(http:\/\/[^\s]*[?&]token=([A-Za-z0-9_-]+))/

/**
 * 找 DSH 的 CLI 入口（`@deepseek-ai/dsh/lib/bin.js`）。
 *
 * 顺序：显式配置 → 环境变量 → 桌面版自带 → 常见全局安装位置。
 * 找不到就返回 null 并给出候选，让面板/CLI 能说人话，而不是抛一个 ENOENT。
 *
 * @param {object} [options]
 * @param {string} [options.configured] 配置里显式给的路径
 * @param {string} [options.env=process.env.DSH_HARNESS_BIN]
 * @param {string} [options.appPath] DSH Desktop 安装路径（可覆盖，便于测试）
 * @returns {{ bin: string, source: string } | null}
 */
export function discoverHarnessBin(options = {}) {
  const candidates = []
  const configured = typeof options.configured === 'string' ? options.configured.trim() : ''
  if (configured !== '') candidates.push({ bin: configured, source: 'config' })
  const fromEnv = typeof options.env === 'string' ? options.env.trim() : ''
  if (fromEnv !== '') candidates.push({ bin: fromEnv, source: 'env' })
  const appPath = options.appPath ?? '/Applications/DSH Desktop.app/Contents/Resources/app'
  candidates.push({
    bin: path.join(appPath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    source: 'desktop-app',
  })
  candidates.push({ bin: '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', source: 'npm-global' })
  candidates.push({ bin: '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', source: 'npm-global' })

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate.bin)) return candidate
    } catch {
      /* 继续找下一个 */
    }
  }
  return null
}

/**
 * 找真正能跑 Harness 的 runtime。
 *
 * ⚠️ 关键坑：DSH Desktop 会把自己的 `node` shim（`ELECTRON_RUN_AS_NODE=1` + Electron Helper）
 * 放进 PATH。它是 Electron，会**拒绝** `NODE_OPTIONS` 环境变量；用它跑 Harness 必须把
 * `--expose-internals` 当**命令行参数**传（桌面应用自己就是这么做的）。所以这里优先找真 node，
 * shim 只作为最后的兜底。
 *
 * @param {object} [options]
 * @param {string} [options.configured]
 * @param {NodeJS.ProcessEnv} [options.env=process.env]
 * @returns {{ node: string, source: string, electron: boolean }}
 */
export function discoverRuntime(options = {}) {
  const env = options.env ?? process.env
  const configured = typeof options.configured === 'string' ? options.configured.trim() : ''
  const pick = (value, source) => ({ node: value, source, electron: /Helper|Electron/i.test(value) })
  if (configured !== '') return pick(configured, 'config')
  if (typeof env.DSH_TENANT_NODE === 'string' && env.DSH_TENANT_NODE.trim() !== '') {
    return pick(env.DSH_TENANT_NODE.trim(), 'env')
  }
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    try {
      if (fs.existsSync(candidate)) return pick(candidate, 'path')
    } catch {
      /* 继续 */
    }
  }
  // 兜底：本进程自己（若宿主是 Electron，则要用命令行参数传 --expose-internals）
  const self = process.execPath
  const shim = path.join(env.HOME ?? os.homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness', '.desktop-bin', 'node')
  if (/Helper|Electron/i.test(self)) return pick(self, 'self')
  try {
    if (fs.existsSync(shim)) return pick(shim, 'desktop-shim')
  } catch {
    /* 忽略 */
  }
  return pick(self, 'self')
}

/**
 * 组装启动参数（纯函数，便于测试）。
 * @param {object} options
 * @param {string} options.bin dsh 入口
 * @param {string} options.profile profile 名（= 租户 id）
 * @param {number} options.port 0 = 让系统分配
 * @param {boolean} options.initialize 是否加 `--from-default-profile web`
 * @param {boolean} [options.electron] runtime 是不是 Electron Helper
 * @param {string[]} [options.extraArgs]
 */
export function buildInstanceArgv(options) {
  const argv = []
  // Electron Helper 必须拿到这个参数（NODE_OPTIONS 会被它拒绝）；真 node 给上也无害
  if (options.electron !== false) argv.push('--expose-internals')
  argv.push(options.bin)
  argv.push('--profile', options.profile)
  if (options.initialize) argv.push('--from-default-profile', 'web')
  argv.push('--no-open', '--host', '127.0.0.1', '--port', String(options.port))
  for (const extra of options.extraArgs ?? []) argv.push(extra)
  return argv
}

/** 从一行 stdout 里取就绪地址与令牌。 */
export function parseReadyLine(text) {
  const match = READY_PATTERN.exec(String(text ?? ''))
  if (match === null) return null
  let port = 0
  try {
    port = Number(new URL(match[1]).port)
  } catch {
    port = 0
  }
  return { url: match[1], token: match[2], port: Number.isSafeInteger(port) ? port : 0 }
}

/**
 * 一个租户实例。
 *
 * @param {object} options
 * @param {object} options.tenant 归一化后的租户定义
 * @param {{ bin: string, node: string, electron?: boolean, extraArgs?: string[] }} options.harness
 * @param {number} [options.restartBaseMs=1000] 退避基数
 * @param {number} [options.maxRestarts=5] 连续崩溃上限，超过则停手（等人处理）
 * @param {(state: object) => void} [options.onState]
 * @param {(line: string) => void} [options.log]
 * @param {string} [options.logFile] 实例输出日志（默认 `<home>/instance.log`）。
 *        写它的原因：租户起不来时运维需要一个能看的地方，e2e 也要能从里面取启动令牌。
 * @param {typeof spawn} [options.spawnImpl] 测试用
 */
export function createInstance(options) {
  const tenant = options.tenant
  const harness = options.harness
  const spawnImpl = options.spawnImpl ?? spawn
  const log = options.log ?? (() => {})
  const onState = options.onState ?? (() => {})
  const restartBaseMs = options.restartBaseMs ?? 1000
  const maxRestarts = options.maxRestarts ?? 5
  const logFile = options.logFile ?? path.join(tenant.home, 'instance.log')
  const logLimitBytes = options.logLimitBytes ?? 5 * 1024 * 1024

  let child = null
  let token = ''
  let port = tenant.port
  let stopped = false
  let restarts = 0
  let restartTimer = null
  let state = { id: tenant.id, phase: 'idle', code: 'tenant.idle', params: {}, detail: tEn('tenant.idle'), port, hasToken: false, restarts: 0, pid: null }

  function setState(patch) {
    const next = { ...state, ...patch }
    if (patch.code !== undefined && patch.detail === undefined) next.detail = tEn(patch.code, patch.params)
    state = next
    onState(state)
  }

  function profileExists() {
    try {
      return fs.existsSync(path.join(tenant.home, 'profiles', tenant.profile))
    } catch {
      return false
    }
  }

  /** 追加一行到实例日志；超过上限就滚动一次，避免无限长大。 */
  function appendLog(text) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 })
      try {
        if (fs.statSync(logFile).size > logLimitBytes) fs.renameSync(logFile, logFile + '.1')
      } catch {
        /* 不存在就无所谓 */
      }
      fs.appendFileSync(logFile, text, { mode: 0o600 })
    } catch {
      /* 日志写不进去不影响实例本身 */
    }
  }

  function launch() {
    if (stopped) return
    fs.mkdirSync(tenant.home, { recursive: true, mode: 0o700 })
    const initialize = !profileExists()
    const argv = buildInstanceArgv({
      bin: harness.bin,
      profile: tenant.profile,
      port: tenant.port,
      initialize,
      electron: harness.electron !== false,
      extraArgs: harness.extraArgs,
    })
    setState({
      phase: 'starting',
      code: 'tenant.starting',
      params: { id: tenant.id, port: String(tenant.port) },
      pid: null,
      hasToken: false,
    })
    appendLog('# launch ' + new Date().toISOString() + ' ' + JSON.stringify(argv) + '\n')
    let spawned
    try {
      spawned = spawnImpl(harness.node, argv, {
        cwd: tenant.home,
        env: { ...process.env, DSH_HOME: tenant.home, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      scheduleRestart(tEn('tenant.spawnFailed', { message: String(error?.message ?? error) }))
      return
    }
    child = spawned
    setState({ pid: spawned.pid ?? null })
    let stderr = ''
    const onText = (text, fromStderr) => {
      const ready = parseReadyLine(text)
      if (ready === null) return
      token = ready.token
      if (ready.port > 0) port = ready.port
      setState({
        phase: 'up',
        code: 'tenant.up',
        params: { id: tenant.id, port: String(port) },
        port,
        hasToken: true,
        pid: spawned.pid ?? null,
      })
      log(tEn('tenant.ready', { id: tenant.id, url: 'http://127.0.0.1:' + String(port) + '/' }))
      void fromStderr
    }
    spawned.stdout.on('data', (chunk) => {
      appendLog(chunk.toString('utf8'))
      onText(chunk.toString('utf8'), false)
    })
    spawned.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      appendLog(text)
      stderr = (stderr + text).slice(-4000)
      onText(text, true)
    })
    spawned.on('error', (error) => {
      scheduleRestart(tEn('tenant.spawnFailed', { message: String(error?.message ?? error) }))
    })
    spawned.on('exit', (code, signal) => {
      if (child !== spawned) return
      child = null
      token = ''
      if (stopped) {
        setState({ phase: 'stopped', code: 'tenant.stopped', params: { id: tenant.id }, hasToken: false, pid: null })
        return
      }
      const tail = stderr.trim().split('\n').slice(-2).join(' | ')
      scheduleRestart(
        'exit ' + (signal ?? String(code)) + (tail ? ': ' + tail : ''),
      )
    })
  }

  function scheduleRestart(reason) {
    if (stopped) return
    restarts += 1
    if (restarts > maxRestarts) {
      setState({
        phase: 'error',
        code: 'tenant.crashed',
        params: { id: tenant.id, reason },
        hasToken: false,
        restarts,
      })
      return
    }
    const delay = Math.min(restartBaseMs * 2 ** (restarts - 1), 30000)
    setState({
      phase: 'restarting',
      code: 'tenant.restarting',
      params: { id: tenant.id, reason, seconds: String(Math.round(delay / 1000)) },
      hasToken: false,
      restarts,
    })
    restartTimer = setTimeout(() => {
      restartTimer = null
      launch()
    }, delay)
  }

  return {
    tenantId: tenant.id,
    /** 启动（首次会初始化该租户的 profile）。 */
    start() {
      stopped = false
      restarts = 0
      launch()
      return state
    },
    /** 停止并等子进程退出。 */
    async stop() {
      stopped = true
      if (restartTimer !== null) {
        clearTimeout(restartTimer)
        restartTimer = null
      }
      const current = child
      child = null
      token = ''
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
          }, 4000)
          current.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
      setState({ phase: 'stopped', code: 'tenant.stopped', params: { id: tenant.id }, hasToken: false, pid: null })
      return state
    },
    /** 该租户当前的启动令牌（没起来时为空串）。 */
    token() {
      return token
    },
    /** 上游端口（`port: 0` 时以子进程实际打印的为准）。 */
    upstreamPort() {
      return port
    },
    state() {
      return state
    },
  }
}
