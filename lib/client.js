/**
 * DSH 插件（client 半）：侧栏「远程连接」入口 + 控制面板。
 *
 * 这是真正会被 client-modules 装载的 bundle：它必须调用
 * `window.__ModuleLoader__.load({ id, factory })`，并在 factory 里挂
 * `exports.apply` / `exports.inject`。`react` 与
 * `@deepseek-ai/dsh-client-ui-primitives` 属于运行时 seed 模块，可直接 require，
 * 不需要声明 dsh.client.inject。
 *
 * 手写、无构建步骤：改完即可用（这也是本项目刻意不引入打包器的原因）。
 *
 * @module dsh-plugin-remote-connect-beta/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-remote-connect-beta',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      primitives = null
    }

    const NS = 'remote-connect'
    /** 简体中文（键集的事实来源）。 */
    const zh = {
      'dot.ok': '正常',
      'dot.bad': '网络异常',
      'dot.off': '未开启服务',
      'entry.label': '远程连接',
      'panel.title': '远程连接',
      'panel.hint': '手机或其它电脑用浏览器打开即可使用这个 Harness，无需安装客户端。',
      'panel.localOnly': '当前不是宿主机窗口，只能查看状态。',
      'card.remote': '远程访问',
      'card.settings': '设置',
      'card.settings.desc': '自建服务器、局域网、多租户、诊断都在这里；平时不用打开。',
      'settings.open': '展开',
      'settings.close': '收起',
      'settings.mode': '连接方式',
      'settings.mode.relay': '共享出口',
      'settings.mode.selfhost': '自建服务器',
      'settings.mode.hint': '共享出口 = 别人托管的服务器，你只装插件；自建 = 用你自己的域名和服务器。',
      'settings.mode.saved': '已记住。DSH 下次启动后按这个连接方式生效。',
      'settings.exitGroup': '出口地址与邀请码',
      'settings.selfhost': '自建服务器',
      'settings.selfhost.desc': '在插件配置里填 public.domain 与 public.ssh 后可用。',
      'settings.selfhost.switchFirst': '先切到「自建服务器」，这里才会给出要贴到服务器上的授权行与 nginx 片段。',
      'settings.advanced': '高级',
      'settings.diag': '诊断',
      'action.start': '开启',
      'action.stop': '停止',
      'action.check': '检查服务器',
      'action.snippets': '服务器配置',
      'card.lan': '本地网络连接',
      'card.lan.desc': '同一 Wi-Fi 下的手机/电脑直接打开；窄屏已做手机适配（侧栏浮层 + 点击遮罩关闭）。',
      'card.public': '公网连接',
      'card.public.desc': '经你的服务器提供 HTTPS 入口（访问密钥门；边缘口令可选）。',
      'card.public.unconfigured': '在插件配置里填 public.domain 与 public.ssh 后可用。',
      'card.public.relay.desc': '经共享出口（别人托管的服务器）为运行 Harness 的这台机器提供 HTTPS 入口。',
      'card.public.relay.trust': '⚠️ 走共享出口，等于把「运行 Harness 的这台机器」交给出口管理员：经过出口的请求与响应都是明文，它看得到，也改得了。访问口令由出口服务器签发与校验，运行 Harness 的这台机器把它存进本地状态文件并用它拨隧道。不想把机器交给别人，就改走自建服务器那条路。',
      'relay.exit': '出口地址',
      'relay.exitOfficial': '出口地址（官方出口，默认）',
      'relay.exitPlaceholder': '留空 = 官方出口；填别人的出口地址就换成别人的',
      'relay.exitHint': '换出口会立刻按新出口重拨隧道，链接会短暂断开。换到别人的出口要填那边给的邀请码；出口换了，之前那把访问口令在新出口上作废（这里会重新登记）。',
      'relay.invite': '邀请码',
      'relay.invitePlaceholder': '别人给你的邀请码',
      'relay.exitApply': '换到这个出口',
      'relay.exitSaved': '出口已更新，隧道已按它重拨。',
      'relay.exitNeedsInvite': '出口已记住，但还缺那边的邀请码 —— 填上它才会接上。',
      'relay.name': '你的名字',
      'relay.link': '完整链接（含访问口令，等于密码，别贴群里）',
      'state.running': '运行中',
      'state.stopped': '已停止',
      'state.busy': '处理中…',
      'state.connected': '已连接',
      'state.listening': '监听中',
      'state.unconfigured': '未配置',
      'state.tunnel': '隧道：',
      'phase.idle': '未启动',
      'phase.connecting': '连接中',
      'phase.up': '已连接',
      'phase.stopped': '已停止',
      'phase.reconnecting': '重连中',
      'phase.restarting': '重启中',
      'phase.error': '需要处理',
      'card.public.tailscale.desc': '用 tailscale funnel 发布到你的 tailnet（服务器侧零配置），地址形如 https://<节点>.<tailnet>.ts.net/。',
      'card.public.tailscale.warn': '⚠️ Funnel 没有内建身份门：唯一防线就是上面的「访问口令」，别把它发给不该给的人。',
      'problems.prefix': '配置待补：',
      'qr.hint': '扫码即可在手机上打开',
      'key.fingerprint': '指纹',
      'key.created': '生成于',
      'key.rotations': '已轮换 {count} 次',
      'key.longLived': '此链接长期有效（换来的浏览器会话 12 小时）',
      'key.copy': '复制链接',
      'key.copied': '已复制',
      'key.label': '访问口令',
      'key.reveal': '显示',
      'key.hide': '收起',
      'key.rotate': '换一个新口令',
      'key.rotateConfirm': '换一个新口令？旧链接、旧二维码、已经登录的浏览器都会立刻失效，对方要重新拿新链接进来。你自己不用做别的。确定继续？',
      'key.hint': '口令由运行 Harness 的这台机器生成并校验（它就是链接里的 ?k=）：你的服务器只负责转发请求，看不到也存不到它。改它不用动服务器。',
      'key.relayHint': '这个口令由出口服务器签发与校验，运行 Harness 的这台机器不生成它，只把它存进本地状态文件并用它拨隧道。「换一个新口令」是在出口上换，本机不参与生成。',
      'key.copyHint': '已显示：复制后存进密码管理器；收起后不再显示。',
      'key.onlyOnce': '新口令只在这里显示这一次。要给别人用，请直接复制上面的入口链接发给他。',
      'card.tenants': '租户（每人一个独立 Harness）',
      'card.tenants.desc': '每个租户跑在自己独立的 Harness 实例里：独立 DSH_HOME、独立端口、独立令牌。会话、凭据、工作区互不可见。',
      'card.tenants.off': '多租户未启用（插件配置里打开 tenants.enabled）。',
      'tenants.count': '{count} 个租户',
      'tenants.addPlaceholder': '给谁用？输入名字，例如：张三',
      'tenants.add': '新增租户',
      'tenants.remove': '删除',
      'tenants.rotate': '换新口令',
      'tenants.qr': '二维码',
      'tenants.hideQr': '收起二维码',
      'tenants.confirmRemove': '删除租户「{name}」？他的 Harness 实例会停止，但他的数据目录保留（不会替你删）。',
      'tenants.empty': '还没有租户。新增一个，把链接发给他就能用。',
      'tenants.entryHint': '这条链接就是他的入口（含访问密钥，等于密码，别贴群里）：',
      'tenants.notRunning': '实例没在跑：点「开启」',
      'tenants.phase': '状态',
      'tenants.port': '端口',
      'tenants.restarts': '重启 {count} 次',
      'tenants.encourageCredentials': '他第一次进来需要在自己的实例里配置模型凭据（各自付费、互不可见）。',
    }
    /** English，键集与 zh 一致。 */
    const en = {
      'dot.ok': 'Healthy',
      'dot.bad': 'Network problem',
      'dot.off': 'Not started',
      'entry.label': 'Remote access',
      'panel.title': 'Remote access',
      'panel.hint': 'Open this Harness from a phone or another computer in a browser — no client to install.',
      'panel.localOnly': 'This is not the host window; state is read-only here.',
      'card.remote': 'Remote access',
      'card.settings': 'Settings',
      'card.settings.desc': 'Own server, LAN, tenants and diagnostics live here. You rarely need to open it.',
      'settings.open': 'Expand',
      'settings.close': 'Collapse',
      'settings.mode': 'Connection',
      'settings.mode.relay': 'Shared exit',
      'settings.mode.selfhost': 'Your own server',
      'settings.mode.hint': 'Shared exit = a server someone else runs; you only install the plugin. Your own server = your own domain and box.',
      'settings.mode.saved': 'Saved. It takes effect the next time DSH starts.',
      'settings.exitGroup': 'Exit address & invite code',
      'settings.selfhost': 'Your own server',
      'settings.selfhost.desc': 'Set public.domain and public.ssh in the plugin config to enable it.',
      'settings.selfhost.switchFirst': 'Switch to Your own server first — the SSH authorized-keys line and the nginx snippet appear here.',
      'settings.advanced': 'Advanced',
      'settings.diag': 'Diagnostics',
      'action.start': 'Start',
      'action.stop': 'Stop',
      'action.check': 'Check server',
      'action.snippets': 'Server config',
      'card.lan': 'Local network',
      'card.lan.desc': 'Phones and computers on the same Wi-Fi open it directly; narrow screens get a drawer layout.',
      'card.public': 'Public access',
      'card.public.desc': 'HTTPS entry through your own server (access key gate; edge password optional).',
      'card.public.unconfigured': 'Set public.domain and public.ssh in the plugin config to enable.',
      'card.public.relay.desc': 'An HTTPS entry through a shared exit (a server someone else runs) for the machine running the Harness.',
      'card.public.relay.trust': '⚠️ Using a shared exit hands the machine running the Harness to the exit operator: requests and responses pass through it in plaintext — it can read and change them. The access password is issued and checked by the exit server; the machine running the Harness stores it locally and uses it to dial the tunnel. If you would not hand your machine to someone else, self-host instead.',
      'relay.exit': 'Exit address',
      'relay.exitOfficial': 'Exit address (the official exit — the default)',
      'relay.exitPlaceholder': 'Empty = the official exit; paste someone else\'s exit address to switch to theirs',
      'relay.exitHint': 'Switching re-dials the tunnel on the new exit right away, so the link drops for a moment. Switching to someone else\'s exit needs the invite code they gave you; the old exit\'s password does not work on the new one (you are registered there again).',
      'relay.invite': 'Invite code',
      'relay.invitePlaceholder': 'The invite code they gave you',
      'relay.exitApply': 'Use this exit',
      'relay.exitSaved': 'Exit updated — the tunnel was re-dialled on it.',
      'relay.exitNeedsInvite': 'Exit saved, but it still needs that exit\'s invite code — paste it and it will connect.',
      'relay.name': 'Your name',
      'relay.link': 'Full link (it carries the access password — treat it like a password, do not post it)',
      'state.running': 'Running',
      'state.stopped': 'Stopped',
      'state.busy': 'Working…',
      'state.connected': 'Connected',
      'state.listening': 'Listening',
      'state.unconfigured': 'Not configured',
      'state.tunnel': 'Tunnel: ',
      'phase.idle': 'Not started',
      'phase.connecting': 'Connecting',
      'phase.up': 'Connected',
      'phase.stopped': 'Stopped',
      'phase.reconnecting': 'Reconnecting',
      'phase.restarting': 'Restarting',
      'phase.error': 'Needs attention',
      'card.public.tailscale.desc': 'Publish through tailscale funnel on your tailnet (zero server-side setup); the address looks like https://<node>.<tailnet>.ts.net/.',
      'card.public.tailscale.warn': '⚠️ Funnel has no built-in identity gate: the access password above is the only protection — do not hand it to anyone you would not trust.',
      'problems.prefix': 'Config needs attention: ',
      'qr.hint': 'Scan to open on your phone',
      'key.fingerprint': 'Fingerprint',
      'key.created': 'Created',
      'key.rotations': 'Rotated {count} time(s)',
      'key.longLived': 'This link does not expire (the browser session it issues lasts 12 hours)',
      'key.copy': 'Copy link',
      'key.copied': 'Copied',
      'key.label': 'Access password',
      'key.reveal': 'Reveal',
      'key.hide': 'Hide',
      'key.rotate': 'New password',
      'key.rotateConfirm': 'Generate a new access password? Old links, QR codes and every already-signed-in browser stop working immediately; whoever you gave a link to needs the new one. Nothing else changes for you. Continue?',
      'key.hint': 'This password is generated and checked by the machine running the Harness (it is the ?k= in your link): your server only forwards requests — it never sees or stores it. Changing it does not touch the server.',
      'key.relayHint': 'This password is issued and checked by the exit server; the machine running the Harness does not generate it — it stores it locally and uses it to dial the tunnel. "New password" rotates it on the exit; this machine never generates it.',
      'key.copyHint': 'Shown once: copy it into your password manager. Hiding it will not show it again without another click.',
      'key.onlyOnce': 'The new password is shown here exactly once. To hand it to someone, copy the entry link above and send that.',
      'card.tenants': 'Tenants (one Harness each)',
      'card.tenants.desc': 'Every tenant runs in its own Harness instance: own DSH_HOME, own port, own launch token. Sessions, credentials and workspaces are not shared.',
      'card.tenants.off': 'Multi-tenancy is off (set tenants.enabled in the plugin config).',
      'tenants.count': '{count} tenants',
      'tenants.addPlaceholder': 'Who is it for? Type a name, e.g. Alice',
      'tenants.add': 'Add tenant',
      'tenants.remove': 'Remove',
      'tenants.rotate': 'New password',
      'tenants.qr': 'QR code',
      'tenants.hideQr': 'Hide QR code',
      'tenants.confirmRemove': 'Remove tenant "{name}"? Their Harness stops; their data directory is left untouched.',
      'tenants.empty': 'No tenants yet. Add one and send them the link.',
      'tenants.entryHint': 'This link is their entry point (it carries the access key — treat it like a password):',
      'tenants.notRunning': 'Instance is not running: press Start',
      'tenants.phase': 'State',
      'tenants.port': 'Port',
      'tenants.restarts': '{count} restarts',
      'tenants.encourageCredentials': 'They configure their own model credentials inside their instance on first use (separate billing, nothing shared).',
    }

    /** apply 时记下的 Cordis 上下文：只用于惰性读取 locale 服务。 */
    let ctxRef = null

    const API = '/remote-connect/api'
    const PLUGIN_ID = 'dsh-plugin-remote-connect-beta'
    const POLL_MS = 5000

    /** 点一下把整段链接选中：div 版本的 select-all（替换掉 input 的 .select()）。 */
    const selectAll = (el) => {
      if (typeof window === 'undefined' || el === null || el === undefined) return
      const range = document.createRange()
      range.selectNodeContents(el)
      const selection = window.getSelection()
      if (selection === null) return
      selection.removeAllRanges()
      selection.addRange(range)
    }

    // ── 视觉规范：留白是 4 的倍数；卡片用「浅底」而不是描边嵌套；按钮分主/次两级 ──
    const CSS = [
      // 入口行（侧栏 与 窄栏两态）
      '.dshRcRow{display:flex;align-items:center;width:calc(100% + 4px);margin:4px -2px}',
      '.dshRcRow.isRail{width:36px;justify-content:center;margin:8px 0 10px}',
      '.dshRcTrigger{box-sizing:border-box;cursor:pointer;min-width:0;flex:1;height:42px;display:flex;align-items:center;gap:10px;margin:0;padding:0 10px 0 8px;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:12px;overflow:hidden;transition:background 140ms ease,transform 140ms cubic-bezier(0.23,1,0.32,1)}',
      '.dshRcTrigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.dshRcTrigger:active{transform:scale(.98)}',
      '.dshRcTrigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2f6fed);outline-offset:2px}',
      '.dshRcTrigger.isRail{flex:none;width:36px;height:36px;justify-content:center;gap:0;padding:0;border-radius:50%;corner-shape:round}',
      '.dshRcTriggerLabel{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshRcDot{width:7px;height:7px;flex:none;margin-left:auto;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#f59e0b)}',
      '.dshRcDot.isOk{background:var(--dsw-alias-state-success-primary,#22c55e)}',
      '.dshRcDot.isBad{background:var(--dsw-alias-state-error-primary,#ef4444)}',
      '.dshRcDot.isOff{background:var(--dsw-alias-state-warn-primary,#f59e0b)}',
      // 面板外壳
      '.dshRcLayer{position:absolute;inset:0;z-index:60;pointer-events:auto}',
      '.dshRcBackdrop{position:absolute;inset:0;background:transparent}',
      '.dshRcPanel{position:absolute;left:12px;bottom:104px;box-sizing:border-box;width:352px;max-width:calc(100vw - 24px);max-height:calc(100vh - 140px);overflow:auto;padding:16px;border-radius:16px;background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));box-shadow:0 20px 48px rgba(0,0,0,.16),0 2px 6px rgba(0,0,0,.05);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}',
      '.dshRcTitle{font-size:15px;font-weight:600;letter-spacing:.01em}',
      '.dshRcHint{margin:2px 0 12px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary)}',
      // 卡片：一层极浅底色 + 大留白，取代「框套框」
      '.dshRcCard{padding:12px 12px 14px;margin-bottom:8px;border:1px solid transparent;border-radius:12px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06))}',
      '.dshRcCard.isOn{border-color:var(--dsw-alias-border-l1,rgba(127,127,127,.18))}',
      '.dshRcCard:last-child{margin-bottom:0}',
      '.dshRcHead{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;font-weight:600}',
      '.dshRcDesc{margin-top:6px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary)}',
      '.dshRcMeta{margin-top:6px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);opacity:.85}',
      '.dshRcBadge{flex:none;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:500;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary)}',
      '.dshRcBadge.isOn{background:var(--dsw-alias-state-success-primary,#22c55e);color:#fff}',
      '.dshRcBadge.isWarn{background:var(--dsw-alias-state-warn-primary,#f59e0b);color:#fff}',
      // 只读地址 / 输入框：统一成「代码胶囊」
      '.dshRcUrl{box-sizing:border-box;width:100%;margin-top:8px;padding:7px 10px;font-family:var(--ds-font-family-code,monospace);font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base,rgba(127,127,127,.05));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));border-radius:9px;text-overflow:ellipsis}',
      '.dshRcUrl::selection{background:var(--dsw-alias-brand-primary,#2f6fed);color:#fff}',
      // 入口链接必须**完整可见**：单行 input 会省略号截断，标题却写着「完整链接」——
      // 换成一个可换行的 div（点一下仍然全选），长链接折行显示，不藏任何一段。
      '.dshRcUrl.isWrap{white-space:pre-wrap;word-break:break-all;overflow-wrap:anywhere;cursor:text;text-overflow:clip;user-select:all}',
      '.dshRcInput{margin-top:6px;cursor:text}',
      '.dshRcInput::placeholder{color:var(--dsw-alias-label-secondary,rgba(0,0,0,.42))}',
      '.dshRcKeyValue{margin-left:6px;font-family:var(--ds-font-family-code,monospace);font-size:12px}',
      // 按钮：一级填充 / 二级描边；控件圆角与输入框统一为 9
      '.dshRcActions{margin-top:10px;display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
      // 同一行里的输入框（出口那一栏的邀请码）分掉剩余宽度；按钮窄屏会自己换行
      '.dshRcActions .dshRcUrl{flex:1 1 140px;min-width:0;margin-top:0}',
      '.dshRcButton{cursor:pointer;padding:6px 12px;font:inherit;font-size:12px;font-weight:500;line-height:18px;color:#fff;background:var(--dsw-alias-brand-primary,#2f6fed);border:1px solid transparent;border-radius:9px;transition:background 140ms ease,opacity 140ms ease,transform 140ms cubic-bezier(0.23,1,0.32,1)}',
      '.dshRcButton:active{transform:scale(.97)}',
      '.dshRcButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2f6fed);outline-offset:2px}',
      '.dshRcButton.isGhost{color:var(--dsw-alias-label-primary);background:0 0;border-color:var(--dsw-alias-border-l1,rgba(127,127,127,.24))}',
      '.dshRcButton:disabled{opacity:.45;cursor:default}',
      '.dshRcButton:disabled:active{transform:none}',
      // 提示 / 校验
      '.dshRcWarn{margin-top:8px;padding-left:8px;font-size:12px;line-height:1.5;border-left:2px solid var(--dsw-alias-state-warn-primary,#f59e0b);color:var(--dsw-alias-state-warn-primary,#b45309)}',
      '.dshRcError{margin-top:8px;padding-left:8px;font-size:12px;line-height:1.5;border-left:2px solid var(--dsw-alias-state-error-primary,#ef4444);color:var(--dsw-alias-state-error-primary,#dc2626);word-break:break-word}',
      '.dshRcCheck{margin-top:10px;display:flex;flex-direction:column;gap:8px;font-size:11.5px}',
      '.dshRcCheckRow{line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.dshRcCheckHead{display:flex;align-items:baseline;gap:6px}',
      '.dshRcCheckHead b{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dshRcCheckMark{flex:none}',
      '.dshRcCheckDetail{word-break:break-word}',
      '.dshRcCheckHint{color:var(--dsw-alias-state-warn-primary,#b45309)}',
      // 折叠标题行：用 button，所以要把它重置成「看起来还是标题」
      '.dshRcHeadRight{display:flex;align-items:center;gap:8px}',
      '.dshRcHead.isToggle{cursor:pointer;width:100%;padding:0;font:inherit;font-size:13px;font-weight:600;text-align:left;color:inherit;background:0 0;border:0;border-radius:6px}',
      '.dshRcHead.isToggle:active{opacity:.7}',
      '.dshRcHead.isToggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2f6fed);outline-offset:3px}',
      // 设置里的分组：一条极细的分隔线 + 小标题，替代「卡片里再套卡片」
      '.dshRcGroup{margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14))}',
      '.dshRcGroup:first-child{margin-top:6px;padding-top:0;border-top:0}',
      '.dshRcGroupName{font-size:11.5px;font-weight:600;letter-spacing:.03em;color:var(--dsw-alias-label-secondary)}',
      // 连接方式：两格分段控件（选中的那格填充 brand）
      '.dshRcSeg{display:flex;gap:6px;margin-top:8px}',
      '.dshRcSegBtn{flex:1;cursor:pointer;padding:6px 10px;font:inherit;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-primary);background:0 0;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:9px;transition:background 140ms ease,color 140ms ease,transform 140ms cubic-bezier(0.23,1,0.32,1)}',
      '.dshRcSegBtn.isOn{color:#fff;background:var(--dsw-alias-brand-primary,#2f6fed);border-color:transparent}',
      '.dshRcSegBtn:active{transform:scale(.97)}',
      '.dshRcSegBtn:disabled{opacity:.45;cursor:default}',
      '.dshRcSegBtn:disabled:active{transform:none}',
      '.dshRcSegBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2f6fed);outline-offset:2px}',
      // 远程访问开关：开启=绿，关闭=灰
      '.dshRcSwitch{position:relative;flex:none;width:38px;height:22px;padding:0;cursor:pointer;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.28));border:1px solid transparent;border-radius:999px;transition:background 160ms ease}',
      '.dshRcSwitch.isOn{background:var(--dsw-alias-state-success-primary,#22c55e)}',
      '.dshRcSwitch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform 160ms cubic-bezier(0.23,1,0.32,1)}',
      '.dshRcSwitch.isOn::after{transform:translateX(16px)}',
      '.dshRcSwitch:disabled{opacity:.45;cursor:default}',
      '.dshRcSwitch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2f6fed);outline-offset:2px}',
      '@media (prefers-reduced-motion:reduce){.dshRcSwitch,.dshRcSwitch::after{transition:none}}',
      // 租户
      '.dshRcTenant{margin-top:8px;padding:10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));border-radius:10px}',
      // 二维码 / 片段
      '.dshRcQr{margin-top:10px;display:flex;justify-content:center;background:#fff;padding:10px;border-radius:12px}',
      '.dshRcQrHint{margin-top:8px;font-size:11.5px;text-align:center;color:var(--dsw-alias-label-secondary)}',
      '.dshRcSnippet{margin-top:10px;padding:10px;max-height:180px;overflow:auto;white-space:pre;font-family:var(--ds-font-family-code,monospace);font-size:11px;line-height:1.5;background:var(--dsw-alias-bg-base,rgba(127,127,127,.05));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));border-radius:9px}',
      // 交互态：hover 只在真有指针时才生效 —— 触屏上 tap 会误触发 hover
      '@media (hover:hover) and (pointer:fine){',
      '.dshRcButton:hover{opacity:.9}',
      '.dshRcButton.isGhost:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));opacity:1}',
      '}',
      // 面板入场：从触发点（左下角）长出来，不从中心凭空放大
      '.dshRcPanel{transform-origin:0 100%;animation:dshRcPanelIn 180ms cubic-bezier(0.23,1,0.32,1)}',
      '@keyframes dshRcPanelIn{from{opacity:0;transform:translateY(6px) scale(.97)}to{opacity:1;transform:none}}',
      // 无障碍：减少动态时保留颜色/透明度，去掉位移与缩放
      '@media (prefers-reduced-motion:reduce){',
      '.dshRcPanel{animation:none}',
      '.dshRcTrigger,.dshRcButton{transition:background 140ms ease,opacity 140ms ease}',
      '.dshRcTrigger:active,.dshRcButton:active{transform:none}',
      '}',
      // ── 深色模式：主题变量优先；只有拿不到变量（或我们写死的地方）时才用这里的兜底 ──
      '@media (prefers-color-scheme: dark){',
      '.dshRcPanel{background:var(--dsw-alias-bg-overlay,#1f2126);border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.1));box-shadow:0 20px 48px rgba(0,0,0,.5),0 2px 6px rgba(0,0,0,.3)}',
      '.dshRcCard{background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.05))}',
      '.dshRcCard.isOn{border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.16))}',
      '.dshRcUrl{background:var(--dsw-alias-bg-base,rgba(255,255,255,.04));border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.12))}',
      // 二维码保持白底黑码：反色会导致部分手机扫不出来
      '.dshRcSnippet{background:var(--dsw-alias-bg-base,rgba(255,255,255,.04));border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.12))}',
      '.dshRcWarn,.dshRcCheckHint{color:var(--dsw-alias-state-warn-primary,#fbbf24)}',
      '.dshRcInput::placeholder{color:var(--dsw-alias-label-secondary,rgba(255,255,255,.45))}',
      '.dshRcButton.isGhost{border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.16))}',
      '}',
    ].join('\n')

    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(PLUGIN_ID + '/client.css') + ']') === null
    ) {
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = PLUGIN_ID + '/client.css'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ---- 极简 store：组件订阅，异步动作直接 setState ----
    const store = {
      open: false,
      busy: false,
      error: null,
      data: null,
      checkResults: null,
      snippet: null,
      revealedKey: null,
      keyBusy: false,
      keyCopied: false,
      tenantQr: null,
      tenantQrId: null,
      tenantDraft: '',
      // 出口地址那一栏：null = 还没动过（显示后端给的当前出口），'' = 用户清空了（= 官方出口）
      exitDraft: null,
      inviteDraft: '',
      exitBusy: false,
      exitNotice: null,
      // 设置是折叠的：第一次打开只看得到「远程访问」，专业功能要自己展开
      settingsOpen: false,
      modeNotice: null,
    }
    const listeners = new Set()

    function setState(patch) {
      Object.assign(store, patch)
      for (const listener of [...listeners]) listener()
    }

    function useStore() {
      const pair = React.useState(0)
      const force = pair[1]
      React.useEffect(() => {
        const listener = () => force((value) => value + 1)
        listeners.add(listener)
        return () => listeners.delete(listener)
      }, [])
      return store
    }

    /**
     * 面板当前语言：优先用 harness 的 locale 服务，取不到时退回浏览器语言。
     * 宿主半用它渲染检查结果与隧道状态，所以每次请求都带上。
     */
    function currentLocale() {
      const locale = ctxRef === null ? undefined : ctxRef.get('locale')
      const active = locale === undefined ? undefined : locale.getLocale?.().active
      if (typeof active === 'string' && active !== '') return active
      if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') return navigator.language
      return undefined
    }

    /**
     * 组件外的文案：面板动作（rotateKey）不在 React 里，拿不到 props.t，
     * 所以按当前语言直接从本插件的两份字典里取。
     */
    function tt(key) {
      const lang = String(currentLocale() ?? 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en'
      const table = lang === 'zh' ? zh : en
      return table[key] ?? en[key] ?? key
    }

    async function api(path, options) {
      try {
        const locale = currentLocale()
        const url = API + path + (locale === undefined ? '' : '?locale=' + encodeURIComponent(locale))
        const response = await fetch(url, {
          headers: { 'content-type': 'application/json' },
          ...options,
        })
        const text = await response.text()
        if (text === '') return { ok: false, error: 'HTTP ' + String(response.status) }
        try {
          return JSON.parse(text)
        } catch (error) {
          return { ok: false, error: text.slice(0, 300) }
        }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    }

    async function refresh() {
      const payload = await api('/state')
      setState({
        data: payload.ok === false ? store.data : payload,
        error: payload.ok === false ? payload.error : null,
      })
    }

    async function act(path) {
      setState({ busy: true, error: null, snippet: null })
      const payload = await api(path, { method: 'POST' })
      setState({
        busy: false,
        data: payload.ok === false ? store.data : payload,
        error: payload.ok === false ? payload.error : null,
      })
    }

    async function runCheck() {
      setState({ busy: true, error: null })
      const payload = await api('/check', { method: 'POST' })
      setState({
        busy: false,
        checkResults: Array.isArray(payload.results) ? payload.results : null,
        error: payload.ok === false ? payload.error : null,
      })
    }

    /** 显示访问口令明文（只在宿主窗口可用；收起后要再点一次才会再显示）。 */
    async function revealKey() {
      if (store.revealedKey !== null) {
        setState({ revealedKey: null })
        return
      }
      setState({ keyBusy: true })
      const payload = await api('/access-key/reveal', { method: 'POST' })
      setState({
        keyBusy: false,
        revealedKey: typeof payload.accessKey === 'string' ? payload.accessKey : null,
        error: payload.ok === false ? payload.error : null,
      })
    }

    /** 复制当前入口链接（含新口令），并短暂提示"已复制"。 */
    async function copyEntryLink() {
      const entry = store.data?.public?.entry ?? null
      if (typeof entry !== 'string' || entry === '') return
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
          await navigator.clipboard.writeText(entry)
        }
      } catch {
        /* 复制失败就让用户手动选中输入框 */
      }
      setState({ keyCopied: true })
      setTimeout(() => setState({ keyCopied: false }), 1500)
    }

    /**
     * 换一个新口令：**只有这一个动作**，口令由主机生成后回显一次。
     *
     * 为什么没有"自己起一个"「先输当前口令」这条路：口令是机器发的凭据，不是用户要记的
     * 密码；让人自拟的结局通常是弱口令，而"忘记当前口令"又必然要一条绕过验证的后门。
     * 于是只剩一键：点它 → 换一把新的 → 旧链接全部失效（面板里已写明），破坏性由确认框兜住。
     */
    async function rotateKey() {
      if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        if (window.confirm(tt('key.rotateConfirm')) !== true) return
      }
      setState({ keyBusy: true, error: null })
      const payload = await api('/access-key/rotate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ acknowledge: true }),
      })
      await refresh()
      setState({
        keyBusy: false,
        revealedKey: typeof payload.accessKey === 'string' ? payload.accessKey : null,
        error: payload.ok === false ? payload.error : null,
      })
    }

    /**
     * 换出口：面板上「出口地址」那一栏就是它。
     *
     * 默认填着官方出口 —— 不改，就还是官方出口；把别人的地址粘进去点一下，就换成别人的
     * （宿主会立刻按新出口重拨隧道）。旁边那个框是**邀请码**：换到别人的出口时，那串码是
     * 入场券（一次性，登记成功后出口作废它），没有它就登记不上、也就拨不上隧道。
     */
    async function applyExit() {
      const current = store.data?.public?.relay?.url ?? ''
      const draft = store.exitDraft === null || store.exitDraft === undefined ? current : store.exitDraft
      const url = String(draft).trim()
      const invite = String(store.inviteDraft ?? '').trim()
      setState({ exitBusy: true, error: null, exitNotice: null })
      const payload = await api('/relay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, invite }),
      })
      await refresh()
      setState({
        exitBusy: false,
        exitDraft: null,
        inviteDraft: '',
        // 出口换了但登记没成（比如邀请码不对）时照实说 —— 别让人以为接上了
        exitNotice:
          payload.ok === false
            ? null
            : payload.needsInvite === true
              ? tt('relay.exitNeedsInvite')
              : tt('relay.exitSaved'),
        error: payload.ok === false ? payload.error : (payload.warning ?? null),
      })
    }

    /**
     * 切换连接方式：共享出口 ⇄ 自建服务器。
     *
     * 为什么只到「记住」为止：两边的**凭据模型不一样** —— 共享出口的口令由出口签发并校验，
     * 自建的是本机生成、写进状态文件。换引擎等于重走一遍插件初始化的那一段，所以真正生效在
     * DSH 下次启动（面板上照实说，不许写成「立刻生效」）。
     */
    async function applyMode(mode) {
      setState({ busy: true, error: null, modeNotice: null })
      const payload = await api('/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      await refresh()
      setState({
        busy: false,
        modeNotice: payload.ok === false ? null : tt('settings.mode.saved'),
        error: payload.ok === false ? payload.error : null,
      })
    }

    /** 租户管理：所有改动都由宿主半校验（只有宿主窗口能调）。 */
    async function tenantAction(action, body) {
      setState({ busy: true, error: null })
      const payload = await api('/tenants/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      setState({
        busy: false,
        data: payload.ok === false || payload.tenants === undefined ? store.data : { ...store.data, tenants: { ...store.data.tenants, list: payload.tenants } },
        error: payload.ok === false ? payload.error : null,
      })
      return payload
    }

    async function tenantAdd() {
      const name = String(store.tenantDraft ?? '').trim()
      if (name === '') return
      const payload = await tenantAction('add', { name })
      if (payload.ok !== false) setState({ tenantDraft: '' })
    }

    async function tenantQr(id) {
      if (store.tenantQrId === id) {
        setState({ tenantQr: null, tenantQrId: null })
        return
      }
      const payload = await api('/tenants/qr?id=' + encodeURIComponent(id))
      setState({
        tenantQr: Array.isArray(payload.rows) ? payload.rows : null,
        tenantQrId: payload.ok === false ? null : id,
        error: payload.ok === false ? payload.error : null,
      })
    }

    async function loadSnippet() {
      const payload = await api('/snippets?kind=nginx')
      setState({
        snippet: payload.ok === false ? null : payload,
        error: payload.ok === false ? payload.error : null,
      })
    }

    function GlobeIcon(props) {
      const size = props.size === undefined ? 16 : props.size
      const Icon = primitives === null ? undefined : primitives.IconGlobeOutline14
      if (typeof Icon === 'function') return React.createElement(Icon, { size })
      return React.createElement(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        React.createElement('circle', { cx: 8, cy: 8, r: 6.1, stroke: 'currentColor', strokeWidth: 1.3 }),
        React.createElement('ellipse', { cx: 8, cy: 8, rx: 2.6, ry: 6.1, stroke: 'currentColor', strokeWidth: 1.3 }),
        React.createElement('path', {
          d: 'M2.3 6.1h11.4M2.3 9.9h11.4',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
      )
    }

    function QrCode(props) {
      const t = props.t === undefined ? (key) => key : props.t
      const rows = props.rows
      const size = rows.length
      let path = ''
      for (let y = 0; y < size; y += 1) {
        const row = rows[y]
        for (let x = 0; x < row.length; x += 1) {
          if (row.charAt(x) === '1') path += 'M' + String(x) + ' ' + String(y) + 'h1v1h-1z'
        }
      }
      return React.createElement(
        'div',
        { className: 'dshRcQr' },
        React.createElement(
          'svg',
          {
            width: 132,
            height: 132,
            viewBox: '0 0 ' + String(size) + ' ' + String(size),
            shapeRendering: 'crispEdges',
            role: 'img',
            'aria-label': t('qr.hint'),
          },
          React.createElement('rect', { x: 0, y: 0, width: size, height: size, fill: '#ffffff' }),
          React.createElement('path', { d: path, fill: '#000000' }),
        ),
      )
    }

    function Entry(props) {
      const t = props.t === undefined ? (key) => key : props.t
      const state = useStore()
      const wide = props.wide !== false
      const data = state.data
      /**
       * 侧栏状态灯三态：
       *   isOk  绿 —— 有入口在正常工作（局域网在听，或公网监听 + 隧道 up 且上游令牌有）
       *   isBad 红 —— 该工作的没工作：隧道掉了/重连中、配置有问题、上游令牌拿不到
       *   isOff 橙 —— 两个入口都没开（服务未启用）
       */
      const entryStatus = (() => {
        if (data === null || data === undefined) return 'off'
        const lan = data.lan ?? {}
        const pub = data.public ?? {}
        const tunnel = pub.tunnel ?? null
        const problems = (data.config?.problems ?? []).length
        const hasToken = data.upstream?.hasToken !== false
        const tunnelBroken = pub.running === true && tunnel !== null && tunnel.phase !== 'up'
        const bad = problems > 0 || hasToken === false || tunnelBroken
        const on = lan.running === true || pub.running === true
        if (bad) return 'bad'
        return on ? 'ok' : 'off'
      })()
      React.useEffect(() => {
        void refresh()
        const timer = setInterval(() => {
          void refresh()
        }, 15000)
        return () => clearInterval(timer)
      }, [])
      return React.createElement(
        'div',
        { className: 'dshRcRow' + (wide ? '' : ' isRail') },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dshRcTrigger' + (wide ? '' : ' isRail'),
            'aria-label': t('entry.label'),
            title: t('entry.label'),
            onClick: () => {
              const next = !state.open
              setState({ open: next })
              if (next) void refresh()
            },
          },
          React.createElement(GlobeIcon, { size: wide ? 16 : 18 }),
          wide ? React.createElement('span', { className: 'dshRcTriggerLabel' }, t('entry.label')) : null,
          wide
            ? React.createElement('span', {
                className: 'dshRcDot' + (entryStatus === 'ok' ? ' isOk' : entryStatus === 'bad' ? ' isBad' : ' isOff'),
                title: t('dot.' + entryStatus),
                'aria-label': t('dot.' + entryStatus),
              })
            : null,
        ),
      )
    }

    function Card(props) {
      // 可折叠的卡（「设置」）：整行标题就是开关 —— 用 <button> 而不是给 div 挂 onClick，
      // 键盘用户才能 Tab 到它并回车展开。
      const toggleable = typeof props.onToggle === 'function'
      const headProps = { className: 'dshRcHead' + (toggleable ? ' isToggle' : '') }
      if (toggleable) {
        headProps.type = 'button'
        headProps['aria-expanded'] = props.on === true
        headProps.onClick = () => props.onToggle()
      }
      return React.createElement(
        'div',
        { className: 'dshRcCard' + (props.on ? ' isOn' : '') },
        React.createElement(
          toggleable ? 'button' : 'div',
          headProps,
          React.createElement('span', null, props.title),
          React.createElement(
            'span',
            { className: 'dshRcHeadRight' },
            props.extra === undefined ? null : props.extra,
            React.createElement(
              'span',
              { className: 'dshRcBadge' + (props.on ? ' isOn' : props.warn ? ' isWarn' : '') },
              props.badge,
            ),
          ),
        ),
        props.children,
      )
    }

    function Panel(props) {
      const t = props.t === undefined ? (key) => key : props.t
      const state = useStore()
      React.useEffect(() => {
        if (!state.open) return undefined
        void refresh()
        const timer = setInterval(() => {
          void refresh()
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [state.open])
      if (!state.open) return null

      const data = state.data
      const lan = data === null || data === undefined ? null : data.lan
      const pub = data === null || data === undefined ? null : data.public
      const canControl = data === null || data === undefined || data.canControl !== false
      const qr = data === null || data === undefined ? null : data.qr
      const problems =
        data === null || data === undefined || data.config === undefined ? [] : data.config.problems || []
      const lanOn = lan !== null && lan.running === true
      const pubOn = pub !== null && pub.running === true
      const tunnel = pub === null || pub === undefined ? null : pub.tunnel
      const tunnelMode =
        data === null || data === undefined || data.config === undefined || typeof data.config.tunnel !== 'string'
          ? 'ssh'
          : data.config.tunnel
      // 只有自建服务器（ssh）这条路需要自己填域名；tailscale 用节点自带的 ts.net 域名
      const relay = pub === null || pub === undefined ? null : (pub.relay ?? null)
      const relayConfigured = tunnelMode === 'relay' && relay !== null && typeof relay.url === 'string' && relay.url !== ''
      const pubConfigured = pub !== null && pub !== undefined && (pub.domain !== '' || tunnelMode === 'tailscale' || relayConfigured)
      // 访问口令的掩码：state 还没回来（pub 为 null）时也要能渲染，不能崩
      const keyMasked = pub === null || pub === undefined ? '—' : String(pub.accessKeyMasked ?? '—')
      const keyFingerprint = pub === null || pub === undefined ? '—' : String(pub.accessKeyFingerprint ?? '—')
      const keyCreated = pub === null || pub === undefined ? '—' : String(pub.accessKeyCreatedAt ?? '—').slice(0, 19).replace('T', ' ')
      const keyRotations = pub === null || pub === undefined ? 0 : Number(pub.accessKeyRotations ?? 0)
      const canManageKey = pub !== null && pub !== undefined
      // 出口那一栏的草稿值：null = 用户还没动过 → 显示后端给的当前出口
      // 标签也放这儿：官方出口必须显式标出（aria-label 用同一句，避免两处口径不一致）
      const exitLabel = relay === null ? '' : relay.official === true ? t('relay.exitOfficial') : t('relay.exit')
      const exitValue =
        relay === null
          ? ''
          : state.exitDraft === null || state.exitDraft === undefined
            ? String(relay.url ?? '')
            : state.exitDraft
      const inviteValue = String(state.inviteDraft ?? '')
      // 没改地址也没填邀请码 → 按钮就不该亮（不给出一个点了没反应的按钮）
      const exitDirty =
        relay !== null &&
        (exitValue.trim() !== String(relay.url ?? '') || inviteValue.trim() !== '')
      const phaseLabel = (phase) => {
        const key = 'phase.' + String(phase)
        return t(key) === key ? String(phase) : t(key)
      }

      return React.createElement(
        'div',
        { className: 'dshRcLayer' },
        React.createElement('div', { className: 'dshRcBackdrop', onClick: () => setState({ open: false }) }),
        React.createElement(
          'div',
          { className: 'dshRcPanel', role: 'dialog', 'aria-label': t('panel.title') },
          React.createElement('div', { className: 'dshRcTitle' }, t('panel.title')),
          React.createElement(
            'div',
            { className: 'dshRcHint' },
            t('panel.hint'),
          ),
          problems.length > 0
            ? React.createElement('div', { className: 'dshRcWarn' }, t('problems.prefix') + problems.join('；'))
            : null,
          !canControl
            ? React.createElement('div', { className: 'dshRcHint' }, t('panel.localOnly'))
            : null,

          // ══════ 主视图：远程访问 ══════
          // 这里只留「朋友想用一下」那条路：开关、链接、口令、二维码。
          // 自建服务器 / 边缘口令 / 多租户 / 诊断全部收在下面的「设置」里（默认折叠）。
          React.createElement(
            Card,
            {
              title: t('card.remote'),
              on: pubOn,
              // 开关放在标题行里（标题 —— 开关 —— 状态徽章），主视图上就只剩这一个动作
              extra: React.createElement('button', {
                type: 'button',
                className: 'dshRcSwitch' + (pubOn ? ' isOn' : ''),
                role: 'switch',
                'aria-checked': pubOn === true,
                'aria-label': t('card.remote'),
                disabled: state.busy === true || !canControl || !pubConfigured,
                onClick: (event) => {
                  // 别让点击冒泡到标题行（那张卡本身不是开关）
                  event.stopPropagation()
                  void act(pubOn ? '/public/stop' : '/public/start')
                },
              }),
              warn: pub !== null && pub !== undefined && !pubConfigured,
              badge:
                pub === null || pub === undefined || !pubConfigured
                  ? t('state.unconfigured')
                  : pubOn
                    ? tunnel !== null && tunnel.phase === 'up'
                      ? t('state.connected')
                      : tunnel === null
                        ? t('state.listening')
                        : phaseLabel(tunnel.phase)
                    : t('state.stopped'),
            },
            React.createElement(
              'div',
              { className: 'dshRcDesc' },
              pubConfigured
                ? tunnelMode === 'tailscale'
                  ? t('card.public.tailscale.desc')
                  : tunnelMode === 'relay'
                    ? t('card.public.relay.desc')
                    : t('card.public.desc')
                : t('card.public.unconfigured'),
            ),
            tunnelMode === 'tailscale'
              ? React.createElement('div', { className: 'dshRcWarn' }, t('card.public.tailscale.warn'))
              : null,
            relay !== null
              ? React.createElement(
                  'div',
                  { className: 'dshRcDesc' },
                  t('relay.name') + ' ' + String(relay.name || relay.subdomain || '—'),
                )
              : null,
            relay !== null ? React.createElement('div', { className: 'dshRcDesc' }, t('relay.link')) : null,
            pub !== null && pub !== undefined && pub.entry !== null && pub.entry !== undefined
              ? React.createElement(
                  'div',
                  {
                    className: 'dshRcUrl isWrap',
                    title: pub.entry,
                    tabIndex: 0,
                    role: 'textbox',
                    'aria-readonly': 'true',
                    onFocus: (event) => selectAll(event.currentTarget),
                    onClick: (event) => selectAll(event.currentTarget),
                  },
                  pub.entry,
                )
              : null,
            // 访问口令：面板里唯一需要用户记住的凭据
            React.createElement(
              'div',
              { className: 'dshRcDesc' },
              React.createElement('span', null, t('key.label')),
              React.createElement(
                'span',
                { className: 'dshRcKeyValue' },
                state.revealedKey !== null ? state.revealedKey : keyMasked,
              ),
            ),
            React.createElement(
              'div',
              { className: 'dshRcActions' },
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dshRcButton isGhost',
                  disabled: state.busy === true || state.keyBusy === true || !canControl || !canManageKey,
                  onClick: () => void revealKey(),
                },
                state.revealedKey !== null ? t('key.hide') : t('key.reveal'),
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  // 这是本卡片唯一的改口令入口，做成主按钮（不是 ghost）：
                  // 它已经不是"顺便可用"，而是全部动作。
                  className: 'dshRcButton',
                  disabled: state.busy === true || state.keyBusy === true || !canControl || !canManageKey,
                  onClick: () => void rotateKey(),
                },
                t('key.rotate'),
              ),
            ),
            React.createElement(
              'div',
              { className: 'dshRcMeta' },
              t('key.fingerprint') + ' ' + keyFingerprint + ' · ' + t('key.created') + ' ' + keyCreated +
                ' · ' + t('key.rotations', { count: keyRotations }) + ' · ' + t('key.longLived'),
            ),
            React.createElement(
              'div',
              { className: 'dshRcActions' },
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dshRcButton isGhost',
                  disabled: !canManageKey || pub === null || pub === undefined || pub.entry === null || pub.entry === undefined,
                  onClick: () => void copyEntryLink(),
                },
                state.keyCopied === true ? t('key.copied') : t('key.copy'),
              ),
            ),
            state.revealedKey !== null
              ? React.createElement(
                  'div',
                  { className: 'dshRcWarn' },
                  t('key.copyHint') + ' ' + t('key.onlyOnce'),
                )
              : React.createElement('div', { className: 'dshRcDesc' }, relay !== null ? t('key.relayHint') : t('key.hint')),
            // 信任提醒：共享出口 = 把机器交给出口管理员。必须先说清楚（不许「端到端加密」式漂亮话）
            relay !== null
              ? React.createElement('div', { className: 'dshRcWarn' }, t('card.public.relay.trust'))
              : null,
            pub !== null && pub !== undefined && pub.tunnelUrl
              ? React.createElement('input', {
                  className: 'dshRcUrl',
                  readOnly: true,
                  value: pub.tunnelUrl,
                  onFocus: (event) => event.target.select(),
                  onClick: (event) => event.target.select(),
                })
              : null,
            Array.isArray(qr) && qr.length > 0 ? React.createElement(QrCode, { rows: qr, t: t }) : null,
            Array.isArray(qr) && qr.length > 0
              ? React.createElement('div', { className: 'dshRcQrHint' }, t('qr.hint'))
              : null,
          ),

          // ══════ ⚙️ 设置（默认折叠）：专业功能都在这里 ══════
          React.createElement(
            Card,
            {
              title: t('card.settings'),
              on: state.settingsOpen === true,
              badge: state.settingsOpen === true ? t('settings.close') : t('settings.open'),
              // 折叠标题行就是开关（Card 会把它渲染成 <button aria-expanded>）
              onToggle: () => setState({ settingsOpen: !(state.settingsOpen === true) }),
            },
            React.createElement('div', { className: 'dshRcDesc' }, t('card.settings.desc')),
            state.settingsOpen === true
              ? React.createElement(
                  'div',
                  null,
                  // ── 连接方式：共享出口 ⇄ 自建服务器 ──
                  React.createElement(
                    'div',
                    { className: 'dshRcGroup' },
                    React.createElement('div', { className: 'dshRcGroupName' }, t('settings.mode')),
                    React.createElement(
                      'div',
                      { className: 'dshRcSeg' },
                      React.createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dshRcSegBtn' + (tunnelMode === 'relay' ? ' isOn' : ''),
                          'aria-pressed': tunnelMode === 'relay',
                          disabled: state.busy === true || !canControl,
                          onClick: () => void applyMode('relay'),
                        },
                        t('settings.mode.relay'),
                      ),
                      React.createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dshRcSegBtn' + (tunnelMode === 'ssh' ? ' isOn' : ''),
                          'aria-pressed': tunnelMode === 'ssh',
                          disabled: state.busy === true || !canControl,
                          onClick: () => void applyMode('ssh'),
                        },
                        t('settings.mode.selfhost'),
                      ),
                    ),
                    React.createElement('div', { className: 'dshRcMeta' }, t('settings.mode.hint')),
                    state.modeNotice !== null && state.modeNotice !== undefined
                      ? React.createElement('div', { className: 'dshRcMeta' }, state.modeNotice)
                      : null,
                  ),
                  // ── 出口地址与邀请码（共享出口那条路才有）──
                  relay !== null
                    ? React.createElement(
                        'div',
                        { className: 'dshRcGroup' },
                        React.createElement('div', { className: 'dshRcGroupName' }, t('settings.exitGroup')),
                        React.createElement('div', { className: 'dshRcDesc' }, exitLabel),
                        React.createElement('input', {
                          className: 'dshRcUrl dshRcInput',
                          type: 'text',
                          inputMode: 'url',
                          spellCheck: false,
                          autoComplete: 'off',
                          'aria-label': exitLabel,
                          value: exitValue,
                          placeholder: t('relay.exitPlaceholder'),
                          disabled: !canControl || state.exitBusy === true,
                          onChange: (event) => setState({ exitDraft: event.target.value, exitNotice: null }),
                        }),
                        React.createElement(
                          'div',
                          { className: 'dshRcActions' },
                          React.createElement('input', {
                            className: 'dshRcUrl dshRcInput',
                            type: 'text',
                            spellCheck: false,
                            autoComplete: 'off',
                            'aria-label': t('relay.invite'),
                            value: inviteValue,
                            placeholder: t('relay.invitePlaceholder'),
                            disabled: !canControl || state.exitBusy === true,
                            onChange: (event) => setState({ inviteDraft: event.target.value, exitNotice: null }),
                          }),
                          React.createElement(
                            'button',
                            {
                              type: 'button',
                              className: 'dshRcButton isGhost',
                              disabled: state.busy === true || state.exitBusy === true || !canControl || !exitDirty,
                              onClick: () => void applyExit(),
                            },
                            state.exitBusy === true ? t('state.busy') : t('relay.exitApply'),
                          ),
                        ),
                        React.createElement('div', { className: 'dshRcMeta' }, t('relay.exitHint')),
                        state.exitNotice !== null && state.exitNotice !== undefined
                          ? React.createElement('div', { className: 'dshRcMeta' }, state.exitNotice)
                          : null,
                      )
                    : null,
                  // ── 自建服务器 ──
                  React.createElement(
                    'div',
                    { className: 'dshRcGroup' },
                    React.createElement('div', { className: 'dshRcGroupName' }, t('settings.selfhost')),
                    React.createElement('div', { className: 'dshRcDesc' }, t('settings.selfhost.desc')),
                    // data 为 null（首次请求还没回来或失败）时不能取 config —— 否则面板直接崩
                    data !== null &&
                    data !== undefined &&
                    data.config !== undefined &&
                    data.config !== null &&
                    data.config.sshUser &&
                    tunnelMode === 'ssh'
                      ? React.createElement(
                          'div',
                          { className: 'dshRcMeta' },
                          t('state.tunnel') +
                            data.config.sshUser +
                            '@' +
                            (data.config.sshHost || pub.domain) +
                            (data.config.sshPort ? ':' + String(data.config.sshPort) : '') +
                            ' → 127.0.0.1:' +
                            String(data.config.remotePort ?? 8788),
                        )
                      : null,
                    tunnelMode === 'ssh'
                      ? React.createElement(
                          'div',
                          { className: 'dshRcActions' },
                          React.createElement(
                            'button',
                            {
                              type: 'button',
                              className: 'dshRcButton isGhost',
                              disabled: state.busy === true,
                              onClick: () => void loadSnippet(),
                            },
                            t('action.snippets'),
                          ),
                        )
                      : React.createElement('div', { className: 'dshRcMeta' }, t('settings.selfhost.switchFirst')),
                  ),
                  // ── 高级：局域网入口 + 多租户 ──
                  React.createElement(
                    'div',
                    { className: 'dshRcGroup' },
                    React.createElement('div', { className: 'dshRcGroupName' }, t('settings.advanced')),
                    React.createElement(
                      'div',
                      { className: 'dshRcHead' },
                      React.createElement('span', null, t('card.lan')),
                      React.createElement(
                        'span',
                        { className: 'dshRcBadge' + (lanOn ? ' isOn' : '') },
                        lanOn ? t('state.running') : t('state.stopped'),
                      ),
                    ),
                    React.createElement('div', { className: 'dshRcMeta' }, t('card.lan.desc')),
                    lan !== null && lan.url !== null && lan.url !== undefined
                      ? React.createElement('input', {
                          className: 'dshRcUrl',
                          readOnly: true,
                          value: lan.url,
                          onFocus: (event) => event.target.select(),
                          onClick: (event) => event.target.select(),
                        })
                      : null,
                    React.createElement(
                      'div',
                      { className: 'dshRcActions' },
                      React.createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dshRcButton' + (lanOn ? ' isGhost' : ''),
                          disabled: state.busy === true || !canControl,
                          onClick: () => void act(lanOn ? '/lan/stop' : '/lan/start'),
                        },
                        lanOn ? t('action.stop') : t('action.start'),
                      ),
                    ),
                    // 多租户：每人一个独立 Harness 实例
                    data !== null && data !== undefined && data.tenants !== undefined && data.tenants !== null
                      ? React.createElement(
                          'div',
                          { className: 'dshRcGroup' },
                          React.createElement(
                            'div',
                            { className: 'dshRcHead' },
                            React.createElement('span', null, t('card.tenants')),
                            React.createElement(
                              'span',
                              {
                                className:
                                  'dshRcBadge' +
                                  (data.tenants.enabled === true && (data.tenants.list ?? []).length > 0 ? ' isOn' : ''),
                              },
                              data.tenants.enabled !== true
                                ? t('state.unconfigured')
                                : t('tenants.count', { count: (data.tenants.list ?? []).length }),
                            ),
                          ),
                          React.createElement(
                            'div',
                            { className: 'dshRcMeta' },
                            data.tenants.enabled === true ? t('card.tenants.desc') : t('card.tenants.off'),
                          ),
                          // 找不到 harness 入口时直接说清楚，否则每个租户都会起不来
                          data.tenants.harness !== null &&
                          data.tenants.harness !== undefined &&
                          data.tenants.harness.problem !== null
                            ? React.createElement('div', { className: 'dshRcWarn' }, String(data.tenants.harness.problem))
                            : null,
                          data.tenants.enabled === true
                            ? React.createElement(
                                'div',
                                { className: 'dshRcActions' },
                                React.createElement('input', {
                                  className: 'dshRcUrl dshRcInput',
                                  placeholder: t('tenants.addPlaceholder'),
                                  value: state.tenantDraft ?? '',
                                  onChange: (event) => setState({ tenantDraft: event.target.value }),
                                  onKeyDown: (event) => {
                                    if (event.key === 'Enter') void tenantAdd()
                                  },
                                }),
                                React.createElement(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'dshRcButton',
                                    disabled: state.busy === true || !canControl || String(state.tenantDraft ?? '').trim() === '',
                                    onClick: () => void tenantAdd(),
                                  },
                                  t('tenants.add'),
                                ),
                              )
                            : null,
                          data.tenants.enabled === true && (data.tenants.list ?? []).length === 0
                            ? React.createElement('div', { className: 'dshRcDesc' }, t('tenants.empty'))
                            : null,
                          data.tenants.enabled === true
                            ? (data.tenants.list ?? []).map((tenant) =>
                                React.createElement(
                                  'div',
                                  { key: tenant.id, className: 'dshRcTenant' },
                                  React.createElement(
                                    'div',
                                    { className: 'dshRcHead' },
                                    React.createElement('span', null, tenant.name + ' · ' + tenant.id),
                                    React.createElement(
                                      'span',
                                      { className: 'dshRcBadge' + (tenant.running === true ? ' isOn' : '') },
                                      phaseLabel(tenant.phase),
                                    ),
                                  ),
                                  React.createElement(
                                    'div',
                                    { className: 'dshRcDesc' },
                                    tenant.running === true
                                      ? t('tenants.port') + ' ' + String(tenant.port) + (tenant.restarts > 0 ? ' · ' + t('tenants.restarts', { count: tenant.restarts }) : '')
                                      : t('tenants.notRunning'),
                                  ),
                                  tenant.detail
                                    ? React.createElement('div', { className: 'dshRcDesc' }, tenant.detail)
                                    : null,
                                  tenant.hint ? React.createElement('div', { className: 'dshRcWarn' }, tenant.hint) : null,
                                  tenant.lanEntry !== null && tenant.lanEntry !== undefined
                                    ? React.createElement('input', {
                                        className: 'dshRcUrl',
                                        readOnly: true,
                                        value: tenant.lanEntry,
                                        onFocus: (event) => event.target.select(),
                                        onClick: (event) => event.target.select(),
                                      })
                                    : null,
                                  React.createElement(
                                    'div',
                                    { className: 'dshRcActions' },
                                    React.createElement(
                                      'button',
                                      {
                                        type: 'button',
                                        className: 'dshRcButton' + (tenant.running === true ? ' isGhost' : ''),
                                        disabled: state.busy === true || !canControl,
                                        onClick: () => void tenantAction(tenant.running === true ? 'stop' : 'start', { id: tenant.id }),
                                      },
                                      tenant.running === true ? t('action.stop') : t('action.start'),
                                    ),
                                    React.createElement(
                                      'button',
                                      {
                                        type: 'button',
                                        className: 'dshRcButton isGhost',
                                        disabled: state.busy === true || !canControl,
                                        onClick: () => void tenantQr(tenant.id),
                                      },
                                      state.tenantQrId === tenant.id ? t('tenants.hideQr') : t('tenants.qr'),
                                    ),
                                    React.createElement(
                                      'button',
                                      {
                                        type: 'button',
                                        className: 'dshRcButton isGhost',
                                        disabled: state.busy === true || !canControl,
                                        title: t('tenants.rotate'),
                                        onClick: () => void tenantAction('rotate', { id: tenant.id }),
                                      },
                                      t('tenants.rotate'),
                                    ),
                                    React.createElement(
                                      'button',
                                      {
                                        type: 'button',
                                        className: 'dshRcButton isGhost',
                                        disabled: state.busy === true || !canControl,
                                        onClick: () => {
                                          if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
                                            if (window.confirm(t('tenants.confirmRemove', { name: tenant.name })) !== true) return
                                          }
                                          void tenantAction('remove', { id: tenant.id })
                                        },
                                      },
                                      t('tenants.remove'),
                                    ),
                                  ),
                                  state.tenantQrId === tenant.id && Array.isArray(state.tenantQr)
                                    ? React.createElement(QrCode, { rows: state.tenantQr, t: t })
                                    : null,
                                ),
                              )
                            : null,
                          data.tenants.enabled === true && (data.tenants.list ?? []).length > 0
                            ? React.createElement('div', { className: 'dshRcDesc' }, t('tenants.encourageCredentials'))
                            : null,
                        )
                      : null,
                  ),
                  // ── 诊断 ──
                  React.createElement(
                    'div',
                    { className: 'dshRcGroup' },
                    React.createElement('div', { className: 'dshRcGroupName' }, t('settings.diag')),
                    tunnel !== null && tunnel.detail
                      ? React.createElement(
                          'div',
                          { className: 'dshRcDesc' },
                          t('state.tunnel') + phaseLabel(tunnel.phase) + ' (' + tunnel.detail + ')',
                        )
                      : null,
                    tunnel !== null && tunnel.hint !== undefined && tunnel.hint !== null
                      ? React.createElement('div', { className: 'dshRcWarn' }, tunnel.hint)
                      : null,
                    React.createElement(
                      'div',
                      { className: 'dshRcActions' },
                      React.createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dshRcButton isGhost',
                          disabled: state.busy === true,
                          onClick: () => void runCheck(),
                        },
                        t('action.check'),
                      ),
                    ),
                    Array.isArray(state.checkResults)
                      ? React.createElement(
                          'div',
                          { className: 'dshRcCheck' },
                          // 检查结果由宿主按当前语言渲染；这里只排版，不加任何语言相关的标点
                          state.checkResults.map((item, index) =>
                            React.createElement(
                              'div',
                              { key: String(index), className: 'dshRcCheckRow' },
                              React.createElement(
                                'div',
                                { className: 'dshRcCheckHead' },
                                React.createElement('span', { className: 'dshRcCheckMark' }, item.ok ? '✔' : '✖'),
                                React.createElement('b', null, item.name),
                              ),
                              React.createElement('div', { className: 'dshRcCheckDetail' }, item.detail),
                              item.ok === false && item.hint
                                ? React.createElement('div', { className: 'dshRcCheckHint' }, item.hint)
                                : null,
                            ),
                          ),
                        )
                      : null,
                    typeof state.snippet === 'string'
                      ? React.createElement('div', { className: 'dshRcSnippet' }, state.snippet)
                      : null,
                  ),
                )
              : null,
          ),
          state.error !== null && state.error !== undefined
            ? React.createElement('div', { className: 'dshRcError' }, state.error)
            : null,
        ),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      ctxRef = ctx
      const locale = ctx.get('locale')
      if (locale !== undefined) {
        ctx.effect(() => locale.register(NS, { zh, en }), 'remote-connect: dictionaries')
      }
      slots.inject('sidebar.footer.action', () =>
        slots.register(
          // 侧栏不投影 footer action 的 label（真正显示的是组件内的 t() 文案），这里只作兜底
          { name: 'sidebar.footer.action', id: 'remote-connect', order: -100, label: '远程连接', locale: NS },
          Entry,
        ),
      )
      slots.inject('shell.overlay', () =>
        slots.register({ name: 'shell.overlay', id: 'remote-connect-panel', order: 40, locale: NS }, Panel),
      )
    }

    // locale 是软依赖：没有它时组件用 key 兜底渲染，插件仍然可用
    const inject = ['slots', 'locale']

    exports.apply = apply
    exports.inject = inject
    /** 供测试/排障使用；装载器只读 apply 与 inject，忽略其它导出。 */
    exports.internals = {
      store,
      setState,
      api,
      refresh,
      act,
      runCheck,
      loadSnippet,
      currentLocale,
      tenantAction,
      tenantAdd,
      tenantQr,
      revealKey,
      copyEntryLink,
      rotateKey,
    }
    return module.exports
  },
})
