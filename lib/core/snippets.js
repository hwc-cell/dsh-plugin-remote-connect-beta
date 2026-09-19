/**
 * 服务器侧配置片段生成：用户拿到就能贴。
 * 目标是把公网域名 → 服务器回环端口（ssh -R 的远端口）→ 本机代理 串起来，
 * 并保证流式（SSE）与 WebSocket 可用。
 *
 * @module dsh-plugin-remote-connect/core/snippets
 */

/** nginx 需要的 upgrade 映射（放 http 上下文）。 */
export const NGINX_LOG_FORMAT = [
  '# ?k= 是敏感凭据：请求行里的密钥绝不能落盘',
  'log_format dsh_nokey \'$remote_addr - $remote_user [$time_local] "$request_method $uri" $status\';',
].join('\n')

export const NGINX_UPGRADE_MAP = [
  'map $http_upgrade $connection_upgrade {',
  '    default upgrade;',
  "    ''      close;",
  '}',
].join('\n')

/**
 * 生成 nginx server block。
 * @param {object} options
 * @param {string} options.domain 公网域名，例如 dsh.example.com
 * @param {number} [options.targetPort=8788] 服务器回环端口（与 ssh -R 的远端口一致）
 * @param {string} [options.certPath] fullchain.pem 路径
 * @param {string} [options.keyPath] privkey.pem 路径
 * @param {string} [options.htpasswdPath='/etc/nginx/.htpasswd-dsh']
 * @param {string} [options.authRealm='DSH']
 * @param {number} [options.maxBodyMb=64] 放宽上传（Harness 会传图/附件）
 * @param {boolean} [options.logRedaction=true] 用脱敏 format 单独记日志（避免 ?k= 落盘）
 */
export function nginxServerBlock(options) {
  const domain = options.domain
  const port = options.targetPort ?? 8788
  const certPath = options.certPath ?? '/etc/letsencrypt/live/' + domain + '/fullchain.pem'
  const keyPath = options.keyPath ?? '/etc/letsencrypt/live/' + domain + '/privkey.pem'
  const htpasswdPath = options.htpasswdPath ?? '/etc/nginx/.htpasswd-dsh'
  const realm = options.authRealm ?? 'DSH'
  const maxBodyMb = options.maxBodyMb ?? 64
  const logRedaction = options.logRedaction !== false
  return [
    '# ' + domain + ' —— DSH Harness 公网入口',
    '# 1) upgrade map 与 log_format 放 http {} 上下文（conf.d/dsh-http.conf）',
    '# 2) 刻意不提供 80 端口 server block：http→https 与 ACME challenge 由现有默认 server 承担；',
    '#    另加精确 server_name 的 80 块会顶掉 /.well-known/acme-challenge/，导致签发/续期失败',
    '',
    'server {',
    '    listen 443 ssl;',
    '    listen [::]:443 ssl;',
    '    http2 on;',
    '    server_name ' + domain + ';',
    '',
    '    ssl_certificate     ' + certPath + ';',
    '    ssl_certificate_key ' + keyPath + ';',
    '',
    '    # 第一道门：边缘口令',
    '    auth_basic           "' + realm + '";',
    '    auth_basic_user_file ' + htpasswdPath + ';',
    '',
    '    client_max_body_size ' + String(maxBodyMb) + 'm;',
    '',
    logRedaction ? '    # ?k= 是敏感凭据，禁止完整请求行落盘（access_log off 亦可）' : '    # 未启用脱敏时，?k= 会明文进入访问日志',
    logRedaction ? '    access_log /var/log/nginx/dsh.access.log dsh_nokey;' : '    access_log /var/log/nginx/dsh.access.log;',
    '',
    '    location / {',
    '        proxy_pass http://127.0.0.1:' + String(port) + ';',
    '        proxy_http_version 1.1;',
    '',
    '        proxy_set_header Host              $host;',
    '        proxy_set_header X-Real-IP         $remote_addr;',
    '        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '        proxy_set_header Upgrade           $http_upgrade;',
    '        proxy_set_header Connection        $connection_upgrade;',
    '',
    '        # ★ 关缓冲 + 放长超时：不关的话 Harness 的流式输出会卡死',
    '        proxy_buffering         off;',
    '        proxy_request_buffering off;',
    '        proxy_read_timeout      3600s;',
    '        proxy_send_timeout      3600s;',
    '        proxy_connect_timeout   15s;',
    '',
    '        proxy_redirect off;',
    '    }',
    '}',
    '',
    '# 注意：这里刻意不提供 80 端口 server block —— 见文件头第 2 条。',
  ].join('\n')
}

/**
 * 生成 Caddy 配置片段（Caddy 自带证书与流式处理）。
 * @param {object} options
 * @param {string} options.domain
 * @param {number} [options.targetPort=8788]
 * @param {string} [options.basicAuthUser='dsh']
 * @param {string} [options.basicAuthHash] caddy hash-password 的输出
 * @param {number} [options.maxBodyMb=64]
 */
export function caddySite(options) {
  const port = options.targetPort ?? 8788
  const user = options.basicAuthUser ?? 'dsh'
  const hash = options.basicAuthHash ?? '$2a$14$REPLACE_WITH_caddy_hash_password_OUTPUT'
  const maxBodyMb = options.maxBodyMb ?? 64
  return [
    options.domain + ' {',
    '    basic_auth {',
    '        ' + user + ' ' + hash,
    '    }',
    '    reverse_proxy 127.0.0.1:' + String(port) + ' {',
    '        flush_interval -1          # ★ 不缓冲，等价于 nginx 的 proxy_buffering off',
    '    }',
    '    request_body {',
    '        max_size ' + String(maxBodyMb) + 'MB',
    '    }',
    '}',
  ].join('\n')
}

/**
 * authorized_keys 限制行：这把钥匙只能做转发，且只能监听指定回环端口。
 * @param {string} publicKey 形如 "ssh-ed25519 AAAA... comment"
 * @param {number} [targetPort=8788]
 */
export function authorizedKeysLine(publicKey, targetPort = 8788) {
  const clean = publicKey.trim().replace(/\s+/g, ' ')
  return 'restrict,port-forwarding,permitlisten="127.0.0.1:' + String(targetPort) + '" ' + clean
}

/**
 * Mac/客户端侧要跑的 ssh 反向隧道命令。
 * @param {object} options
 * @param {string} options.user 服务器上的专用账号
 * @param {string} options.host 服务器地址（域名或 IP）
 * @param {string} [options.keyPath] 私钥路径
 * @param {number} [options.localPort=8788] 本机监听端口（代理的公网口）
 * @param {number} [options.remotePort=8788] 服务器回环端口（与反代目标一致）
 * @param {number} [options.port=22] 服务器 sshd 端口（非 22 时必须显式给出）
 */
export function sshTunnelCommand(options) {
  const localPort = options.localPort ?? 8788
  const remotePort = options.remotePort ?? 8788
  const port = options.port ?? 22
  const parts = [
    'ssh -N -T',
    ...(port === 22 ? [] : ['  -p ' + String(port)]),
    '  -o ExitOnForwardFailure=yes',
    '  -o ServerAliveInterval=30 -o ServerAliveCountMax=3',
    '  -o StrictHostKeyChecking=yes',
  ]
  if (options.keyPath) parts.push('  -i ' + options.keyPath)
  parts.push(
    '  -R 127.0.0.1:' + String(remotePort) + ':127.0.0.1:' + String(localPort),
    '  ' + options.user + '@' + options.host,
  )
  return parts.join(' \\\n')
}

/** 服务器一次性准备步骤（给用户照抄）。 */
export function serverSetupSteps(options) {
  const targetPort = options.targetPort ?? 8788
  const user = options.user ?? 'dshtunnel'
  return [
    '在服务器上执行（Debian/Ubuntu 为例）：',
    '',
    '  # 1) 专用账号（不复用 root 或日常账号；隧道只用 -N -T，不需要登录 shell）',
    '  sudo useradd -m -s /usr/sbin/nologin ' + user,
    '  sudo -u ' + user + ' mkdir -p /home/' + user + '/.ssh',
    '  sudo -u ' + user + ' chmod 700 /home/' + user + '/.ssh',
    '',
    '  # 2) 把下面这行 authorized_keys 限制写入（公钥用 dsh-remote keygen 生成）',
    '  #    见 `dsh-remote keygen` 的输出',
    '',
    '  # 3) 确认 sshd 允许转发（被加固过的机器常被关掉）',
    '  sudo sshd -T | grep -Ei "allowtcpforwarding|gatewayports"',
    '  #    需要 allowtcpforwarding=yes（或 local,remote）；gatewayports 保持 no 即可',
    '  #    建议同时设 ClientAliveInterval 30（长连接隧道更稳）',
    '',
    '  # 4) Basic Auth 口令文件',
    '  sudo apt install -y apache2-utils',
    '  sudo htpasswd -c /etc/nginx/.htpasswd-dsh dsh',
    '',
    '  # 5) 贴上 nginx 片段，然后',
    '  sudo nginx -t && sudo systemctl reload nginx',
    '',
    '目标：服务器回环 ' + String(targetPort) + ' 端口 ← 由 Mac 的 ssh -R 提供，',
    '      再由 nginx/Caddy 用 HTTPS + Basic Auth 暴露成公网域名。',
  ].join('\n')
}
