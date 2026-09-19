/**
 * 服务器侧安装器生成：把《任务书》里"6 项交付"折叠成**一个可审查、幂等、可卸载的脚本**。
 *
 * 为什么是"生成脚本"而不是"插件去改用户的服务器"：
 *  * 用户的服务器是他的生产机，插件不该直接动它；
 *  * 脚本可以 `--dry-run` 先看、可以 `probe` 只探测、可以 `uninstall` 撤销；
 *  * 所有写入都落在"本脚本独占的文件"里（conf.d 一个文件 + sshd drop-in + deploy hook），
 *    因此幂等 = 覆盖写，卸载 = 删文件。
 *
 * 生成前对所有插入 bash 的取值做**严格校验**：域名/用户名/路径都会被拼进脚本，
 * 不校验就等于把命令行参数当代码执行。
 *
 * @module dsh-plugin-remote-connect/core/serversetup
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPLATE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'assets',
  'server-setup.sh.tpl',
)

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i
const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/
const PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/

/**
 * 校验并归一化生成参数。
 * @param {object} options
 * @returns {{ values: Record<string,string>, problems: string[] }}
 */
export function resolveServerSetupValues(options) {
  const problems = []
  const domain = String(options.domain ?? '')
  if (!HOSTNAME_PATTERN.test(domain)) problems.push('domain 必须是合法主机名（例如 dsh.example.com）')

  const tunnelUser = String(options.tunnelUser ?? 'dshtunnel')
  if (!USERNAME_PATTERN.test(tunnelUser)) problems.push('tunnel-user 必须是合法 Linux 用户名')

  const authUser = String(options.authUser ?? 'dsh')
  if (!USERNAME_PATTERN.test(authUser)) problems.push('auth-user 必须是合法 Linux 用户名')

  const remotePort = Number(options.remotePort ?? 8788)
  if (!Number.isSafeInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    problems.push('remote-port 必须是 1–65535 的整数')
  }

  const paths = {
    AUTH_FILE: String(options.authFile ?? '/etc/nginx/.htpasswd-dsh-remote'),
    WEBROOT: String(options.webroot ?? '/var/www/html'),
    NGINX_CONF: String(options.nginxConf ?? '/etc/nginx/conf.d/dsh-remote.conf'),
    SSHD_DROPIN: String(options.sshdDropin ?? '/etc/ssh/sshd_config.d/60-dsh-remote.conf'),
    DEPLOY_HOOK: String(options.deployHook ?? '/etc/letsencrypt/renewal-hooks/deploy/10-reload-web.sh'),
  }
  for (const [key, value] of Object.entries(paths)) {
    if (!PATH_PATTERN.test(value)) problems.push(key + ' 必须是绝对路径且不含引号/空格/变量')
  }

  return {
    problems,
    values: {
      DOMAIN: domain,
      REMOTE_PORT: String(remotePort),
      TUNNEL_USER: tunnelUser,
      AUTH_USER: authUser,
      ...paths,
    },
  }
}

/**
 * 生成服务器安装脚本全文。
 * @param {object} options 见 resolveServerSetupValues
 * @returns {string}
 * @throws {Error} 参数不合法时抛出（生成物会被执行，宁可不生成）
 */
export function buildServerSetupScript(options) {
  const { values, problems } = resolveServerSetupValues(options)
  if (problems.length > 0) {
    throw new Error('服务器安装脚本参数不合法：' + problems.join('；'))
  }
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8')
  let out = template
  for (const [key, value] of Object.entries(values)) {
    out = out.split('{{' + key + '}}').join(value)
  }
  const leftover = /\{\{[A-Z_]+\}\}/.exec(out)
  if (leftover !== null) throw new Error('服务器安装脚本模板占位符未替换：' + leftover[0])
  if (!out.endsWith('\n')) out += '\n'
  return out
}

/**
 * 生成**独立**的卸载脚本（不依赖安装脚本还在不在服务器上）。
 * @param {object} options 见 resolveServerSetupValues
 * @returns {string}
 */
export function buildServerUninstallScript(options) {
  const { values, problems } = resolveServerSetupValues(options)
  if (problems.length > 0) {
    throw new Error('卸载脚本参数不合法：' + problems.join('；'))
  }
  return [
    '#!/usr/bin/env bash',
    '# dsh-remote 服务器侧卸载（由 dsh-plugin-remote-connect 生成）',
    '#   sudo bash server-uninstall.sh [--purge-user]',
    '# 只删除本方案自己创建的文件；不动你的 nginx/sshd 主配置、不动 DNS、不动 Basic Auth 口令文件。',
    'set -euo pipefail',
    '',
    'TUNNEL_USER="' + values.TUNNEL_USER + '"',
    'NGINX_CONF="' + values.NGINX_CONF + '"',
    'SSHD_DROPIN="' + values.SSHD_DROPIN + '"',
    'DEPLOY_HOOK="' + values.DEPLOY_HOOK + '"',
    'PURGE=0',
    '[ "${1:-}" = "--purge-user" ] && PURGE=1',
    '',
    '[ "$(id -u)" = "0" ] || { echo "✖ 需要 root"; exit 1; }',
    'for f in "$NGINX_CONF" "$SSHD_DROPIN" "$DEPLOY_HOOK"; do',
    '  if [ -f "$f" ]; then rm -f "$f"; echo "已删除 $f"; else echo "不存在，跳过 $f"; fi',
    'done',
    'if command -v nginx >/dev/null 2>&1; then nginx -t && systemctl reload nginx || true; fi',
    'if command -v sshd >/dev/null 2>&1; then sshd -t && systemctl reload ssh || true; fi',
    'if [ "$PURGE" = "1" ]; then',
    '  if id "$TUNNEL_USER" >/dev/null 2>&1; then userdel -r "$TUNNEL_USER"; echo "已删除账号 $TUNNEL_USER"; fi',
    'else',
    '  echo "保留隧道账号 $TUNNEL_USER（加 --purge-user 可一并删除）"',
    'fi',
    'echo "完成。DNS 记录与 Basic Auth 口令文件未动（可能被其它服务共用）。"',
    '',
  ].join('\n')
}
