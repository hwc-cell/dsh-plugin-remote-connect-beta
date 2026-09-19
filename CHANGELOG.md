# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`tailscale` tunnel mode** (`--tunnel tailscale` / `public.tunnel: tailscale`): publishes the loopback entry port with `tailscale funnel --bg`, reads the node address from `tailscale status --json`, probes the funnel periodically, and removes only its own mapping on stop. Failure paths (client missing, logged out, Funnel not enabled) surface a translated hint instead of retrying forever.
- **Host-side message catalog** (`lib/core/messages.js`, one key set per language) so preflight results, tunnel state and panel API errors render in the language the panel asks for. The panel now sends `?locale=` with every API call; unknown locales fall back to English.
- **CLI language support**: `--lang <en|zh>`, plus `DSH_REMOTE_LANG` / `LC_ALL` / `LANG` detection (English by default). `--help`, check results, the serve banner and the common errors are bilingual. `doctor`, `setup-server` and `keygen` still print their detailed report in Chinese and now say so in one line under an English locale.
- `doctor` reports the tailscale funnel check when the configured tunnel mode is `tailscale`.
- CI workflow (Node 20/22: gate → tests → pack-content check), `CONTRIBUTING.md`, Homebrew formula template and `docs/market-submission.md`.

### Fixed

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
- **Bilingual panel**: zh/en dictionaries (22 keys each) with `locale` as a soft dependency.
- **Zero-dependency `Config`**: a Standard Schema validator so malformed configuration fails before activation without adding a dependency.

### Security

- `Host`/`Origin` rewrite and launch-token injection so the Harness API fence and browser authentication work through any ingress.
- Access-key gate (`?k=`) answers 404, never 401, and rotates without touching the edge.
- Generated server template redacts the request line so the access key never reaches an access log.
- Public mode refuses to start without an access key; Harness upstream always binds loopback.
- Repository gate (`npm run gate`) rejects author-private values in every committed file.
