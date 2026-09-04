# Manual pipeline CRUD — the product contract (#1108)

Every sequence-pipeline entity is CRUD-able through server functions, with
downstream-only invalidation: a filmmaker (or a future API/MCP layer wrapping
these fns) can drive the whole pipeline by hand — create structure, write
prompts, upload media, edit cast, recover from failures — without ever running
storyboard. This doc is the **as-implemented** contract: the invalidation
rules, the soft-delete semantics, and the server-fn inventory the future API
maps onto.

It builds on two existing docs — read those for the _why_ of hashing:

- [workflow-snapshots-and-content-hash-staleness.md](./workflow-snapshots-and-content-hash-staleness.md) — why inputs are hashed and snapshotted
- [prompt-staleness-dependency-graph.md](./prompt-staleness-dependency-graph.md) — the per-artifact hash surfaces and stamp/verify symmetry

Plan of record: `docs/plans/manual-pipeline-crud.md` (§4 is the source these
rules were implemented from; where the two disagree, THIS doc describes what
shipped).

---

## 1. Invalidation contract (as implemented)

### 1.1 Principles

1. **Staleness is derived, never stored.** Every rule below is a consequence of
   what each artifact's input hash contains — no mutation writes a stale flag,
   and no mutation manually flips another artifact's hash.
2. **Video "clearing" is derivation, not a status write.** Since #1067 phase 2d
   there are no `shots.video*` columns. A render's `video_variants.manifest`
   names the exact motion-prompt / frame-version ids it consumed; when a
   selection pointer moves past them, the render reads stale
   (`scene-segments.ts`). Nothing is set to "pending".
3. **Position is identity, not content (hash v5).** `sceneId` (v4, #867) and
   `sceneNumber` (v5, #1108) are excluded from the prompt-hash scene surface —
   a pure scene/shot reorder changes **no** prompt or image hash.
   **Documented exception:** the _music prompt_ hashes the ordered
   `sceneSummaries` array, so reordering scenes legitimately re-stales it — a
   score follows narrative order; that is a real driver, not identity.
4. **Never auto-mutate upstream.** Replacing a still never rewrites the visual
   prompt; editing a bible never touches scenes; soft-deleting cast never
   strips scene continuity tags.
5. **Versions are append-only; selection is a pointer; soft discard only.**

### 1.2 Edge table (what a mutation stales)

| User mutation                                     | Goes stale (derived)                                                                      | Untouched                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Scene script / location / timeOfDay / storyBeat   | Visual + motion prompts of the scene's shots                                              | Title (display label); sheets (no script→bible edge — locked decision #3) |
| Scene/shot **reorder**                            | Music prompt only (ordered summaries)                                                     | Visual/motion prompts, images, video (v5)                                 |
| Shot duration                                     | Video (manifest value-snapshot)                                                           | Prompts, stills                                                           |
| Character/location bible field edit               | Prompts of referencing scenes (projected visual fields); the entity's sheet               | Name (display label); unreferenced entities                               |
| Regenerate sheet (from current bible)             | Stills of referencing scenes (selected version id enters the still hash); then video      | Recast talent binding; shots are not auto-regenerated                     |
| `consistencyTag` edit                             | The sheet only                                                                            | Prompts (projected out of the prompt hash, #867)                          |
| Soft-delete character/location/element            | Prompts of referencing scenes (entity leaves the narrowed bible)                          | Continuity tags, the row's own hashes                                     |
| Visual prompt edit (save or §1.3 A)               | Image (prompt text is in the image hash)                                                  | Video, until the image itself moves                                       |
| Still replaced (upload or regen + select, §1.3 B) | Video (manifest names the superseded frame version); motion prompt (starting-frame URL)   | Visual prompt                                                             |
| Motion prompt edit                                | Video (manifest names the superseded motion version)                                      | Still, visual prompt                                                      |
| Music prompt user-edit                            | Nothing derived — hash goes **null → 'untracked'** (no nag; regenerate is user-initiated) | The playing track, uploaded scores                                        |
| Sheet manual upload                               | Stills (selected version id is a new identity); the sheet itself is fresh if inputs match | Prompts                                                                   |

### 1.3 Prompt + still replace (the atomic rule)

| Op                     | Fn                                                      | Behavior                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** prompt only      | `saveShotPromptFn`                                      | Append `user-edit` version; image reads stale.                                                                                                                                                                                                                                                                                        |
| **B** still only       | `replaceFrameContentFn` (omit / unchanged `promptText`) | Append `frame_variants` `kind:'upload'` stamped against the **current** selected prompt + sheets, then `frameVariants.select` (the exact `setImageFromVariantFn` repoint). Video stale by derivation.                                                                                                                                 |
| **C** both, atomically | `replaceFrameContentFn`                                 | ONE `db.batch()` via `frameVariants.replaceContent`: prompt version (stamped) + image version hashed against the **new** text + both pointers repointed + live prompt claims demoted + events. The image can never be observed stale relative to its prompt. Unchanged prompt text silently degrades to B (no duplicate history row). |

Stamp == verify **by construction**: the upload hash goes through
`buildRegenerateShotSnapshot` — the same function `computeShotStaleness`
verifies with — including resolving the `user-upload` sentinel model through
`safeTextToImageModel` exactly as verify does
(`src/lib/shots/upload-media.ts`).

### 1.4 Upload hash-stamping semantics (per surface)

| Surface                  | Stamped hash                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Null/untracked case                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frame still              | Current (B) or new (C) prompt text + current sheet/element ref hashes + resolved model + aspect ratio                                                                                                                                                                                                                                                                                                                                                                                                           | Frame with **no selected prompt** stamps null → 'untracked' (verify only compares when a prompt exists); a later prompt makes it stale, correctly |
| Shot video               | `computeVideoManifestInputHash` over a manifest of the **current** selected motion/frame pointers + durationMs (the upload's decoded duration re-snaps `shots.durationMs` **before** hashing)                                                                                                                                                                                                                                                                                                                   | —                                                                                                                                                 |
| Sequence music           | **Always null** → 'untracked' (§4.4 escape hatch, deliberate): no track-level verify exists, and a user's chosen score must never nag for regeneration. The previous `user-upload` primary is **retired** (soft-discarded), not overwritten, so history survives. `includeMusic` is switched on — choosing a track is opting in.                                                                                                                                                                                |
| Character/location sheet | The PARENT (`characters.sheetInputHash` / `sequence_locations.referenceInputHash`) and each VERSION row get the same verify-mirrored current-inputs hash (bible + talent/library ref + style + model) so later edits re-stale the sheet. `selectedSheetVersionId` / `selectedReferenceVersionId` is the live pointer (mirrored onto the parent URL). Stills hash the selected version id when present, else the parent input hash — so a new sheet image re-stales stills even when bible inputs didn't change. | Legacy rows with no selection pointer keep hashing the parent input hash (no catalog-wide untracked wipe).                                        |

All uploads: presign (`getSignedUploadUrl` → client PUT to
`/api/storage/upload`) → finalize. Finalize validates the `publicUrl` against
the caller's team namespace (`<bucket>/teams/<teamId>/…`, no traversal) and the
presign enforces a per-surface extension allow-list (an `.svg` under `/r2/`
would be stored XSS). `USER_UPLOAD_MODEL = 'user-upload'` is never a valid
generation model id — every model-resolution tier skips it by design.

---

## 2. Soft-delete contract

Product delete is **soft** everywhere; the only hard-delete paths left are the
storyboard full-regen wipe (`shots.delete*` / `scenes.delete*` — a separate,
confirmed destructive path) and admin/GC scoped methods, each documented at the
method.

| Table                | Column              | Cascade                                           | Revival on re-analysis upsert                            |
| -------------------- | ------------------- | ------------------------------------------------- | -------------------------------------------------------- |
| `scenes`             | `deletedAt`         | soft-deletes its LIVE shots, one shared timestamp | slot identity: `(sequenceId, orderIndex)`                |
| `shots`              | `deletedAt`         | —                                                 | slot identity: `(sceneId, shotNumber)`                   |
| `characters`         | `deletedAt`         | —                                                 | analysis identity: `(sequenceId, characterId)`           |
| `sequence_locations` | `deletedAt`         | —                                                 | analysis identity: `(sequenceId, locationId)`            |
| `sequence_elements`  | `deletedAt`         | —                                                 | none (tokens stay reserved across deleted rows)          |
| `sequences`          | `status='archived'` | —                                                 | n/a (unarchive restores the event-recorded prior status) |

**Restore semantics.** Deleted rows KEEP their order slot (`orderIndex` /
`shotNumber` — the unique indexes span deleted rows, so nothing can steal it),
which makes restore positionally exact with no bookkeeping. Only a reorder
moves deleted rows — into the tail band after the live set, relative order
preserved (two-pass negative-park inside one `db.batch()` so the unique
indexes never collide mid-flight). Restored rows come back with their prior
hashes and may honestly read stale if upstream moved meanwhile.

**Scene cascade + selective restore.** `softDeleteCascade` stamps the scene and
its live shots with ONE shared `deletedAt` and records the exact cascade set in
the `scene.deleted` event's `data.shotIds` (same batch). `restoreCascade`
restores exactly the shots named by that event — a shot the user deleted
separately earlier (even within the same second: `deletedAt` has SECOND
precision) stays hidden. Timestamp-equality matching survives only as the
fallback for pre-event/pruned rows. `shots.restore` refuses while
the parent scene is deleted ("restore the scene instead") — live-shot ⇒
live-scene is an invariant. Cast soft-delete does **not** strip scene
continuity tags (lossless undo); the UI may render a "missing cast" warning by
diffing tags against the live cast list.

**Read surfaces** (the ghost-prevention rule, condensed — every default
sequence-scoped read excludes deleted rows):

- **Filtered at the scoped list layer** (all callers inherit):
  `scenes.listBySequence`, `shots.listBySequence` (⇒ editor, prompt contexts,
  update-stale-plan/Update-all, smart retry, export inputs, theatre, api-v1,
  VTT), `sequences.listShotsByIds`, `shots.countInRenderSegment`,
  `characters.list/listWithTalent/listWithSheets/getNeedingSheets`,
  `sequenceLocations.list/listWithReferences/getNeedingReferences/getTeamLibrary`,
  `sequenceElements.list/getShotCountsByElement`, the character/location/element
  → shots matcher scans (recast + replace-element affected sets).
- **Deliberately unfiltered:** id-addressed gets (`getById`/`getByIds`/
  `getWithSequence` — restore, claims, middleware need deleted rows), admin
  reads (support sees everything), and `sequenceElements.cascadeRename`'s shot
  scan (a token rename must reach deleted shots so a later restore comes back
  consistent).
- **Segments re-tile by derivation:** `getSequenceSegmentsFn` builds membership
  from the filtered shots list, so a segment with no live shots never surfaces;
  segment rows are retained for restore.

Every mutation logs a `sequence_events` row (`data.prevState` carries what
restore/undo needs: prev orderIndex, prev pointers, prev bible values, cascade
shot ids). Target types: `sequence | scene | shot | frame | variant | character
| location | element`. Events for pointer mutations commit in the SAME
`db.batch()` as the mutation.

---

## 3. Server-fn inventory (the future API map)

Grouped the way an API/MCP layer would wrap them. Auth: `shot…` fns use
`shotAccessMiddleware` (input `sequenceId + shotId`), the rest
`sequenceAccessMiddleware` (input `sequenceId`) unless noted.

### Media inject (`src/functions/media-upload.ts`)

| Fn                                                                                                | Input → output                                                                                  | Rule enforced                                                    |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `presignFrameImageUploadFn` / `presignShotVideoUploadFn`                                          | `{…, filename}` → `{uploadUrl, publicUrl, path, contentType}`                                   | extension allow-list, team-namespace path                        |
| `presignSequenceMusicUploadFn` / `presignCharacterSheetUploadFn` / `presignLocationSheetUploadFn` | `{sequenceId, filename (+characterId/locationDbId)}` → same                                     | same                                                             |
| `replaceFrameContentFn`                                                                           | `{…, frameId?, promptText?, publicUrl}` → `{shotId, versionId, promptVersionId, promptChanged}` | §1.3 B (omit/unchanged prompt) + C (atomic)                      |
| `setShotVideoFromUploadFn`                                                                        | `{…, publicUrl, durationSeconds?}` → `{shotId, versionId, videoUrl}`                            | manifest snapshot; duration re-snap; rejects multi-shot segments |
| `setSequenceMusicFromUploadFn`                                                                    | `{sequenceId, publicUrl, durationSeconds?}` → `{sequence, variantId}`                           | §1.4 music (retire + untracked + includeMusic)                   |
| `setCharacterSheetFromUploadFn` / `setLocationSheetFromUploadFn`                                  | `{sequenceId, characterId/locationDbId, publicUrl}` → updated row                               | §1.4 sheets (append version + select)                            |
| `regenerateCharacterSheetFn` / `regenerateLocationSheetFn`                                        | `{sequenceId, characterId/locationDbId}` → `{workflowRunId}`                                    | sheet only — no recast, no shot regen                            |

### Prompts (`src/functions/prompt-variants.ts`)

| Fn                                | Input → output                                               | Rule                                                                     |
| --------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `saveShotPromptFn` (pre-existing) | `{…, promptType, text}` → `{unchanged} \| {versionId}`       | §1.3 A                                                                   |
| `saveMusicPromptFn`               | `{sequenceId, prompt, tags?}` → `{unchanged} \| {versionId}` | user-edit → hash null → 'untracked'; no forced regen; no completion gate |

### Structure (`src/functions/scenes.ts`, `src/functions/shots.ts`)

| Fn                                          | Input → output                                                                           | Rule                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `createSceneFn`                             | `{sequenceId, title?, location?, timeOfDay?, storyBeat?, withShot?}` → `{scene, shotId}` | appends at end; first shot by default          |
| `updateSceneFn`                             | `{sequenceId, sceneId, narrative fields, continuity? partial}` → scene                   | prompts stale by derivation; continuity merged |
| `updateSceneScriptFn` (pre-existing, fixed) | `{sequenceId, sceneId, extract}`                                                         | now preserves prior dialogue (§8 trap fixed)   |
| `reorderScenesFn` / `reorderShotsFn`        | `{sequenceId, sceneIds}` / `{sequenceId, sceneId, shotIds}` → `{success}`                | full live set validated; hash-inert (v5)       |
| `softDeleteSceneFn` / `restoreSceneFn`      | `{sequenceId, sceneId (+restoreShots?)}` → `{deletedAt, shotIds}` / scene                | §2 cascade + selective restore                 |
| `createShotFn` (extended)                   | `{sequenceId, sceneId?, shotNumber?, durationMs?}` → shot                                | auto-numbers `max+1` across ALL rows           |
| `deleteShotFn` (now SOFT) / `restoreShotFn` | `{sequenceId, shotId}` → `{success, deletedAt}` / shot                                   | slot kept; restore refused in deleted scene    |

### Cast & world (`sequence-characters.ts`, `sequence-locations.ts`, `sequence-elements.ts`)

| Fn                                                                | Input → output                                           | Rule                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `createSequenceCharacterFn` / `createSequenceLocationFn`          | `{sequenceId, name, bible fields}` → row                 | fresh `char_/loc_<ulid>` id; sheet-less (`pending`); sheet via recast or §1.4 upload |
| `updateSequenceCharacterFn` / `updateSequenceLocationFn`          | `{sequenceId, characterId/locationDbId, fields}` → row   | `''` clears; prompts + sheet stale by derivation                                     |
| `regenerateCharacterSheetFn` / `regenerateLocationSheetFn`        | id inputs → `{workflowRunId}`                            | from current bible; stills stale via selected version id                             |
| `selectCharacterSheetVersionFn` / location twin                   | `{versionId}` → selected row                             | pointer + URL mirror; does not discard history                                       |
| `softDelete…Fn` / `restore…Fn` (character, location)              | id inputs → `{deletedAt}` / row                          | §2; tags untouched                                                                   |
| `deleteSequenceElementFn` (now SOFT) / `restoreSequenceElementFn` | `{sequenceId, elementId}` → `{success, deletedAt}` / row | tokens stay reserved across deleted rows                                             |

### Sequence meta & recovery (`sequences.ts`, `motion-functions.ts`)

| Fn                                                     | Input → output                                    | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renameSequenceFn`                                     | `{sequenceId, title}` → sequence                  | minimal write (see §4 trap)                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `archiveSequenceFn` (extended) / `unarchiveSequenceFn` | `{sequenceId}` → `{success (+status)}`            | archive records `prevState.status`; unarchive restores it (content-derived fallback)                                                                                                                                                                                                                                                                                                                                                                       |
| `getArchivedSequencesFn`                               | `{}` → `Sequence[]`                               | default list filters archived                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `cancelVideoRenderFn`                                  | `{sequenceId, shotId, versionId}` → `{cancelled}` | guarded flip to `status: 'cancelled'` (union extended to mirror `frame_variants`) — smart retry / failure surfaces match 'failed' only, so a deliberate cancel is never re-billed; `persistMotionCompletion` is `completeIfLive`-guarded and `markFailedByWorkflowRun` counts terminal rows as accounted-for, so neither a finishing run nor `onFailure` can resurrect a cancel; the public API doc maps 'cancelled' to completed/pending (never surfaced) |

---

## 4. Traps for future editors

- **`updateSequenceFn` is not a general update** — it force-defaults
  `aspectRatio` and treats field presence as a regeneration trigger (credits +
  storyboard wipe). That is why `renameSequenceFn` / `setSequenceMusicFn` exist
  as separate minimal writes. Documented, not fixed: route any new
  single-field sequence write around it, never through it
  (`src/functions/sequences.ts`).
- **Integer timestamp columns round-trip at SECOND precision.** Two writes
  40ms apart store the SAME value — which is why the scene cascade restore
  matches by the event's recorded `shotIds`, not by timestamp equality (that
  earlier design resurrected separately-deleted shots in the same second).
  Never use a stored timestamp as an identity, or compare one against an
  in-memory millisecond `Date`, in code or tests.
- **Prompt-hash body changes use dual-hash verify, not catalog nulling.**
  Changing the hashed body shape still bumps `PROMPT_INPUT_HASH_VERSION`
  (`src/lib/ai/input-hash.ts`) when the stamp itself needs a version tag, but
  verify is `*InputHashMatches`: a stored digest is fresh if it matches the
  current stamp **or** a legacy digest of the same live inputs. Do not NULL
  stored hashes to paper over a shape change — that is the #867 false-positive
  class in reverse (everything reads 'untracked'). The v5 folder
  `drizzle/migrations/20260828031159_null_prompt_hashes_for_v5` is a no-op
  kept for the snapshot chain; delete the legacy hashers after
  `LEGACY_HASH_UNTIL` (2026-09-28, #1371).
- **D1 schema changes: additive only.** All five #1108 migrations are plain
  `ALTER TABLE ADD COLUMN` or data-only — see CLAUDE.md "D1 table-rebuild
  trap" before touching schema; a rebuild fires `ON DELETE CASCADE` and
  destroys child tables.
- **`kind`/status unions are TS-only** (`$type<>()` on plain text columns) —
  extending one (e.g. `frame_variants.kind: 'upload'`) needs no migration, but
  audit every exhaustive consumer.
- **`sequence_events.kind` is an open string; `targetType` is a typed union**
  — new kinds are free, new target types are a (TS-only) union edit.

## 5. File map

| Concern                                                                      | File                                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Upload helpers (sentinel model, path/extension validation, still-hash stamp) | `src/lib/shots/upload-media.ts`                                                                  |
| Atomic replace + upload appends (stills)                                     | `src/lib/db/scoped/frame-variants.ts` (`replaceContent`, `appendUploadedVersion`)                |
| Video upload append / guarded complete / cancel                              | `src/lib/db/scoped/video-variants.ts`                                                            |
| Music retire-not-overwrite                                                   | `src/lib/db/scoped/sequence-variants.ts`                                                         |
| Soft-delete + reorder (structure)                                            | `src/lib/db/scoped/scenes.ts`, `shots.ts`                                                        |
| Soft-delete + bible CRUD (cast/world)                                        | `src/lib/db/scoped/characters.ts`, `sequence-locations.ts`, `sequence-elements.ts`               |
| Staleness matrix tests (the executable §1 contract)                          | `src/lib/shots/staleness-matrix.test.ts`                                                         |
| Acceptance tests (media, cast, structure)                                    | `src/lib/db/scoped/media-upload.test.ts`, `sequence-cast-crud.test.ts`, `structure-crud.test.ts` |
