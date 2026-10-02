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

Every tool name has the `openstory.` prefix (`openstory.get_scene`); this guide drops it for brevity. Only `whoami` has none.

| What              | Value                                                                                                                                                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server URL        | `https://<your-openstory-host>/mcp` (Streamable HTTP, POST only, no sessions)                                                                                                                                                                                                                                        |
| Protocol revision | `2026-07-28`, plus 2025 sessions for clients that open one (`initialize`). A 2025 session lives on one server instance; when a request reaches another, the client gets "session not found" and opens a new session. With the official SDK client, set `versionNegotiation: { mode: 'auto' }` (or pin `2026-07-28`). |
| OAuth (preferred) | Discovery at `/.well-known/oauth-protected-resource/mcp`; dynamic client registration; authorization code + PKCE; `resource` = `https://<host>/mcp`. An unauthenticated request gets a 401 with a `WWW-Authenticate` challenge pointing at that document.                                                            |
| Static header     | `Authorization: Bearer osk_…` with an API key from Settings → Developer. API keys are not scoped.                                                                                                                                                                                                                    |
| Getting a key     | Without a browser redirect, use the REST device-code login: `POST /api/v1/device/code`, show the user the code, poll the returned link until it returns the key.                                                                                                                                                     |

### Scopes (OAuth only)

| Scope             | Grants                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sequences:read`  | Every read tool and resource.                                                                                                                                                  |
| `sequences:write` | `update_scene`, `update_sequence`, `archive_sequence`, `unarchive_sequence`, scene and shot create / reorder / delete / restore, `update_shot`, `plan_export`, `start_export`. |
| `generate`        | `create_sequence`, `regenerate_storyboard`, `plan_generation`, `execute_generation`, `retry_failed_work` — anything that can spend credits.                                    |

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
- A successful result has structured content and the same JSON as text; a coded error carries `structuredContent.error` (`code`, `message`, `details`). A result over 256 KiB is refused with a message telling you to page; nothing is silently cut.

### Resources

For hosts that attach context rather than call tools:

- `openstory://sequences/{sequenceId}/summary` — same as `get_sequence`.
- `openstory://sequences/{sequenceId}/bible` — same as `get_production_bible`.
- `openstory://sequences/{sequenceId}/scenes/{sceneId}` — same as `get_scene`.

`resources/templates/list` returns the templates, `resources/list` the summary and bible of your 50 latest sequences. Every resource has a tool, so nothing depends on a host supporting resources.

### Inline views (MCP Apps)

`get_sequence` links an MCP Apps view (`ui://openstory/sequence-card.html`): hosts that render MCP Apps show the poster, status, counts and music inline. Hosts without MCP Apps get the plain structured result; the view changes nothing in it.

## The production workflow

This is the loop an agent should follow. It is also the procedure to put in an agent skill.

0. **Create (optional).** `create_sequence` with a script starts a new sequence (same input as `POST /api/v1/sequences`); poll `get_sequence_status` until the storyboard is done. `regenerate_storyboard` replaces a sequence's whole script, style or aspect ratio and rebuilds every scene, so ask first.
1. **Inspect.** `get_sequence_status` for what is ready and what failed. `get_production_bible` for the story and cast. `get_scene` for the scene you will touch — note `script.id`.
2. **Edit.** `update_scene` with `sequenceId`, `sceneId`, `expectedScriptVersionId` (the `script.id` you read) and only the fields you change (`scriptExtract`, `title`, `location`, `timeOfDay`, `storyBeat`, `continuity`). A `CONFLICT` means the scene changed since you read it — possibly your own edit whose reply was lost (`details.selectedScriptVersionId` is the current version): read it again and redo the edit only if it is still needed. `changed: false` means nothing differed.
   Structure: `create_scene` (optionally with its script), `reorder_scenes`, `delete_scene` / `restore_scene`, `create_shot`, `reorder_shots`, `delete_shot` / `restore_shot`, `update_shot` (length, start frame on/off), `update_sequence` (title, target length, music on/off, default video model). Deletes are soft and undoable. None of these starts generation.
3. **See the effect.** The edit returns the scene and its first shots' staleness. `list_shot_staleness` pages the rest. Editing starts no generation.
4. **Plan.** `plan_generation` with `mode: "stale"` and a `depth` (`prompts`, `images`, `dialogue`, `video` or `music`: how far to update what the edit made stale; whole sequence, `sceneIds` or `shotIds`) or `mode: "missing"` with `stopAt` (continue an unfinished sequence, whole sequence only), or `retry_failed_work` after failures. A plan starts nothing. It returns per-stage shot ids, skipped shots, models, an estimate in USD (`null` when a component has no price) and `blockers`.
5. **Ask for approval.** Show the user the concrete work and the cost from the plan. Do not execute without a yes.
6. **Execute.** `execute_generation` with `planToken` and `confirm: true`. If the work or price moved since planning it is refused (`CONFLICT` with `details.code: "PLAN_CHANGED"`: plan again). A live run, a blocker or too few credits also refuse it, and the plan stays executable. Safe to retry after a timeout: a repeat returns the same `workflowRunIds` and never charges twice; `PLAN_CHANGED` or `GENERATION_IN_PROGRESS` on a repeat means the earlier call started the work — check `get_sequence_status`.
7. **Poll.** `get_operation_status` with the `workflowRunIds`, every `pollAfterSeconds`. It reports those runs only: per-shot failures, skips, and a `terminal` flag. `partially_failed` lists what failed; plan a retry for it. `LAUNCH_INCOMPLETE` from `execute_generation` names the runs that did start: poll them and do not plan the same work again.
8. **Inspect and export.** Read the shots again. `plan_export` previews what an export would do; `start_export` renders an MP4 (no plan or confirm: it spends no credits, and a ready MP4 of the same cut is reused). Poll `get_export_status`. The MP4 renderer runs in production only: on previews, local dev and self-hosted Deploy-button installs an export does not render.

## Not available through MCP yet

- Uploading media, or selecting an older version of a still or clip.
- Editing characters, locations, elements or shot prompts.
- Cancelling a running operation.

## Client compatibility

| Client                                                     | Status                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official MCP SDK client 2.1.0 (`versionNegotiation: auto`) | Tested in CI against the server handler (auth stubbed; the HTTP auth layer has its own tests): discovery, reads, sequence-wide and scene-filtered shot paging, scene ↔ shot navigation, resources, missing scope. |
| Clients that only speak the 2025 handshake                 | Served through a session (tested with the official SDK client in legacy mode).                                                                                                                                    |
| Claude Code                                                | Untested against a deployment.                                                                                                                                                                                    |
| Claude.ai custom connector                                 | Untested.                                                                                                                                                                                                         |
| Cursor                                                     | Untested.                                                                                                                                                                                                         |
| Codex, ChatGPT                                             | Untested.                                                                                                                                                                                                         |

"Untested" means no one has connected that client to a deployment and run the workflow above. Results are recorded here as they are verified.
