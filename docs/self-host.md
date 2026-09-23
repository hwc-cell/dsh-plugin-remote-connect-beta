# Self-hosting the public entry (your server + your domain)

[English](self-host.md) | [中文](self-host.zh.md)

This is the long-form version of the `selfhost` backend: what has to exist on **your** server
before `dsh-remote serve --public` can work, and how to check each piece. The short version is
in the [README](../README.md); if you have no server at all, use `--tunnel tailscale` or
`--tunnel cloudflared` instead and skip this page.

Nothing here is specific to one hosting provider. Sample values: domain `dsh.example.com`,
server `203.0.113.10`, tunnel account `dshtunnel`, ssh port `22022`, remote port `8788`.

---

## 0. The shape of the link

```
any browser ──https──► your server: nginx/Caddy ──► 127.0.0.1:8788   (loopback only)
                           TLS + edge password        ▲
                                                      │ ssh -R (your machine dials out)
                                                      │
                   your machine: access key gate ──► Harness on 127.0.0.1:<its own port>
```

Three properties make this safe to run on a machine that can execute commands:

1. The tunnel is **outbound**: your machine never accepts an inbound connection for the public path.
2. The reverse-proxy target is **loopback on the server** (`127.0.0.1:8788`), never a public port.
3. The Harness itself keeps listening on `127.0.0.1` only — this plugin never rebinds it.

---

## 1. Generate what you need

```bash
# an access key for the plugin's own gate (independent from the edge password)
openssl rand -hex 16

# a tunnel-only key pair (no shell access on the server)
npx dsh-plugin-remote-connect-beta keygen --out ~/.ssh/dsh_remote_tunnel
```

`keygen` prints a ready-to-paste `authorized_keys` line that is restricted to one forward.

---

## 2. Server side: the scripted path (recommended)

```bash
# on your machine: render the installer (it prints by default, it never touches the server)
npx dsh-plugin-remote-connect-beta setup-server \
  --domain dsh.example.com --ssh-user dshtunnel --remote-port 8788 \
  --out /tmp/dsh-server-setup.sh

# copy it over and follow the three-step ritual
scp /tmp/dsh-server-setup.sh you@203.0.113.10:/tmp/
ssh you@203.0.113.10 'bash /tmp/dsh-server-setup.sh probe'                 # what exists already
ssh you@203.0.113.10 'sudo bash /tmp/dsh-server-setup.sh install --dry-run' # what it would change
ssh you@203.0.113.10 'sudo bash /tmp/dsh-server-setup.sh install'           # do it
```

The installer **only writes files it owns**, so it is safe next to an existing site:

| File | Purpose |
| --- | --- |
| `/etc/nginx/conf.d/dsh-remote.conf` | your entry's `server` block (or drop it in `sites-enabled` yourself with `--nginx-conf`) |
| `/etc/ssh/sshd_config.d/60-dsh-remote.conf` | `AllowTcpForwarding yes` + `ClientAliveInterval 30` (delete the file to undo) |
| `/etc/letsencrypt/renewal-hooks/deploy/10-reload-web.sh` | reloads the web server after a renewal, so the served certificate cannot go stale |

Useful switches: `--skip-cert` (you manage certificates yourself), `--purge-user` (uninstall
also removes the tunnel account), `install --dry-run` (print the plan, change nothing).
Uninstall is the same script: `sudo bash /tmp/dsh-server-setup.sh uninstall`.

---

## 3. Server side: the manual path

If you prefer your own layout, `npx dsh-plugin-remote-connect-beta snippets --domain dsh.example.com`
prints the same content as text. The parts that actually matter:

```nginx
# http context (once)
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
# the access key travels in the query string: keep it out of the access log
log_format dsh_nokey '$remote_addr - $remote_user [$time_local] "$request_method $uri $server_protocol" '
                     '$status $body_bytes_sent "$http_referer" "$http_user_agent"';

server {
    listen 443 ssl;
    http2 on;
    server_name dsh.example.com;

    ssl_certificate     /etc/letsencrypt/live/<lineage>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<lineage>/privkey.pem;

    access_log /var/log/nginx/dsh.access.log dsh_nokey;

    client_max_body_size 64m;      # images/uploads

    # Optional edge password (off by default): your identity is the per-person ?k= link, and a shared
    # password cannot be revoked per person while being painful to type on a phone.
    # Uncomment both lines to enable:
    # auth_basic           "DSH";
    # auth_basic_user_file /etc/nginx/.htpasswd-dsh-remote;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;      # WebSocket: without this the UI says "disconnected"
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host       $host;
        proxy_buffering off;                            # streaming output dies with buffering on
        proxy_read_timeout 3600s;                       # long turns
        proxy_send_timeout 3600s;
    }
}
```

Deliberately **no port-80 `server` block** for this name: an exact `server_name` on port 80
would shadow `/.well-known/acme-challenge/` and break issuance/renewal. Let your existing
default block handle http→https.

Caddy equivalent:

```caddyfile
dsh.example.com {
    # Optional edge password (off by default) — uncomment to enable:
    # basic_auth {
    #     dsh <bcrypt-hash>
    # }
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

## 4. TLS

Extend the certificate that already covers your domain so its SAN list includes the entry name,
then reload the web server:

```bash
sudo certbot certonly --webroot -w /var/www/html --expand -d dsh.example.com -d example.com
sudo nginx -t && sudo systemctl reload nginx     # without this the old certificate stays in memory
```

Verify from **outside** that the served certificate is the one on disk:

```bash
echo | openssl s_client -connect dsh.example.com:443 -servername dsh.example.com 2>/dev/null \
  | openssl x509 -noout -dates -ext subjectAltName -fingerprint -sha256
openssl x509 -in /etc/letsencrypt/live/<lineage>/fullchain.pem -noout -fingerprint -sha256
```

The two SHA-256 values must match. Copy the on-disk one and pin it from the client side:

```bash
npx dsh-plugin-remote-connect-beta doctor --domain dsh.example.com \
  --expect-cert-sha256 <sha256> --ssh-user dshtunnel --ssh-host dsh.example.com --ssh-port 22022
```

---

## 4.5 The edge credential (optional — only if you want a second, independent door)

The edge password is an **optional** second door; the required one is the plugin's own `?k=` (see §4.8).
If you do want it, do not improvise the password:

```bash
npx dsh-plugin-remote-connect-beta credential            # a typeable passphrase (~46 bit) + the exact commands
npx dsh-plugin-remote-connect-beta credential --random   # or a 24-character random one (~141 bit)
```

It prints the password **once** (save it in your password manager) and the two ways to install
it on the server. The password travels over stdin, so it never lands in the process list or shell
history:

```bash
printf %s '<the password>' | sudo htpasswd -i -c /etc/nginx/.htpasswd-dsh dsh
sudo chmod 640 /etc/nginx/.htpasswd-dsh && sudo nginx -t && sudo systemctl reload nginx
```

Or let the generated installer do it, also over stdin:

```bash
printf %s '<the password>' | sudo bash /tmp/dsh-server-setup.sh install --auth-password-stdin
```

Verify the gate, then verify it opens with the password:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://dsh.example.com/                 # 401 without credentials
curl -sS -o /dev/null -w '%{http_code}\n' -u 'dsh:<the password>' https://dsh.example.com/   # not 401
```

Rotating this password does **not** affect the plugin's `?k=` key, and rotating `?k=` does not
affect this one — two independent doors. Never put the password in a URL
(`https://user:pass@host/`): browsers strip it and it leaks into history and logs.

### 4.6 Naming and rotating the edge user

`setup-server --edge-user <name>` changes the user name (default `dsh`); the installer records the
previous name it wrote and deletes that entry first, so a renamed account cannot be logged into with
the old name. `--edge-password auto` (default) generates a password and prints it once;
`--edge-password prompt` lets the server-side installer ask interactively; `--edge-password <text>`
takes your own (validated: at least 12 characters, no common weak values). The password always
travelled over stdin — never in `argv`, `ps` output or shell history.

After rotating, delete the old password from your browser/password manager before retrying: a browser
that keeps replaying an old password can pile up 401s and trip your provider's rate limiting.

### 4.7 Changing the access password requires the current one

The plugin's own access password (the `?k=` in the link) cannot be changed with one click:

1. The panel asks for **current password + new password + confirmation**, checks them locally
   (at least 12 characters, both new entries equal, new differs from current), then posts the current
   password to `POST /access-key/verify`.
2. Only if that verification passes does it call `POST /access-key/rotate`, which writes the new value,
   bumps the key epoch (every issued cookie stops matching) and invalidates every old link and QR code.
   A failed verification writes nothing, so a wrong "current password" can never leave you locked out.
3. Five consecutive failures put the entry into a five-minute cooldown, and each failure is written to
   `$DSH_HOME/remote-connect/audit.log` (time and event only — never the password).
4. **Reset** is a separate, deliberately degraded path for "I forgot it": no current password is
   required, but it must be confirmed explicitly (the panel says so), it invalidates old links and
   sessions, and it leaves an audit line.

The password never appears in `argv`, logs, telemetry or the UI after submission.

The access key is generated **and checked by the machine running the Harness**; your server only
forwards traffic and never sees or stores it. That is why rotating it needs no server change at all.

### 4.8 A password that is already in use is refused

A password is a credential, not a name, so the same value must not be shared by two identities — and
reusing your own previous password means "nothing actually changed" while you believe it did. Before
writing, the plugin checks the candidate against the current key **and** against the SHA-256
fingerprints of every key that has been active (stored as 16-hex prefixes; the plaintext of old keys is
never kept). A hit is refused with "this password is already in use, pick another" — it never says
whose it is. The check happens only **after** the current password was verified (otherwise the endpoint
would be an oracle for "is anyone using this password?") and it shares one lock with the write, so two
concurrent changes cannot both pass.

### 4.9 One key namespace per machine

Every password this plugin hands out — the local access key and each tenant's key — comes from one
pool, and no two of them are ever equal, including **keys that have already been retired**. The pool
stores only SHA-256 prefixes (16 hex characters) in `$DSH_HOME/remote-connect/keys-used.json`
(mode 0600, newest 500 kept), so the file cannot leak a usable key; active keys are also compared in
constant time, so a change that would collide with a tenant's key is refused as well.

## 5. The tunnel account

```bash
sudo useradd -m -s /usr/sbin/nologin dshtunnel
sudo install -d -m 700 -o dshtunnel -g dshtunnel /home/dshtunnel/.ssh
# paste the restricted line printed by `keygen` into /home/dshtunnel/.ssh/authorized_keys
sudo chown dshtunnel:dshtunnel /home/dshtunnel/.ssh/authorized_keys
sudo chmod 600 /home/dshtunnel/.ssh/authorized_keys
```

The line looks like this (one line, `permitlisten` is what keeps the forward on loopback):

```
restrict,remote-port-forwarding,permitlisten="127.0.0.1:8788" ssh-ed25519 AAAAC3Nza... dsh-tunnel
```

The generated drop-in `/etc/ssh/sshd_config.d/60-dsh-remote.conf` contains exactly two lines —
`AllowTcpForwarding yes` and `ClientAliveInterval 30` — and is owned by the installer, so deleting
it reverts the change.

There is no CLI flag for that path: if your security baseline wants a `Match User dshtunnel` block
(or a different filename), edit the generated script before running it, or call
`buildServerSetupScript` from `lib/core/serversetup.js` with your own `sshdDropin` / `deployHook`
values. The two requirements are only: forwarding allowed for this account, and a keep-alive long
enough that the tunnel survives idle periods. Do **not** set `GatewayPorts yes`.

---

### 5.5 If your provider rate-limits SSH connections

Some hosts cap **new connections per IP** (a common firewall rule is 20 per minute, 8 concurrent).
A tunnel that retries on a fixed short interval will hit that cap, and the symptom is not an error
message — SSH simply times out, which is very hard to diagnose. The plugin therefore backs off
**exponentially with jitter** (5 s, 10 s, 20 s … capped at 60 s, ±25 %), and only resets that
counter after the tunnel has been stable for two minutes. If your provider is stricter, tune
`backoffBaseMs` / `backoffMaxMs` in the tunnel options rather than retrying harder.

## 6. DNS

One `A` record for the entry name pointing at the server. That is all this plugin needs.

If you run your own authoritative DNS (BIND, CoreDNS, …) with several views or several
nameservers, remember that **every** copy must agree, and bump the zone serial so secondaries
pick the change up. A record that exists in only one view gives you "sometimes it resolves"
behaviour that looks like a plugin bug and is not.

---

## 7. Client side

```bash
export DSH_REMOTE_KEY=$(openssl rand -hex 16)
npx dsh-plugin-remote-connect-beta serve --public --key "$DSH_REMOTE_KEY" \
  --domain dsh.example.com --tunnel ssh \
  --ssh-user dshtunnel --ssh-host dsh.example.com --ssh-key ~/.ssh/dsh_remote_tunnel --ssh-port 22022
```

Or keep it running as part of the Harness (recommended) — one row in
`profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-plugin-remote-connect-beta
      name: dsh-plugin-remote-connect-beta
      config:
        lan: { enabled: true, port: 8787 }
        public:
          enabled: true
          domain: dsh.example.com
          port: 8788
          accessKey: <the key from step 1>
          tunnel: ssh
          ssh: { user: dshtunnel, host: dsh.example.com, port: 22022, keyPath: ~/.ssh/dsh_remote_tunnel, remotePort: 8788 }
```

The panel then shows the entry URL (`https://dsh.example.com/?k=…`) and a QR code; the
`Check server` button runs the same checks as `doctor`.

---

## 8. Verify, then keep it verified

```bash
npx dsh-plugin-remote-connect-beta check  --domain dsh.example.com --user dsh --password '***' \
  --ssh-user dshtunnel --ssh-host dsh.example.com --ssh-port 22022
npx dsh-plugin-remote-connect-beta doctor --domain dsh.example.com \
  --expect-cert-sha256 <sha256> --ssh-user dshtunnel --ssh-host dsh.example.com --ssh-port 22022
```

`check` covers DNS / certificate / edge password / ssh tunnel; `doctor` adds upstream and token
provenance, a proxy self-test, the certificate actually served, the fingerprint comparison, and
the checks only the server can run (access-log leak, deploy hook). Run `doctor` again after any
certificate renewal or nginx edit.

---

### 8.5 When a link does not work: read `X-DSH-Reason`

Every failure keeps the same HTTP status (404, so a stranger cannot probe for the entry) but now says
*why* in a response header and in a distinct page:

| `X-DSH-Reason` | Meaning | Page you see |
| --- | --- | --- |
| `no-key` | the request carried no access key at all | short "no access key" page |
| `bad-key` | the value does not match the current key (truncated or mistyped) | "that key is not correct" |
| `key-unusable` | the value has the right shape but is a rotated/old key | "that key is no longer valid" |
| `host-not-allowed` | the request arrived with an unexpected Host header | plain 404 |

```bash
curl -sS -D - -o /dev/null "https://dsh.example.com/?k=00001111" | grep -i '^x-dsh-reason'
curl -sS "https://dsh.example.com/_dsh/health"        # no key needed, never returns the key
```

`/_dsh/health` reports the tunnel state, the key fingerprint, when it was created, how many times it
has been rotated, the last successful access and the last 24 hours of failures by reason — enough to
tell "tunnel is down" from "your link is old" without reading any server log. Failures are also logged
by the plugin as `reason=… key_len=… key_fp8=<sha256 prefix>` — never the key itself.

The access key is persisted (0600) the first time it exists, so restarts, tunnel reconnects and
reboots do not change it; it only changes when you explicitly reset or change it. The panel shows its
fingerprint, creation time and rotation count so you can check at a glance whether the link in someone's
hand is the current one.

## 9. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `502 Bad Gateway` | proxy points at the wrong port | target must be the plugin's port (`8788`), not the Harness port |
| Page loads, output never streams | response buffering | `proxy_buffering off` (Caddy: `flush_interval -1`) |
| UI keeps saying "disconnected" | WebSocket upgrade dropped | forward `Upgrade`/`Connection` (the `map` above) |
| Long tasks cut off | default 60s read timeout | `proxy_read_timeout 3600s` |
| `413` on uploads | body size limit | `client_max_body_size 64m` |
| Blank page under a subpath | Harness needs the root path | serve at `/`, not `/dsh/` |
| `Permission denied (publickey)` | key not installed for the account, or wrong permissions | check `authorized_keys` content, owner, `600` |
| `remote port forwarding failed` | `permitlisten` missing/mismatched | it must be `127.0.0.1:8788`, matching `remotePort` |
| Certificate "old" after renewal | server never reloaded | reload, and keep the `renewal-hooks/deploy` hook installed |
| Works on some networks only | a DNS view/secondary is stale | update every zone copy, bump the serial |
| Works with `curl`, not in the browser | browser too old | the Harness UI needs Chrome/Edge 119+, Safari 17.4+, Firefox 121+ |

---

## 10. What this page deliberately does not do

- No hosted relay, no shared entry point, no third-party account: the plugin only ever talks to
  the server you configured.
- No IP allowlist / geo restriction options — access control is the two credentials
  (edge password + `?k=` key) plus the Harness session, by design.
- No "multi-user inside one Harness": a Harness instance is single-user by construction, and this
  guide only wires one ingress to one instance. Serving several people is a separate layer — the
  gateway gives each tenant their own instance, credentials, port and token; see
  [`multi-tenant.md`](multi-tenant.md).
