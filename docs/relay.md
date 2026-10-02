# Shared exit (relay): so that "install it and it just works"

> Written for whoever edits this code (humans and AI alike). It explains **why**, not just what.
>
> Status: **M1 (identity service) and M2 (tunnel transport) done; plugin exit and deployment still to come.** Every section below is
> tagged with the stage it lands in.

## 1. The problem

The old shape was "bring your own server": a VPS, a domain, DNS, nginx, a certificate — about eight
steps from `docs/self-host`. For "my friend just wants to try it", that threshold is fatal.

So there is a **shared exit**: one party hosts the exit, everybody else only installs the plugin — no
domain to change, no account to create, no server to configure.

That **contradicts** the old README line "the author does not host or relay anything". That line has to
go: the default is the **shared exit**, and the bring-your-own-server path stays for anyone who would
rather not trust the exit.

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
| **M3** | plugin's fourth exit engine `relay`: enroll once → store key → dial → panel shows link and QR | todo |
| **M4** | exit deployment: frp/nginx wildcard block, `*.dsh.example.com` wildcard DNS, certificate | todo |
| **M5** | docs: README positioning, risk table, contrast with `docs/self-host` | todo |

## 6. Deployment (the commands M4 will need, for the record)

```bash
# identity service (1 core / 1 GB is plenty: it signs, then mostly forwards)
node relay/server.mjs --state /var/lib/dsh-relay/state.json --port 8790
node relay/server.mjs --state /var/lib/dsh-relay/state.json --new-invite   # mint an invite
node relay/server.mjs --state /var/lib/dsh-relay/state.json --list         # registry (never keys)

# nginx: wildcard subdomain → local identity service / tunnel port
#   certificates: issue per-name over HTTP-01 first; DNS-01 only if you want the wildcard
```

What a user gets is one command:

```bash
npx dsh-plugin-remote-connect-beta serve --relay wss://exit.example.com/relay --invite <code>
# → https://<name>.exit.example.com/?k=<key>
```

No domain to change, no account to create, no client to install.
