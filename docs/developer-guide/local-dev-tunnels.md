---
title: Local dev tunnels
description: Optional public HTTPS URLs for multi-worktree local development
section: Developer Guide
order: 3
---

`bun install && bun dev` stays on [http://localhost:3000](http://localhost:3000). Use a tunnel only when something on the public internet has to call your laptop: Google OAuth redirect URIs, fal.ai callbacks, a phone.

## How slots stay unique across machines

A single named tunnel with ten CNAMEs cannot isolate worktrees: extra `cloudflared` connectors on that tunnel are **load-balanced**, so a `dev2` request can land on the process that only serves `dev1`.

Each slot is its own named tunnel (`openstory-dev1` … `openstory-dev10`) and hostname (`dev1.openstory.so` … `dev10.openstory.so`), bound to a fixed loopback port (`3000` … `3009`).

Occupancy is **Cloudflare's live connector list**, not a file on disk. `bun tunnel` skips any slot that already has a connector (another laptop, another person). If two claims race, the loser sees a second connector, kills its process, and tries the next slot. `~/.openstory-dev-slots.json` only remembers this machine's pid so teardown and reboot recovery know what to kill.

Open-source clones cannot attach to these tunnels. The credential JSON files created by `cloudflared tunnel create` are the capability to become a connector; they are not in the repo. `cloudflared tunnel login` against some other account cannot write DNS on `openstory.so`.

While a connector is up, the hostname is on the public internet. Put Cloudflare Access in front of `dev*.openstory.so` (Google `@openstory.so`) so random clients cannot hit a laptop. The fixed local OTP (`123456`) is **not** served on tunnel hostnames.

Local Miniflare R2 is reachable through the same hostname (`/r2/…`). Do not flip R2 to `"remote": true`. Stripe CLI already has its own listen tunnel; `bun dev:all` still forwards to `localhost:$PORT`. E2E stays on `http://localhost:3001`.

## One-time (Cloudflare account)

Needs `cloudflared` and `cloudflared tunnel login` against the account that owns `openstory.so`.

```bash
brew install cloudflared
cloudflared tunnel login
bun tunnel:provision
```

That creates the ten tunnels and DNS CNAMEs. Then:

1. Add all ten Google OAuth redirect URIs to the client (`https://devN.openstory.so/api/auth/callback/google`).
2. Put Cloudflare Access on `dev*.openstory.so` (allow `@openstory.so`).
3. Put the ten `~/.cloudflared/<uuid>.json` tunnel credential files in the team secret store (1Password, not git). Each laptop still runs `cloudflared tunnel login` for its own `cert.pem` (needed to _list_ connectors). The JSON files are needed to _run_ a slot.

## Per worktree

```bash
bun tunnel      # pick the first globally free slot, write VITE_APP_URL / PORT, start cloudflared
bun dev         # if this worktree already holds a slot, restarts a dead cloudflared; never claims a new one unless .env.local already has a tunnel URL
bun teardown    # kill that cloudflared, free the slot, restore http://localhost:$PORT
bun tunnel --status
```

`bun setup --tunnel` claims as part of setup; `--no-tunnel` skips the prompt.

Copying a worktree (and its `.env.local`) onto another machine does not steal the old hostname: `bun tunnel` / `bun dev` claims a free slot and rewrites the URL.

Ten live connectors is the cap. A connector that was not torn down usually drops on its own; if a slot looks stuck, `cloudflared tunnel info openstory-devN` and `cloudflared tunnel cleanup openstory-devN` (only when you are sure nobody else holds it).
