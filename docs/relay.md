# Shared exit (relay): so that "install it and it just works"

> Written for whoever edits this code (humans and AI alike). It explains **why**, not just what.
>
> Status: **M1–M5 all landed** — identity service, duplex tunnel, the plugin's fourth exit engine, exit
> deployment, docs. **The default is the official exit (see §7)**; the bring-your-own-server path stays
> for anyone who will not hand their machine to an exit.

## 1. The problem

The old shape was "bring your own server": a VPS, a domain, DNS, nginx, a certificate — about eight
steps from `docs/self-host`. For "my friend just wants to try it", that threshold is fatal.

So there is a **shared exit**: one party hosts the exit, everybody else only installs the plugin — no
domain to change, no account to create, no server to configure.

That **contradicts** the old README line "the author does not host or relay anything", which is now
gone. The current line: the default is the **shared exit, and the default exit is run by the project
author** (address in §7); the bring-your-own-server path stays for anyone who would rather not trust
an exit.

## 2. Topology

```
browser  →  https://<name>.dsh.example.com   (exit nginx; TLS terminates here)
              │
              ├── /relay/*  →  identity service (issues keys, registers names)
              └── everything else → 127.0.0.1:<relayPort> → tunnel ──┐
                                                                     │ (plugin dials OUT)
                                                                     ▼
                                                      plugin (machine running the Harness)
                                                        → 127.0.0.1:8788 → local Harness
```

The connection is always dialled **from the plugin outwards**: the other side opens no inbound port.
The exit only has to feed requests for a given name into that connection.

## 3. Who owns the key (the heart of this change)

Old model: the key is generated **and checked by the machine running the Harness**; the exit never sees it.

New model (from M1): **the exit issues the key**, for three reasons —

1. With several people behind one exit, "globally unique" needs a global authority; `lib/core/keypool.js`
   only guarantees uniqueness **inside one machine**.
2. "The key has to be well-formed" is done once, correctly, by the issuer — instead of being re-checked
   on every client.
3. The exit must be able to **revoke** someone, which requires a registry.

**But the exit does not keep the key.** The only things the identity service writes to disk are:

- `keyFingerprint` = the first 16 hex chars of `sha256(key)`;
- plus each name's **retired fingerprints**, so a rotated-away value can never be issued again.

In other words, whoever steals that state file **cannot recover a single usable key** — they only learn
how many people there are, what they are called, and when they rotated.

The cost has to be stated plainly: **at the moment of issuance the service process does see the plaintext key.**
If you do not trust even that instant, read the code — which is why the exit service lives in this repo.

Name (subdomain) uniqueness is enforced **at issuance**; one name maps to exactly one key.

## 4. Risk — this belongs at the top of the README

| Who | What they can see | Can they change content |
| --- | --- | --- |
| **the exit operator** | **all plaintext traffic** through the exit (headers, request and response bodies); the `?k=` too, if it sits in the query string | **yes** — it is in the middle of the path, rewriting is a one-liner for it |
| the exit operator, other people's keys | no, unless it logged them at issuance time; ordinary traffic only carries the fingerprint | — |
| anyone else on the network | TLS ends at the exit; they see nothing | no |
| other users on the plugin's machine | can reach `127.0.0.1:8788` directly (loopback is unauthenticated), bypassing TLS | yes (local) |

**In one sentence**: using a shared exit means **handing your machine to the exit operator**. That is the
shape, not an implementation bug. Therefore:

- the exit service **must be open source and auditable** (here it is), so people can check it themselves;
- the docs may not say things like "end-to-end encrypted";
- anyone who does not want to trust an exit takes the `docs/self-host` path — that path has no such problem.

The invite code is an **entry credential**: leaking it means "someone else can claim a name". So: single
use, with an expiry, revocable.

## 5. Stages

| Stage | Content | Status |
| --- | --- | --- |
| **M1** | identity service: invites, issuance (name + key), rotation, registry (fingerprints only) | ✅ `relay/server.mjs` |
| **M2** | tunnel transport: plugin dials out → exit feeds requests in (streaming both ways) | ✅ `lib/core/relayTunnel.js` + `relay/server.mjs` |
| **M3** | plugin's fourth exit engine `relay`: enroll once → store key → dial → panel shows link and QR | ✅ |
| **M4** | exit deployment: nginx wildcard block, `*.dsh.example.com` wildcard DNS, wildcard certificate | ✅ |
| **M5** | docs: README positioning, risk table, contrast with `docs/self-host` | ✅ |
| **M6** | the official exit becomes the **default** (one flag to change it); gate exempts the official host exactly | ✅ see §7 |

## 6. Deployment (the commands M4 will need, for the record)

```bash
# identity service (1 core / 1 GB is plenty: it signs, then mostly forwards)
node relay/server.mjs --state /var/lib/dsh-relay/state.json --port 8790
node relay/server.mjs --state /var/lib/dsh-relay/state.json --new-invite   # mint an invite (14 days by default)
node relay/server.mjs --state /var/lib/dsh-relay/state.json --new-invite --ttl 30   # pick the TTL in days (--ttl 0 = never expires)
node relay/server.mjs --state /var/lib/dsh-relay/state.json --invites      # every code's state (usable/used/expired/revoked)
node relay/server.mjs --state /var/lib/dsh-relay/state.json --revoke-invite <code>   # retire a code that has not been used
node relay/server.mjs --state /var/lib/dsh-relay/state.json --list         # registry (never keys)

# In server mode, --admin-token-file opens three admin routes (for the account-linked side;
# without a token none of them exist):
#   POST /relay/admin/invite         issue a code, body may carry {"ttlDays": <1..365|0 = never>}
#   POST /relay/admin/invite/status  one code's state (used/expired/revoked; never echoes or lists codes)
#   POST /relay/admin/invite/revoke  retire an unused code — this is what makes replacing a code work

# nginx: wildcard subdomain → local identity service / tunnel port
#   certificates: issue per-name over HTTP-01 first; DNS-01 only if you want the wildcard
```

What a user gets is one command:

```bash
npx dsh-plugin-remote-connect-beta serve --relay --invite <code>          # the official exit (default)
npx dsh-plugin-remote-connect-beta serve --relay https://my-exit.example.com --invite <code>
# → https://<name>.<exit-domain>/?k=<key>
```

No domain to change, no account to create, no client to install.

## 7. The official exit (the default) — the one place a real address lives

**The default exit is the official exit**: leave `public.relay.url` empty and you get it. The address
lives in exactly one file, `lib/core/officialExit.js`:

```js
export const OFFICIAL_EXIT_URL = 'https://relay.dsh.lycheeledger.cn'
```

Why it may sit in a public repo: it is a **public product endpoint** (same nature as ngrok.com or
trycloudflare.com), not a private value. That is why the gate `test/no-private-values.sh` exempts this
one subdomain of `dsh.lycheeledger.cn` — and the exemption is **exact**: the host is stripped and the
rules are re-run, so **any other subdomain of the same domain** (anything that is not the `dsh` one)
still counts as a leak, as do server IPs, private keys, and local paths.

**Default is not the only option.** Two ways to point elsewhere, neither needs a code change:

| Form | Result |
| --- | --- |
| `--relay` (no value) / `--tunnel relay` / empty url in config | the official exit |
| `--relay official` / `--relay default` | the official exit (explicit form) |
| `--relay https://your-exit.example.com` | your own exit |
| config `public.relay.url: https://your-exit.example.com` | same as the line above |

**The panel must label the official exit** (`relay.exitOfficial`) — the default exit is the author's
machine, and a user has the right to know who they are trusting; we do not pick that for them silently.
Do not drop that label; `test/verify.mjs` asserts it.

To run your own exit for other people: the service is `relay/server.mjs` in this repo (deployment in
§6) — hand the address to whoever you invite.

### Switching exits from the panel (that field is filled with the official exit by default)

The panel's **Exit address** field comes **pre-filled with the official exit**; you can point it at
someone else's:

| What you type there | What you get |
| --- | --- |
| The official exit address (the default — leave it alone) / empty / `official` / `default` | The official exit |
| Someone else's exit address (`https://` optional) | Theirs — the tunnel is re-dialled on the new exit **immediately**, so the link drops for a moment |

- The **invite code** box next to it is for switching: paste the one-time invite that exit gave you.
  Without it you cannot be registered there, and the tunnel will not come up. Once an exit has
  registered you, you never need it again. The old exit's access password does not work on the new
  one — the panel registers you there again, and switching back picks up the stored credential.
- Switching writes a **state file** (`$DSH_HOME/remote-connect/relay-exit.json`, 0600) — it never
  touches your `cordis.patch.yml`. The `url` in the config is only a seed; the runtime truth lives in
  the state file (the same rule as the access password).
- The field hides no default: the official exit is the author's machine, so it is always labelled.
- On the wire this is one **new** route: `POST /remote-connect/api/relay` (body `{url, invite?}`,
  host window only). No other route or response shape changed.

