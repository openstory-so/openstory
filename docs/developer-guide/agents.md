---
title: Use OpenStory from an agent
description: Connect an MCP client or script to OpenStory — inspect a production, edit a scene, plan and approve generation, poll it, and export
section: Developer Guide
order: 2
---

OpenStory has two agent surfaces:

- **MCP** at `/mcp` — inspect a whole production, edit scenes, plan and run generation, and export. This is the one to use from Claude, Cursor or any MCP client.
- **REST** at `/api/v1` — create a sequence from a script in one call, then poll it. See [Public API](/docs/developer-guide/public-api). Use it where MCP is not available, and for creating sequences (MCP cannot create one yet).

## Connect

| What              | Value                                                                                                                                                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server URL        | `https://<your-openstory-host>/mcp` (Streamable HTTP, POST only, no sessions)                                                                                                                                                                             |
| Protocol revision | `2026-07-28` only. A client that only speaks the 2025 handshake gets `-32022 Unsupported protocol version` naming the supported revision. With the official SDK client, set `versionNegotiation: { mode: 'auto' }` (or pin `2026-07-28`).                 |
| OAuth (preferred) | Discovery at `/.well-known/oauth-protected-resource/mcp`; dynamic client registration; authorization code + PKCE; `resource` = `https://<host>/mcp`. An unauthenticated request gets a 401 with a `WWW-Authenticate` challenge pointing at that document. |
| Static header     | `Authorization: Bearer osk_…` with an API key from Settings → Developer. API keys are not scoped.                                                                                                                                                         |
| Getting a key     | Without a browser redirect, use the REST device-code login: `POST /api/v1/device/code`, show the user the code, poll the returned link until it returns the key.                                                                                          |

### Scopes (OAuth only)

| Scope             | Grants                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `sequences:read`  | Every read tool and resource.                                                                   |
| `sequences:write` | `update_scene`, `plan_export`, `start_export`.                                                  |
| `generate`        | `plan_generation`, `execute_generation`, `retry_failed_work` — anything that can spend credits. |

A missing scope is a tool error with code `INSUFFICIENT_SCOPE` and `details.scope` naming what to re-authorize with. Tool discovery and `whoami` need no scope.

## Identifiers

- `sequenceId` is required on every production tool; everything below it is checked against it.
- A **scene** id (`sceneId`) and a **shot** id (`shotId`) are different things. `get_scene` takes a scene id and refuses a shot id; `get_shot` takes a shot id and refuses a scene id. A shot carries its parent `sceneId`, so you can always navigate back up.
- What a scene or shot shows is its **selected version** (script, prompt, still, clip). Reads return the selected version and its id; `update_scene` asks for the selected script version you read, so an edit never overwrites one you did not see.
- Ids from another team, another sequence or a deleted row are reported as not found.

## Reads, pages and limits

- Start with `list_sequences`, then `get_sequence` (summary and counts) or `get_sequence_status` (failures, cheaper).
- `list_scenes` and `list_shots` page with `limit` and the opaque `nextCursor`. Prompts and media are opt-in (`includePrompts`, `includeAssets`).
- `get_production_bible` returns style, cast, locations, elements and every scene's narrative in one call. When it cannot include everything, a `*Truncated` field names the list tool (and cursor) that continues it.
- Every result has structured content and the same JSON as text. A result over 256 KiB is refused with a message telling you to page; nothing is silently cut.

### Resources

For hosts that attach context rather than call tools:

- `openstory://sequences/{sequenceId}/summary` — same as `get_sequence`.
- `openstory://sequences/{sequenceId}/bible` — same as `get_production_bible`.
- `openstory://sequences/{sequenceId}/scenes/{sceneId}` — same as `get_scene`.

`resources/templates/list` returns the templates, `resources/list` the summary and bible of your 50 latest sequences. Every resource has a tool, so nothing depends on a host supporting resources.

### Inline views (MCP Apps)

`get_sequence` links an MCP Apps view (`ui://openstory/sequence-card.html`): hosts that render MCP Apps show the poster, status, counts and music inline. Hosts without MCP Apps get the same structured result as before.

## The production workflow

This is the loop an agent should follow. It is also the procedure to put in an agent skill.

1. **Inspect.** `get_sequence_status` for what is ready and what failed. `get_production_bible` for the story and cast. `get_scene` for the scene you will touch — note `script.id`.
2. **Edit.** `update_scene` with `sequenceId`, `sceneId`, `expectedScriptVersionId` (the `script.id` you read) and only the fields you change (`scriptExtract`, `title`, `location`, `timeOfDay`, `storyBeat`, `continuity`). A `CONFLICT` means someone else edited the scene: read it again and redo the edit. `changed: false` means nothing differed.
3. **See the effect.** The edit returns the scene and its first shots' staleness. `list_shot_staleness` pages the rest. Editing starts no generation.
4. **Plan.** `plan_generation` with `mode: "stale"` (update what the edit made stale; whole sequence, `sceneIds` or `shotIds`) or `mode: "missing"` (continue an unfinished sequence, `stopAt` a stage), or `retry_failed_work` after failures. A plan starts nothing. It returns per-stage shot ids, skipped shots, models, an estimate in USD and `blockers`.
5. **Ask for approval.** Show the user the concrete work and the cost from the plan. Do not execute without a yes.
6. **Execute.** `execute_generation` with `planId` and `confirm: true`. If the work or price moved since planning it is refused (`PLAN_CHANGED`, plan again); after 30 minutes `PLAN_EXPIRED`. Calling it again for the same plan returns the same operation and never charges twice — safe to retry after a timeout.
7. **Poll.** `get_operation_status` with the `operationId`, every `pollAfterSeconds`. It reports this run only: per-shot failures, skips, and a `terminal` flag. `partially_failed` lists what failed; plan a retry for it.
8. **Inspect and export.** Read the shots again. `plan_export` then `start_export` (with `confirm: true`) renders an MP4; a ready MP4 of the same cut is reused. Poll `get_export_status`.

## Not available through MCP yet

- Creating a sequence — use `POST /api/v1/sequences`.
- Choosing a shot's starting frame, uploading media, or selecting an older version of a still or clip.
- Editing characters, locations, elements, shot prompts or sequence settings.
- Cancelling a running operation.

## Client compatibility

| Client                                                     | Status                                                                                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Official MCP SDK client 2.1.0 (`versionNegotiation: auto`) | Tested in CI over Streamable HTTP: discovery, reads and paging, scene ↔ shot navigation, resources, stale-edit conflict, missing scope. |
| Clients that only speak the 2025 handshake                 | Refused with `-32022` (tested).                                                                                                         |
| Claude Code                                                | Untested against a deployment.                                                                                                          |
| Claude.ai custom connector                                 | Untested.                                                                                                                               |
| Cursor                                                     | Untested.                                                                                                                               |
| Codex, ChatGPT                                             | Untested.                                                                                                                               |

"Untested" means no one has connected that client to a deployment and run the workflow above. Results are recorded here as they are verified.
