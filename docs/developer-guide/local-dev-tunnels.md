---
title: Local dev tunnels
description: Optional public HTTPS URLs for multi-worktree local development
section: Developer Guide
order: 3
---

`bun install && bun dev` stays on [http://localhost:3000](http://localhost:3000). Use a tunnel only when something on the public internet has to call your laptop: Google OAuth redirect URIs, fal.ai callbacks, a phone, another machine.

## Why not one shared tunnel

A single named tunnel with ten CNAMEs (`dev1`…`dev10` → one UUID) looks simpler, but extra `cloudflared` connectors on that tunnel are **load-balanced**. Ingress rules run after a request already landed on a connector, so a `dev2` request can hit the worktree that only serves `dev1` and 404.

Each slot is therefore its own named tunnel (`openstory-dev1` … `openstory-dev10`) and hostname (`dev1.openstory.so` … `dev10.openstory.so`), bound to a fixed loopback port (`3000` … `3009`).

Local Miniflare R2 is reachable through the same hostname (`/r2/…`). Do not flip R2 bindings to `"remote": true` just to make uploads public. Stripe CLI already has its own listen tunnel; `bun dev:all` still forwards to `localhost:$PORT`.

The fixed local OTP (`123456`) is **not** served on tunnel hostnames — those URLs are on the public internet. Sign in with Google (or real email OTP) on a tunnel URL; use localhost when you want the auto-OTP.

E2E stays on `http://localhost:3001` and never claims a slot.

## One-time (Cloudflare account)

Needs `cloudflared` and `cloudflared tunnel login` against the account that owns `openstory.so`.

```bash
brew install cloudflared
cloudflared tunnel login
bun tunnel:provision
```

That creates the ten tunnels and DNS CNAMEs. Then add all ten Google OAuth redirect URIs to the client:

```
https://dev1.openstory.so/api/auth/callback/google
…
https://dev10.openstory.so/api/auth/callback/google
```

Copy `~/.cloudflared/` (cert + the per-tunnel credential JSON files) onto other machines that should run slots.

## Per worktree

```bash
bun tunnel      # lock ~/.openstory-dev-slots.json, pick the first free slot, write VITE_APP_URL / PORT, start cloudflared
bun dev         # if this worktree already holds a slot, restarts a dead cloudflared; never claims a new one
bun teardown    # kill that cloudflared, free the slot, restore http://localhost:$PORT
bun tunnel --status
```

`bun setup --tunnel` claims as part of interactive setup; `--no-tunnel` skips the prompt.

Slots are stored in `~/.openstory-dev-slots.json` (not in the repo). Stale PIDs are swept on the next claim. Ten live worktrees is the cap.
