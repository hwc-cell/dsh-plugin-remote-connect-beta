# Using a shared exit (relay): no domain to change, no server to run

This route is one sentence long: **someone else runs the exit, you only install the plugin.**

## Two things you need

1. **An exit address** — an `https://` base URL. **Leave it out and you use the official exit**:
   `https://relay.dsh.lycheeledger.cn`, run by the project author. If someone else (a friend, or you
   yourself) gave you an exit, pass that address instead — the two routes differ only in that one field.
2. **An invite code** — single use. This one only ever comes from whoever invites you.

The official exit is the **default**, and it is written down in this repository
(`lib/core/officialExit.js`) because it is a **public product endpoint** (the same nature as
ngrok.com), not a private value. With a non-official exit, the address only ever arrives in that
person's message.

## How to use it

### A. In the plugin config (panel + persistent)

```yaml
public:
  enabled: true
  tunnel: relay
  relay:
    url: https://relay.dsh.lycheeledger.cn   # empty = the official exit; or the address you were given
    invite: <the one-time invite code>
    name: <the subdomain you want; may be left empty>
```

The first run trades the invite for **your name + an access password**: the password is **written to
the local state file before it is ever displayed**. The invite is now spent — remove it from the
config; the plugin reuses the stored credential and never re-registers.

### B. One command (works without DSH installed)

```bash
npx dsh-plugin-remote-connect-beta serve --relay --invite <code> --name <name>   # the official exit
npx dsh-plugin-remote-connect-beta serve --relay <exit url> --invite <code> --name <name>
```

## What you get

An entry that looks like `https://<name>.<exit domain>/?k=<password>`. The panel shows the **exit
address, your name, the full link (copyable) and a QR code**; send the link to whoever needs it —
they open it in a browser. No domain to change, no account to create, no client to install.

## Rotating, and leaving

- **New password** in the panel rotates it **on the exit** (the exit is the authority; this machine
  never generates it). Every old link, QR code and signed-in browser stops working immediately.
- To leave: stop the plugin and ask the exit operator to `--revoke <your name>`. A revoked name has
  its live tunnel cut within one sweep period — not merely blocked from reconnecting.

## The one risk you must know

**A shared exit means handing the machine running the Harness to the exit operator.** Requests and
responses pass through the exit in plaintext — it **can read them and can change them**. The access
password is issued by the exit (it sees the plaintext only at the instant it issues one and stores
merely a fingerprint), so you have to trust whoever runs that exit.

If you would rather not, take the **self-hosted** route ([`self-host.md`](self-host.md)): server,
domain and certificate are all yours, with nobody in the middle. A side-by-side comparison is in the
README section *Who the exit is, and who can see what*.
