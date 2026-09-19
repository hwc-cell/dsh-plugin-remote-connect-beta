#!/usr/bin/env bash
# dsh-remote 服务器侧安装器（由 dsh-plugin-remote-connect 生成，勿手工编辑生成物）
#
#   sudo bash server-setup.sh probe                 # 只探测环境，不改任何东西
#   sudo bash server-setup.sh install --dry-run     # 打印将要执行的动作
#   sudo bash server-setup.sh install               # 幂等安装
#   sudo bash server-setup.sh install --skip-cert   # 已有证书时跳过签发
#   printf %s '<边缘口令>' | sudo bash server-setup.sh install --auth-password-stdin
#                                                # 非交互设置边缘口令（口令不进命令历史）
#   sudo bash server-setup.sh uninstall             # 撤销（默认保留隧道账号）
#   sudo bash server-setup.sh uninstall --purge-user
#
# 设计原则：
#   * 只写"自己拥有"的文件（conf.d 下的一个文件 + sshd 的 drop-in + 一个 deploy hook），
#     不去改用户既有的 nginx/sshd 主配置 —— 这样卸载 = 删文件，幂等 = 覆盖写。
#   * 不新增 80 端口 server block：ACME challenge 与 http→https 交给既有默认 server。
#   * 访问日志默认脱敏：?k= 是敏感凭据，禁止完整请求行落盘。
set -euo pipefail

DOMAIN="{{DOMAIN}}"
REMOTE_PORT="{{REMOTE_PORT}}"
TUNNEL_USER="{{TUNNEL_USER}}"
AUTH_USER="{{AUTH_USER}}"
AUTH_FILE="{{AUTH_FILE}}"
WEBROOT="{{WEBROOT}}"
NGINX_CONF="{{NGINX_CONF}}"
SSHD_DROPIN="{{SSHD_DROPIN}}"
DEPLOY_HOOK="{{DEPLOY_HOOK}}"
LOG_FILE="/var/log/nginx/dsh-remote.access.log"

DRY_RUN=0
SKIP_CERT=0
SKIP_DNS=0
PURGE_USER=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-cert) SKIP_CERT=1 ;;
    --skip-dns) SKIP_DNS=1 ;;
    --purge-user) PURGE_USER=1 ;;
    --auth-password-stdin) AUTH_PASSWORD_STDIN=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done
COMMAND="${ARGS[0]:-probe}"

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry-run] %s\n' "$*"
    return 0
  fi
  printf '   + %s\n' "$*"
  "$@"
}
need_root() {
  if [ "$(id -u)" != "0" ] && [ "$DRY_RUN" != "1" ]; then
    say "✖ 需要 root（或用 --dry-run 只看计划）"; exit 1
  fi
}
have() { command -v "$1" >/dev/null 2>&1; }

# ─────────────────────────────── probe ───────────────────────────────
probe() {
  step "系统"
  if [ -r /etc/os-release ]; then . /etc/os-release; say "发行版：${PRETTY_NAME:-unknown}"; else say "发行版：未知（无 /etc/os-release）"; fi
  say "内核：$(uname -sr)　CPU：$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo '?') 核"
  if have free; then say "内存：$(free -m | awk '/^Mem:/{print $2" MB"}')"; fi
  say "root：$([ "$(id -u)" = "0" ] && echo 是 || echo 否)"

  step "反向代理"
  if have nginx; then say "nginx：$(nginx -v 2>&1)"; else say "nginx：未安装"; fi
  if have caddy; then say "caddy：$(caddy version 2>/dev/null | head -1)"; else say "caddy：未安装"; fi

  step "证书"
  if have certbot; then say "certbot：$(certbot --version 2>&1)"; else say "certbot：未安装"; fi
  if [ -d /etc/letsencrypt/renewal-hooks/deploy ]; then
    count=$(find /etc/letsencrypt/renewal-hooks/deploy -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')
    say "renewal-hooks/deploy：${count} 个文件$([ "$count" = "0" ] && echo '  ⚠ 空 → 续签后不会 reload，线上会继续发旧证书')"
  else
    say "renewal-hooks/deploy：目录不存在"
  fi

  step "sshd"
  if have sshd; then
    sshd -T 2>/dev/null | grep -Ei '^(port|allowtcpforwarding|gatewayports|clientaliveinterval|passwordauthentication)' | sed 's/^/   /' || true
  else
    say "sshd：未找到（可能用其它 SSH 实现）"
  fi

  step "其它"
  say "htpasswd：$(have htpasswd && echo 有 || echo '无（需 apache2-utils）')"
  say "python3：$(have python3 && echo 有 || echo 无)"
  say "node：$(have node && echo 有 || echo '无（本方案不需要)')"
  if have ufw; then say "ufw：$(ufw status 2>/dev/null | head -1)"; fi
  say "80/443 监听：$( (ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null) | grep -cE ':(80|443)\s' || true) 条"
}

# ─────────────────────────────── install ───────────────────────────────
write_nginx_conf() {
  step "反向代理配置 → $NGINX_CONF"
  if [ -f "$NGINX_CONF" ]; then say "   已存在，将覆盖（本文件由本脚本独占）"; fi
  if [ "$DRY_RUN" = "1" ]; then
    say "   [dry-run] 写入 $NGINX_CONF（map + log_format + 443 server block，不含 80 块）"
  else
    mkdir -p "$(dirname "$NGINX_CONF")"
    cat > "$NGINX_CONF" <<NGINX
# managed by dsh-remote — 删除本文件即可完整撤销（勿手工编辑）
map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      close;
}

# ?k= 是敏感凭据：只记 $uri（不含 query），禁止完整请求行落盘
log_format dsh_remote_nokey '\$remote_addr - \$remote_user [\$time_local] "\$request_method \$uri" \$status';

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${DOMAIN};

    # 证书：若为通配符或其它 lineage，改这两行即可
    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;

    auth_basic           "DSH";
    auth_basic_user_file ${AUTH_FILE};

    client_max_body_size 64m;

    access_log ${LOG_FILE} dsh_remote_nokey;

    location / {
        proxy_pass http://127.0.0.1:${REMOTE_PORT};
        proxy_http_version 1.1;

        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        \$connection_upgrade;

        # 关缓冲 + 放长超时：不关的话 Harness 的流式输出会卡死
        proxy_buffering         off;
        proxy_request_buffering off;
        proxy_read_timeout      3600s;
        proxy_send_timeout      3600s;
        proxy_connect_timeout   15s;

        proxy_redirect off;
    }
}

# 刻意不提供 80 端口 server block：ACME challenge 与 http→https 由既有默认 server 承担。
# 另加精确 server_name 的 80 块会顶掉 /.well-known/acme-challenge/，导致签发/续期失败。
NGINX
  fi
  run nginx -t
  run systemctl reload nginx
}

ensure_auth_file() {
  step "边缘口令 → $AUTH_FILE"
  if [ -f "$AUTH_FILE" ]; then
    say "   已存在，保留现有口令（如需重置：sudo htpasswd $AUTH_FILE $AUTH_USER）"
    return 0
  fi
  # 非交互：口令从 stdin 传入（printf %s '<口令>' | sudo bash 本脚本 install --auth-password-stdin）
  if [ "$AUTH_PASSWORD_STDIN" = "1" ]; then
    if IFS= read -r AUTH_PASSWORD; then
      if [ -z "$AUTH_PASSWORD" ]; then say "   ✖ 从 stdin 读到的口令为空"; return 1; fi
      if have htpasswd; then
        run sh -c "printf '%s' \"\$1\" | htpasswd -i -c \"$AUTH_FILE\" \"$AUTH_USER\"" _ "$AUTH_PASSWORD"
      else
        hash="$(printf '%s' "$AUTH_PASSWORD" | openssl passwd -apr1 -stdin)"
        printf '%s:%s\n' "$AUTH_USER" "$hash" > "$AUTH_FILE"
      fi
      chmod 640 "$AUTH_FILE"
      if id www-data >/dev/null 2>&1; then chown root:www-data "$AUTH_FILE"; fi
      say "   已写入 $AUTH_FILE（口令来自 stdin，未写入脚本、未进命令历史）"
      unset AUTH_PASSWORD
      return 0
    fi
    say "   ✖ --auth-password-stdin 需要从管道传入口令"; return 1
  fi
  if ! have htpasswd; then
    say "   缺少 htpasswd：请先安装（Debian/Ubuntu: apt install -y apache2-utils；RHEL: dnf install -y httpd-tools）"
    say "   或手工生成：printf '%s:%s\n' '$AUTH_USER' \"\$(openssl passwd -apr1)\" | sudo tee $AUTH_FILE"
    return 1
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "   [dry-run] htpasswd -c $AUTH_FILE $AUTH_USER（交互式输入强口令）"
    return 0
  fi
  htpasswd -c "$AUTH_FILE" "$AUTH_USER"
  chmod 640 "$AUTH_FILE"
  if id www-data >/dev/null 2>&1; then chown root:www-data "$AUTH_FILE"; fi
  say "   已写入（口令不会出现在本脚本或日志里）"
}

ensure_tunnel_user() {
  step "隧道专用账号 → $TUNNEL_USER"
  if id "$TUNNEL_USER" >/dev/null 2>&1; then
    say "   账号已存在，跳过创建"
  else
    run useradd -m -s /usr/sbin/nologin "$TUNNEL_USER"
  fi
  home="$(getent passwd "$TUNNEL_USER" | cut -d: -f6)"; home="${home:-/home/$TUNNEL_USER}"
  run install -d -m 700 -o "$TUNNEL_USER" -g "$TUNNEL_USER" "$home/.ssh"
  if [ "$DRY_RUN" != "1" ] && [ ! -f "$home/.ssh/authorized_keys" ]; then
    install -m 600 -o "$TUNNEL_USER" -g "$TUNNEL_USER" /dev/null "$home/.ssh/authorized_keys"
  fi
  say "   下一步：把本机公钥写入 $home/.ssh/authorized_keys，行首带限制："
  say "     restrict,port-forwarding,permitlisten=\"127.0.0.1:${REMOTE_PORT}\" <你的公钥> dsh-mac-tunnel"
}

ensure_sshd_dropin() {
  step "sshd 转发与保活 → $SSHD_DROPIN"
  if [ -f "$SSHD_DROPIN" ]; then say "   已存在，覆盖写（本文件由本脚本独占）"; fi
  if [ "$DRY_RUN" = "1" ]; then
    say "   [dry-run] 写入 $SSHD_DROPIN（AllowTcpForwarding yes / ClientAliveInterval 30）"
  else
    mkdir -p "$(dirname "$SSHD_DROPIN")"
    cat > "$SSHD_DROPIN" <<SSHD
# managed by dsh-remote — 删除本文件即可完整撤销
AllowTcpForwarding yes
ClientAliveInterval 30
SSHD
  fi
  if have sshd; then
    run sshd -t
    run systemctl reload ssh
  else
    say "   未找到 sshd，跳过校验与 reload（请自行确认允许 TCP 转发）"
  fi
}

ensure_cert() {
  step "证书 → $DOMAIN"
  if [ "$SKIP_CERT" = "1" ]; then say "   --skip-cert：跳过"; return 0; fi
  if ! have certbot; then
    say "   未安装 certbot，跳过。手动签发后回来跑：bash $0 install --skip-cert"
    return 0
  fi
  if [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
    say "   已有证书文件，跳过签发（续期由 certbot.timer 负责）"
  else
    run certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --non-interactive --agree-tos --keep-until-expiring
  fi
  ensure_deploy_hook
}

ensure_deploy_hook() {
  step "续签后自动 reload → $DEPLOY_HOOK"
  if [ "$DRY_RUN" = "1" ]; then
    say "   [dry-run] 写入 $DEPLOY_HOOK（reload nginx）"
    return 0
  fi
  mkdir -p "$(dirname "$DEPLOY_HOOK")"
  cat > "$DEPLOY_HOOK" <<'HOOK'
#!/usr/bin/env bash
# managed by dsh-remote —— 没有它，certbot 续签后 nginx 仍发旧证书（线上表现为"续签成功但浏览器报过期"）
set -euo pipefail
if command -v nginx >/dev/null 2>&1; then nginx -t && systemctl reload nginx || true; fi
if command -v caddy >/dev/null 2>&1; then systemctl reload caddy || true; fi
HOOK
  chmod 755 "$DEPLOY_HOOK"
  say "   已安装：certbot 续签后会自动 reload（根治「续签成功但线上未生效」）"
}

verify_live_cert() {
  step "线上实际生效的证书"
  if have openssl; then
    served="$(echo | openssl s_client -connect "127.0.0.1:443" -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null || true)"
    say "   线上发出：${served:-读取失败（443 未就绪？）}"
    if [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
      onfile="$(openssl x509 -in "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" -noout -enddate 2>/dev/null || true)"
      say "   磁盘文件：${onfile:-读取失败}"
      [ "$served" = "$onfile" ] || say "   ⚠ 两者不一致 → 说明 nginx 还在内存里用旧证书，执行：systemctl reload nginx"
      fingerprint="$(openssl x509 -in "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f' || true)"
      if [ -n "$fingerprint" ]; then
        say "   把这一行交给本机侧，从外部核对线上发的就是这张证书："
        say "     --expect-cert-sha256 ${fingerprint}"
      fi
    fi
  fi
}

install() {
  need_root
  probe
  write_nginx_conf
  ensure_auth_file || say "   （口令文件未就绪，nginx 会 500；先补上再 reload）"
  ensure_tunnel_user
  ensure_sshd_dropin
  ensure_cert
  verify_live_cert
  step "完成"
  say "下一步：在本机（跑 Harness 的那台）上跑"
  say "  dsh-remote doctor --domain $DOMAIN --user $AUTH_USER --ssh-user $TUNNEL_USER --ssh-host $DOMAIN --remote-port $REMOTE_PORT"
}

uninstall() {
  need_root
  step "撤销"
  if [ -f "$NGINX_CONF" ]; then run rm -f "$NGINX_CONF"; else say "   nginx 配置不存在，跳过"; fi
  if [ -f "$SSHD_DROPIN" ]; then run rm -f "$SSHD_DROPIN"; else say "   sshd drop-in 不存在，跳过"; fi
  if [ -f "$DEPLOY_HOOK" ]; then run rm -f "$DEPLOY_HOOK"; else say "   deploy hook 不存在，跳过"; fi
  run nginx -t
  run systemctl reload nginx
  if have sshd; then run systemctl reload ssh; fi
  if [ "$PURGE_USER" = "1" ]; then
    if id "$TUNNEL_USER" >/dev/null 2>&1; then run userdel -r "$TUNNEL_USER"; fi
  else
    say "   保留隧道账号 $TUNNEL_USER（要一并删除加 --purge-user）"
  fi
  say "   注意：Basic Auth 口令文件 ${AUTH_FILE} 与 DNS 记录未动（可能被其它服务共用）"
}

case "$COMMAND" in
  probe) probe ;;
  install) install ;;
  uninstall) uninstall ;;
  *) say "用法：bash $0 {probe|install|uninstall} [--dry-run] [--skip-cert] [--skip-dns] [--purge-user]"; exit 2 ;;
esac
