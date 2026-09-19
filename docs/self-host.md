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
                                                      │ ssh -R (your Mac dials out)
                                                      │
                       your Mac: access key gate ──► Harness on 127.0.0.1:<its own port>
```

Three properties make this safe to run on a machine that can execute commands:

1. The tunnel is **outbound**: your Mac never accepts an inbound connection for the public path.
2. The reverse-proxy target is **loopback on the server** (`127.0.0.1:8788`), never a public port.
3. The Harness itself keeps listening on `127.0.0.1` only — this plugin never rebinds it.

---

## 1. Generate what you need

```bash
# an access key for the plugin's own gate (independent from the edge password)
openssl rand -hex 16

# a tunnel-only key pair (no shell access on the server)
npx dsh-plugin-remote-connect keygen --out ~/.ssh/dsh_remote_tunnel
```

`keygen` prints a ready-to-paste `authorized_keys` line that is restricted to one forward.

---

## 2. Server side: the scripted path (recommended)

```bash
# on your machine: render the installer (it prints by default, it never touches the server)
npx dsh-plugin-remote-connect setup-server \
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

If you prefer your own layout, `npx dsh-plugin-remote-connect snippets --domain dsh.example.com`
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
    auth_basic           "DSH";
    auth_basic_user_file /etc/nginx/.htpasswd-dsh-remote;

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
npx dsh-plugin-remote-connect doctor --domain dsh.example.com \
  --expect-cert-sha256 <sha256> --ssh-user dshtunnel --ssh-host dsh.example.com --ssh-port 22022
```

---

## 4.5 The edge credential (do this instead of inventing a password)

The edge password is the only door in front of your machine, so do not improvise it:

```bash
npx dsh-plugin-remote-connect credential            # a typeable passphrase (~46 bit) + the exact commands
npx dsh-plugin-remote-connect credential --random   # or a 24-character random one (~141 bit)
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
restrict,port-forwarding,permitlisten="127.0.0.1:8788" ssh-ed25519 AAAAC3Nza... dsh-tunnel
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
npx dsh-plugin-remote-connect serve --public --key "$DSH_REMOTE_KEY" \
  --domain dsh.example.com --tunnel ssh \
  --ssh-user dshtunnel --ssh-host dsh.example.com --ssh-key ~/.ssh/dsh_remote_tunnel --ssh-port 22022
```

Or keep it running as part of the Harness (recommended) — one row in
`profiles/web/cordis.patch.yml`:

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
          accessKey: <the key from step 1>
          tunnel: ssh
          ssh: { user: dshtunnel, host: dsh.example.com, port: 22022, keyPath: ~/.ssh/dsh_remote_tunnel, remotePort: 8788 }
```

The panel then shows the entry URL (`https://dsh.example.com/?k=…`) and a QR code; the
`Check server` button runs the same checks as `doctor`.

---

## 8. Verify, then keep it verified

```bash
npx dsh-plugin-remote-connect check  --domain dsh.example.com --user dsh --password '***' \
  --ssh-user dshtunnel --ssh-host dsh.example.com --ssh-port 22022
npx dsh-plugin-remote-connect doctor --domain dsh.example.com \
  --expect-cert-sha256 <sha256> --ssh-user dshtunnel --ssh-host dsh.example.com --ssh-port 22022
```

`check` covers DNS / certificate / edge password / ssh tunnel; `doctor` adds upstream and token
provenance, a proxy self-test, the certificate actually served, the fingerprint comparison, and
the checks only the server can run (access-log leak, deploy hook). Run `doctor` again after any
certificate renewal or nginx edit.

---

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
