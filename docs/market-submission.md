# 上架材料（插件市场 / 目录提交用）

这份文件是**给你（fork 者）复制粘贴用的**，不是给别人安装用的。所有方括号 `<...>` 都是占位符。

## 0. 先改这些（否则会被拒或被当成隐私事故）

| 位置 | 现在 | 改成 |
| --- | --- | --- |
| `package.json` → `name` | `dsh-plugin-remote-connect` | `@<your-scope>/dsh-plugin-remote-connect`（或确认无 scope 名可用） |
| `package.json` → `repository/homepage/bugs/author` | 空 | 你的仓库与联系方式 |
| `LICENSE` | 版权行留空 | `<你的名字或组织>` |
| `SECURITY.md` | 通用 | 你的漏洞披露渠道（邮箱 / GitHub Security Advisory） |
| `README.md` / `README.zh.md` 顶部 | 相对链接 | 若有官网，补一行项目地址 |

改完跑：`npm run gate && npm test && npm pack --dry-run`。

## 1. 一句话简介（≤ 80 字）

- 中文：把 DSH Harness 安全地开放到局域网或你自己的域名上，手机与别的电脑都能用；不经过任何第三方中转。
- English: Expose your DSH Harness safely on your LAN or your own domain — usable from your phone and any other computer, with no third-party relay.

## 2. 长描述（可直接贴）

中文：

> DSH Harness 默认只监听 `127.0.0.1`，这是对的，但你就没法用手机或另一台电脑打开它。
> 本插件在 Harness 前面加一层反向代理：监听地址、端口、绑定网卡、上游端口全部由 Harness 自己上报，不写死；访问入口带一层密钥门（`?k=...` 换取签名 Cookie，之后不再出现在 URL 里），并且永远不会把 Harness 改成监听 `0.0.0.0`。
> 两条通道：
> - **局域网**：一条命令起服务，同网段手机直接访问 `http://192.168.x.x:8787`，附二维码。
> - **公网**：用你自己的服务器和域名。插件只负责在你机器上把流量加密隧道送到服务器；服务器侧配置由插件生成的、可审计的 bash 脚本完成（不碰 80 端口、不覆盖你已有的站点）。
> 附带 `doctor`（四处键门 + 证书 SHA-256 固定）与 `check`（本机连通性自检），配置只来自 Harness 的配置校验结果，不写死端口（CLI 3080 / Desktop 43129 都对）。

English：

> DSH Harness listens on `127.0.0.1` only — correct, but it means you cannot open it from your phone or another computer.
> This plugin puts a reverse proxy in front of the Harness. Listen address, port, bind interface and upstream port are all reported by the Harness itself and never hardcoded; the entry point has a key gate (`?k=...` is exchanged for a signed cookie and never stays in the URL), and the Harness is never reconfigured to listen on `0.0.0.0`.
> Two channels:
> - **LAN**: one command, then any phone on the same network opens `http://192.168.x.x:8787`, with a QR code.
> - **Public**: bring your own server and domain. The plugin only tunnels encrypted traffic from your machine to your server; the server side is a generated, auditable bash script (it does not touch port 80 and never overwrites an existing site).
> Ships with `doctor` (four key-gate checks plus certificate SHA-256 pinning) and `check` (local reachability self-test). Every tunable comes from the Harness config validator — nothing hardcodes a port, so both the CLI (3080) and Desktop (43129) work.

## 3. 分类与标签

- 分类：网络 / 远程访问 / 开发者工具
- 标签：`lan`、`remote-access`、`reverse-proxy`、`tunnel`、`mobile`、`no-relay`、`self-hosted`、`ssh-tunnel`、`tailscale`、`cloudflared`

## 4. 需要的权限 / 能力声明（填表用）

| 项 | 值 | 说明 |
| --- | --- | --- |
| 网络监听 | 是 | 默认 `0.0.0.0:<lan.port>`，**仅在你显式启动局域网服务时**；`lan.enabled` 默认 `false` |
| 出站连接 | 是 | 仅公网模式，且仅连你自己配置的服务器（`ssh.host`） |
| 读文件 | 有限 | 仅读 `logPaths` 指定的 Harness 日志以匹配启动 token，以及调用方给的证书文件 |
| 写文件 | 是 | 仅写状态文件（`stateDir`）与生成的服务器脚本；服务器脚本默认 `--dry-run` |
| 子进程 | 是 | `ssh` / `tailscale` / `cloudflared` / `ssh-keygen`；不在系统里装任何服务 |
| 遥测 | 无 | 不发任何请求到第三方，除非你启动对应隧道后端 |
| Harness 配置改动 | 无 | 不修改 Harness 监听配置，不写 `0.0.0.0` |

## 5. 审核预期问答

**Q：它是不是"把 Harness 暴露到公网"的一键危险按钮？**
A：不是。公网模式需要你自己有服务器和域名；插件不会给你一个共享入口，也不提供任何中转。默认配置下 `public.enabled` 与 `lan.enabled` 都是 `false`。

**Q：密钥怎么存的？**
A：只在内存与状态文件里；`?k=` 首次访问后立刻换成 HttpOnly + SameSite=Lax 的签名 Cookie 并 303 重定向，`Referer` 不会带走它。日志与错误信息里会脱敏。

**Q：为什么不用 `0.0.0.0` 监听 Harness 本身？**
A：因为那样 Harness 自己就成了暴露面。代理可以只做转发、可随时关掉，且保留了密钥门。

**Q：会上传我的域名 / IP 吗？**
A：不会。`npm run gate` 会拒绝把作者自己的域名、服务器 IP、本机路径或真实公钥提交进仓库 —— 这也是本仓库演示配置里用 `example.com` 与 `192.0.2.x` 的原因。

## 6. 截图与素材

- `docs/client-preview.png` —— 侧栏入口与面板（已脱敏：域名/IP/密钥均为演示值）
- 需要更多截图时用 `npm run preview` 起的本地预览页截，不要用真实部署页

## 7. 提交前自检命令

```bash
npm run gate && npm test && npm pack --dry-run --json
```
