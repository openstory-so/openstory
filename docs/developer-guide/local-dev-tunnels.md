---
title: Local dev tunnels
description: Per-machine public HTTPS hostnames for ports 3000–3009
section: Developer Guide
order: 3
---

Ports **3000–3009** are reserved for local `bun dev` worktrees. E2E uses **3020** and never takes a tunnel slot.

Each laptop has its own ten random `*.openstory.so` names, stored at **`~/.openstory/dev-tunnels.json`** (not in git). Agents and humans on that machine all read the same file.

## One-time per machine

Uses your existing **`wrangler login`** session (the OAuth token Wrangler already stores). No Cloudflare API token. Hostnames are `<two-words>.<zone>`; the zone is the host of `OPENSTORY_API_URL` (default `openstory.so`). If DNS create is denied (Wrangler’s login is zone-read-only), run **`cloudflared tunnel login`** once — also a browser login, not an API key — so `cloudflared tunnel route dns` can write the CNAMEs.

```bash
bun tunnel:provision
```

That:

1. Creates (or reuses) a Wrangler named tunnel `openstory-dev-<hostname>`
2. Allocates ten two-word hostnames (`briny-otter.openstory.so`, …) mapped to `127.0.0.1:3000` … `:3009`
3. Writes DNS CNAMEs and the tunnel ingress on Cloudflare
4. Saves the map to `~/.openstory/dev-tunnels.json`
5. Prints the Google OAuth redirect URIs (`http://localhost:<port>` and the `https://` name, for each port) — add those by hand to the Google client

`bun tunnel` reprints the map.

## Daily

1. In the worktree `.env.local`, set `PORT` to an unused value in 3000–3009.
2. `bun dev` — `ensure-env` writes `PORT` and `VITE_APP_URL` for that port and puts them on the Vite process. Vite does not read `.env.local`.
3. Press **`t + Enter` once** on this machine. The Vite plugin connects the named tunnel; Cloudflare sends each hostname to the matching local port. A second `t` in another worktree is a replica and will load-balance — don't.

Work in the app at `http://localhost:$PORT` — that stays on your machine, and Google sign-in works there with no tunnel connected. Use the `https://…openstory.so` URL only for inbound webhooks or a phone. Google returns you to the host the sign-in started on (`bun dev` never sets `BETTER_AUTH_URL`, which would pin every sign-in to the tunnel host), and a session belongs to one host — signing in on localhost does not sign you in on the tunnel name. Every request on that hostname hairpins through Cloudflare’s edge, so it will feel slower (especially HMR).

Put Cloudflare Access on `*.openstory.so` (or the ten names) if you do not want the URLs world-readable. The fixed local OTP is not served on those hosts: `isLocalRequestHost` fails closed unless every Host / X-Forwarded-Host value is loopback, so a spoofed `X-Forwarded-Host: localhost` on a tunnel hostname does not turn it on. Without a mapping file, `bun dev` does not start a Quick Tunnel.

Ordinary `bun install && bun dev` without a map still uses `http://localhost:3000`.
