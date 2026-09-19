# 自建公网入口（你自己的服务器 + 你自己的域名）

[English](self-host.md) | [中文](self-host.zh.md)

这是 `selfhost` 后端的完整版说明：`dsh-remote serve --public` 要在**你的服务器**上先具备
什么，以及每一项怎么验证。速览版在 [README](../README.zh.md)；如果你根本没有服务器，
用 `--tunnel tailscale` 或 `--tunnel cloudflared`，不必看这一页。

本文不绑定任何云厂商。示例值：域名 `dsh.example.com`、服务器 `203.0.113.10`、
隧道账号 `dshtunnel`、ssh 端口 `22022`、远端端口 `8788`。

---

## 0. 链路长什么样

```
任意浏览器 ──https──► 你的服务器：nginx/Caddy ──► 127.0.0.1:8788   （只绑回环）
                          TLS + 边缘口令            ▲
                                                    │ ssh -R（你的 Mac 主动拨出）
                                                    │
                        你的 Mac：访问密钥门 ──► Harness（只在 127.0.0.1 上监听）
```

三条性质决定了它敢跑在一台"能执行命令"的机器后面：

1. 隧道是**出站**的：公网这条路，你的 Mac 不接受任何入站连接；
2. 反代目标是**服务器上的回环**（`127.0.0.1:8788`），不是公网端口；
3. Harness 本体永远只听 `127.0.0.1` —— 本插件不会把它改成监听 `0.0.0.0`。

---

## 1. 先生成两样东西

```bash
# 插件自己那道门的访问密钥（与边缘口令相互独立）
openssl rand -hex 16

# 只用于端口转发的密钥对（在服务器上没有 shell 权限）
npx dsh-plugin-remote-connect keygen --out ~/.ssh/dsh_remote_tunnel
```

`keygen` 会打印一行可直接粘贴的 `authorized_keys` 内容，已限制成只能做一条转发。

---

## 2. 服务器侧：脚本路线（推荐）

```bash
# 本机渲染安装脚本（默认只打印，不碰服务器）
npx dsh-plugin-remote-connect setup-server \
  --domain dsh.example.com --ssh-user dshtunnel --remote-port 8788 \
  --out /tmp/dsh-server-setup.sh

# 拷过去，按三步走：看环境 → 看计划 → 执行
scp /tmp/dsh-server-setup.sh you@203.0.113.10:/tmp/
ssh you@203.0.113.10 'bash /tmp/dsh-server-setup.sh probe'
ssh you@203.0.113.10 'sudo bash /tmp/dsh-server-setup.sh install --dry-run'
ssh you@203.0.113.10 'sudo bash /tmp/dsh-server-setup.sh install'
```

安装脚本**只写自己独占的文件**，所以和你现有站点共存是安全的：

| 文件 | 作用 |
| --- | --- |
| `/etc/nginx/conf.d/dsh-remote.conf` | 你的入口 `server` 块（想放 `sites-enabled` 就用 `--nginx-conf` 指定） |
| `/etc/ssh/sshd_config.d/60-dsh-remote.conf` | `AllowTcpForwarding yes` + `ClientAliveInterval 30`（删掉该文件即撤销） |
| `/etc/letsencrypt/renewal-hooks/deploy/10-reload-web.sh` | 续签后自动 reload，避免"线上继续发旧证书" |

常用开关：`--skip-cert`（证书自己管）、`--purge-user`（卸载时连隧道账号一起删）、
`install --dry-run`（只打印计划）。卸载用同一个脚本：`sudo bash /tmp/dsh-server-setup.sh uninstall`。

---

## 3. 服务器侧：手工路线

如果你更喜欢自己的目录组织，`npx dsh-plugin-remote-connect snippets --domain dsh.example.com`
会把同样的内容按文本打印出来。真正要紧的就这几处：

```nginx
# http 上下文（只写一次）
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
# 访问密钥在 query string 里：绝不能让它进 access log
log_format dsh_nokey '$remote_addr - $remote_user [$time_local] "$request_method $uri $server_protocol" '
                     '$status $body_bytes_sent "$http_referer" "$http_user_agent"';

server {
    listen 443 ssl;
    http2 on;
    server_name dsh.example.com;

    ssl_certificate     /etc/letsencrypt/live/<lineage>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<lineage>/privkey.pem;

    access_log /var/log/nginx/dsh.access.log dsh_nokey;

    client_max_body_size 64m;      # 传图/附件
    auth_basic           "DSH";
    auth_basic_user_file /etc/nginx/.htpasswd-dsh-remote;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;      # WebSocket：少了它界面一直显示"连接中断"
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host       $host;
        proxy_buffering off;                            # 开着缓冲，流式输出会卡死
        proxy_read_timeout 3600s;                       # 长任务
        proxy_send_timeout 3600s;
    }
}
```

**刻意不给这个域名写 80 端口的 `server` 块**：精确 `server_name` 的 80 块会顶掉
`/.well-known/acme-challenge/`，把签发/续期弄坏。http→https 交给你现有的默认块。

Caddy 等价写法：

```caddyfile
dsh.example.com {
    basic_auth {
        dsh <bcrypt-hash>
    }
    reverse_proxy 127.0.0.1:8788 {
        flush_interval -1
    }
    log {
        output file /var/log/caddy/dsh.access.log
        format filter {
            wrap json
            fields {
                request>uri query {
                    delete ?k
                }
            }
        }
    }
}
```

---

## 4. 证书

把已有证书扩签，使 SAN 覆盖入口域名，然后 reload：

```bash
sudo certbot certonly --webroot -w /var/www/html --expand -d dsh.example.com -d example.com
sudo nginx -t && sudo systemctl reload nginx     # 不 reload，内存里还是旧证书
```

从**外部**确认真发出去的就是磁盘上那张：

```bash
echo | openssl s_client -connect dsh.example.com:443 -servername dsh.example.com 2>/dev/null \
  | openssl x509 -noout -dates -ext subjectAltName -fingerprint -sha256
openssl x509 -in /etc/letsencrypt/live/<lineage>/fullchain.pem -noout -fingerprint -sha256
```

两个 SHA-256 必须一致。把磁盘那个指纹抄下来，从客户端侧钉住它：

```bash
npx dsh-plugin-remote-connect doctor --domain dsh.example.com \
  --expect-cert-sha256 <sha256> --ssh-user dshtunnel --ssh-host dsh.example.com --ssh-port 22022
```

---

## 5. 隧道账号

```bash
sudo useradd -m -s /usr/sbin/nologin dshtunnel
sudo install -d -m 700 -o dshtunnel -g dshtunnel /home/dshtunnel/.ssh
# 把 `keygen` 打印的那一行粘进 /home/dshtunnel/.ssh/authorized_keys
sudo chown dshtunnel:dshtunnel /home/dshtunnel/.ssh/authorized_keys
sudo chmod 600 /home/dshtunnel/.ssh/authorized_keys
```

那一行长这样（一行写完，`permitlisten` 决定转发只能落在回环）：

```
restrict,port-forwarding,permitlisten="127.0.0.1:8788" ssh-ed25519 AAAAC3Nza... dsh-tunnel
```

生成的 `/etc/ssh/sshd_config.d/60-dsh-remote.conf` 里只有两行 —— `AllowTcpForwarding yes` 与
`ClientAliveInterval 30`，且由安装脚本独占，删掉文件即完整撤销。如果你的安全基线要求更细的粒度，
也可以改成 `Match User dshtunnel` 块手工放置；要求只有两条：**该账号允许转发**、**保活时间足够长**
（否则空闲一段时间隧道会被对端断开）。**不要**开 `GatewayPorts yes`。

---

## 6. DNS

给入口域名加一条 `A` 记录指向服务器，就这些。

如果你用自己的权威 DNS（BIND、CoreDNS 等）且分了多个 view / 多台 NS，请记住**每一份都必须一致**，
并 bump zone serial 让从库更新。只在其中一个 view 里加记录，会得到"时好时坏"的解析——
那看起来像插件 bug，其实不是。

---

## 7. 客户端侧

```bash
export DSH_REMOTE_KEY=$(openssl rand -hex 16)
npx dsh-plugin-remote-connect serve --public --key "$DSH_REMOTE_KEY" \
  --domain dsh.example.com --tunnel ssh \
  --ssh-user dshtunnel --ssh-host dsh.example.com --ssh-key ~/.ssh/dsh_remote_tunnel --ssh-port 22022
```

或者（推荐）让它跟着 Harness 一起跑 —— `profiles/web/cordis.patch.yml` 里加一行：

```yaml
- insert:
    - id: dsh-plugin-remote-connect
      name: dsh-plugin-remote-connect
      config:
        lan: { enabled: true, port: 8787 }
        public:
          enabled: true
          domain: dsh.example.com
          port: 8788
          accessKey: <第 1 步生成的密钥>
          tunnel: ssh
          ssh: { user: dshtunnel, host: dsh.example.com, port: 22022, keyPath: ~/.ssh/dsh_remote_tunnel, remotePort: 8788 }
```

之后面板会显示入口地址（`https://dsh.example.com/?k=…`）与二维码；「检查服务器」按钮跑的就是
`doctor` 那套检查。

---

## 8. 验证，并且让它一直保持被验证

```bash
npx dsh-plugin-remote-connect check  --domain dsh.example.com --user dsh --password '***' \
  --ssh-user dshtunnel --ssh-host dsh.example.com --ssh-port 22022
npx dsh-plugin-remote-connect doctor --domain dsh.example.com \
  --expect-cert-sha256 <sha256> --ssh-user dshtunnel --ssh-host dsh.example.com --ssh-port 22022
```

`check` 覆盖 DNS / 证书 / 边缘口令 / ssh 隧道四项；`doctor` 再加上上游与令牌来源、代理自测、
**线上实际发出的证书**、指纹比对，以及只能在服务器上跑的两项（日志泄漏、deploy 钩子）。
每次续签证书或改 nginx 之后，再跑一次 `doctor`。

---

## 9. 排错表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `502 Bad Gateway` | 反代指错了端口 | 必须是插件端口（`8788`），不是 Harness 的端口 |
| 页面能开，输出不流式 | 开了响应缓冲 | `proxy_buffering off`（Caddy：`flush_interval -1`） |
| 界面一直"连接中断" | WebSocket 升级被丢 | 透传 `Upgrade`/`Connection`（上面那个 `map`） |
| 长任务被掐断 | 默认 60s 读超时 | `proxy_read_timeout 3600s` |
| 传文件 `413` | 体积上限 | `client_max_body_size 64m` |
| 挂子路径后白屏 | Harness 需要根路径 | 部署在 `/`，不要 `/dsh/` |
| `Permission denied (publickey)` | 公钥没装上 / 权限不对 | 检查 `authorized_keys` 内容、属主与 `600` |
| `remote port forwarding failed` | `permitlisten` 缺失或不匹配 | 必须是 `127.0.0.1:8788`，与 `remotePort` 一致 |
| 续签后证书"还是旧的" | 服务器没 reload | reload，并保留 `renewal-hooks/deploy` 钩子 |
| 只在某些网络能通 | 有 DNS view/从库没更新 | 每份 zone 都改，bump serial |
| `curl` 能通、浏览器不行 | 浏览器太旧 | Harness 前端需要 Chrome/Edge 119+、Safari 17.4+、Firefox 121+ |

---

## 10. 本页刻意不做的事

- 不提供托管中转、共享入口或任何第三方账号：插件只连你配置的那台服务器。
- 不提供 IP 白名单 / 地域限制选项 —— 按设计，访问控制就是两道凭据（边缘口令 + `?k=` 密钥）
  加 Harness 自己的会话。
- 不做"单实例多用户"：一个 Harness 实例本身就是单用户的，本页只把一条入口接到一个实例。
  要让多个人用，是另一层的事 —— 网关给每个租户一个独立实例、独立凭据、独立端口与令牌，
  详见 [`multi-tenant.zh.md`](multi-tenant.zh.md)。
