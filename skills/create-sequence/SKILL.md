---
name: create-sequence
description: >
  Create a multi-scene AI video sequence via OpenStory's public HTTP API
  — turn a script or brief into a sequence, enhance a script, poll
  generation, and export a stitched MP4. Use when asked to make,
  generate, or produce a video or sequence from a script or idea; to
  enhance or expand an OpenStory script; to check generation status; to
  export/download an MP4; or when the user runs /create-sequence. Not
  for creating a library style (that's create-style) and not for editing
  the OpenStory codebase.
---

# Create sequence

Public API at `https://openstory.so`. Override the origin only when the user
gives a self-hosted base URL.

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

## Create a video

API defaults are stills (`motion`/`music` false). Unless the user says
otherwise, send `motion: true`, `music: true`, `enhance: "auto"`. Set
`targetSeconds` from the brief; omit it if they did not imply a length.
`music: true` requires `motion: true`.

Pass style, cast, and locations as **names** or inline `{ name, ... }`
objects. Never invent ids. Omit `style` to let the API pick. Mint a new
library style from refs with `create-style`. Do not send person
`referenceImageUrls` unless the user provided images and the live
schema's portrait-attestation fields.

`POST` the `_links.create-sequence` href with a JSON body. Expect `202`.
Take `sequences[0]`; follow its `_links.poll` (or `statusUrl`).

## Poll generation

Sequence status long-polls. Append `?wait=60s` (also `30`, `2m`,
`1500ms`; cap 90s). A malformed `wait` is `400` — do not invent other
syntax.

Repeat `GET` on the poll link until `X-Wait-Done: true`. Then:

- `failed` / `archived` → report and stop.
- `completed` → read `counts`. `videosFailed > 0` means the run finished
  with broken shots; say so. Do not call it a full success.

Status is database-backed; reconnecting and polling again is correct.

## Export MP4

Export only when `counts.videosReady === counts.shots` and
`videosFailed === 0`. Otherwise the export `POST` rejects a partial cut.

1. `POST` `_links.create-export` (empty JSON object is valid).
2. `GET` `_links.exports` until an entry is `ready` (use its `url`) or
   `failed` (surface `error`). Export list does **not** long-poll.
3. Return the HTTPS URL. Download to disk only if the user asked for a
   local file.

For every still, line, and clip on disk (not just the MP4), with a
shell: `npx @openstory/cli@latest pull <sequenceId> --dir <dir>`. It
signs in on first use and skips files already there. `--exports` adds
rendered MP4s.

## Enhance only

When the user wants a script, not a video: `POST` `_links.enhance-script`.
The response is SSE:

- unnamed `data:` frames → `{ "delta": "..." }`
- `event: done` → `{ "enhancedScript", "_links" }`
- `event: error` → fail

Stop after `done` unless they then want a sequence — follow that
response's `create-sequence` example (`enhance: "off"`).

## List

`GET` `_links.list-sequences` for this key's sequences. Page with the
`next` link; its absence is the end.
