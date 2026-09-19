/**
 * 插件自己的路径约定（host 半与 CLI 共用，避免两边算出不同的位置）。
 *
 * @module dsh-plugin-remote-connect-beta/core/paths
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 插件状态目录（0600 语义）：租户注册表、Cookie 签名密钥都落在这里。
 * 默认跟 harness home 走（`$DSH_HOME/remote-connect`），没有 DSH_HOME 时退回 `~/.dsh`。
 */
export function pluginStateDir(env = process.env) {
  const home =
    typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : path.join(os.homedir(), '.dsh')
  return path.join(home, 'remote-connect')
}

/** 默认的租户注册表位置。 */
export function defaultRegistryPath(env = process.env) {
  return path.join(pluginStateDir(env), 'tenants.json')
}

/** Cookie 签名密钥的默认位置。 */
export function defaultGateSecretPath(env = process.env) {
  return path.join(pluginStateDir(env), 'gate.secret')
}

/**
 * Cookie 签名密钥：读不到就生成一个并落盘（0600）。
 *
 * 为什么要独立于任何租户的 accessKey：多租户下轮换某个租户的密钥，
 * 不能顺带把别人的登录态弄失效。为什么必须落盘：否则每次重启全员重新登录。
 *
 * @param {string} file
 * @param {(line: string) => void} [onProblem] 落盘失败时的回调（不抛异常）
 * @returns {{ secret: string, created: boolean, persisted: boolean }}
 */
export function loadOrCreateGateSecret(file, onProblem) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing.length >= 32) return { secret: existing, created: false, persisted: true }
  } catch {
    /* 首次运行：下面生成 */
  }
  const secret = crypto.randomBytes(32).toString('base64url')
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, secret + '\n', { mode: 0o600 })
    return { secret, created: true, persisted: true }
  } catch (error) {
    if (typeof onProblem === 'function') {
      onProblem('Cookie 签名密钥落盘失败（重启后所有会话要重新登录）：' + String(error?.message ?? error))
    }
    return { secret, created: true, persisted: false }
  }
}
