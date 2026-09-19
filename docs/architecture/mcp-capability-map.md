# MCP production read coverage

This branch implements **46 read tools plus `whoami`** at `/mcp`. It expands [#1458](https://github.com/openstory-so/openstory/issues/1458) from sequence/scene/shot inspection to the active sequence production graph, Studio, Gallery and asset libraries. Every production tool requires `sequences:read` for OAuth; existing API keys retain their unscoped semantics.

## Registered tools

Every name below has the `openstory.` prefix.

| Area                   | Tools                                                                                                                         | Content                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production navigation  | `list_sequences`, `get_sequence`, `get_sequence_status`, `list_scenes`, `get_scene`, `list_shots`, `get_shot`                 | Sequence summaries, selected scripts, narrative/continuity, shot parameters, selected images/videos/prompts, aggregate failures and active work references                               |
| Characters             | `list_characters`, `get_character`                                                                                            | Appearance, clothing, performance, analysis label, linked talent ID, first mention, selected reference sheet, generation status, assigned voice, voice previews and effective voice mode |
| Locations              | `list_locations`, `get_location`                                                                                              | Environment/design/lighting, analysis label, linked library ID, first mention, selected reference sheet and generation status                                                            |
| Elements               | `list_elements`, `get_element`                                                                                                | Script token, image/video/audio kind, filename, description, media URL, duration, first mention and analysis status                                                                      |
| Sequence configuration | `get_sequence_settings`                                                                                                       | Model defaults, dimensions, target duration, music/voice/start-frame flags, pipeline/stop settings and effective style snapshot (normalised to v2)                                       |
| Script                 | `get_sequence_script`                                                                                                         | Original or composed script; composed uses active selected scene versions, falling back to original before any script is available                                                       |
| Frames                 | `list_frames`, `get_frame`                                                                                                    | Every frame role and order, selected image/prompt IDs, pending selection, status and error                                                                                               |
| Render segments        | `list_render_segments`, `get_render_segment`                                                                                  | Scene ownership, selected/pending video IDs and paged current shot membership                                                                                                            |
| Histories              | `list_versions`, `get_version`                                                                                                | Nine explicitly supported history kinds, including discarded versions when requested, selected state, media links and full version content                                               |
| Music and audio        | `get_sequence_music`, `get_shot_audio`                                                                                        | Current music state/prompt/tags and the shot's working dialogue clips; historical clips and audio direction are in motion-prompt versions                                                |
| Reference usage        | `list_shot_references`, `list_entity_usages`                                                                                  | Both directions between shots and characters/locations/elements, using the existing scene/reference matching functions                                                                   |
| Freshness              | `get_shot_staleness`, `list_shot_staleness`, `get_reference_staleness`, `get_render_segment_staleness`, `get_music_staleness` | Existing product hash/pointer semantics for prompts, images, reference sheets, video manifests and music prompts                                                                         |
| Activity               | `list_sequence_events`, `get_sequence_event`                                                                                  | Event metadata, entity/version references and the stored change details                                                                                                                  |
| Exports                | `list_exports`, `get_export_status`                                                                                           | Existing ready/processing/failed exports, source-cut hash, duration, workflow ID, error and URL; no render or reconciliation side effects                                                |

## Studio, Gallery and libraries

| Area                           | Tools                                            | Content                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Talent library                 | `list_talent`, `get_talent`                      | Team and public identities, appearance/performance descriptions, voices, avatar, favorites and library flags                                                         |
| Location library               | `list_library_locations`, `get_library_location` | Team and public location descriptions, reference images and reference hashes                                                                                         |
| Styles                         | `list_styles`, `get_style`                       | Team and public library styles, complete stored configurations, defaults, tags, use cases, sample videos, derived Gallery sample, hover video and preview still URLs |
| Gallery                        | `list_gallery_samples`                           | The same showcase selection and canonical fallback as the app; style IDs link to full details                                                                        |
| Library children               | `list_library_resources`, `get_library_resource` | Talent sheets, uploaded reference images/videos/recordings, talent sheet versions, location sheets and versions, audio and VFX                                       |
| Studio and catalog generations | `list_generated_assets`, `get_generated_asset`   | Team runs, source/activity/endpoint/favorite filters, full input settings and prompts, output media, status/errors, cost and workflow reference                      |
| Studio uploads                 | `list_studio_uploads`                            | Every page of team composer uploads: image/video/audio URLs, MIME type, size and upload date                                                                         |

Library detail tools take `id` and return revision-checked JSON document windows, including long descriptions/configurations. Lists select compact summaries; detail tools return all documented public fields. Library resources use these `kind` / `parentId` combinations. `parentId` is required for every child kind and must be omitted for `audio` / `vfx`:

| Kind                                       | Parent              |
| ------------------------------------------ | ------------------- |
| `talent_sheet`, `talent_media`             | Talent ID           |
| `talent_sheet_version`                     | Talent sheet ID     |
| `location_sheet`, `location_sheet_version` | Library location ID |
| `audio`, `vfx`                             | No parent           |

Library sheet versions include discarded entries and retain divergence/discard markers. Sequence-location versions remain under `list_versions`; the type-tagged parent prevents confusing them with library-location history.

For a complete talent read, follow `list_talent` → `get_talent` → `list_library_resources(kind: "talent_sheet" / "talent_media", parentId: talentId)` → `get_library_resource` for each ID. Follow each sheet through `talent_sheet_version`. For locations, use `location_sheet` and `location_sheet_version` with the library location ID. These lists include public resources as well as the current team's private resources.

For Studio, use `list_generated_assets({ source: "studio" })` and `get_generated_asset({ id })`, plus `list_studio_uploads`. Omit `source` to include retained catalog runs. For Gallery, use `list_gallery_samples` and then `get_style` for settings and all persisted samples.

## Version navigation

`list_versions` takes `sequenceId`, `kind`, `entityId`, `limit`, optional `cursor`, and `includeDiscarded` (default false). `get_version` adds `versionId` and document-window arguments.

| `kind`            | Meaning of `entityId`              | Full version detail                                                                                                      |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `image`           | Frame ID                           | Image URL, model, resolution, framing/upload/preview kind, prompt dependency, hashes and generation state                |
| `video`           | Render-segment ID                  | Video URL, model, resolution and immutable input manifest, including covered shot/frame/prompt/audio identities          |
| `character_sheet` | Sequence-character database ID     | Sheet output, model, hash, generation/divergence/discard state                                                           |
| `location_sheet`  | Sequence-location database ID      | Reference output/model/hash and generation/divergence/discard state; library-location sheets are a different parent type |
| `music`           | Sequence ID (same as `sequenceId`) | Track URL, model, prompt/tags, duration, loudness and divergence/discard state                                           |
| `visual_prompt`   | Frame ID                           | Full text, structured components, source/model/hash, author and lifecycle                                                |
| `motion_prompt`   | Shot ID                            | Full text, components, parameters, dialogue, audio direction, captured clips, mode, source/model/hash and author         |
| `music_prompt`    | Sequence ID (same as `sequenceId`) | Full prompt/tags, source/model/hash and author                                                                           |
| `scene_script`    | Scene ID                           | Script extract, dialogue, source and author                                                                              |

Character/location selection resolves the existing legacy fallback when the selection pointer is null. Music has no selected-version pointer: track matches use output URL and model; prompt matches use text and tags. Multiple history rows may therefore match the current music state. A selected version and a failed newer generation remain separate facts.

## Pagination and document windows

- Collections use database keyset paging. Default limit is 20, maximum 100. `list_shot_staleness` uses default 5, maximum 20 because dependency comparison is more expensive; it shares sequence reference loads across the page.
- New database collections are ordered by stable database ID, oldest ID first, except generated assets (newest first). Studio uploads follow storage-key order. Frame `orderIndex`, scene order and shot `shotNumber` describe creative/playback order. Existing scene/shot tools retain their hierarchical ordering.
- Pass `nextCursor` with the same team/sequence, collection, parent and filters. Cursors from another collection/filter are rejected. Changing page size is allowed.
- Usage queries page **candidates examined**, then apply the same matchers as the editor. `examined` reports the work scanned. An empty page with a non-null cursor does not mean there are no further matches. Continue until `nextCursor` is null.
- Version lists select compact metadata without loading prompt text or render manifests. Full content is fetched by explicit version ID.
- Large scripts, version records, library/asset details, audio clip sets and activity payloads use `document.text`, `offset`, `totalLength`, `nextOffset`, `revision` and `format`. Default window length is 8,000 UTF-16 code units, maximum 16,000.
- Continue with `offset: nextOffset` and the returned `revision`. A changed document rejects the continuation. For `format: json`, concatenate all windows before parsing JSON. UTF-16 windows can split a surrogate pair; joining the returned strings restores the original text.
- Both structured results and JSON text fallback are returned. Their combined envelope is capped at 256 KiB. Oversized collections return an actionable error to reduce the page size; data is not silently truncated.
- Version, reference and media outputs have explicit schema allowlists. Database storage paths and pending input claims are excluded. Media URLs are made absolute using the same storage helper as the public API.

## Traversal examples

Read a character and discover every affected shot:

1. `list_characters({ sequenceId })` → a database character `id`.
2. `get_character({ sequenceId, characterId: id })` → selected sheet and voice state.
3. `list_versions({ sequenceId, kind: "character_sheet", entityId: id })` → history IDs.
4. `get_version({ sequenceId, kind: "character_sheet", entityId: id, versionId })` → full version document.
5. `list_entity_usages({ sequenceId, kind: "character", entityId: id })` → shot/scene IDs, continuing every page.
6. `get_shot({ sequenceId, shotId })` and `get_shot_staleness({ sequenceId, shotId })` → current outputs and freshness.

Inspect how a video was produced:

1. `get_shot` → `renderSegmentId` and selected video version ID.
2. `get_render_segment` → current membership, with pagination.
3. `get_version({ sequenceId, kind: "video", entityId: renderSegmentId, versionId })` → captured render manifest.
4. Follow manifest frame/motion-prompt IDs through the relevant `get_version` calls.
5. `get_render_segment_staleness` → comparison with current inputs and voice bindings.

## Authorization and read-only behavior

The MCP server is a request composition boundary. Its narrow `no-scoped-factory` exception permits `createScopedDb(auth.teamId, auth.user.id)` after checking the OAuth read scope. It has no raw-DB or SQL exception. Discovery and `whoami` do not create a scoped DB.

Queries live in product `server/db/` modules. Production repository entry points authorize the sequence, then validate the owning child chain. Library reads permit team-owned or explicitly public resources; styles exclude sequence-bound rows. Every library child read validates its parent, including the talent → sheet → version chain. Generated assets and audio/VFX libraries remain team-only. Studio upload cursors are team-bound and R2 queries use an exact directory prefix. Gallery and upload pages report candidates examined and must continue even when a filtered page is empty. A frame must belong to an active shot in that sequence; a segment must belong to an active scene. History lookups also constrain the version's actual parent, including location sheet parent type. Wrong-team, wrong-sequence, wrong-parent and deleted-child reads return not-found.

The new read methods use `get`/`list` names so the existing `WorkflowScopedDb` type removes them from workflow write surfaces. MCP reads never repair anchor frames, alter selections, claim generation, reserve credits, start exports or reconcile jobs.

Staleness uses existing domain semantics. A missing anchor is reported as untracked rather than created. Voice-only characters report sheet freshness as not applicable. Music track-level freshness is explicitly untracked; the current product derives music regeneration from prompt changes. These are inspection tools, not a second generation planner.

## Remaining MCP work

This PR covers active production inspection, retained histories, Studio, Gallery, talent/location/style libraries and stored audio/VFX assets. It does not expose mutations, paid execution, archived/deleted entity recovery, live provider model catalogs, billing administration or cross-team support/admin views. Retained model-catalog generations are readable through generated-asset tools.

The intended next boundaries are:

1. **This PR:** production, Studio, Gallery and library reads, shared contracts, docs and tests.
2. **Editing:** sequence creation/settings, scene/shot structure, cast/location/element editing, prompts, media uploads and version selection through shared domain operations.
3. **Execution:** generation plans/approval, replay-safe execution, operation polling, cancellation, retries and export rendering.

[#1462](https://github.com/openstory-so/openstory/issues/1462) can assemble bible/resources from shared read projections without waiting for mutations. [#1463](https://github.com/openstory-so/openstory/issues/1463) covers incremental client compatibility and workflow documentation. Local tests exercise the official server handler with real migrated SQLite; a deployed client compatibility matrix is separate release evidence and is not claimed by those tests.
