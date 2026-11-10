---
name: create-style
description: >
  Create an OpenStory library style from reference images, video, URLs,
  or a written look. Scans the inputs, drafts a v2 config, POSTs
  create-style. Use when asked to create, extract, capture, or craft a
  style or look from refs; to turn footage or a brand into an OpenStory
  style; or when the user runs /create-style. Not for generating a
  video (that's create-sequence).
---

# Create style

Mint a team-owned OpenStory library style from whatever the user handed
you. Public API at `https://openstory.so`. Override the origin only when
the user gives a self-hosted base URL.

## MCP first

The OpenStory plugin (ChatGPT, Codex, Claude, Grok, and Gemini CLI) connects `https://openstory.so/mcp`. When this session
has OpenStory MCP tools, call those. They authenticate with the client's
OAuth grant (or a Bearer `osk_` key the client already attached). Use the
HTTP API below only when those tools are absent, or the user gave a
self-hosted origin. Do not start a device-code login while MCP tools are
available.

## Discover first

`GET {origin}/api/v1` (unauthenticated). The body is the contract:
`instructions`, `requestSchema`, and `_links`. Follow `_links` (each has
`method`; writes also have `contentType` and `examples`). Do not hardcode
paths or paste the schema into later calls from memory — if a field is
unclear, re-read `requestSchema` or `GET {origin}/api/v1/openapi.json`.
This skill uses `_links.create-style` and `_links.list-styles`.

## Auth

Required on every call except the root and the device-login pair. Resolve
a key in this order:

1. `OPENSTORY_API_KEY` in the environment.
2. `~/.config/openstory/credentials` — a line `OPENSTORY_API_KEY=<key>`.
3. `~/.openstory/credentials.json`, written by the OpenStory CLI
   (`npx @openstory/cli@latest login`): `keys["<origin>"]`, e.g.
   `keys["https://openstory.so"]`.
4. If the root `_links` has `device-authorize`, `POST` it (empty JSON
   body). Reply in the chat with `user_code` and `verification_url` as
   copyable plain text, plus the `verification_url_complete` link.
   Opening a browser is extra, never a substitute. Never print
   `device_code`. **Stop this turn.** Done when the reply contains the
   code as visible text.
5. On the next turn, `GET` `_links.poll` with `?wait=60s` until it
   returns `api_key` (`authorization_pending` means keep polling;
   `expired_token` or `access_denied` means stop and tell the user).
   Write the key to `~/.config/openstory/credentials` (mode 600) and
   continue.
6. If there is no `device-authorize` link, stop. Tell the user to
   create a key under **Settings → Developer** at the origin and
   export `OPENSTORY_API_KEY`. Do not open the dashboard unless they
   ask.

Send `Authorization: Bearer <key>` (or `x-api-key`). A `401` means the
key is bad or revoked — go back to step 4 (or 6) rather than retrying.

Keys are team-scoped. `429` includes `Retry-After` — honor it. Errors are
always `{ "error": { "code", "message", "details"? } }`.

## Gather

Collect every ref before drafting. Accept mixed input:

| Input               | Scan                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image (file or URL) | Read it with vision.                                                                                                                                    |
| Video (file or URL) | Download if needed. Pull 3–5 stills across the clip with `ffmpeg`, then Read each still. Also note camera move, cut pace, and energy from the timeline. |
| Web page            | Fetch or screenshot; treat visible art direction as refs.                                                                                               |
| Text / brand notes  | Hard constraints. They win when they conflict with a ref.                                                                                               |

Video stills (need `ffmpeg` + `ffprobe`):

```bash
mkdir -p /tmp/create-style
dur=$(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$VIDEO")
for p in 15 40 65 90; do
  t=$(awk -v d="$dur" -v p="$p" 'BEGIN { printf "%.2f", d*p/100 }')
  ffmpeg -y -ss "$t" -i "$VIDEO" -frames:v 1 -q:v 2 "/tmp/create-style/f$p.jpg"
done
```

If `ffmpeg` is missing, say so and continue with stills + text you do have.
Skip a ref only when it is unreadable; list what you skipped.

Done when every provided ref is observed or explicitly skipped.

## Draft

`GET` list-styles (for slug clashes and as a specificity bar). Re-read
the live create-style schema; fill every required field it names. Omit
optional fields you cannot support. Never send server-managed fields
(`isTemplate`, ids, usage counts).

Write the recipe from the pixels:

- **Palette** — hexes sampled from the refs, 3–8 colors. No stock
  teal-and-orange cinematic set unless that is actually on screen.
- **Lighting / grading / mood / artStyle** — sources, direction, medium
  you can see (e.g. "35mm live action, window-side key, crushed teal
  shadows"). Not "cinematic, high quality".
- **Motion** — `camera` always. `pace` / `energy` when video or the user
  implied movement.
- **Name** — short distinctive title from the look, not the filename.
  If list-styles already has that slug, pick another.
- **references** — hosted URLs when the user gave them; otherwise short
  labels of the files you scanned.

Text-only input is allowed: draft the same complete config from the
description.

Done when the body satisfies the live required set.

## Create

`POST` the create-style href. Use that link's `examples` for shape, not
memory.

- `201` — take the document and stop retrying.
- `409` — rename once and POST again.
- `4xx` with `details` — fix the named fields and POST again.

There is no update/delete on v1. A tweak is a new style.

## Report

Return `name`, `id`, a one-line look summary, and a compose URL:

`{origin}/?style=<slug>&prefill=style#compose`

Slug the `name`: lowercase, spaces to hyphens. Use a `slug` field on
the created document when the API sends one.

To generate via the API, pass `style: "<name>"` (the `create-sequence`
skill). Follow `_links.create-sequence` on the style document only if
they asked for a video next.
