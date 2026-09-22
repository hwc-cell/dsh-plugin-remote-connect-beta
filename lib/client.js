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
      'action.start': '开启',
      'action.stop': '停止',
      'action.check': '检查服务器',
      'action.snippets': '服务器配置',
      'card.lan': '本地网络连接',
      'card.lan.desc': '同一 Wi-Fi 下的手机/电脑直接打开；窄屏已做手机适配（侧栏浮层 + 点击遮罩关闭）。',
      'card.public': '公网连接',
      'card.public.desc': '经你的服务器提供 HTTPS 入口（访问密钥门；边缘口令可选）。',
      'card.public.unconfigured': '在插件配置里填 public.domain 与 public.ssh 后可用。',
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
      'key.current': '当前口令',
      'key.new': '新口令（≥12 位）',
      'key.confirm': '再输一次新口令',
      'key.change': '修改口令',
      'key.changeHint': '修改必须先验证当前口令；验证不过不会写入任何东西。',
      'key.mismatchLocal': '两次输入的新口令不一致（或还有空项）',
      'key.reset': '重置口令（忘记当前口令时）',
      'key.resetConfirm': '这是「重置」不是「修改」：不需要当前口令，但旧链接、旧 Cookie、旧二维码会立即全部失效，并且会记一条本机审计。确定继续？',
      'key.resetDone': '已重置。请在浏览器/密码管理器里删掉旧口令，用新口令重新登录。',
      'key.label': '访问口令',
      'key.reveal': '显示',
      'key.hide': '收起',
      'key.rotate': '生成新的',
      'key.rotateConfirm': '生成新的访问口令？旧链接和已发出的登录状态会立刻失效，需要重新扫码。',
      'key.hint': '口令由运行 Harness 的这台机器生成并校验（它就是链接里的 ?k=）：你的服务器只负责转发请求，看不到也存不到它。改它不用动服务器。',
      'key.copyHint': '已显示：复制后存进密码管理器；收起后不再显示。',
      'card.tenants': '租户（每人一个独立 Harness）',
      'card.tenants.desc': '每个租户跑在自己独立的 Harness 实例里：独立 DSH_HOME、独立端口、独立令牌。会话、凭据、工作区互不可见。',
      'card.tenants.off': '多租户未启用（插件配置里打开 tenants.enabled）。',
      'tenants.count': '{count} 个租户',
      'tenants.addPlaceholder': '给谁用？输入名字，例如：张三',
      'tenants.add': '新增租户',
      'tenants.remove': '删除',
      'tenants.rotate': '换密钥',
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
      'action.start': 'Start',
      'action.stop': 'Stop',
      'action.check': 'Check server',
      'action.snippets': 'Server config',
      'card.lan': 'Local network',
      'card.lan.desc': 'Phones and computers on the same Wi-Fi open it directly; narrow screens get a drawer layout.',
      'card.public': 'Public access',
      'card.public.desc': 'HTTPS entry through your own server (access key gate; edge password optional).',
      'card.public.unconfigured': 'Set public.domain and public.ssh in the plugin config to enable.',
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
      'key.current': 'Current password',
      'key.new': 'New password (12+ chars)',
      'key.confirm': 'Repeat the new password',
      'key.change': 'Change password',
      'key.changeHint': 'Changing verifies the current password first; nothing is written if verification fails.',
      'key.mismatchLocal': 'The two new passwords do not match (or a field is empty)',
      'key.reset': 'Reset password (forgot the current one)',
      'key.resetConfirm': 'This is a RESET, not a change: it needs no current password, but every old link, cookie and QR code stops working immediately, and a local audit line is written. Continue?',
      'key.resetDone': 'Reset done. Delete the old password from your browser/password manager and sign in with the new one.',
      'key.label': 'Access password',
      'key.reveal': 'Show',
      'key.hide': 'Hide',
      'key.rotate': 'Generate new',
      'key.rotateConfirm': 'Generate a new access password? Old links and issued sessions stop working immediately; you will need to scan again.',
      'key.hint': 'This password is generated and checked by the machine running the Harness (it is the ?k= in your link): your server only forwards requests — it never sees or stores it. Changing it does not touch the server.',
      'key.copyHint': 'Shown once: copy it into your password manager. Hiding it will not show it again without another click.',
      'card.tenants': 'Tenants (one Harness each)',
      'card.tenants.desc': 'Every tenant runs in its own Harness instance: own DSH_HOME, own port, own launch token. Sessions, credentials and workspaces are not shared.',
      'card.tenants.off': 'Multi-tenancy is off (set tenants.enabled in the plugin config).',
      'tenants.count': '{count} tenants',
      'tenants.addPlaceholder': 'Who is it for? Type a name, e.g. Alice',
      'tenants.add': 'Add tenant',
      'tenants.remove': 'Remove',
      'tenants.rotate': 'New key',
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

    const CSS = [
      '.dshRcRow{display:flex;align-items:center;gap:8px;width:calc(100% + 4px);margin:4px -2px}',
      '.dshRcRow.isRail{width:36px;margin:8px 0 10px}',
      '.dshRcTrigger{box-sizing:border-box;cursor:pointer;min-width:0;height:42px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:12px;flex:1;display:flex;align-items:center;gap:8px;margin:0;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;overflow:hidden}',
      '.dshRcTrigger:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshRcTrigger.isRail{corner-shape:round;border-radius:50%;flex:none;justify-content:center;gap:0;width:36px;height:36px;margin:0;padding:0}',
      '.dshRcTriggerLabel{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshRcDot{width:7px;height:7px;border-radius:50%;flex:none;margin-left:auto;background:var(--dsw-alias-state-warn-primary,#f59e0b)}',
      '.dshRcDot.isOk{background:var(--dsw-alias-state-success-primary,#22c55e)}',
      '.dshRcDot.isBad{background:var(--dsw-alias-state-error-primary,#ef4444)}',
      '.dshRcDot.isOff{background:var(--dsw-alias-state-warn-primary,#f59e0b)}',
      '.dshRcLayer{position:absolute;inset:0;z-index:60;pointer-events:auto}',
      '.dshRcBackdrop{position:absolute;inset:0;background:transparent}',
      '.dshRcPanel{position:absolute;left:12px;bottom:104px;width:344px;max-width:calc(100vw - 24px);max-height:calc(100vh - 140px);overflow:auto;box-sizing:border-box;padding:14px;border-radius:14px;background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));box-shadow:0 16px 40px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
      '.dshRcTitle{font-size:14px;font-weight:600;margin-bottom:2px}',
      '.dshRcHint{color:var(--dsw-alias-label-secondary);margin-bottom:10px}',
      '.dshRcCard{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:10px;padding:10px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1,transparent)}',
      '.dshRcCard.isOn{border-color:var(--dsw-alias-brand-primary)}',
      '.dshRcHead{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600}',
      '.dshRcDesc{color:var(--dsw-alias-label-secondary);margin-top:4px}',
      '.dshRcBadge{font-size:11px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);flex:none;font-weight:500}',
      '.dshRcBadge.isOn{background:var(--dsw-alias-state-success-primary);color:#fff}',
      '.dshRcBadge.isWarn{background:var(--dsw-alias-state-warn-primary);color:#fff}',
      '.dshRcUrl{width:100%;box-sizing:border-box;margin-top:8px;font-family:var(--ds-font-family-code,monospace);font-size:12px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.dshRcQr{margin-top:10px;display:flex;justify-content:center;background:#fff;border-radius:10px;padding:8px}',
      '.dshRcQrHint{margin-top:6px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dshRcActions{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}',
      '.dshRcButton{cursor:pointer;border:none;border-radius:8px;padding:6px 14px;font:inherit;font-weight:500;background:var(--dsw-alias-brand-primary,#2f6fed);color:#fff}',
      '.dshRcButton.isGhost{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1)}',
      '.dshRcButton:disabled{opacity:.55;cursor:default}',
      '.dshRcWarn{margin-top:8px;color:var(--dsw-alias-state-warn-primary)}',
      '.dshRcError{margin-top:8px;color:var(--dsw-alias-state-error-primary);word-break:break-word}',
      '.dshRcCheck{margin-top:8px;font-size:12px;display:flex;flex-direction:column;gap:6px}',
      '.dshRcCheckRow{color:var(--dsw-alias-label-secondary)}',
      '.dshRcCheckHead{display:flex;align-items:baseline;gap:6px}',
      '.dshRcCheckHead b{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dshRcCheckMark{flex:none}',
      '.dshRcCheckDetail{word-break:break-word}',
      '.dshRcCheckHint{color:var(--dsw-alias-state-warn-primary,rgba(180,83,9,1))}',
      '.dshRcTenant{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:10px;padding:8px;margin-top:8px}',
      '.dshRcInput{cursor:text;flex:1 1 140px;width:auto;min-width:0}',
      '.dshRcInput::placeholder{color:var(--dsw-alias-label-secondary,rgba(0,0,0,.45))}',
      '.dshRcKeyValue{margin-left:6px;font-family:var(--ds-font-family-code,monospace)}',
      // ── 深色模式：主题变量优先；只有拿不到变量（或我们写死的地方）时才用这里的兜底 ──
      '@media (prefers-color-scheme: dark){',
      '.dshRcPanel{background:var(--dsw-alias-bg-overlay,#1f2126);border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.12));box-shadow:0 16px 40px rgba(0,0,0,.5)}',
      '.dshRcCard,.dshRcTenant{border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.12))}',
      '.dshRcUrl{background:var(--dsw-alias-bg-base,#17181c);border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.12))}',
      // 二维码保持白底黑码：反色会导致部分手机扫不出来
      '.dshRcSnippet{background:var(--dsw-alias-bg-base,#17181c);border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.12))}',
      '.dshRcCheckHint{color:var(--dsw-alias-state-warn-primary,#fbbf24)}',
      '.dshRcInput::placeholder{color:var(--dsw-alias-label-secondary,rgba(255,255,255,.5))}',
      '.dshRcButton.isGhost{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08));border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.14))}',
      '}',
      '.dshRcSnippet{margin-top:8px;max-height:180px;overflow:auto;white-space:pre;font-family:var(--ds-font-family-code,monospace);font-size:11px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px}',
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
      keyCurrent: '',
      keyNext: '',
      keyConfirm: '',
      keyCopied: false,
      tenantQr: null,
      tenantQrId: null,
      tenantDraft: '',
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
     * 组件外的文案：面板动作（changeKey/resetKey）不在 React 里，拿不到 props.t，
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
     * 修改访问口令：先把「当前口令」送宿主半校验，通过才写新口令。
     * 校验与写入是两次调用（规范 §4），避免"旧口令错了但新口令已经写进去"。
     */
    async function changeKey() {
      const current = String(store.keyCurrent ?? '')
      const next = String(store.keyNext ?? '')
      const confirm = String(store.keyConfirm ?? '')
      if (current === '' || next === '' || next !== confirm) {
        setState({ error: tt('key.mismatchLocal') })
        return
      }
      setState({ keyBusy: true, error: null })
      const verdict = await api('/access-key/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: current }),
      })
      if (verdict.ok === false) {
        setState({ keyBusy: false, error: verdict.error })
        return
      }
      const payload = await api('/access-key/rotate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current, password: next, confirm }),
      })
      await refresh()
      setState({
        keyBusy: false,
        keyCurrent: payload.ok === false ? store.keyCurrent : '',
        keyNext: payload.ok === false ? store.keyNext : '',
        keyConfirm: payload.ok === false ? store.keyConfirm : '',
        revealedKey: typeof payload.accessKey === 'string' ? payload.accessKey : null,
        error: payload.ok === false ? payload.error : null,
      })
    }

    /** 重置（忘记口令）：不需要旧口令，但必须显式确认 —— UI 上写明这是降级路径。 */
    async function resetKey() {
      if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        if (window.confirm(tt('key.resetConfirm')) !== true) return
      }
      setState({ keyBusy: true, error: null })
      const payload = await api('/access-key/rotate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reset: true, acknowledge: true }),
      })
      await refresh()
      setState({
        keyBusy: false,
        revealedKey: typeof payload.accessKey === 'string' ? payload.accessKey : null,
        error: payload.ok === false ? payload.error : tt('key.resetDone'),
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
      return React.createElement(
        'div',
        { className: 'dshRcCard' + (props.on ? ' isOn' : '') },
        React.createElement(
          'div',
          { className: 'dshRcHead' },
          React.createElement('span', null, props.title),
          React.createElement(
            'span',
            { className: 'dshRcBadge' + (props.on ? ' isOn' : props.warn ? ' isWarn' : '') },
            props.badge,
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
      const pubConfigured = pub !== null && pub !== undefined && (pub.domain !== '' || tunnelMode === 'tailscale')
      // 访问口令的掩码：state 还没回来（pub 为 null）时也要能渲染，不能崩
      const keyMasked = pub === null || pub === undefined ? '—' : String(pub.accessKeyMasked ?? '—')
      const keyFingerprint = pub === null || pub === undefined ? '—' : String(pub.accessKeyFingerprint ?? '—')
      const keyCreated = pub === null || pub === undefined ? '—' : String(pub.accessKeyCreatedAt ?? '—').slice(0, 19).replace('T', ' ')
      const keyRotations = pub === null || pub === undefined ? 0 : Number(pub.accessKeyRotations ?? 0)
      const canManageKey = pub !== null && pub !== undefined
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

          React.createElement(
            Card,
            { title: t('card.lan'), on: lanOn, badge: lanOn ? t('state.running') : t('state.stopped') },
            React.createElement(
              'div',
              { className: 'dshRcDesc' },
              t('card.lan.desc'),
            ),
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
          ),

          React.createElement(
            Card,
            {
              title: t('card.public'),
              on: pubOn,
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
                  : t('card.public.desc')
                : t('card.public.unconfigured'),
            ),
            // data 为 null（首次请求还没回来或失败）时不能取 config —— 否则面板直接崩
            data !== null &&
            data !== undefined &&
            data.config !== undefined &&
            data.config !== null &&
            data.config.sshUser &&
            tunnelMode === 'ssh'
              ? React.createElement(
                  'div',
                  { className: 'dshRcDesc' },
                  t('state.tunnel') +
                    data.config.sshUser +
                    '@' +
                    (data.config.sshHost || pub.domain) +
                    (data.config.sshPort ? ':' + String(data.config.sshPort) : '') +
                    ' → 127.0.0.1:' +
                    String(data.config.remotePort ?? 8788),
                )
              : null,
            pub !== null && pub !== undefined && pub.entry !== null && pub.entry !== undefined
              ? React.createElement('input', {
                  className: 'dshRcUrl',
                  readOnly: true,
                  value: pub.entry,
                  onFocus: (event) => event.target.select(),
                  onClick: (event) => event.target.select(),
                })
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
                  className: 'dshRcButton isGhost',
                  disabled: state.busy === true || state.keyBusy === true || !canControl || !canManageKey,
                  onClick: () => void rotateKey(),
                },
                t('key.rotate'),
              ),
            ),
            React.createElement(
              'div',
              { className: 'dshRcDesc' },
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
            React.createElement('input', {
              className: 'dshRcUrl dshRcInput',
              type: 'password',
              placeholder: t('key.current'),
              value: state.keyCurrent ?? '',
              onChange: (event) => setState({ keyCurrent: event.target.value }),
            }),
            React.createElement('input', {
              className: 'dshRcUrl dshRcInput',
              type: 'password',
              placeholder: t('key.new'),
              value: state.keyNext ?? '',
              onChange: (event) => setState({ keyNext: event.target.value }),
            }),
            React.createElement('input', {
              className: 'dshRcUrl dshRcInput',
              type: 'password',
              placeholder: t('key.confirm'),
              value: state.keyConfirm ?? '',
              onChange: (event) => setState({ keyConfirm: event.target.value }),
            }),
            React.createElement(
              'div',
              { className: 'dshRcActions' },
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dshRcButton',
                  disabled:
                    state.busy === true ||
                    state.keyBusy === true ||
                    !canControl ||
                    String(state.keyCurrent ?? '') === '' ||
                    String(state.keyNext ?? '') === '',
                  onClick: () => void changeKey(),
                },
                t('key.change'),
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dshRcButton isGhost',
                  disabled: state.busy === true || state.keyBusy === true || !canControl,
                  onClick: () => void resetKey(),
                },
                t('key.reset'),
              ),
            ),
            state.revealedKey !== null
              ? React.createElement('div', { className: 'dshRcWarn' }, t('key.copyHint'))
              : React.createElement('div', { className: 'dshRcDesc' }, t('key.changeHint')),
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
            pub !== null && pub !== undefined && pub.tunnelUrl
              ? React.createElement('input', {
                  className: 'dshRcUrl',
                  readOnly: true,
                  value: pub.tunnelUrl,
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
                  className: 'dshRcButton' + (pubOn ? ' isGhost' : ''),
                  disabled: state.busy === true || !canControl || !pubConfigured,
                  onClick: () => void act(pubOn ? '/public/stop' : '/public/start'),
                },
                pubOn ? t('action.stop') : t('action.start'),
              ),
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
              tunnelMode === 'ssh'
                ? React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'dshRcButton isGhost',
                      disabled: state.busy === true,
                      onClick: () => void loadSnippet(),
                    },
                    t('action.snippets'),
                  )
                : null,
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

          // ── 多租户：每人一个独立 Harness 实例 ──
          data !== null && data !== undefined && data.tenants !== undefined && data.tenants !== null
            ? React.createElement(
                Card,
                {
                  title: t('card.tenants'),
                  on: data.tenants.enabled === true && (data.tenants.list ?? []).length > 0,
                  badge:
                    data.tenants.enabled !== true
                      ? t('state.unconfigured')
                      : t('tenants.count', { count: (data.tenants.list ?? []).length }),
                },
                React.createElement(
                  'div',
                  { className: 'dshRcDesc' },
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
          Array.isArray(qr) && qr.length > 0 ? React.createElement(QrCode, { rows: qr, t: t }) : null,
          Array.isArray(qr) && qr.length > 0
            ? React.createElement('div', { className: 'dshRcQrHint' }, t('qr.hint'))
            : null,
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
      changeKey,
      resetKey,
    }
    return module.exports
  },
})
