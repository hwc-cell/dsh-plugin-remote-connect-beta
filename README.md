# dsh-plugin-remote-connect

English | [中文](README.zh.md)

> ⚠️ **Read this first.** This plugin exposes an agent that **runs commands and reads/writes files on your machine** to the network. If it is compromised, your machine is compromised. Treat it as "publishing a host that can execute arbitrary commands", not as an ordinary web tool.
>
> The author **does not operate any hosted or relay service**, and no live instance address appears in these docs — bring your own server and domain. Threat model, credential handling, and vulnerability reporting live in [SECURITY.md](SECURITY.md).

Give a **DSH Harness** a remote entry point: over your local network, or over the public internet through your own server. Any phone, tablet, or computer with a modern browser can use it — no client to install, no VPN.

Two ways to use it, one shared core:

- **DSH plugin** — a "Remote access" panel above *Settings* in the sidebar, with switches, addresses, and a QR code.
- **Standalone CLI** — `dsh-remote serve / check / doctor / snippets / keygen / setup-server / uninstall-server`, usable without DSH and convenient for debugging on a server.

---

## Four backends (pick one; same core)

| Backend | Work required on the server | Who it suits | Reachability in mainland China |
| --- | --- | --- | --- |
| `lan` | **0 items** | Phone/computer on the same Wi-Fi | No external dependency ✅ |
| `cloudflare` | **0 items** (install `cloudflared`, authorize; brings its own certificate, Cloudflare Access available) | Most people | ⚠️ unstable |
| `tailscale` | **0 items** (`tailscale funnel`; brings its own certificate and domain) | People who prefer not to use Cloudflare | ⚠️ unstable |
| `selfhost` | **6 items**: DNS / certificate / nginx reverse proxy / edge password / dedicated ssh account / self-test — step-by-step guide: [`docs/self-host.md`](docs/self-host.md) | People with a VPS and their own domain who want full control | ✅ recommended for mainland users |

> Hosted tunnels are **unreliable from mainland China**, so `selfhost` is a first-class backend rather than a patch: for those users, "own VPS + own domain" is usually a hard requirement.

**Implementation status (honest, not marketing):**

| Capability | Status |
| --- | --- |
| `lan` backend (panel + CLI + mobile layout + QR) | ✅ implemented; verified end to end |
| `selfhost` backend (ssh -R tunnel, config generation, preflight) | ✅ implemented; the six server-side items are delivered by a generated installer script |
| `cloudflare` backend | ✅ implemented as a tunnel mode (`--tunnel cloudflared`); ⚠️ not exercised in this environment |
| `tailscale` backend | ✅ implemented as a tunnel mode (`--tunnel tailscale` / `public.tunnel: tailscale`): runs `tailscale funnel --bg` against the loopback port, reads the node's `ts.net` address from `tailscale status --json`, probes the funnel every 60s, and removes exactly its own mapping on stop. ⚠️ not exercised against a real tailnet in this environment (argv, URL parsing, start/stop and the failure path are unit-tested with a stub binary) |
| `setup-server` / `uninstall-server` | ✅ implemented: idempotent install/uninstall script (`probe` / `install` / `uninstall` / `--dry-run` / `--skip-*`) that only writes files it owns; the generated script passes `bash -n` and the generator rejects shell injection in its inputs |
| `doctor` | ✅ implemented: upstream provenance, proxy self-test, four public checks, live certificate expiry, `--expect-cert-sha256` cross-machine fingerprint comparison, local key-leak check |
| Port / token discovery (no hardcoded 3080 or 43129) | ✅ official `webServer.port` first; `/state` exposes `upstream.source` to prove it |
| Token acquisition (no log scraping) | ✅ official `connection.authenticatedUrl()`, resolved lazily; the log fallback accepts **only a start line whose port matches this process** |
| Credentials never persisted | ✅ `?k=` never reaches logs (the generated template redacts by default); no secrets in the repository |
| Config validation | ✅ exports `Config` as a zero-dependency Standard Schema: out-of-range ports, malformed domains, unknown `tunnel` values fail **before activation** |
| Bilingual panel | ✅ zh/en dictionaries (29 keys each) with `locale` as a soft dependency |
| Bilingual host-side text | ✅ one catalog (`lib/core/messages.js`, 87 keys per language) renders preflight results, tunnel state and panel API errors in the language the panel asks for (`?locale=`); `doctor`/`setup-server`/`keygen` detail output is still Chinese-only and prints an English notice (see CHANGELOG) |
| Certificate "is it actually served?" | ✅ two paths: the installer compares served vs on-disk live, and prints `--expect-cert-sha256` for `doctor` to verify from outside |

---

## Why it exists (and not just "open a port")

The Harness web server binds `127.0.0.1` only, so nothing else can reach it. Pointing a public domain straight at it also fails: the `/api` transport has a DNS-rebinding fence that trusts loopback or declared authorities only.

This plugin sits in between and does the three things that make it work:

1. **Rewrites `Host`/`Origin`** to `127.0.0.1:<upstream port>` so the fence passes.
2. **Injects `?token=` on first visit** (the process launch token) to mint the browser-session cookie — the token stays inside the process, never in URL history or logs.
3. **Injects a same-origin stylesheet and a tiny shim** into the index so narrow screens work: the sidebar becomes an overlay drawer, the conversation keeps full width, tapping the scrim closes it, and safe-area insets apply.

Public mode adds an **access-key gate**: anything without a valid `?k=` gets a plain 404 (deliberately not 401, to avoid advertising that something is there).

---

## Install (DSH plugin)

```bash
# 1) install into the profile directory (DSH resolves plugin names from there)
cd "$HOME/Library/Application Support/dsh-desktop/harness/profiles/web"   # or ${DSH_HOME:-$HOME/.dsh}/profiles/web
npm install dsh-plugin-remote-connect

# 2) add one entry to cordis.patch.yml in the same directory
# 3) restart DSH Desktop
```

```yaml
- insert:
    - id: dsh-plugin-remote-connect
      name: dsh-plugin-remote-connect
      config:
        lan:
          enabled: true
          port: 8787
        public:
          enabled: false
          domain: dsh.example.com
          port: 8788
          tunnel: ssh            # ssh | cloudflared | tailscale | none
          tailscale:             # only for tunnel: tailscale
            path: tailscale      # client binary
            httpsPort: 443       # funnel's public HTTPS port (served by tailscaled)
            probeMs: 60000       # funnel health probe interval
          ssh:
            user: dshtunnel
            host: dsh.example.com
            keyPath: ~/.ssh/dsh_remote_tunnel
            port: 22022          # server sshd port; a non-22 port must be given
            remotePort: 8788
```

> Keep `id` equal to the package name (the shipped patches do the same), and do **not** also pass the same file with `--patch`: the profile's `cordis.patch.yml` is already loaded, and applying it twice fails with `duplicate loader entry id`.

Panel switches work **only in the host window** (loopback, not through a proxy); remote visitors get a read-only panel. That is deliberate — a remote visitor must not be able to change what you expose.

---

## Install (CLI only)

```bash
npx dsh-plugin-remote-connect serve        # LAN entry; prints a QR code in the terminal
```

Public entry with your own server:

```bash
# 1) tunnel key pair + the restricted authorized_keys line to paste on the server
dsh-remote keygen

# 2) generate the server installer and review it before running anything
dsh-remote setup-server --domain dsh.example.com --ssh-user dshtunnel --out /tmp/dsh-setup.sh
scp /tmp/dsh-setup.sh <server>:/tmp/
ssh <server> "sudo bash /tmp/dsh-setup.sh probe"                # probe only
ssh <server> "sudo bash /tmp/dsh-setup.sh install --dry-run"    # print every step it would take
ssh <server> "sudo bash /tmp/dsh-setup.sh install"              # idempotent install

# 3) start the proxy and the tunnel (reconnects with backoff)
dsh-remote serve --public --key "$(openssl rand -hex 16)" --domain dsh.example.com \
    --tunnel ssh --ssh-user dshtunnel --ssh-host dsh.example.com --ssh-port 22022 \
    --ssh-key ~/.ssh/dsh_remote_tunnel
#   → public entry: https://dsh.example.com/?k=<key>

# 4) health check
dsh-remote doctor --domain dsh.example.com --user dsh --password '<edge password>' \
    --ssh-user dshtunnel --ssh-host dsh.example.com --ssh-port 22022 --key '<access key>'

# remove it again
dsh-remote uninstall-server --domain dsh.example.com --out /tmp/dsh-uninstall.sh
ssh <server> "sudo bash /tmp/dsh-uninstall.sh"
```

**No server at all?** Two zero-setup backends:

```bash
# 1) tailscale funnel — your own machine is the exit; the node's ts.net name is the address
tailscale up                        # once, if you have not joined a tailnet
dsh-remote serve --public --key "$(openssl rand -hex 16)" --tunnel tailscale
#    or in cordis.patch.yml:  public: { enabled: true, tunnel: tailscale }
#    the panel shows https://<node>.<tailnet>.ts.net/ once the funnel is up
#    (Funnel must be enabled for the node in the Tailscale admin console; the plugin
#     prints a hint if it is not)

# 2) cloudflared — temporary public address
dsh-remote serve --public --key "$(openssl rand -hex 16)" --tunnel cloudflared
```

Both keep the access key gate: the public address is useless without `?k=<key>`, and the proxy still talks to the Harness over loopback only.

---

## Commands

| Command | Purpose |
| --- | --- |
| `serve` | Start the proxy; `--public` binds loopback only and enforces the key gate; `--tunnel ssh\|cloudflared\|tailscale` also starts a tunnel |
| `check` | DNS / certificate / edge password / ssh tunnel (or tailscale funnel), each with a verdict and a fix; text follows `--lang` / `DSH_REMOTE_LANG` / `LANG` |
| `doctor` | Full physical: upstream provenance, proxy self-test, the four public checks, **the certificate actually served**, `--expect-cert-sha256` comparison, plus the checks only the server can run |
| `snippets` | Print nginx / Caddy fragments and the `authorized_keys` line (for people who prefer to hand-write config) |
| `keygen` | Generate the tunnel ed25519 key pair (default `~/.ssh/dsh_remote_tunnel`) |
| `setup-server` | Generate the server installer (prints by default; `probe` / `install` / `--dry-run` inside) |
| `uninstall-server` | Generate a standalone uninstall script (`--purge-user` also removes the account) |

Common flags: `--port`, `--upstream`, `--token`, `--domain` (repeatable), `--no-mobile`, `--json`; tunnel flags: `--ssh-user`, `--ssh-host`, `--ssh-key`, **`--ssh-port`**, `--remote-port`.

---

## Security model

The public entry point fronts a machine that can execute commands, so the gates are real:

- **Edge password** (nginx `auth_basic` / Caddy `basic_auth` / Cloudflare Access): keeps out anyone who merely knows the address.
- **Access key `?k=`** (this plugin, on by default): if the edge configuration is ever loosened or bypassed, the attacker still gets a 404. Rotating the key invalidates old links immediately.
- **Harness session token**: injected only for requests that passed the first two gates.

Where each backend sits on that ladder:

| Backend | Who can reach it | Gates in front of it |
| --- | --- | --- |
| `lan` | Anything on the same network | Harness session only — **no access key by design**, because the LAN entry exists so a phone can open the address with no ceremony. On an untrusted network (campus, hotel, office guest Wi-Fi), use the public backend instead |
| `selfhost` | The internet | edge password + `?k=` + Harness session |
| `cloudflared` | The (temporary) internet address | `?k=` + Harness session — add Cloudflare Access if you keep it |
| `tailscale` | Your tailnet (and, with Funnel, the public internet) | `?k=` + Harness session; Tailscale ACLs if you keep it tailnet-only |

Hygiene rules the code enforces:

- `serve --public` refuses to start without `--key` (unless you explicitly pass `--allow-no-key`, which is not recommended).
- The generated server template logs a **redacted** request line (`$uri`, no query), so `?k=` never lands on disk; `doctor` can check the server log and local logs for leaks.
- Harness itself always binds loopback; the plugin never offers a "bind 0.0.0.0" option for the upstream.
- Not multi-tenant: every visitor shares the same Harness and sees the same session list. Deploy one instance per person.

---

## Known limits

| Limit | Detail |
| --- | --- |
| Browser floor | The Harness frontend uses `Promise.withResolvers`, so the practical floor is roughly **Chrome/Edge 119+, Safari 17.4+, Firefox 121+**. Older browsers show a blank page; that is the frontend, not this plugin |
| Corporate/campus proxies | If a proxy does not pass WebSocket `Upgrade` (common with TLS interception), the live channel breaks and the UI reports a disconnected session. Change networks or tunnel egress |
| Proxy authentication (407) | Stacked on top of Basic Auth, some browsers handle the double prompt poorly |
| Latency | Streaming output crosses the tunnel twice; a distant VPS adds roughly 50–200 ms per turn |
| sshd port | Servers often move ssh off 22. Configure `public.ssh.port` / pass `--ssh-port`, or the tunnel fails with `Connection refused` |
| Access logs | Any log that records the full URI leaks the `?k=` gate. The generated template redacts by default; verify with `doctor` |
| Port 80 | The template deliberately emits **no** port-80 server block: an exact `server_name` block there would shadow `/.well-known/acme-challenge/` and break issuance/renewal |
| Sidebar width | Harness sizes the collapsed rail from the user agent (80 px on Mac, 56 px on phones). Do not force it narrower in CSS — the icons get clipped |

---

## Layout

```
bin/dsh-remote.js              CLI entry (serve / check / doctor / snippets / keygen / setup-server / uninstall-server)
lib/index.js                   DSH plugin host half: routes, in-process proxy and tunnel, lifecycle
lib/client.js                  DSH plugin client half: hand-written bundle (no build step), sidebar entry + panel
lib/core/proxy.js              Reverse proxy core: Host rewrite, token injection, mobile adaptation, key gate
lib/core/tunnel.js             ssh -R / cloudflared supervision with exponential backoff; tailscale funnel start/stop
lib/core/tailscale.js          tailscale funnel argv, status parsing and error classification (pure + testable)
lib/core/messages.js           zh/en catalog for host-generated text (preflight, tunnel state, API errors, CLI)
lib/core/preflight.js          DNS / TLS / HTTPS+auth / ssh tunnel checks
lib/core/snippets.js           nginx / Caddy / authorized_keys generation
lib/core/serversetup.js        Server installer generation (input validation against shell injection)
lib/core/assets/               Installer script template (real bash; output must pass `bash -n`)
test/verify.mjs                Contract / render / generator assertions
test/e2e-isolated.sh           End-to-end: boot an isolated DSH instance and mount this repo as a plugin
test/no-private-values.sh      Gate: no author-private values in the repository
```

---

## Verification

```bash
npm test              # contract, render, generator and localization assertions
npm run gate          # no author-private values in the repository
npm run e2e           # isolated DSH instance, plugin mounted, entry reachable
```

`npm test` covers the host half (export shape, config validation, routes, switches, privilege fence, upstream provenance, port release after fiber disposal), the client half (`__ModuleLoader__.load` protocol, slot registration, zh/en dictionaries, store/fetch interaction, real React SSR including the QR SVG), and the generators (the rendered installer and uninstaller must pass `bash -n`; shell injection in inputs must be rejected).

`test/e2e-isolated.sh` boots a **real Harness** with its own `DSH_HOME` and port, mounts this repository as a plugin, and asserts: no `plugin failures`, host API reachable, LAN entry opened by the plugin, client half present in the boot graph, and the LAN entry completing the token exchange.

See `docs/client-preview.png` for the client half rendered in a real browser with sanitized data.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — including the pre-publish checklist (repository metadata, npm scope, changelog) that a fork owner must fill in.

## License

MIT — see [LICENSE](LICENSE). Security policy: [SECURITY.md](SECURITY.md).
