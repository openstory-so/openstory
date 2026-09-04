---
title: Public API
description: Create AI video sequences programmatically — one-shot create, poll for status, with HAL links, ?wait long-polling, and an OpenAPI 3.1 spec
section: Developer Guide
order: 1
---

OpenStory exposes a small public HTTP API so agents and scripts can create video
sequences without driving the UI. It is **self-describing**: an agent can learn
the whole surface from two unauthenticated endpoints and never has to read this
page.

## Discovery

- `GET /api/v1` — the API root: an instructions narrative, the create request
  JSON Schema, and a HAL `_links` catalog of available actions.
- `GET /api/v1/openapi.json` — the full OpenAPI 3.1 specification, generated from
  the same schema the API validates against.

Both are unauthenticated so tooling can discover the API before a key is wired
up. `https://openstory.so/llms.txt` also points here.

## Authentication

Except discovery and the device-login pair, callers send an `osk_` key **or**
an OAuth access token. Two ways to get a key:

- **Device-code login** (for agents/CLIs, no copy-pasting): `POST
/api/v1/device/code` returns a `device_code`, a short `user_code`, and a
  `verification_url`. Show the user the code and URL (or open
  `verification_url_complete`), then `GET
/api/v1/device/token?device_code=…&wait=60s` until it returns `200 { api_key,
team }`. While the user decides you get `428 authorization_pending` (keep
  polling; `?wait` blocks server-side), `429 slow_down` if you poll faster than
  `interval` without `?wait`, `403 access_denied`, or `410 expired_token` (codes
  last 10 minutes; start again). Both endpoints are rate limited per IP.
- **Manually**: create a key in the dashboard under **Settings → Developer**.

Either way the key is a normal key the user can revoke under Settings →
Developer. Send it as either header:

```
Authorization: Bearer <key>
x-api-key: <key>
```

Keys are team-scoped — a key only ever sees its own team's sequences — and rate
limited to **10 requests/second**; exceeding it returns `429` with a `Retry-After`
header.

### OAuth 2.1 ("login with OpenStory")

Apps that can run an authorization-code + PKCE flow — hosted MCP clients such
as Claude or Cursor, a fork of OpenStory offering "Connect OpenStory", anything
with a browser redirect — don't need a key at all. OpenStory is an OAuth 2.1
authorization server:

- **Discovery:** `GET /.well-known/oauth-authorization-server` (RFC 8414; also
  `/.well-known/openid-configuration`). The API's protected-resource document
  is `GET /.well-known/oauth-protected-resource/api/v1` (RFC 9728), and the
  MCP endpoint's is `/.well-known/oauth-protected-resource/mcp`.
- **Registration is dynamic** (RFC 7591): `POST /api/auth/oauth2/register`
  with your `redirect_uris` and `client_name`. No dashboard step. The endpoint
  is rate limited per IP. Unused DCR clients (no consent, no refresh token)
  older than a week are deleted on later registration requests.
- **Authorize:** send the user to `/api/auth/oauth2/authorize` with PKCE
  (`S256`), the scopes you need, and `resource=<origin>/api/v1` (RFC 8707) so
  the token is issued for this API. They sign in if needed, then approve on
  the consent page, which names your app and the team the grant bills to.
- **Token:** exchange the code at `/api/auth/oauth2/token`. Access tokens are
  JWTs valid for an hour; request `offline_access` for a refresh token.

Send the access token exactly like a key:

```
Authorization: Bearer <access_token>
```

Tokens are **scoped**, unlike keys:

| Scope             | Grants                                                    |
| ----------------- | --------------------------------------------------------- |
| `sequences:read`  | Every `GET`                                               |
| `sequences:write` | Edits and exports (`POST …/exports`, style mutations)     |
| `generate`        | Anything that spends credits (`POST /sequences`, enhance) |
| `credits:read`    | Credit balance (reserved for the MCP endpoint)            |

A token without the scope a route needs gets `403` with a
`WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` challenge
naming what to re-authorize with; an invalid or expired token gets `401` with
`error="invalid_token"`. Both carry `resource_metadata="…"` pointing at the
RFC 9728 document, which is how MCP clients find their way into the flow.

Users review and revoke grants under **Settings → Developer → Authorized
apps**. Revoking invalidates the refresh token immediately; an access token
already issued runs out within the hour.

## Create a sequence

`POST /api/v1/sequences` turns a script into a video sequence. Generation is
asynchronous: the call returns `202` immediately with the created sequence id(s)
and a status URL to poll.

```bash
curl -X POST https://openstory.so/api/v1/sequences \
  -H "Authorization: Bearer $OPENSTORY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "script": "A lighthouse keeper befriends a stranded whale.",
    "title": "Sea Tale",
    "style": "Cinematic Noir",
    "targetSeconds": 30,
    "motion": true,
    "music": true,
    "characters": ["Old Tom the keeper", { "name": "The whale", "isHuman": false }],
    "locations": ["Stormy lighthouse"]
  }'
```

The body is ergonomic: reference a style, cast member, or location by id or name,
or pass an inline object to create a new one. `enhance` (`auto` | `always` |
`off`) controls script expansion; `motion` and `music` toggle video and score.
See `GET /api/v1` or the OpenAPI spec for the full request schema.

Response (`202`):

```json
{
  "sequences": [
    {
      "id": "seq_…",
      "status": "draft",
      "workflowRunId": "…",
      "statusUrl": "/api/v1/sequences/seq_…",
      "_links": {
        "self": { "href": "…", "method": "GET" },
        "poll": { "href": "…", "method": "GET", "templated": true }
      }
    }
  ],
  "enhancedScript": "…",
  "_links": { "self": { "…": "…" } }
}
```

## Poll for status

`GET /api/v1/sequences/{id}` returns a database-derived status document: overall
status, the `style` and `models` it was generated with, aspect ratio, per-frame
image/video status and URLs, music, poster, and ready/failed counts. Because it
is derived from the database it is always correct, even if you reconnect later.

`style` is `{ id, name }` (the name is `null` only in the rare case the style
row fails to resolve) and `models` is `{ analysis, image, video, music }` — the
raw model ids. These are the same values the dashboard filters and searches
sequences on.

A terminal `completed` status can still carry `counts.videosFailed > 0` — a
failed frame does not fail the whole run — so check the counts to confirm an
end-to-end success.

## List your sequences

`GET /api/v1/sequences` returns your team's sequences, most recent first. Each
entry is a compact summary of the status document — `status`, `aspectRatio`,
`style`, `models`, `poster`, `music`, and the ready/failed `counts`, but **not**
the per-frame array — with a `self` link to its full status document.

```bash
curl "https://openstory.so/api/v1/sequences?limit=20" \
  -H "x-api-key: $OPENSTORY_API_KEY"
```

Page with `?limit` (default 20, max 100) and the opaque `?cursor` returned in the
response's `_links.next`. Follow that link to fetch the next page; its absence
means you've reached the end. Archived sequences are excluded.

## Long-polling with `?wait`

Agents often have no sleep tool, so every pollable endpoint accepts
`?wait=<duration>` (`60s`, `30`, `2m`, `1500ms`; capped at 90s). The server holds
the request open and returns the moment the sequence changes or reaches a
terminal state:

```bash
curl "https://openstory.so/api/v1/sequences/seq_…?wait=60s" \
  -H "x-api-key: $OPENSTORY_API_KEY"
```

The response carries `X-Wait-Changed` (did it advance?) and `X-Wait-Done` (is it
terminal?) headers. On `POST`, `?wait` additionally embeds each new sequence's
first progress snapshot, with `waitChanged`/`waitDone` flags per sequence. A
malformed `wait` value is rejected with `400` rather than silently downgrading to
a non-blocking request.

## Conventions

- **HAL links.** Every response includes a `_links` map of the actions available
  from that resource, each stating its `method`. Follow links rather than
  hardcoding paths.
- **Errors are always JSON:** `{ "error": { "code", "message", "details"? } }`
  with the matching HTTP status — never an HTML page or redirect.
