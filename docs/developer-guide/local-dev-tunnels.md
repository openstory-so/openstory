---
title: Local dev tunnels
description: Per-machine public HTTPS hostnames for ports 3000–3009
section: Developer Guide
order: 3
---

Ports **3000–3009** are reserved for local `bun dev` worktrees. E2E uses **3020** and never takes a tunnel slot.

Each laptop has its own ten random `*.openstory.so` names, stored at **`~/.openstory/dev-tunnels.json`** (not in git). Agents and humans on that machine all read the same file.

## One-time per machine

Needs Wrangler credentials (`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`).

```bash
bun tunnel:provision
```

That:

1. Creates (or reuses) a Wrangler named tunnel `openstory-dev-<hostname>`
2. Allocates ten random hostnames and maps them to `127.0.0.1:3000` … `:3009`
3. Writes DNS CNAMEs and the tunnel ingress on Cloudflare
4. Saves the map to `~/.openstory/dev-tunnels.json`
5. Prints the ten Google OAuth redirect URIs — add those by hand to the Google client

`bun tunnel` reprints the map.

## Daily

1. In the worktree `.env.local`, set `PORT` to an unused value in 3000–3009.
2. `bun dev` — `ensure-env` sets `VITE_APP_URL` from the map for that port.
3. Press **`t + Enter` once** on this machine. The Vite plugin connects the named tunnel; Cloudflare sends each hostname to the matching local port. A second `t` in another worktree is a replica and will load-balance — don't.

Put Cloudflare Access on `*.openstory.so` (or the ten names) if you do not want the URLs world-readable. The fixed local OTP is not served on those hosts.

Ordinary `bun install && bun dev` without a map still uses `http://localhost:3000`.
