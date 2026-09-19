# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
