# Workflow snapshots and content-hash staleness

> **Scene → Shot → Frame.** The still-image surface, version pointers, and retired image `divergedAt` path are defined in [scene-shot-frame-redesign.md](./scene-shot-frame-redesign.md) (#989). This doc covers input-hash staleness and workflow snapshots on top of that model.

This is the companion to [managing-complex-dependency-graphs-in-collaborative-ai-video-platforms.md](./managing-complex-dependency-graphs-in-collaborative-ai-video-platforms.md). The original doc proposed a general-purpose versioned-DAG architecture with branching, XState lifecycles, Inngest, Postgres MVCC, Redis pub/sub, and Linear-style transaction sync. A review against the codebase shows that most of that infrastructure is already solved differently on our stack (Cloudflare Workflows, Durable Object-backed SSE realtime, Cloudflare D1, Drizzle, and scoped DB access from workflow payload `teamId`/`userId`) — and most of what remains unsolved reduces to a critical path of three ideas. This doc is the stack-specific subset we intend to ship.

It composes with [scoped-db-context-implementation.md](./scoped-db-context-implementation.md); every new data-access path described here flows through `ScopedDb`.

## The two failure modes we're closing

**1. Lost-work mid-generation.** Content-generation workflows must not read mutable DB state for anything that should be frozen at trigger time. Before the snapshot pattern, `regenerateShotsWorkflow` (`RegenerateShotsWorkflow` in `src/lib/workflows/regenerate-shots-workflow.ts`) could re-resolve sequence fields or sheet references mid-flight. If a user edits a character, location, or prompt while the workflow is running, generation can read a mix of pre- and post-edit inputs. The result is written as the primary artifact either way, with no signal that what landed isn't what the user had in mind when they triggered the workflow. `RegenerateShotsWorkflow` is the reference fix: it inlines per-shot snapshot DTOs and a batch `snapshotInputHash` at trigger time via `src/lib/workflows/regenerate-shots-snapshot.ts`.

**2. Silent staleness.** After a character recast or location swap, downstream shots (and their anchor-frame stills), character sheets, location sheets, and talent sheets still display their prior outputs. Nothing in the schema records which inputs those outputs were derived from, so the UI can't distinguish "still current" from "stale but not yet regenerated" — and neither can a workflow about to apply a new result.

Both failure modes collapse into one missing primitive: **every generated artifact needs to remember the inputs it was generated from**, and every workflow needs to **freeze those inputs at start time and verify them at write time**.

## What we're explicitly not doing

Before describing the design, it's worth stating what the original doc recommended that we're skipping, and why — so future implementers don't accidentally drift back toward it:

| Original recommendation           | Why we skip it                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inngest for orchestration         | Cloudflare Workflows is already wired, and `OpenStoryWorkflowEntrypoint` (`src/lib/workflow/base-workflow.ts`) enforces `teamId`/`userId` on every run. Swapping orchestrators would be pure churn.                                                                                                                                                     |
| XState v5 lifecycle machines      | Per-artifact status columns on `frames` (`imageStatus`) and `shots` (`videoStatus`, `audioStatus`) already model `pending → generating → completed → failed`. `sequences.status` is sequence lifecycle (`draft → processing → completed → failed → archived`), not per-artifact generation. Adding XState on top would duplicate state, not replace it. |
| Custom Redis pub/sub + PG NOTIFY  | `src/lib/realtime/index.ts` already provides a typed `realtimeSchema`; delivery runs through the in-repo SSE client and `RealtimeChannel` Durable Object. We extend this schema, we don't replace it.                                                                                                                                                   |
| Postgres JSONB / SKIP LOCKED      | The app runs on Cloudflare D1 (SQLite). Cloudflare Workflows is already the durable job engine; we don't need a DB-level queue at all.                                                                                                                                                                                                                  |
| Entity version chains / branching | `frame_variants` (`src/lib/db/schema/frame-variants.ts`) already holds alternate per-model outputs, which covers the realistic "keep old vs new" use case for frame artifacts. General-purpose branching adds complexity we don't need.                                                                                                                 |
| Property-level LWW + rebasing     | We are not a concurrent editor. TanStack Query + server functions give us implicit last-writer-wins at the server boundary.                                                                                                                                                                                                                             |
| Dependency edge table (v1)        | Character/location → shot linkage is inferred at runtime via `characterTags` in shot metadata and `matchCharactersToScene` (`src/lib/workflows/scene-matching.ts`). Good enough until we have a reason to materialize it.                                                                                                                               |
| `stale` status enum value (v1)    | Staleness is a **derived** boolean (`generatedFromInputHash !== computeInputHash(entity)`). Adding it to the enum is a v2 question if the derived form ever proves insufficient.                                                                                                                                                                        |

## Pillar 1: Input-hash staleness

Every artifact-bearing row stores the SHA-256 hash of the canonical serialization of the inputs used to generate it. Staleness is a query-time comparison, not a stored flag.

### What goes into the hash

The rule is: anything that, if changed, should cause the user to see a "regenerate" affordance. For our artifacts this is:

- **Frame image** (`frames.imageInputHash`, mirrored on the selected `frame_variants` version) — the composed visual prompt (`frame.imagePrompt` or `shot.metadata` fallback), image model, aspect ratio, and the **content hash of each referenced character sheet, location sheet, and element reference**. Crucially, the hash is over the _referenced sheets' hashes_, not their URLs.
- **Shot video** (`shots.videoInputHash`) — source still selection, motion prompt, motion model, duration, fps, aspect ratio.
- **Shot audio** (`shots.audioInputHash`) — music prompt, tags, duration, audio model.
- **Visual prompt** (`frames.visualPromptInputHash`) — upstream scene metadata + style config + character/location bible + analysis model.
- **Motion prompt** (`shots.motionPromptInputHash`) — same upstream context plus the starting-frame image hash.
- **Character sheet** (`characters.sheetInputHash`) — character bible entry, talent reference hash (if any), style config, image model.
- **Sequence location reference** (`sequence_locations.referenceInputHash`) and **library location template** (`location_library.referenceInputHash`) — location bible entry, library reference hash (if any), style config, image model. Per-sequence generated sheets also carry `location_sheets.inputHash`.
- **Talent sheet** (`talent_sheets.inputHash`) — talent metadata, reference media hashes, image model.

Model _version strings_ count as inputs. If we upgrade an image model, every existing artifact it produced becomes stale — which is the correct behaviour.

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
| `*_sheet_variants`        | `inputHash` + `divergedAt` on divergent sheet rows                                         |
| `sequence_music_variants` | `inputHash` + `divergedAt` on divergent music rows                                         |

We deliberately do **not** add a `content_hash` column on upstream entities themselves (characters, locations, talent) — the referenced-sheet's `input_hash` _is_ the content hash for downstream staleness. This avoids a second-order invalidation layer.

### Where the helpers live

`src/lib/ai/input-hash.ts` exports one named helper per artifact type (e.g. `computeShotImageInputHash`, `computeCharacterSheetInputHash`, `computeMotionPromptInputHash`). Each helper accepts the minimal input DTO it needs (never a whole DB row) and returns a `string`. This keeps callers honest about what counts as input and makes the helpers trivially unit-testable without DB setup.

The existing `src/lib/utils/hash.ts` (`simpleHash`) is not cryptographic and is too weak for this purpose — it stays where it is for its existing non-security uses, and the staleness helpers use `crypto.subtle.digest('SHA-256', ...)`.

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

- **`WorkflowScopedDb`** (`src/lib/db/scoped-workflow.ts`) is what `runImpl` receives instead of `ScopedDb`: the same write surface with every read-shaped method (`get*`, `list*`, `find*`, `resolve*`, `has*`, …) removed from every domain. A mid-run read is a type error. The narrowing is purely type-level — `toWorkflowScopedDb` returns the same object.
- **Three named hatches** carry what a run legitimately cannot know at the trigger. One catch-all would make every exception look alike; the name at the call site is the argument:

  | hatch                                   | what it is                                | why it's safe                                                                                             |
  | --------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
  | `scopedDb.credentials.…`                | `resolveKey` / `resolveLlmKey`, flat      | returns a secret, never a row a generation decision can turn on                                           |
  | `scopedDb.claims.<domain>.getById…(id)` | an append-only row by an id the run holds | the id names one immutable row — nothing for a concurrent edit to substitute                              |
  | `scopedDb.liveRead.<domain>.…`          | live by design                            | divergence recomputation, sibling-workflow polling, balance + spawn-time billing guards, existence guards |

  The split is load-bearing rather than cosmetic: `claims` **cannot express a selection pointer** and `credentials` **cannot express a row**, so the two failure modes behind this work — rendering from a pointer a concurrent edit moved, and treating key access as licence to read data — are unspellable, not merely discouraged.

  `src/lib/workflow/no-mid-run-reads.test.ts` scans `src/lib/workflows/*.ts` and fails on any read not in its per-file allow-list, on an allow-list entry whose call site is gone, and on a read whose recorded category doesn't match the hatch its call site used (a `CLAIM-BY-ID` read reached via `liveRead` fails). Helper modules that declare a narrowed dependency type (`SheetSnapshotReadDb`, `WaitForSheetsReadDb`, `FrameImageReadDb`, `PreflightScopedDb`, `CredentialScopedDb`) are handed the hatch by their workflow caller.

**Chained renders resolve their prompt by id, never by pointer.** `completePendingAiVersion` can end a run on either of two rows: the claim it completed, or — when a completed row already carries the same `(parent, input_hash)` and the same text — the existing row the claim retires in favour of. The prompt children return whichever one ended up live as `finalVersionId` (`FramePromptResult`, `MotionPromptWorkflowResult`), and the parent re-reads that id with `getByIdForFrame` / `getByIdForShot`. Resolving the collision by comparing the selection pointer's `inputHash` against the plan's live hash instead would be wrong twice over: `input_hash` pins the generation _inputs_, not the text, so a same-inputs-different-text version passes the check; and the pointer can move between the check and the render. No child result means the prompt didn't land, which is a stand-down, not a fallback.

The one wide hatch is `scopedDb.stalenessPlanning` (full `ScopedDb`), used only by `update-stale-shots-workflow.ts` for the planner: staleness IS a live-state comparison, so there is nothing to freeze, and the same code renders the "what's stale" preview in the server fns. The same test asserts it has exactly one consumer.

Helper modules shared between server fns and workflows declare a narrowed dependency type instead of taking `ScopedDb` — `SheetSnapshotReadDb`, `WaitForSheetsReadDb`, `FrameImageReadDb`, `PreflightScopedDb`, `CredentialScopedDb` — so a workflow hands over `scopedDb.liveRead` and a server fn its full `ScopedDb`.

### Per-workflow snapshot modules

There is no centralized `snapshot` config on `OpenStoryWorkflowEntrypoint`. Each migrated workflow owns a companion `*-snapshot.ts` module that:

1. **Builds the inlined DTO at trigger time** (server function / parent workflow) from live scoped-DB state — e.g. `buildRegenerateShotSnapshot` in `regenerate-shots-snapshot.ts`, scene snapshot builders in `sheet-snapshots.ts`.
2. **Hashes the DTO** for tamper detection — e.g. `computeRegenerateShotsBatchHash`, `computeShotImagesHashFromDto`, per-artifact helpers in `image-workflow-snapshot.ts`.
3. **Validates at workflow start** inside `step.do('validate-snapshot')` by recomputing the hash from `event.payload` and comparing to `snapshotInputHash`.
4. **Branches at write time** by recomputing a current hash from live state and comparing to the frozen `snapshotInputHash` — convergent results apply as primary; divergent results route through `sheet-divergence.ts`, `music-workflow.ts`, or (for images) pointer-retention in `image-workflow.ts` (see Pillar 3).

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

- **`regenerateShotsWorkflow`** (`RegenerateShotsWorkflowInput`, `src/lib/workflows/regenerate-shots-workflow.ts`) — **reference implementation.** Trigger time inlines `shotSnapshots` (per-shot prompt, reference URLs, and sheet hashes via `buildRegenerateShotSnapshot`), freezes `aspectRatio`, and sets `snapshotInputHash` from `computeRegenerateShotsBatchHash`. The workflow body reads only the inlined DTO; start-time validation runs in `step.do('validate-snapshot')`.
- **`shotImagesWorkflow`** (`ShotImagesWorkflowInput`, `src/lib/workflows/shot-images-workflow.ts`) — inlines `sceneSnapshots` (per-scene upstream sheet hashes) and optional `snapshotInputHash`. Hash helpers live in `image-workflow-snapshot.ts` and `sheet-snapshots.ts`.
- **`characterSheetWorkflow`** (`CharacterSheetWorkflowInput`) — inlines character/talent metadata and reference URLs; carries `snapshotInputHash`. Write-time divergence routes through `decideSheetDivergence` / `saveDivergentCharacterSheet` in `sheet-divergence.ts`.
- **`locationSheetWorkflow`** (`LocationSheetWorkflowInput`) — same pattern for location sheets and library-location references.
- **`libraryTalentSheetWorkflow`** (`LibraryTalentSheetWorkflowInput`) — inlines `referenceImageUrls`, `talentDescription`, and `snapshotInputHash`. Talent media is append-only in practice, so the snapshot is the list of reference URLs themselves.

Most migrations are additive — payloads already carry most of the data. The work is inlining hashes, validating at start, and branching at write time.

### Snapshot size

Cloudflare Workflows has event payload size limits, but our payloads are dominated by prompts, sheet URLs, and metadata — not by the artifacts themselves, which are accessed by URL. We inline snapshots into the payload in v1. If that becomes a problem we add a `workflow_input_snapshots` table with content-addressable storage (as the original doc proposed), but this is not part of v1.

## Pillar 3: Divergence-on-completion

Before writing a generation result, compare hashes:

```ts
// illustrative — character-sheet-workflow reconcile step
const snapshotInputHash = input.snapshotInputHash ?? null;
const currentHash = snapshotInputHash
  ? await computeCharacterSheetHashCurrent(input, scopedDb)
  : null;
const decision = decideSheetDivergence(snapshotInputHash, currentHash);

if (decision.kind === 'divergent') {
  // Parks in character_sheet_variants and emits generation.stale:detected
  await saveDivergentCharacterSheet({
    scopedDb,
    characterId,
    sequenceId,
    model,
    url,
    storagePath,
    workflowRunId,
    snapshotInputHash: decision.snapshotInputHash,
  });
  return { kind: 'divergent' };
}

// Inputs unchanged — apply as the primary sheet (existing behaviour)
await scopedDb.characters.updateSheet(
  characterId,
  url,
  storagePath,
  snapshotInputHash
);
```

Per-shot **image** artifacts use the same hash comparison inside `image-workflow`, but mid-flight drift no longer routes to divergent `frame_variants` rows or `generation.stale:detected` (#989): the workflow appends a new `frame_variants` version, stamps `inputHash`, and deliberately does not repoint `selectedImageVersionId`. `regenerate-shots-workflow` fans out to `image-workflow` children and does not perform its own divergence emit — `divergedShotIds` is always empty today.

### Where divergent / drifted results land

Two models — do not conflate them:

**A. Pointer drift (images, #989).** `image-workflow` compares `snapshotInputHash` vs a live recompute. On drift it appends a new `frame_variants` version with `inputHash`, does **not** repoint `frames.selectedImageVersionId`, and does **not** emit `generation.stale:detected`. The retained unselected version is the drift signal; the user switches primaries via `frameVariants.select` (pointer repoint). Versions are soft-hidden with `discardedAt`, not hard-deleted. `frame_variants` has no `divergedAt` — each row is a flat version (`kind: 'model' | 'framing'`).

**B. Divergent alternates (sheets, music, legacy shot video/audio).** Write-time hash mismatch parks a row in a `*_variants` table with `divergedAt`, then emits `generation.stale:detected` with a required `divergedVariantId`:

- **Character / location / talent sheets** → `character_sheet_variants`, `location_sheet_variants`, `talent_sheet_variants` via `sheet-divergence.ts`.
- **Sequence music** → `sequence_music_variants` via `music-workflow.ts`.
- **Shot video / audio** (when the divergent path is used) → `shot_variants` with partial unique indexes `shot_variants_primary_key` (WHERE `divergedAt IS NULL`) and `shot_variants_divergent_key` (WHERE `divergedAt IS NOT NULL`). No production workflow emits divergent **image** rows on `shot_variants` today — images moved to model A.

**Convergent image writes** repoint `frames.selectedImageVersionId`, mirror `frames.imageUrl`, and stamp `frames.imageInputHash` — see `image-workflow.ts` and `frameVariants.select`.

### Realtime event

`realtimeSchema.generation` in `src/lib/realtime/index.ts` defines `stale:detected` as a discriminated union on `entityType`. Clients subscribe on the generation channel and listen for the dotted path `generation.stale:detected`:

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

`divergedVariantId` is required on every branch — emitters in `sheet-divergence.ts` and `music-workflow.ts` park the divergent artifact first, then reference the new variant row's id. Image drift (model A) does **not** use this event. This gives the UI a single event shape across sheet/music (and future video) divergence without adding new channels.

## How it composes with existing patterns

- **Scoped DB** (`src/lib/db/scoped/*`) is the only entry point. Staleness reads go through scoped getters; hash computation helpers accept a `ScopedDb` and use it. No code path bypasses team scoping.
- **Per-workflow snapshot modules** (`*-snapshot.ts`) own DTO building, hashing, and validation — existing workflows keep working unchanged until they gain one.
- **Status columns** on `frames` / `shots` stay `pending | generating | completed | failed`. Staleness does not become a fifth value. The UI composes `status === 'completed' && isStale(...)` when it needs "completed but stale".
- **`frame_variants`** stores flat image versions with `inputHash`; selection is `frames.selectedImageVersionId`. **`shot_variants`** still carries `divergedAt` for video/audio divergent alternates; image variants on this table are legacy.

## Shipped vs deferred

Much of the original "stage 1" plan is live. This section separates what exists today from what remains deferred so implementers don't re-build shipped tables.

### Shipped

- **`src/lib/ai/input-hash.ts`** — per-artifact SHA-256 helpers + unit tests.
- **Hash columns** — on `frames`, `shots`, `characters`, `sequence_locations`, `location_sheets`, `location_library`, `talent_sheets`, `frame_variants`, `shot_variants`.
- **Workflow snapshots** — per-workflow `*-snapshot.ts` modules; `RegenerateShotsWorkflow` is the reference implementation.
- **Image versions (#989)** — `frame_variants` flat versions + `frames.selectedImageVersionId` pointer; drift = unselected version, not `stale:detected`.
- **Sheet divergent alternates** — `character_sheet_variants`, `location_sheet_variants`, `talent_sheet_variants` + `sheet-divergence.ts` + `generation.stale:detected`.
- **Music divergent alternates** — `sequence_music_variants` + `music-workflow.ts` emit path.
- **Prompt version history** — `frame_prompt_versions` (visual) and `shot_prompt_versions` (motion), with `visualPromptInputHash` / `motionPromptInputHash` staleness mirrors.
- **Realtime** — `realtimeSchema.generation['stale:detected']` discriminated union is live.

### Still deferred

### Stage 3 (video): render-segment video variants (#990)

Scene video is tiled into ≤15s `render_segments`; per-shot video selection moves to `video_variants` with a render manifest. No `sequences.mergedVideoUrl` columns — merged output is a function of segment variants. Divergence routing for video will follow the sheet pattern once Phase 3 lands.

### Stage 4 (remaining prompt UX)

Prompt **storage** is shipped (`frame_prompt_versions`, `shot_prompt_versions`). Still open: full history UI, field-level diff inside `<DivergenceCompareDialog>`, and sequence-level music-prompt version table if music prompt undo is needed beyond the cached `sequences.musicPrompt` / `musicTags` columns.

### Stage 5: dependency materialization

Everything else from the original doc that we're explicitly _not_ implementing yet:

- **`frame_dependencies` edge table.** Keep inferring from `characterTags` / `matchCharactersToScene` (`src/lib/workflows/scene-matching.ts`, used by `sheet-snapshots.ts` and `shot-images-workflow.ts`) until there's a concrete reason to materialize it — e.g., needing to walk dependents faster than a scan allows.
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
