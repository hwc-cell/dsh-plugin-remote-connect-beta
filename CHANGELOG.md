# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-beta.3] - 2026-09-21

One password per person, one button to rotate it. The access password is now a machine-issued token
from a machine-wide pool, and the panel no longer asks you to type or remember anything.

### Changed

- **The manual "change password" form is gone.** The panel used to offer current/new/confirm fields
  plus "Change" and "Reset (I forgot it)". That whole path — including the `POST /access-key/verify`
  current-password check — has been removed. What is left is one button, **"New password"**, which
  generates a fresh value on this machine, bumps the key epoch (every old link, QR code and signed-in
  browser stops matching) and shows the new value once. Rotating needs no old password; the entry point
  is still host-window-only (`requireLocalControl`) and still needs an explicit confirmation.
- `POST /access-key/rotate` now honours `{"acknowledge": true}` and **ignores** any `password` /
  `current` / `confirm` / `reset` field: values are generated locally, never accepted from a caller.
- **Passwords are unique across the whole machine, and one password maps to one Harness.** New
  `lib/core/keypool.js` keeps the ledger (`$DSH_HOME/remote-connect/keys-used.json`, 0600, sha256
  16-hex fingerprints only) shared by the access password and every tenant key: no two active
  passwords are equal, a **retired** value (one that was rotated away) can never be issued again, and a
  collision is resolved by regenerating during generation rather than failing at write time. The
  registry now refuses a tenant key that equals the access password, not just one that duplicates
  another tenant.
- Access passwords are now generated as 32 URL-safe characters (~192 bits) instead of a six-word
  passphrase. Nothing is typed by hand any more, so "easy to type on a phone" stopped being a virtue;
  links are copied or forwarded instead. (The edge password on your server is unaffected — it is still
  a passphrase, because that one *is* typed.)
- Tenant keys move from the tenant registry's own de-duplication to the shared pool, so rotating a
  tenant key also retires the old value.

### Fixed

- The panel's and `/_dsh/health`'s "key fingerprint" was the first 8 and last 4 plaintext characters of
  the key, dressed up as a fingerprint. It is now a real sha256 16-hex fingerprint — as both
  `docs/self-host.md` §4.8 and the UI claimed, and as "only fingerprints are stored" always implied.

## [0.1.0-beta.2] - 2026-09-19

Documentation-only release: both READMEs now lead with a Risks section (what each entry exposes —
the LAN entry has no gate at all — what a leaked `?k=` link means, what the tunnel key can and cannot
do, the root-keys-on-the-same-machine risk, that the sandbox is DSH's rather than this plugin's, what
is stored where, availability you can lose) plus a six-item pre-flight checklist and the kill switch.

## [0.1.0-beta.1] - 2026-09-19

First public beta. Installed with `npm i dsh-plugin-remote-connect-beta@beta` (the `latest` tag is left
untouched on purpose), or straight from the repository.

### Added

- A single key namespace per machine (`lib/core/keypool.js`, from the server side's spec): the local
  access key and every tenant key come from one pool, no two are equal — including retired values —
  and only SHA-256 16-hex fingerprints are persisted (`keys-used.json`, 0600, newest 500). Active keys
  are compared in constant time too, so a new value that collides with a tenant's key is refused.


- Dark mode: the panel and the host-side failure pages follow `prefers-color-scheme` (theme
  variables first, dark fallbacks when a variable is missing). The QR code deliberately stays
  white-on-black so phones can still scan it.
- The sidebar status dot now has three states: **green** healthy, **red** network problem
  (tunnel reconnecting/down, missing upstream token, or config problems), **amber** nothing
  started. Each state carries a localized title/aria-label, and the preview harness can render
  all three (`?mode=down`, `?mode=off`, `?dark=1`).


- Password de-duplication on the Mac side, per the updated spec: a new access password is refused if it
  matches the current one or any key that has been active before (only SHA-256 16-hex fingerprints are
  kept, never old plaintext), with "already in use, pick another" and no hint of whose it is. The check
  runs only after the current password was verified and shares a lock with the write, so concurrent
  changes cannot both pass.
- When the upstream cannot be reached (tunnel down / Harness not running) the entry now answers 503 with
  a readable page and `X-DSH-Reason: tunnel-down` instead of passing a bare 502 through.


- Diagnostics for the second gate, per the server side's confirmation document: failures now carry
  `X-DSH-Reason` (`no-key` / `bad-key` / `key-unusable` / `host-not-allowed`) while keeping HTTP 404,
  each reason gets its own page copy, and the plugin logs `reason= key_len= key_fp8=` (a hash prefix,
  never the key). `GET /_dsh/health` answers without a key and reports tunnel state, key fingerprint,
  creation time, rotation count, last success and the last 24 h of failures by reason.
- The access key is now **persisted before it is displayed** (0600, with `createdAt` / `rotations`), so
  restarts, tunnel reconnects and reboots never change it; the panel shows fingerprint, creation time
  and rotation count plus a copy-link button.
- The launch token is no longer put in the browser's URL: a stale session is healed by re-logging in
  **server-side** and relaying the cookie, so the token never reaches history or Referer.


- Changing the access password now requires the current one (re-authentication), per the server side's
  spec: the panel asks for current + new + confirmation, verifies the current value through
  `POST /access-key/verify`, and only then writes. A failed verification writes nothing, five
  consecutive failures trigger a five-minute cooldown, and every failure or reset appends a line to
  `audit.log` that never contains a password. **Reset** (forgotten password) is a separate, explicitly
  confirmed path that invalidates old links and sessions. The one-click "generate new" action is gone.


- **`tailscale` tunnel mode** (`--tunnel tailscale` / `public.tunnel: tailscale`): publishes the loopback entry port with `tailscale funnel --bg`, reads the node address from `tailscale status --json`, probes the funnel periodically, and removes only its own mapping on stop. Failure paths (client missing, logged out, Funnel not enabled) surface a translated hint instead of retrying forever.
- **Host-side message catalog** (`lib/core/messages.js`, one key set per language) so preflight results, tunnel state and panel API errors render in the language the panel asks for. The panel now sends `?locale=` with every API call; unknown locales fall back to English.
- **CLI language support**: `--lang <en|zh>`, plus `DSH_REMOTE_LANG` / `LC_ALL` / `LANG` detection (English by default). `--help`, check results, the serve banner and the common errors are bilingual. `doctor`, `setup-server` and `keygen` still print their detailed report in Chinese and now say so in one line under an English locale.
- `doctor` reports the tailscale funnel check when the configured tunnel mode is `tailscale`.
- CI workflow (Node 20/22: gate → tests → pack-content check), `CONTRIBUTING.md`, Homebrew formula template and `docs/market-submission.md`.

### Added

- **Multi-tenant gateway**: each tenant gets their own Harness process — own `DSH_HOME`, own loopback port, own launch token, own credentials. The key gate resolves the tenant from `?k=`/cookie and routes that request to that tenant's upstream with that tenant's token; the cookie is signed with a secret independent of every tenant key.
  - `lib/core/tenant.js` (registry, 0600, atomic writes, duplicate id/key rejection, tolerant loading), `lib/core/instance.js` (per-tenant supervisor: real-node spawn, token from the child's own stdout, backoff restart, per-tenant `instance.log`), `lib/core/tenancy.js` (orchestration and routing handles), `lib/core/paths.js` (shared state paths).
  - Panel: a Tenants card — add by name, per-tenant link and QR, start/stop, rotate key, remove, live state and actionable errors.
  - CLI: `tenant list|add|rm|rotate|key` (registry only) and `serve --multi` (gateway + instances in one process, torn down on exit).
  - Text is bilingual, and the new `docs/multi-tenant.md` / `.zh.md` explain the isolation model, the registry format, the real-node gotcha and the operating questions.
- WebSocket upgrades now pass the same key gate as ordinary requests (they previously bypassed it).

### Documentation

- Both READMEs now lead with a **Risks** section: what the LAN entry exposes (nothing protects it),
  what a leaked `?k=` link means, what the tunnel key can and cannot do, the "what else is on this
  machine" risk (root keys elsewhere on the same box), that the sandbox belongs to DSH rather than to
  this plugin, what is stored where, which failures you can lose availability to, and a six-item
  pre-flight checklist plus a kill switch.


- `docs/self-host.md` + `docs/self-host.zh.md`: the long-form guide to the `selfhost` backend — link shape, scripted vs manual server setup, TLS with served-vs-on-disk fingerprint verification, the restricted tunnel account, DNS with multiple views, client configuration, verification commands and a troubleshooting table.
- `package.json` now ships `docs/` (the guides and the preview image) so every README link resolves in the published tarball; CI checks those files are present in the pack.

### Changed

- `npm run gate` also rejects hardcoded private LAN addresses (`192.168.x.x` / `10.x.x.x` literals); `192.168.x.x`-style placeholders still pass.
- Preview harness (`npm run preview`) can render the tailscale backend (`?mode=tailscale`) and take documentation screenshots (`?shot=1&zoom=0.72`); `docs/client-preview.png` was regenerated from it.
- Repository initialized with an initial commit and the packaging/CI files in place, so publishing is `git remote add` + `npm publish` away.

### Added

- Credential defaults follow the server side's spec: the edge **user name** defaults to `dsh` and is
  renameable (`--edge-user`, the installer deletes the previous entry so the old name stops working);
  the edge **password** has no default — `--edge-password auto` generates one and prints it once,
  `prompt` defers to the installer's interactive prompt, an explicit value is strength-checked. The
  installer now uses `-i -B` (stdin + bcrypt) and only passes `-c` when the file does not exist yet.
- The CI gate also rejects built-in default passwords and the author instance's sample password.
- The panel warns that on the `tailscale` backend the access password is the only protection
  (Funnel has no identity gate of its own).

### Fixed

- **Tunnel reconnect no longer hammers the server.** The counter was reset on every exit, so the
  backoff never grew past its first step (a fixed ~2 s retry loop, 30 connections/minute). Hosts
  that rate-limit SSH port 22022 (a common firewall rule: 20 new connections per minute per IP)
  answer that with silent timeouts. Reconnects now back off exponentially with jitter (5 s → 60 s,
  ±25 %) and only reset after the tunnel has been stable for two minutes.
- The generated `authorized_keys` line now uses `remote-port-forwarding` instead of
  `port-forwarding`, so the tunnel account cannot open local forwards either.
- `credential` now emits `htpasswd -i -B` (bcrypt) and no longer uses `-c`, which would wipe other
  users in an existing htpasswd file; first-time creation is shown separately.
- A request that arrives with a wrong or rotated `?k=` now gets a short explanation page instead of
  a bare 404 (requests without any credential still get the bare 404, so the entry's existence is
  not revealed to scanners).

- `dsh-remote --help` was treated as an unknown command (`--help` must be the first argument to be parsed as a flag).
- Panel no longer crashes when the first `/state` request fails (`data` is still `null`).
- `public.domain` is now required only for the `ssh` tunnel mode; `cloudflared` and `tailscale` provide their own hostname.

## [0.1.0] - 2026-09-19

### Added

- **`lan` backend**: reverse proxy that binds all interfaces, injects a mobile-adaptation stylesheet and shim into the Harness index, prints a terminal QR code, and serves an authenticated browser session.
- **`selfhost` backend**: `ssh -R` tunnel supervision with exponential backoff, plus `setup-server` / `uninstall-server` generators that emit an idempotent installer (`probe` / `install` / `uninstall` / `--dry-run` / `--skip-*`).
- **`cloudflare` tunnel mode** (`serve --tunnel cloudflared`) for users without a server.
- **`doctor`**: upstream and token provenance, proxy self-test, DNS / certificate / edge password / ssh tunnel checks, the certificate actually served, `--expect-cert-sha256` cross-machine comparison, and the checks only the server can run.
- **DSH plugin halves**: host half (`lib/index.js`) with panel routes and in-process proxy/tunnel lifecycle; client half (`lib/client.js`) as a hand-written bundle with no build step.
- **Bilingual panel**: zh/en dictionaries with `locale` as a soft dependency (29 keys each as of the host-catalog change).
- **Zero-dependency `Config`**: a Standard Schema validator so malformed configuration fails before activation without adding a dependency.

### Security

- `Host`/`Origin` rewrite and launch-token injection so the Harness API fence and browser authentication work through any ingress.
- Access-key gate (`?k=`) answers 404, never 401, and rotates without touching the edge.
- Generated server template redacts the request line so the access key never reaches an access log.
- Public mode refuses to start without an access key; Harness upstream always binds loopback.
- Repository gate (`npm run gate`) rejects author-private values in every committed file.
