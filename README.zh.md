# dsh-plugin-remote-connect

[English](README.md) | 中文

> ⚠️ **先读这条**：本插件会把一台**能在你机器上执行命令、读写文件**的 agent 暴露到网络，被攻破等于你的机器被控制。
> 请按"对外发布一台可执行任意命令的主机"来对待。**作者不提供任何托管 / 中转服务**，文档里也不放任何现成实例地址——
> 服务器与域名请自备。威胁模型、凭据紧急处置、漏洞报告方式见 [SECURITY.md](SECURITY.md)。

给 **DSH Harness** 开一条远程入口：局域网直连，或经你自己的服务器走公网。手机、平板、任何一台能上网的电脑，用现代浏览器打开就能用——不装客户端、不用 VPN。

两种用法，同一份核心：

- **DSH 插件**：侧栏「设置」上方多一个「远程连接」面板，开关与二维码都在里面（推荐）。
- **独立 CLI**：`dsh-remote serve / check / snippets / keygen`，不依赖 DSH 也能用（也方便在服务器上排障）。

---

## 四种后端（同一套核心，选一种）

| 后端 | 服务器侧要做的事 | 适合谁 | 中国大陆可达性 |
| --- | --- | --- | --- |
| `lan` | **0 项** | 同一 Wi-Fi 下的手机/电脑 | 无外部依赖 ✅ |
| `tenants` | **0 项** | 多个人各用各的 Harness —— 见 [`docs/multi-tenant.zh.md`](docs/multi-tenant.zh.md) | 取决于上面的入口 |
| `cloudflare` | **0 项**（装 `cloudflared` + 登录授权，自带证书，可用 Access 做鉴权） | 大多数人 | ⚠️ 不稳定 |
| `tailscale` | **0 项**（`tailscale funnel`，自带证书与域名） | 不想用 Cloudflare 的人 | ⚠️ 不稳定 |
| `selfhost` | 详见 [`docs/self-host.zh.md`](docs/self-host.zh.md)；**6 项**：DNS / 证书 / nginx 反代 / 边缘口令 / 专用 ssh 账号 / 自测 | 有 VPS 与自有域名、要完全自主可控 | ✅ 推荐给大陆用户 |

> 托管隧道（cloudflare / tailscale）在**中国大陆可达性不稳定**，所以 `selfhost` 是一等公民而不是补丁：
> 对大陆用户"自备 VPS + 自有域名"往往是刚需。

**实现状态（诚实标注，不吹）**：

| 能力 | 状态 |
| --- | --- |
| `lan` 后端（面板 + CLI + 手机适配 + 二维码） | ✅ 已实现并端到端验证 |
| `selfhost` 后端（ssh -R 隧道、配置生成、前置检查） | ✅ 已实现；服务器侧 6 项仍需按 `snippets` 的产物人工落地 |
| `cloudflare` 后端 | ✅ 作为隧道模式实现（`--tunnel cloudflared`）；⚠️ 本环境未实连验证 |
| 多租户网关 | ✅ 已实现并用两个真实实例验证：每租户一把访问密钥 → 每租户一个独立 Harness 进程（独立 `DSH_HOME`、端口、启动令牌）；面板有增删/轮换/启停与每人的链接和二维码；`serve --multi` 与 `tenant` CLI 齐备。隔离硬证据：把 A 的令牌打到 B 的端口返回 401 |
| `tailscale` 后端 | ✅ 已作为隧道模式实现（`--tunnel tailscale` / `public.tunnel: tailscale`）：对本机回环端口执行 `tailscale funnel --bg`，从 `tailscale status --json` 取节点的 `ts.net` 域名，每 60s 探测一次 funnel，停止时只撤销自己那一条映射。⚠️ 本环境没有真实 tailnet，未实连验证（argv、域名解析、启停与失败路径都用桩二进制做了单测） |
| `setup-server` / `uninstall-server` | ✅ 已实现：生成幂等安装/卸载脚本（`probe` / `install` / `uninstall` / `--dry-run` / `--skip-*`），只写自己独占的文件；生成物过 `bash -n` 并有注入防护测试 |
| `doctor` | ✅ 已实现：上游来源、代理自测、公网四项、线上证书到期与生效性、本机密钥泄漏检查 |
| 端口自动探测（不硬编码 3080 / 43129） | ✅ 优先官方 `webServer.port`；`/state` 的 `upstream.source` 可自证 |
| 令牌获取（不抓日志） | ✅ 优先官方 `connection.authenticatedUrl()`（惰性等它挂载）；日志兜底**只认端口一致的启动行**，避免拿到别的进程的令牌 |
| 凭据零落盘 | ✅ `?k=` 不进日志（模板默认脱敏）；仓库内无任何密钥 |
| 配置校验 | ✅ 导出 `Config`（零依赖 Standard Schema）：端口越界/域名非法/tunnel 取值未知在**装载前**就报错；不引 `schemastery`，因为 profile 目录解析不到它 |
| 面板双语 | ✅ zh/en 各 29 键 + `locale` 软依赖（缺 locale 时用 key 兜底）；槽位注册带命名空间 |
| 证书"线上生效性" | ✅ 两条路：安装脚本 `verify_live_cert` 现场比对 + 打印 `--expect-cert-sha256`，`doctor` 从外部核对线上发的是不是服务器上那张 |

---

## 为什么需要它（而不是直接开端口）

Harness 的 Web 服务固定只监听 `127.0.0.1`，局域网和公网都够不着；直接把它挂到公网域名上还会 403——Harness 对 `/api` 有防 DNS-rebinding 围栏，只信 loopback 或受信 authority。

所以本工具在中间做三件必须做的事：

1. **Host / Origin 改写**为 `127.0.0.1:<上游端口>`，让围栏通过；
2. **首次访问补 `?token=`**（Harness 进程启动令牌）换签名 Cookie——令牌只在本机进程内使用，不进 URL 历史、不进日志；
3. **首页注入同源样式表 + 极小 shim**，让窄屏可用：侧栏展开时变成浮层抽屉、会话区保持整宽、点遮罩关闭、安全区适配。

公网模式另加一道**访问密钥门**：不带合法密钥一律 404（故意不返回 401，避免暴露服务存在）。

---

## 安装（DSH 插件）

### 1. 装到 profile 目录

DSH 按 `ctx.baseUrl`（profile 目录）解析插件包名，所以装在 profile 下最干净：

```bash
# DSH Desktop 的 profile 目录：
#   ~/Library/Application Support/dsh-desktop/harness/profiles/web
# 其它安装方式： ${DSH_HOME:-$HOME/.dsh}/profiles/web
cd "$HOME/Library/Application Support/dsh-desktop/harness/profiles/web"
npm install dsh-plugin-remote-connect
```

### 2. 在同一个目录的 `cordis.patch.yml` 里加一行

该文件默认是 `[]`，改成：

```yaml
- insert:
    - id: dsh-plugin-remote-connect
      name: dsh-plugin-remote-connect
      config:
        lan:
          enabled: true          # 载入即开局域网入口
          port: 8787
        public:
          enabled: false         # 服务器就绪后再打开
          domain: dsh.example.com
          port: 8788
          accessKey: ''          # 留空则每次启动随机生成（面板会显示完整链接）
          tunnel: ssh            # ssh | cloudflared | tailscale | none
          tailscale:             # 仅 tunnel: tailscale 时使用
            path: tailscale      # 客户端可执行文件
            httpsPort: 443       # funnel 对外 HTTPS 端口（由 tailscaled 提供证书）
            probeMs: 60000       # funnel 健康探测间隔
          ssh:
            user: dshtunnel
            host: dsh.example.com
            keyPath: ~/.ssh/dsh_remote_tunnel
            remotePort: 8788
```

> `id` 请与包名一致（官方 patch 也都是这么写的）。
> **不要**再把同一个文件用 `--patch` 传一遍：profile 层的 `cordis.patch.yml` 本来就会被加载，
> 重复应用会报 `duplicate loader entry id`（实测如此）。

### 3. 重启 Harness

侧栏「设置」上方出现「远程连接」，点开即可开关、看地址、扫码、复制服务器配置、跑前置检查。

> 面板里的**开关只在宿主机窗口可用**（Host 为 loopback 且不经代理）。经局域网/公网打开时面板只能看状态——这是有意的：远程访客不该能改动宿主机的暴露面。

---

## 安装（只用 CLI，不需要 DSH）

```bash
npx dsh-plugin-remote-connect serve                    # 局域网，一条命令，终端会打印二维码
npx dsh-plugin-remote-connect keygen                   # 生成隧道密钥 + 服务器要贴的受限行
npx dsh-plugin-remote-connect snippets --domain dsh.example.com --kind nginx
npx dsh-plugin-remote-connect check --domain dsh.example.com --user dsh --password '***' \
    --ssh-user dshtunnel --ssh-host dsh.example.com --ssh-key ~/.ssh/dsh_remote_tunnel
```

公网四步（`selfhost`，脚本向导优先）：

```bash
# 1) 生成隧道密钥，把打印出的 authorized_keys 限制行贴到服务器
dsh-remote keygen

# 2) 生成服务器安装脚本，拷上去先看后装（脚本默认什么都不做）
dsh-remote setup-server --domain dsh.example.com --ssh-user dshtunnel --out /tmp/dsh-setup.sh
scp /tmp/dsh-setup.sh <服务器>:/tmp/
ssh <服务器> "sudo bash /tmp/dsh-setup.sh probe"                 # 只探测：发行版/nginx/certbot/sshd/可用的工具
ssh <服务器> "sudo bash /tmp/dsh-setup.sh install --dry-run"    # 打印将要做的每一步
ssh <服务器> "sudo bash /tmp/dsh-setup.sh install"              # 幂等安装（conf.d 一个文件 + sshd drop-in + deploy hook）

# 3) 本机起代理 + 隧道（ssh 掉线自动退避重连）
dsh-remote serve --public --key "$(openssl rand -hex 16)" --domain dsh.example.com \
    --tunnel ssh --ssh-user dshtunnel --ssh-host dsh.example.com --ssh-port 22022 \
    --ssh-key ~/.ssh/dsh_remote_tunnel
#   → 公网入口：https://dsh.example.com/?k=<密钥>

# 4) 体检（含"线上实际发出的证书"与只能在服务器上跑的那几条）
dsh-remote doctor --domain dsh.example.com --user dsh --password '<边缘口令>' \
    --ssh-user dshtunnel --ssh-host dsh.example.com --ssh-port 22022 --key '<访问密钥>'

# 不用了：一键撤销
dsh-remote uninstall-server --domain dsh.example.com --out /tmp/dsh-uninstall.sh
ssh <服务器> "sudo bash /tmp/dsh-uninstall.sh"
```

> 想手写配置的人仍可用 `dsh-remote snippets`（生成 nginx / Caddy 片段与 authorized_keys 行）。

**完全没有服务器？** 两条零配置后端：

```bash
# 1) tailscale funnel —— 你自己这台机器就是出口，地址是节点自带的 ts.net 域名
tailscale up                        # 首次用需要先加入 tailnet
dsh-remote serve --public --key "$(openssl rand -hex 16)" --tunnel tailscale
#    或在 cordis.patch.yml 里写：public: { enabled: true, tunnel: tailscale }
#    funnel 起来后面板会显示 https://<节点>.<tailnet>.ts.net/
#    （需要在 Tailscale 管理后台为这个节点启用 Funnel；没开会打印人话提示）

# 2) cloudflared —— 拿一个临时公网地址
dsh-remote serve --public --key "$(openssl rand -hex 16)" --tunnel cloudflared
```

两条路都保留访问密钥门：没有 `?k=<密钥>` 打不开，代理依旧只经回环访问 Harness。

---

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `serve` | 起代理；`--public` 只绑 127.0.0.1 并强制密钥门；`--tunnel ssh\|cloudflared\|tailscale` 同时起隧道 |
| `check` | DNS / 证书 / 边缘口令 / ssh 隧道（或 tailscale funnel）逐项给结论与修法；文案跟随 `--lang` / `DSH_REMOTE_LANG` / `LANG` |
| `snippets` | 生成 nginx 或 Caddy 配置、`authorized_keys` 限制行、一次性准备步骤 |
| `keygen` | 生成隧道专用 ed25519 密钥（默认 `~/.ssh/dsh_remote_tunnel`） |
| `setup-server` | **生成服务器侧安装脚本**（默认只打印）：`probe` 看环境 / `install --dry-run` 看计划 / `install` 幂等安装；只写自己独占的文件，不动你的 nginx/sshd 主配置 |
| `uninstall-server` | 生成**独立卸载脚本**（删文件即撤销；`--purge-user` 连账号一起删） |
| `doctor` | 一条命令体检：上游与令牌来源、代理自测、DNS/证书/口令/ssh 隧道、**线上实际发出的证书**、`--expect-cert-sha256` 跨机指纹比对，并列出只能在服务器上跑的三条检查 |

常用参数：`--port`、`--upstream`、`--token`、`--domain`（可重复）、`--no-mobile`、`--json`；
隧道相关：`--ssh-user`、`--ssh-host`、`--ssh-key`、**`--ssh-port`（服务器 sshd 非 22 时必须给）**、`--remote-port`。

---

## 安全模型（请读完再用公网模式）

公网入口后面是一台**能在你机器上执行命令、读写文件**的 agent，所以门必须是真的：

- **边缘口令**（nginx `auth_basic` / Caddy `basic_auth`）：挡住所有"知道地址就想进"的人；
- **访问密钥 `?k=`**（本插件）：即使边缘配置将来被误改，攻击者拿到的仍是 404；换密钥即让旧链接失效；
- **Harness 自身会话令牌**：只对通过前两道门的请求注入。

四种后端各站在哪一级：

| 后端 | 谁能访问 | 门有几道 |
| --- | --- | --- |
| `lan` | 同网段的任何设备 | 只有 Harness 自己的会话 —— **按设计不加访问密钥**，因为局域网入口就是让手机打开地址就能用。在不信任的网络（校园网、酒店、公司访客 Wi-Fi）请改用公网后端 |
| `selfhost` | 公网 | 边缘口令 + `?k=` + Harness 会话 |
| `cloudflared` | 那个（临时）公网地址 | `?k=` + Harness 会话；长期用建议再叠 Cloudflare Access |
| `tailscale` | 你的 tailnet（开 Funnel 则含公网） | `?k=` + Harness 会话；只用 tailnet 时还可再靠 Tailscale ACL |

注意事项：

- `?k=` 会在地址栏出现过一次（随后换成 HttpOnly Cookie，默认 12 小时）。**分享链接等于分享访问权**。
- `serve --public` 在没有 `--key` 时会拒绝启动（除非显式 `--allow-no-key`，不推荐）。
- **隔离边界在 Harness 进程上**：一个 Harness 实例只服务一个人 —— 它的会话、凭据、设置、工作区、启动令牌都在这个实例自己的 `DSH_HOME` 里。所以"多人共用一个实例"不是多租户，多租户 = 网关把每个租户路由到**他自己那个实例**。这一层（每租户凭据 → 每租户上游 + 每租户令牌，实例由插件拉起与看护）正在实现；底层机制已经实测通过：同一台机器上两个实例各用独立 `DSH_HOME`、各自回环端口、各自打印启动令牌，**拿 A 的令牌访问 B 的端口返回 401**。

---

## 已知限制

| 限制 | 说明 |
| --- | --- |
| 浏览器版本 | Harness 前端使用 `Promise.withResolvers`，实际下限约为 **Chrome/Edge 119+、Safari 17.4+、Firefox 121+**。更旧的浏览器会白屏，与本插件无关 |
| 企业/校园网中间代理 | 若代理不支持 WebSocket Upgrade（做 TLS 中间人检查时常见），实时通道会断：页面能开但一直显示连接中断。需换网络或换隧道出口 |
| 代理额外认证（407） | 与 Basic Auth 叠加时部分浏览器弹窗体验很差 |
| 延迟 | 流式输出每个字都要过一趟隧道；异地 VPS 大约多 50–200ms/轮 |
| 侧栏宽度 | Harness 按 UA 决定折叠栏宽度（Mac 80px、手机 56px）。**不要**用样式强行改窄，会把图标裁掉 |
| 宿主进程要求 | host 半 inject `webServer`，只在 web profile 生效；client 半只有 `dsh.client.platform: web` 才是可视的 |
| 服务器 sshd 端口 | 服务器常把 22 关掉改用高位端口（如 22022）。**必须配置 `public.ssh.port` 或用 CLI `--ssh-port`**，否则隧道 `Connection refused` |
| 访问日志 | `?k=` 会出现在请求行里，**任何记录完整 URI 的日志都等于泄漏这道门**。`snippets` 默认生成脱敏 `log_format dsh_nokey` + 独立日志文件 |
| 80 端口 | 模板刻意**不生成** 80 端口 server block：精确 `server_name` 的 80 块会顶掉 `/.well-known/acme-challenge/`，导致证书签发/续期失败 |

---

## 目录结构

```
bin/dsh-remote.js        CLI 入口（serve / check / snippets / keygen）
lib/index.js             DSH 插件 host 半：路由、开关、生命周期（进程内跑代理）
lib/client.js            DSH 插件 client 半：侧栏入口 + 面板（手写 bundle，无构建步骤）
lib/core/proxy.js        代理核心：Host 改写、令牌注入、手机适配、访问密钥门
lib/core/tunnel.js       ssh -R / cloudflared 隧道看护（指数退避重连）+ tailscale funnel 启停
lib/core/tailscale.js    tailscale funnel 的 argv、状态解析与报错分类（纯函数、可单测）
lib/core/messages.js     宿主侧文案目录（前置检查 / 隧道状态 / 接口错误 / CLI）
lib/core/preflight.js    DNS / TLS / HTTPS+口令 / ssh 隧道 检查
lib/core/snippets.js     nginx / Caddy / authorized_keys 配置生成
lib/core/serversetup.js  服务器安装脚本生成（含输入校验防注入）
lib/core/assets/         服务器安装脚本模板（真实 bash，产出必须过 bash -n）
test/verify.mjs          冒烟测试（两半的真实契约，37 项断言）
```

---

## 验证

```bash
npm test                          # 契约 / 渲染 / 生成物 / 本地化断言（当前 68 项）
bash test/e2e-isolated.sh         # 端到端：拉一个隔离的 DSH 实例把本插件装进去
bash test/no-private-values.sh    # 门禁：仓库里不得出现作者私有值
```

`npm test` 覆盖：host 半的导出形状、配置校验、路由、状态与开关、越权拦截、**上游来源自证**、fiber 回收后端口释放；
client 半的 `__ModuleLoader__.load` 协议、槽位注册、store 与 fetch 交互、真实 React SSR 渲染（含二维码 SVG）。

`test/e2e-isolated.sh` 用**独立 `DSH_HOME` + 独立端口**启动一个真实的 Harness，把本仓库作为插件挂进去，验证：

| 断言 | 实测结果 |
| --- | --- |
| 插件装载无失败记录 | ✔ 无 `plugin failures` |
| 隔离 Harness 就绪 | ✔ 打印 `dsh web:` 与令牌 |
| host 半 API 可用 | ✔ `/remote-connect/api/state` 返回 `ok:true` |
| 插件自动开启局域网入口 | ✔ 监听 `*:8891`，状态里带正确 URL |
| client 半进入 boot 图 | ✔ 首页 `__DSH_BOOT__` 含 `dsh-plugin-remote-connect` |
| 局域网入口令牌交换 | ✔ `http://<lan-ip>:8891/` → `303` |

真浏览器里也确认过：侧栏「设置」上方出现「远程连接」（带运行状态点），点开面板显示两种通道、地址、二维码与隧道状态。
见 `docs/client-preview.png`（数据已脱敏的独立预览）。

---

## License

MIT
