# Workflow snapshots and content-hash staleness

> **Scene → Shot → Frame.** The still-image surface, version pointers, and retired image `divergedAt` path are defined in [scene-shot-frame-redesign.md](./scene-shot-frame-redesign.md) (#989). This doc covers input-hash staleness and workflow snapshots on top of that model.

This is the companion to [managing-complex-dependency-graphs-in-collaborative-ai-video-platforms.md](./managing-complex-dependency-graphs-in-collaborative-ai-video-platforms.md). The original doc proposed a general-purpose versioned-DAG architecture with branching, XState lifecycles, Inngest, Postgres MVCC, Redis pub/sub, and Linear-style transaction sync. A review against the codebase shows that most of that infrastructure is already solved differently on our stack (Cloudflare Workflows, Durable Object-backed SSE realtime, Cloudflare D1, Drizzle, and scoped DB access from workflow payload `teamId`/`userId`) — and most of what remains unsolved reduces to a critical path of three ideas. This doc is the stack-specific subset we intend to ship.

It composes with [scoped-db-context-implementation.md](./scoped-db-context-implementation.md); every new data-access path described here flows through `ScopedDb`.

## The two failure modes we're closing

**1. Lost-work mid-generation.** Content-generation workflows must not read mutable DB state for anything that should be frozen at trigger time. Before the snapshot pattern, `regenerateShotsWorkflow` (`RegenerateShotsWorkflow` in `src/shots/server/workflows/regenerate-shots-workflow.ts`) could re-resolve sequence fields or sheet references mid-flight. If a user edits a character, location, or prompt while the workflow is running, generation can read a mix of pre- and post-edit inputs. The result is written as the primary artifact either way, with no signal that what landed isn't what the user had in mind when they triggered the workflow. `RegenerateShotsWorkflow` is the reference fix: it inlines per-shot snapshot DTOs and a batch `snapshotInputHash` at trigger time via `src/shots/server/workflows/regenerate-shots-snapshot.ts`.

**2. Silent staleness.** After a character recast or location swap, downstream shots (and their anchor-frame stills), character sheets, location sheets, and talent sheets still display their prior outputs. Nothing in the schema records which inputs those outputs were derived from, so the UI can't distinguish "still current" from "stale but not yet regenerated" — and neither can a workflow about to apply a new result.

Both failure modes collapse into one missing primitive: **every generated artifact needs to remember the inputs it was generated from**, and every workflow needs to **freeze those inputs at start time and verify them at write time**.

## What we're explicitly not doing

Before describing the design, it's worth stating what the original doc recommended that we're skipping, and why — so future implementers don't accidentally drift back toward it:

| Original recommendation           | Why we skip it                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inngest for orchestration         | Cloudflare Workflows is already wired, and `OpenStoryWorkflowEntrypoint` (`src/platform/server/workflow/base-workflow.ts`) enforces `teamId`/`userId` on every run. Swapping orchestrators would be pure churn.                                                                                                                                         |
| XState v5 lifecycle machines      | Per-artifact status columns on `frames` (`imageStatus`) and `shots` (`videoStatus`, `audioStatus`) already model `pending → generating → completed → failed`. `sequences.status` is sequence lifecycle (`draft → processing → completed → failed → archived`), not per-artifact generation. Adding XState on top would duplicate state, not replace it. |
| Custom Redis pub/sub + PG NOTIFY  | `src/shared/realtime.ts` already provides a typed `realtimeSchema`; delivery runs through the in-repo SSE client and `RealtimeChannel` Durable Object. We extend this schema, we don't replace it.                                                                                                                                                      |
| Postgres JSONB / SKIP LOCKED      | The app runs on Cloudflare D1 (SQLite). Cloudflare Workflows is already the durable job engine; we don't need a DB-level queue at all.                                                                                                                                                                                                                  |
| Entity version chains / branching | `frame_variants` (`src/platform/server/db/schema/frame-variants.ts`) already holds alternate per-model outputs, which covers the realistic "keep old vs new" use case for frame artifacts. General-purpose branching adds complexity we don't need.                                                                                                     |
| Property-level LWW + rebasing     | We are not a concurrent editor. TanStack Query + server functions give us implicit last-writer-wins at the server boundary.                                                                                                                                                                                                                             |
| Dependency edge table (v1)        | Character/location → shot linkage is inferred at runtime via `characterTags` in shot metadata and `matchCharactersToScene` (`src/shots/scene-matching.ts`). Good enough until we have a reason to materialize it.                                                                                                                                       |
| `stale` status enum value (v1)    | Staleness is a **derived** boolean (`generatedFromInputHash !== computeInputHash(entity)`). Adding it to the enum is a v2 question if the derived form ever proves insufficient.                                                                                                                                                                        |

## Pillar 1: Input-hash staleness

Every artifact-bearing row stores the SHA-256 hash of the canonical serialization of the inputs used to generate it. Staleness is a query-time comparison, not a stored flag.

### What goes into the hash

The rule is: anything that, if changed, should cause the user to see a "regenerate" affordance. For our artifacts this is:

- **Frame image** (`frames.imageInputHash`, mirrored on the selected `frame_variants` version) — the composed visual prompt (`frame.imagePrompt` or `shot.metadata` fallback), image model, aspect ratio, and the **content hash of each referenced character sheet, location sheet, and element reference**. Crucially, the hash is over the _referenced sheets' hashes_, not their URLs.
- **Shot video** (`video_variants.inputHash` over the render manifest) — motion-prompt / still version ids, `usesStartFrame`, duration, `audioClipIds`, `audioSourceKey` (voice id + line + tone + TTS model; omitted when voiceless), `dialogueKey` (every line the render prompt quoted, voiced or not; omitted when none, #1784), and `referenceKeys`. Voice ids are **not** on the motion-prompt hash. See "Clip provenance" below.
- **Shot audio** (`shots.audioInputHash`) — music prompt, tags, duration, audio model.
- **Visual prompt** (`frames.visualPromptInputHash`) — upstream scene metadata + style config + character/location bible + analysis model.
- **Motion prompt** (`shots.motionPromptInputHash`) — same upstream context plus the starting-frame image hash, with the script's lines replaced by the shot's own (`shotDialogueResolver`, snapshotted as the payload's `dialogue`, #1784).
- **Character sheet** (`characters.sheetInputHash`) — character bible entry, talent reference hash (if any), and when cast the talent's own description plus the default talent sheet's image and look (#1785), style config, image model.
- **Sequence location reference** (`sequence_locations.referenceInputHash`) — every location bible field the sheet prompt reads (#1785), library reference hash (if any), style config, image model. **Library location template** (`location_library.referenceInputHash`) — name/description, reference media, image model. Per-sequence generated sheets also carry `location_sheets.inputHash`.
- **Talent sheet** (`talent_sheets.inputHash`) — talent metadata, reference media hashes, image model.

Model _version strings_ are in the hashes, but verify recomputes each artifact with the model that made it (#1785), so switching a sequence's image, script or video model never stales existing work — the switch applies to the next generation, and the staleness causes never name it. An uploaded sheet, which has no model of its own, is the one artifact that follows the sequence model. See `prompt-staleness-dependency-graph.md` §3.

### Editor batch read (#1795)

`getShotStalenessBatchFn` compares every shot the scenes editor is showing. Prompt versions, live claims, and `sequence.settings-changed` events are loaded once per sequence (a windowed latest-per-frame / latest-per-shot read), then each shot is compared in memory. While `sequences.status` is `processing` the handler returns `generating` for every requested shot and does not load bibles, prompts, or segments. The editor asks for that sequence batch once; scene and shot scope filter the map on the client. `getShotsFn` inserts an anchor frame only when a shot has none — a read does not rewrite anchors that are already there.

### Where the hash lives

One column per artifact per row. The column is nullable because pre-existing rows won't have one until they're regenerated.

| Table                     | Hash columns (nullable — null means "unknown, not stale")                                  |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `frames`                  | `imageInputHash`, `visualPromptInputHash`                                                  |
| `frame_variants`          | `inputHash` (per image version; `promptHash` retained for legacy reads)                    |
| `shots`                   | `videoInputHash`, `audioInputHash`, `motionPromptInputHash`                                |
| `characters`              | `sheetInputHash`                                                                           |
| `sequence_locations`      | `referenceInputHash`                                                                       |
| `location_sheets`         | `inputHash`                                                                                |
| `location_library`        | `referenceInputHash`                                                                       |
| `talent_sheets`           | `inputHash`                                                                                |
| `shot_variants`           | `inputHash` (video/audio divergent alternates; image variants retired to `frame_variants`) |
| `video_variants`          | `inputHash` over the render `manifest` (see "Clip provenance")                             |
| `dialogue_recordings`     | `inputHash` (the recording key); append-only, no selection of its own                      |
| `shot_dialogue_sections`  | `sourceKey` (the shot's authored voiced lines) + `selectedAt` pointer per shot             |
| `*_sheet_variants`        | `inputHash` + `divergedAt` on divergent sheet rows                                         |
| `sequence_music_variants` | `inputHash` + `divergedAt` on divergent music rows                                         |

We deliberately do **not** add a `content_hash` column on upstream entities themselves (characters, locations, talent) — the referenced-sheet's `input_hash` _is_ the content hash for downstream staleness. This avoids a second-order invalidation layer.

### Bible history (#1600)

A character's or sequence location's bible is append-only history:
`character_bible_versions` / `location_bible_versions`, one row per change,
and `selectedBibleVersionId` on the parent names the live one. Every writer
goes through one append path (`bibleWrite` / the upserts in
`src/cast/server/db/characters.ts` and `sequence-locations.ts`): analysis
and re-analysis (`source: 'analysis'`, only when a field moved), a
person's edit through the form, API or MCP (`'edit'`, with `createdBy`), a
recast (`'recast'`), and an upload's likeness verdict (`isPerson`, an
`'edit'`). Every scoped read joins the live row and returns the fields under
their old names, so the hashes and the prompt builders read the same values
as before. The #1600 migration snapshotted every existing bible as its first
row (`'backfill'`, keyed to the parent's own id, `createdAt` = the
parent's `updatedAt`), so nothing reads stale on deploy.

The parent's old bible columns stay in the database under `legacy*` names
in the schema. They are read only as the fallback for a row with no version —
one a worker older than #1600 wrote during the deploy window — and written
only where NOT NULL forces it (the name, on insert). A follow-up drops them
after a second backfill.

What this buys:

- **A sheet records the bible it was made from.** The trigger snapshots
  `bibleVersionId` onto the payload and the land batch stamps it on the
  sheet's version row, promoted or parked.
- **Causes name the field.** `findStalenessCauses` looks up the version live
  when the stale artifact was made (the newest created at or before it) and
  diffs it against the live bible: `Character "Jack": clothing, sheet`. A row
  touched without a bible change (a claim, a voice) is no longer named. An
  artifact older than the row's history falls back to the old timestamp guess.
- **The hash edge stays a hash edge.** The sheet and prompt hashes read more
  than the bible (talent, style, model, the scene), so a pointer compare
  could not replace them without moving every stored digest.

### Scene narrative (#1600)

A scene's narrative — title, INT./EXT. heading, time of day, story beat and
continuity tags — lives on its selected `scene_script_versions` row with the
script, not on the `scenes` row. Every write appends a row carrying the
selected script plus the new narrative: a person's edit (`updateNarrative`,
`'edit'`), a continuity rescan after a prompt or script edit
(`updateContinuity`, or the same row as the script edit), an element rename
(one `renamed` row with both rewrites), and a hand-added scene (an empty
script plus its narrative). Scene split writes the narrative into the split
row with the script, in place like the content. Every scoped scene read joins
the selected row and returns the fields under their old names (`sceneColumns`
in `src/shots/server/db/scenes.ts`).

The migration copied each scene's narrative onto all its existing rows and
gave a scene with no script version a `backfill` row keyed to its own id.
`scene_script_versions.hasNarrative` marks a row that carries the narrative;
every row written since #1600 does. A row a pre-#1600 worker wrote during the
deploy window does not, and reads fall back to the scene's legacy columns for
it — the only reader of those columns, which nothing writes any more.

Causes diff the scene version live when the artifact was made against the
live one: `Script` for text or lines, `Scene: heading, time of day` for the
narrative. The title is a label, never a cause. History made before #1600
carries the narrative as it stood at deploy, so an older narrative edit on an
older artifact is not named.

### Where the helpers live

`src/shots/input-hash.ts` exports one named helper per artifact type (e.g. `computeShotImageInputHash`, `computeCharacterSheetInputHash`, `computeMotionPromptInputHash`). Each helper accepts the minimal input DTO it needs (never a whole DB row) and returns a `string`. This keeps callers honest about what counts as input and makes the helpers trivially unit-testable without DB setup.

The existing `src/platform/hash.ts` (`simpleHash`) is not cryptographic and is too weak for this purpose — it stays where it is for its existing non-security uses, and the staleness helpers use `crypto.subtle.digest('SHA-256', ...)`.

Canonical serialization matters: object key order, array order for unordered sets (character refs), and trimming of free-text prompts all need to be deterministic. The helper file is the one place this is defined.

### Staleness as a derived read

```ts
// Caller computes the fresh hash, then asks scoped getters to compare.
// Null stored hash → "unknown, not stale" (legacy rows).

const currentImageHash = await computeShotImageInputHash(hashInput);
const imageStale = await scopedDb.frames.isStale(
  anchorFrameId,
  currentImageHash
);

const currentVideoHash = await computeShotVideoInputHash(videoHashInput);
const videoStale = await scopedDb.shots.isStale(
  shotId,
  'video',
  currentVideoHash
);
```

The UI calls this (or a batch variant) when rendering. There is no cascading propagation, no dirty-bit table, no LISTEN/NOTIFY. The staleness calculation is a pure read of the current graph — if character sheets haven't changed, their hash is the same, and the comparison trivially passes.

### Clip provenance: what the manifest has to record (#1657)

A clip is compared by pointer, not by hash: `isSelectedVersionStale` (`src/shots/scene-segments.ts`) walks each `VideoManifestEntry` and asks whether what the render was sent still matches what a render would be sent now. That only works for inputs the manifest stamps and the compare reads, and the red edges on the docs dependency graph (`src/ui/docs/dependency-graph.ts`) were exactly the ones it did neither. Four changes close them:

- **`referenceKeys`** — every reference the render was handed, as `kind:entityId:identity` where identity is the selected version id when the entity has one and the media URL otherwise (`src/motion/reference-provenance.ts`, built from `ReferenceImageDescription.provenanceKey`). Character sheets ride as video references in **both** modes, location sheets only in reference-only, and an element's audio or video clip rides wherever the model takes one — none of which the manifest saw before. The live side is `liveReferenceIdentity`, so a re-selected sheet version, a re-upload, or a deleted entity all read stale; a rename does not.
- **`audioClipIds`, compared** — a generated dialogue clip's id IS the `shot_dialogue_sections` row it was cut from, so the ids the manifest already stamped are the selection pointer. `audioSourceKey` already caught a line, tone or voice edit, but not the user picking a different reading of the same lines, which is a pointer like the frame version. `audioClipsMoved` compares the entry's ids against the shot's working-set clip ids (`audioClipIdsByShot`, from `shots.audioClips`): different sets → stale. An entry with no clip ids is not compared — a voice appearing is `audioSourceKey`'s job — and a manifest from before #1657 holds the ids the working set still holds, so nothing old flips. Sections are per shot, so re-pointing one shot re-stales one clip: a re-record for a neighbour's edit leaves this shot's section, clip id and video alone.
- **Duration, snapped on both sides.** The manifest holds the length the model was asked for, so the live `shots.durationMs` is snapped onto the same model's grid before comparing, and a length raised to cover bound dialogue audio counts as unchanged too (`durationMoved`). Comparing raw values is what made a pipeline re-snap flag every clip, which is why the compare ignored duration entirely until now (#767).
- **Dialogue lines come from the shot, not the script.** `shot_dialogue_versions` is the authored node — append-only, one selected row per shot. Speaking order is shot order, then line order within the shot, so a reorder moves no row and stales nothing. The script's `originalScript.dialogue` stays as the LLM's seed and is only read for a shot with no row yet (`deriveShotDialogueLines`), so no backfill migration exists. `src/shots/server/live-shot-state.ts` is the one loader of the live side, shared by the Scenes read and the Update-all planner, so both compare against identical inputs.

Two rules keep this from moving stored digests. The one new field, `referenceKeys`, is **dropped from the hash body when null or empty** (`canonicalizeManifestEntry` in `src/shots/input-hash.ts`), the same shape-stable trick `usesStartFrame` and `audioSourceKey` use. And an **absent** stamp on a row written before #1657 is unknown, never stale — the same contract as a null hash column.

`sequence_music_variants.inputHash` got the same treatment: it was written by `MusicWorkflow` and never compared, so an edited music prompt or changed shot durations left the track silently stale. `musicTrackStaleness` (`src/audio/music-track-staleness.ts`) recomputes it from the live prompt, tags, clamped request length and audio model; an uploaded score deliberately stores no hash and so reads untracked. Update-all's `regenTrack` is now independent of `regenPrompt`.

## Pillar 2: Workflow input snapshots

Workflows must not read mutable state inside a `step.do()` for anything that should be frozen. The "input snapshot" is just the fully-resolved input DTO, passed end-to-end through the Cloudflare Workflows event payload.

### The pattern

**At trigger time** (server handler/function, before `triggerWorkflow()` calls the workflow binding):

1. Resolve every referenced sheet URL and read its `input_hash`.
2. Assemble the full input DTO for the workflow — prompt, model, params, referenced sheet hashes.
3. Compute `snapshotInputHash = computeInputHash(dto)`.
4. Pass the DTO _and_ `snapshotInputHash` to `triggerWorkflow()`, which resolves the Cloudflare Workflows binding and calls `binding.create({ id, params })`.

**At workflow-start**: the workflow validates `snapshotInputHash` matches what it recomputes from the DTO (cheap tamper/format check), then proceeds using only the DTO.

**At write time** (inside the final `step.do()` that commits the artifact): recompute `currentInputHash` from the _live_ scoped-DB state, and branch on whether it still matches `snapshotInputHash`. (See Pillar 3.)

### How the rule is enforced (#1067)

Two mechanisms, so the rule survives without a reviewer noticing it:

- **`WorkflowScopedDb`** (`src/platform/server/db/scoped-workflow.ts`) is what `runImpl` receives instead of `ScopedDb`: the same write surface with every read-shaped method (`get*`, `list*`, `find*`, `resolve*`, `has*`, …) removed from every domain. A mid-run read is a type error. The narrowing is purely type-level — `toWorkflowScopedDb` returns the same object.
- **Three named hatches** carry what a run legitimately cannot know at the trigger. One catch-all would make every exception look alike; the name at the call site is the argument:

  | hatch                                   | what it is                                | why it's safe                                                                   |
  | --------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
  | `scopedDb.credentials.…`                | `resolveKey` / `resolveLlmKey`, flat      | returns a secret, never a row a generation decision can turn on                 |
  | `scopedDb.claims.<domain>.getById…(id)` | an append-only row by an id the run holds | the id names one immutable row — nothing for a concurrent edit to substitute    |
  | `scopedDb.liveRead.<domain>.…`          | live by design                            | sibling-workflow polling, balance + spawn-time billing guards, existence guards |

  The split is load-bearing rather than cosmetic: `claims` **cannot express a selection pointer** and `credentials` **cannot express a row**, so the two failure modes behind this work — rendering from a pointer a concurrent edit moved, and treating key access as licence to read data — are unspellable, not merely discouraged.

  `src/platform/server/workflow/no-mid-run-reads.test.ts` scans `src/lib/workflows/*.ts` and fails on any read not in its per-file allow-list, on an allow-list entry whose call site is gone, and on a read whose recorded category doesn't match the hatch its call site used (a `CLAIM-BY-ID` read reached via `liveRead` fails). Helper modules that declare a narrowed dependency type (`WaitForSheetsReadDb`, `FrameImageReadDb`, `PreflightScopedDb`, `CredentialScopedDb`) are handed the hatch by their workflow caller. There is no divergence-recompute bucket any more: sheets were its last users, and they land through claims (#1113).

**Chained renders resolve their prompt by id, never by pointer.** `completePendingAiVersion` can end a run on either of two rows: the claim it completed, or — when a completed row already carries the same `(parent, input_hash)` and the same text — the existing row the claim retires in favour of. The prompt children return whichever one ended up live as `finalVersionId` (`FramePromptResult`, `MotionPromptWorkflowResult`), and the parent re-reads that id with `getByIdForFrame` / `getByIdForShot`. Resolving the collision by comparing the selection pointer's `inputHash` against the plan's live hash instead would be wrong twice over: `input_hash` pins the generation _inputs_, not the text, so a same-inputs-different-text version passes the check; and the pointer can move between the check and the render. No child result means the prompt didn't land, which is a stand-down, not a fallback.

The one wide hatch is `scopedDb.stalenessPlanning` (full `ScopedDb`), used only by `update-stale-shots-workflow.ts` for the planner: staleness IS a live-state comparison, so there is nothing to freeze, and the same code renders the "what's stale" preview in the server fns. The same test asserts it has exactly one consumer.

Helper modules shared between server fns and workflows declare a narrowed dependency type instead of taking `ScopedDb` — `WaitForSheetsReadDb`, `FrameImageReadDb`, `PreflightScopedDb`, `CredentialScopedDb` — so a workflow hands over `scopedDb.liveRead` and a server fn its full `ScopedDb`.

### Per-workflow snapshot modules

There is no centralized `snapshot` config on `OpenStoryWorkflowEntrypoint`. Each migrated workflow owns a companion `*-snapshot.ts` module that:

1. **Builds the inlined DTO at trigger time** (server function / parent workflow) from live scoped-DB state — e.g. `buildRegenerateShotSnapshot` in `regenerate-shots-snapshot.ts`, scene snapshot builders in `sheet-snapshots.ts`.
2. **Hashes the DTO** for tamper detection — e.g. `computeRegenerateShotsBatchHash`, `computeShotImagesHashFromDto`, per-artifact helpers in `image-workflow-snapshot.ts`.
3. **Validates at workflow start** inside `step.do('validate-snapshot')` by recomputing the hash from `event.payload` and comparing to `snapshotInputHash`.
4. **Lands through a claim** (see [The claim contract](#the-claim-contract-1130)), not by re-hashing live state: a result the claim still names is promoted; a missed claim lands in history (images, video, prompts) or parks as a divergent variant (sheets, #1113). Music is the last workflow that still recomputes a live hash at write time (`music-workflow.ts`).

```ts
// illustrative — RegenerateShotsWorkflow start-time validation
await step.do('validate-snapshot', async () => {
  const expected = event.payload.snapshotInputHash;
  if (!expected) return;
  const recomputed = await computeRegenerateShotsBatchHash(event.payload);
  if (recomputed !== expected) {
    throw new NonRetryableError(
      'snapshotInputHash does not match the inlined DTO'
    );
  }
});
```

Workflows that have not been migrated yet keep their existing behaviour until they gain a `*-snapshot.ts` module and the trigger path inlines the DTO.

### Per-workflow input surface

For the workflows that do content generation, "input" is specifically:

- **`regenerateShotsWorkflow`** (`RegenerateShotsWorkflowInput`, `src/shots/server/workflows/regenerate-shots-workflow.ts`) — **reference implementation.** Trigger time inlines `shotSnapshots` (per-shot prompt, reference URLs, and sheet hashes via `buildRegenerateShotSnapshot`), freezes `aspectRatio`, and sets `snapshotInputHash` from `computeRegenerateShotsBatchHash`. The workflow body reads only the inlined DTO; start-time validation runs in `step.do('validate-snapshot')`.
- **`shotImagesWorkflow`** (`ShotImagesWorkflowInput`, `src/stills/server/workflows/shot-images-workflow.ts`) — inlines `sceneSnapshots` (per-scene upstream sheet hashes) and optional `snapshotInputHash`. Hash helpers live in `image-workflow-snapshot.ts` and `sheet-snapshots.ts`.
- **`characterSheetWorkflow`** (`CharacterSheetWorkflowInput`) — inlines character/talent metadata and reference URLs; carries `snapshotInputHash` (stamped on the version row) and the claim `sheetVersionId`. Lands through `characterSheetVariants.promoteIfPending`; a missed claim parks the row as divergent and `reportParkedCharacterSheet` emits `stale:detected`. Pipeline sheets (`CharacterBibleWorkflow`) are claimed and hashed like any other since #1113 — they used to carry no hash and read "untracked".
- **`locationSheetWorkflow`** (`LocationSheetWorkflowInput`) — the same, with `referenceVersionId` and `locationSheetVariants.promoteIfPending`; `LocationBibleWorkflow` claims and hashes its children.
- **`libraryTalentSheetWorkflow`** (`LibraryTalentSheetWorkflowInput`) — inlines `referenceImageUrls`, `talentDescription`, `snapshotInputHash`, and the claim `sheetId` (the `talent_sheets` id it writes). Lands through `talent.landSheet`; a missed claim parks the sheet and skips the headshot.
- **`libraryLocationSheetWorkflow`** (`LibraryLocationSheetWorkflowInput`) — carries `referenceClaimId`; publishes its preview through `locations.updateReferenceIfClaimed`, else parks it in `location_sheet_variants`.

Most migrations are additive — payloads already carry most of the data. The work is inlining hashes, validating at start, and branching at write time.

### Snapshot size

Cloudflare Workflows has event payload size limits, but our payloads are dominated by prompts, sheet URLs, and metadata — not by the artifacts themselves, which are accessed by URL. We inline snapshots into the payload in v1. If that becomes a problem we add a `workflow_input_snapshots` table with content-addressable storage (as the original doc proposed), but this is not part of v1.

## Pillar 3: Divergence-on-completion

A generation result lands through the claim its trigger took. Sheets are the example (#1113):

```ts
// illustrative — character-sheet-workflow reconcile step
const landing = await scopedDb.characterSheetVariants.promoteIfPending({
  characterId,
  versionId: input.sheetVersionId, // the claim the trigger took
  url,
  storagePath,
  inputHash: input.snapshotInputHash ?? null,
  model,
  workflowRunId,
});
if (landing === 'parked') {
  // The claim moved (an input edit, a newer kickoff, the user's pick): the
  // row is in character_sheet_variants with divergedAt, the live sheet is
  // untouched. Tell the UI.
  await reportParkedCharacterSheet({
    sequenceId,
    characterId,
    versionId,
    snapshotInputHash,
  });
}
```

Divergence is event-driven: nothing re-hashes live state at write time. Every write that changes a sheet input, or picks a sheet, clears the claim in the same batch as its own write — character bible edits (only the fields the sheet reads), a recast, a cast talent's new/changed/removed sheet or edited description, a sequence location's bible or library link, the library location's reference, and the sequence's style; for the library runs, the talent's description or a deleted reference photo, and the library location's description (a rename never diverged: neither library hash covers the name). The claim is what the run checks.

Per-shot **image** artifacts use the same hash comparison inside `image-workflow`, but mid-flight drift no longer routes to divergent `frame_variants` rows or `generation.stale:detected` (#989): the workflow appends a new `frame_variants` version, stamps `inputHash`, and deliberately does not repoint `selectedImageVersionId`. `regenerate-shots-workflow` fans out to `image-workflow` children and does not perform its own divergence emit — `divergedShotIds` is always empty today.

### Where divergent / drifted results land

Two models — do not conflate them:

**A. Pointer drift (images, #989).** `image-workflow` compares `snapshotInputHash` vs a live recompute. On drift it appends a new `frame_variants` version with `inputHash`, does **not** repoint `frames.selectedImageVersionId`, and does **not** emit `generation.stale:detected`. The retained unselected version is the drift signal; the user switches primaries via `frameVariants.select` (pointer repoint). Versions are soft-hidden with `discardedAt`, not hard-deleted. `frame_variants` has no `divergedAt` — each row is a flat version (`kind: 'model' | 'framing'`).

A picked 3×3 tile (`kind: 'framing'`) has no snapshot of its own: it inherits the grid sheet's `inputHash`, which the grid run stamps from the trigger's `tileHashInput` hashed under the **upscale** model — staleness recomputes from the selected version's model, and the tile is written with that one (#712). A sheet made before #712 has no stamp, so its tiles read `'untracked'`.

**B. Divergent alternates (sheets, music, legacy shot video/audio).** A missed sheet claim (#1113) — or, for music, a write-time hash mismatch — parks a row in a `*_variants` table with `divergedAt`, then emits `generation.stale:detected` with a required `divergedVariantId`:

- **Character / location / talent sheets** → `character_sheet_variants`, `location_sheet_variants`, `talent_sheet_variants`. Character and sequence-location rows park inside their land batch (`src/cast/server/db/sheet-claims.ts`); library-location previews and talent sheets park via `sheet-divergence.ts`.
- **Sequence music** → `sequence_music_variants` via `music-workflow.ts`.
- **Shot video / audio** (when the divergent path is used) → `shot_variants` with partial unique indexes `shot_variants_primary_key` (WHERE `divergedAt IS NULL`) and `shot_variants_divergent_key` (WHERE `divergedAt IS NOT NULL`). No production workflow emits divergent **image** rows on `shot_variants` today — images moved to model A.

**Convergent image writes** repoint `frames.selectedImageVersionId`, mirror `frames.imageUrl`, and stamp `frames.imageInputHash` — see `image-workflow.ts` and `frameVariants.select`.

### Realtime event

`realtimeSchema.generation` in `src/shared/realtime.ts` defines `stale:detected` as a discriminated union on `entityType`. Clients subscribe on the generation channel and listen for the dotted path `generation.stale:detected`:

```ts
'stale:detected': z.discriminatedUnion('entityType', [
  z.object({
    entityType: z.literal('shot'),
    entityId: z.string(),
    artifact: z.enum(['thumbnail', 'variant-image', 'video', 'audio']),
    snapshotInputHash: z.string(),
    divergedVariantId: z.string(),
  }),
  z.object({
    entityType: z.literal('character'),
    entityId: z.string(),
    artifact: z.literal('sheet'),
    snapshotInputHash: z.string(),
    divergedVariantId: z.string(),
  }),
  // ...location, library-location, talent, and sequence (music) branches
]),
```

`divergedVariantId` is required on every branch — the divergent artifact is parked first (in the sheet land batch, `sheet-divergence.ts` or `music-workflow.ts`), then the event names its row id. Image drift (model A) does **not** use this event. This gives the UI a single event shape across sheet/music (and future video) divergence without adding new channels.

## The claim contract (#1130)

Anything generated and promotable to a selection pointer lands through a claim. Five rules:

1. **Row before result.** An append-only version row (or a claim row) exists before anything is spent: in-flight status, model, run id. The rows are the history.
2. **One claim per promotion target.** The trigger takes it, and the last kickoff wins by overwrite (#1070).
3. **Completion consumes the claim.** The pointer moves only through one guarded UPDATE that also consumes the claim. There is no read-then-decide. A run that finds its claim gone lands in history, unselected.
4. **A user's selection clears claims.** Runs still in flight then find the claim moved and finish into history.
5. **Failure clears only its own claim.** A failing run clears the claim only while it still holds it, never a newer kickoff's.

Each domain spells the three methods its own way:

| Domain                   | Claim                                       | Conditional clear                               | Claim-consuming promote                    |
| ------------------------ | ------------------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| Stills                   | `frames.setPendingPromoteVersionId`         | `frames.clearPendingPromoteVersionIdIf`         | `frameVariants.selectIfPendingPromoteIs`   |
| Video                    | `renderSegments.setPendingPromoteVersionId` | `renderSegments.clearPendingPromoteVersionIdIf` | `videoVariants.selectIfPendingPromoteIs`   |
| Voices                   | `characters.createPendingVoiceClaim`        | `characters.markVoiceClaimTerminal`             | `characters.promoteVoiceClaimIfPending`    |
| Image and motion prompts | `*PromptVersions.createPending`             | `*PromptVersions.markTerminal`                  | `*PromptVersions.completePendingAiVersion` |
| Dialogue                 | `shotDialogue.claimRecording`               | `shotDialogue.failClaims`                       | `shotDialogue.appendRecording`             |
| Character sheets         | `characters.claimSheet`                     | `characters.failSheetClaim`                     | `characterSheetVariants.promoteIfPending`  |
| Location sheets          | `sequenceLocations.claimReference`          | `sequenceLocations.failReferenceClaim`          | `locationSheetVariants.promoteIfPending`   |
| Library location refs    | `locations.claimReference`                  | `locations.clearReferenceClaimIf`               | `locations.updateReferenceIfClaimed`       |
| Library talent sheets    | `talent.claimSheet`                         | `talent.clearSheetClaimIf`                      | `talent.landSheet`                         |

Stills and video keep the claim as a pointer column on the parent row. Prompts keep it on the pending row itself (live status plus `pendingInputHash`). Dialogue keeps it in a `shot_dialogue_claims` row, because a section row cannot be its own placeholder. Upscale takes the stills claim like any other still (#1129). Previews (`frame_variants.kind = 'preview'`) are never selectable, so they never claim.

**Sheets (#1113)** keep a pointer claim on the parent row (`characters.pendingPromoteSheetVersionId`, `sequence_locations.pendingPromoteReferenceVersionId`, `talent.pendingPromoteSheetId`, `location_library.pendingReferenceClaimId`). The claim names the id the run's result row _will_ carry — they bend rule 1: there is no pending row, because the sheet history tables are read by many surfaces and a row appended at completion under the claimed id needs no failed-husk bookkeeping. Completion is one batch: append the row, move the pointer only while the claim names it, else mark the row divergent (a miss parks rather than landing as plain history, so the sheet banner offers it), and settle the status to `completed` only if no newer run holds the claim. A failure marks the sheet failed only while it holds the claim or nobody does. Library talent triggers can be deduplicated onto an in-flight run, so the funnel claims only after the trigger started a new run; a reusing trigger leaves the claim alone. That claim is conditional on the snapshot inputs still holding (same description, every reference photo still present): an edit that landed before it found nothing to revoke, so it fails the claim and the run parks. (Claiming first and handing back loses to two concurrent reusing triggers: one hands back the other's claim and the reused run parks.) A payload queued before #1113 has no claim and lands unconditionally (pinned as unclaimed writers). A re-analysis bible upsert revokes the claim in the same batch as the bible version it appends when a sheet input moved; an identical rewrite appends no version and keeps it (#1600). The bible parents claim pointer-only (`markGenerating: false`): their upsert already set the status, and a parent replaying across the deploy must not flip a finished sheet back to `generating`.

**Prompts are only partly claimed.** Only a regeneration the user queued (a run with `targetVersionId`) takes a claim. The pipeline's prompt passes (analysis, a prompt run with no `targetVersionId`, the motion batch) call `write` / `writeAiVersion`, which select their output with no claim and demote live claims, superseding a user override (it stays in history). Two drain paths do the same: a pre-#1786 run's typed edit, and a pre-#1715 voice payload with no husk. These call sites are pinned, not endorsed.

**Pinned by** `src/platform/server/workflow/claim-discipline.test.ts`. It scans the schema for every table a workflow writes results into (a `…WorkflowRunId` column) or that holds generated history (`*_variants`, `*_versions`). Each must belong to a claim domain or sit on its exceptions list with a reason. It also checks that each domain still has its three methods, that no workflow calls a domain's user selector (`frameVariants.select` and the like), and that every workflow call to an unclaimed pointer writer (prompt `write` / `writeAiVersion`, `characters.updateVoice`, and the pre-#1113 sheet drain writers `characters.updateSheet`, `sequenceLocations.updateReference`, `locations.updateReference`) is on its pinned list. The exceptions today are music, the authored script and dialogue-line versions (a re-analysis replaces them by design), the bible versions (authored, #1600), and tables with no selection pointer (studio assets, exports, provenance, legacy `shot_variants`, the sequence run slot).

## How it composes with existing patterns

- **Scoped DB** (`src/lib/db/scoped/*`) is the only entry point. Staleness reads go through scoped getters; hash computation helpers accept a `ScopedDb` and use it. No code path bypasses team scoping.
- **Per-workflow snapshot modules** (`*-snapshot.ts`) own DTO building, hashing, and validation — existing workflows keep working unchanged until they gain one.
- **Status columns** on `frames` / `shots` stay `pending | generating | completed | failed`. Staleness does not become a fifth value. The UI composes `status === 'completed' && isStale(...)` when it needs "completed but stale".
- **`frame_variants`** stores flat image versions with `inputHash`; selection is `frames.selectedImageVersionId`. **`shot_variants`** still carries `divergedAt` for video/audio divergent alternates; image variants on this table are legacy.

- **Selections move only through a claim or a user act (#1786).** A run's result reaches a selection pointer only through a claim-consuming guarded UPDATE (`frameVariants.selectIfPendingPromoteIs`, `videoVariants.selectIfPendingPromoteIs`): one statement moves the pointer and consumes the claim, and a still's mirror and prompt restore then land only while the frame still shows that still. A prompt the user typed into Regenerate is written by the trigger at the click (`prepareShotImageWorkflowInput`, `generateShotMotionFn`) and the run renders from that row by id; no workflow writes a user edit. The clips a render consumed are recorded once, as the manifest's `audioClipIds`; `shot_prompt_versions.audioClips` is dead (unwritten, unread, kept to avoid a table rebuild). Rewrites a run makes mid-flight (content soften, length shorten) are appended unselected and ride their render's promote. Version rows are never rewritten in place: an element-token rename (`sequenceElements.cascadeRename`) appends `renamed` prompt and scene-script rows and compare-and-swaps each pointer. A prompt claim's mirror right is revoked by a pointer that moved to a newer row, not by any newer row, so unselected history cannot cancel a queued regeneration.

## Shipped vs deferred

Much of the original "stage 1" plan is live. This section separates what exists today from what remains deferred so implementers don't re-build shipped tables.

### Shipped

- **`src/shots/input-hash.ts`** — per-artifact SHA-256 helpers + unit tests.
- **Hash columns** — on `frames`, `shots`, `characters`, `sequence_locations`, `location_sheets`, `location_library`, `talent_sheets`, `frame_variants`, `shot_variants`.
- **Workflow snapshots** — per-workflow `*-snapshot.ts` modules; `RegenerateShotsWorkflow` is the reference implementation.
- **Image versions (#989)** — `frame_variants` flat versions + `frames.selectedImageVersionId` pointer; drift = unselected version, not `stale:detected`.
- **Sheet divergent alternates** — `character_sheet_variants`, `location_sheet_variants`, `talent_sheet_variants` + `sheet-divergence.ts` + `generation.stale:detected`.
- **Music divergent alternates** — `sequence_music_variants` + `music-workflow.ts` emit path.
- **Prompt version history** — `frame_prompt_versions` (visual) and `shot_prompt_versions` (motion), with `visualPromptInputHash` / `motionPromptInputHash` staleness mirrors.
- **Realtime** — `realtimeSchema.generation['stale:detected']` discriminated union is live.
- **Clip provenance (#1657)** — `VideoManifestEntry.referenceKeys` + the `audioClipIds` compare, duration snapped on both sides, and `src/shots/server/live-shot-state.ts` as the one live-side loader. Closes the reference-sheet, element-media and duration gaps the docs dependency graph drew red.
- **Authored dialogue + recordings (#1657)** — `shot_dialogue_versions` (append-only lines per shot), `dialogue_recordings` (one whole file per ElevenLabs call, never joined, no selection) and `shot_dialogue_sections` (a time range of a recording per shot, `source: 'recorded' | 'context'`); lines and sections each carry a selected pointer per shot, and `shots.audioClips` mirrors the selected section's cut. A recording in flight is a `shot_dialogue_claims` row (claim → demote → guarded complete → fail, the #1085 lifecycle). The selected lines row is the ONLY source of what a shot says: every reader resolves through `shotDialogueResolver`, and `shot_prompt_versions.dialogue` is no longer written (read only as the resolver's fallback for pre-#1657 rows).
- **Bible history (#1600)** — `character_bible_versions` / `location_bible_versions` + `selectedBibleVersionId`; sheet version rows carry `bibleVersionId`; staleness causes name the bible fields that moved.
- **Voice history (#1657)** — `character_voice_versions` + `characters.selectedVoiceVersionId`, with an explicit `source` and `createdBy` per row and `releasedAt` on any row whose ElevenLabs id has been freed (a released row can never be selected).
- **Music track staleness (#1657)** — `sequence_music_variants.inputHash` is compared, not just written; `musicTrack` is its own facet next to `musicPrompt`.

### Still deferred

### Stage 3 (video): render-segment video variants (#990)

Scene video is tiled into ≤15s `render_segments`; per-shot video selection moves to `video_variants` with a render manifest. No `sequences.mergedVideoUrl` columns — merged output is a function of segment variants. Divergence routing for video will follow the sheet pattern once Phase 3 lands.

### Stage 4 (remaining prompt UX)

Prompt **storage** is shipped (`frame_prompt_versions`, `shot_prompt_versions`). Still open: full history UI, field-level diff inside `<DivergenceCompareDialog>`, and sequence-level music-prompt version table if music prompt undo is needed beyond the cached `sequences.musicPrompt` / `musicTags` columns.

### Stage 5: dependency materialization

Everything else from the original doc that we're explicitly _not_ implementing yet:

- **`frame_dependencies` edge table.** Keep inferring from `characterTags` / `matchCharactersToScene` (`src/shots/scene-matching.ts`, used by `sheet-snapshots.ts` and `shot-images-workflow.ts`) until there's a concrete reason to materialize it — e.g., needing to walk dependents faster than a scan allows.
- **`stale` as a status enum value.** The derived boolean is sufficient until it isn't.
- **Topological regeneration queue.** Not needed until we have a materialized dependency graph to walk.
- **Content-addressable snapshot table** (`workflow_input_snapshots`). Not needed until inlining snapshots into Cloudflare Workflows payloads actually strains the payload-size budget.

## Decision summary

Answering every row of the original doc's decision table for our stack:

| Original decision area   | Original recommendation                   | This doc                                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versioning approach      | Immutable snapshots + version chains      | **Adapted**: per-artifact `input_hash` (stage 1). Variants tables for sheets, sequence video/music, and prompts (stages 2-4). No version chains.                                                                 |
| Staleness detection      | Content hash comparison                   | **Kept**: SHA-256 input-hash comparison, derived at read time.                                                                                                                                                   |
| Invalidation propagation | Lazy dirty bits + demand verification     | **Adapted**: no dirty-bit table; staleness is a pure read of the current graph.                                                                                                                                  |
| Collaborative sync       | Property-level LWW + transactions         | **Dropped**: not a concurrent editor. Server is authoritative.                                                                                                                                                   |
| Workflow isolation       | Application-level snapshots               | **Kept**: snapshot inlined in the Cloudflare Workflows payload; per-workflow `*-snapshot.ts` modules build, hash, and validate it.                                                                               |
| Lifecycle management     | XState machines                           | **Dropped**: existing status columns are sufficient.                                                                                                                                                             |
| Workflow orchestration   | Inngest (or Temporal)                     | **Dropped**: Cloudflare Workflows already does this.                                                                                                                                                             |
| Real-time events         | Redis pub/sub + PG NOTIFY                 | **Kept, different plumbing**: typed SSE events delivered through `RealtimeChannel` Durable Objects; one new event type.                                                                                          |
| Job distribution         | SKIP LOCKED queue                         | **Dropped**: Cloudflare Workflows is the durable job engine.                                                                                                                                                     |
| Branching                | `parentVersion` + branch names            | **Dropped**. Variants tables (stages 2-4) cover the realistic "keep old vs new" use case.                                                                                                                        |
| Divergence handling      | Three options: re-queue / alternate / ask | **Adapted**: images → pointer-retained `frame_variants` versions (#989); sheets + music → `*_variants` + `stale:detected`; shot video/audio divergent path → `shot_variants` when emitters land. No user prompt. |

## Where to go next

Stage 1 core is shipped (see "Shipped vs deferred"). Remaining work, roughly in priority order:

1. **Finish snapshot migration** on any workflow that still live-reads scoped state mid-flight (`shotImagesWorkflow` is largely there; audit the long tail).
2. **Wire UI** to `generation.stale:detected` and `isStale` on surfaces listed in [staleness-and-divergence-ux.md](./staleness-and-divergence-ux.md) — sheet banners are live; shot image divergence banners are retired (#989).
3. **Video variants (#990)** — `video_variants` divergence emitters + render-segment selection pointers.
4. **Prompt history UX** — expose `frame_prompt_versions` / `shot_prompt_versions` in the UI (storage exists).
5. **Dependency materialization** (stage 5) — only if runtime inference via `matchCharactersToScene` becomes a bottleneck.
