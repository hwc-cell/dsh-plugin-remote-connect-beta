/**
 * 服务器侧配置片段生成：用户拿到就能贴。
 * 目标是把公网域名 → 服务器回环端口（ssh -R 的远端口）→ 本机代理 串起来，
 * 并保证流式（SSE）与 WebSocket 可用。
 *
 * @module dsh-plugin-remote-connect-beta/core/snippets
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
 * @param {string} [options.authRealm='DSH'] 边缘门的 realm（仅在 edgeAuth 时用到）
 * @param {boolean} [options.edgeAuth=false] 是否生成边缘口令门（auth_basic）。
 *   默认 **false**：本插件的身份是「每人一条唯一 ?k= 链接」，而边缘口令是一条**共用**口令，
 *   没法按人吊销，在手机上还要多打一长串。只在「同机还跑着别的东西、想让边缘统一兜底」时才开。
 *   生成物里会留两行注释掉的 auth_basic，取消注释即可启用。
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
  const edgeAuth = options.edgeAuth === true
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
    '    client_max_body_size ' + String(maxBodyMb) + 'm;',
    '',
    ...(edgeAuth
      ? [
          '    # 可选边缘门：与插件无关的独立一层（共用口令，无法按人吊销）',
          '    auth_basic           "' + realm + '";',
          '    auth_basic_user_file ' + htpasswdPath + ';',
          '',
        ]
      : [
          '    # 边缘口令默认不开：插件的身份是「每人一条唯一 ?k= 链接」，',
          '    # 再叠一条共用口令只会让手机上的使用者多打一长串，也没法按人吊销。',
          '    # 想让边缘统一兜底（例如同机还跑着别的服务）时，取消下面两行注释再 reload：',
          '    # auth_basic           "' + realm + '";',
          '    # auth_basic_user_file ' + htpasswdPath + ';',
          '',
        ]),
    logRedaction ? '    # ?k= 是敏感凭据，禁止完整请求行落盘（access_log off 亦可）' : '    # 未启用脱敏时，?k= 会明文进入访问日志',
    logRedaction ? '    access_log /var/log/nginx/dsh.access.log dsh_nokey;' : '    access_log /var/log/nginx/dsh.access.log;',
    '',
    '    # 光脱敏 access_log 还不够：nginx 的 error_log 在 502（隧道没连上，最常见）/413',
    '    # （上传超限）/客户端中断时会打印【完整请求行】，里面就带 query string 的 ?k=。',
    '    # 提到 crit 后这类 [error] 日志不再写（只留 worker 崩溃级事件），',
    '    # 排障照旧看上面的 access_log —— 状态码仍然记着。',
    '    error_log /var/log/nginx/dsh.error.log crit;',
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
 * @param {boolean} [options.edgeAuth=false] 同 nginxServerBlock：默认不生成边缘口令门
 * @param {number} [options.maxBodyMb=64]
 */
export function caddySite(options) {
  const port = options.targetPort ?? 8788
  const user = options.basicAuthUser ?? 'dsh'
  const hash = options.basicAuthHash ?? '$2a$14$REPLACE_WITH_caddy_hash_password_OUTPUT'
  const edgeAuth = options.edgeAuth === true
  const maxBodyMb = options.maxBodyMb ?? 64
  return [
    options.domain + ' {',
    ...(edgeAuth
      ? [
          '    # 可选边缘门：与插件无关的独立一层（共用口令，无法按人吊销）',
          '    basic_auth {',
          '        ' + user + ' ' + hash,
          '    }',
        ]
      : [
          '    # 边缘口令默认不开（插件的身份是「每人一条唯一 ?k= 链接」）。',
          '    # 需要边缘统一兜底时取消下面注释，并填 caddy hash-password 的输出：',
          '    # basic_auth {',
          '    #     ' + user + ' ' + hash,
          '    # }',
        ]),
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
 *
 * ⚠️ 为什么是 `port-forwarding`，而不是看起来更贴切的 `remote-port-forwarding`：
 *   OpenSSH **没有** 后者这个选项（`man 5 authorized_keys` 的选项表里只有 `port-forwarding`
 *   与 `no-port-forwarding`）。写一个不存在的选项不是"被忽略"，而是**整行作废**：
 *   sshd 日志 `bad key options: unknown key option`，客户端拿到 `Permission denied (publickey)`，
 *   隧道根本拨不通（2026-09-25 用 OpenSSH 9.6 在本地起临时 sshd 双 case 实测确认）。
 *   而用户排障时最省事的动作就是把整串选项删掉——那会得到一把**裸公钥**（可登录 + 任意转发），
 *   比原来危险得多。所以这一行必须用能生效的选项。
 *
 * 于是「只放 -R」只能这样组合：`restrict`（先关掉一切：shell/pty/agent/x11/转发）
 *   + `port-forwarding`（把转发重新打开）+ `permitlisten`（远端只许绑这一个回环口）。
 *   注意 `-L`（本地转发）在 authorized_keys 里**无法单独禁止**，它由服务器侧
 *   `AllowTcpForwarding` 决定；要连 -L 一起收掉，就把 `Match User <账号>` +
 *   `AllowTcpForwarding remote` 追加到 /etc/ssh/sshd_config **末尾**（不能放 sshd_config.d：
 *   Ubuntu 把 Include 放在该文件顶部，Match 会一直作用到文件末尾、吞掉后面的全局指令）。
 *
 * @param {string} publicKey 形如 "ssh-ed25519 AAAA... comment"
 * @param {number} [targetPort=8788]
 */
export function authorizedKeysLine(publicKey, targetPort = 8788) {
  const clean = publicKey.trim().replace(/\s+/g, ' ')
  return 'restrict,port-forwarding,permitlisten="127.0.0.1:' + String(targetPort) + '" ' + clean
}

/**
 * 客户端侧（跑 Harness 的那台机器）要跑的 ssh 反向隧道命令。
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
    '  #    见 dsh-remote keygen 的输出',
    '',
    '  # 3) 确认 sshd 允许转发（被加固过的机器常被关掉）',
    '  sudo sshd -T | grep -Ei "allowtcpforwarding|gatewayports"',
    '  #    需要 allowtcpforwarding=yes（或 local,remote）；gatewayports 保持 no 即可',
    '  #    建议同时设 ClientAliveInterval 30（长连接隧道更稳）',
    '  #    想连本地转发 -L 也一起收掉（授权行做不到，只能靠 sshd）：',
    '  #      把下面两行追加到 /etc/ssh/sshd_config 的【末尾】，再 sudo systemctl reload ssh',
    '  #        Match User ' + user,
    '  #            AllowTcpForwarding remote',
    '  #      必须放末尾：Match 会作用到其后所有行；放进 sshd_config.d/ 会吞掉后面的全局指令。',
    '',
    '  # 4) （可选）边缘口令 —— 只有你想再叠一道与插件无关的门时才需要',
    '  #    sudo apt install -y apache2-utils',
    '  #    sudo htpasswd -c /etc/nginx/.htpasswd-dsh dsh',
    '',
    '  # 5) 贴上 nginx 片段，然后',
    '  sudo nginx -t && sudo systemctl reload nginx',
    '',
    '⚠️ 信任边界：TLS 在服务器上终止，这台服务器上拿到 root 的人（含服务商）能看到 ?k= 与登录 Cookie。',
    '   所以服务器必须是「你自己、且你信得过」的那台 —— 加多少道门都替代不了这一条。',
    '',
    '目标：服务器回环 ' + String(targetPort) + ' 端口 ← 由本机（跑 Harness 的那台）的 ssh -R 提供，',
    '      再由 nginx/Caddy 用 HTTPS 暴露成公网域名；边缘口令可选。',
  ].join('\n')
}
