# Staleness and divergence UX

> **Scene → Shot → Frame.** Image selection is a pointer repoint on `frame_variants` (#989) — there is no divergent-image `stale:detected` path. See [scene-shot-frame-redesign.md](./scene-shot-frame-redesign.md).

Companion to [workflow-snapshots-and-content-hash-staleness.md](./workflow-snapshots-and-content-hash-staleness.md). The architecture doc is intentionally backend-heavy — it specifies hashes, snapshots, and divergence routing but punts on what the user sees. This is the answer.

The architecture surfaces two new states through a single realtime event (`generation.stale:detected`) and a derived `isStale(entity, artifact)` reader. Both states need UI, but they're meaningfully different — and conflating them is the most likely way the UX fails.

## Vocabulary

We use two names, deliberately. Treat them as load-bearing — copy in the UI sticks to these terms.

| Term                         | When it applies                                                                                                                                                              | What it means to the user                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stale**                    | Fresh hash ≠ stored `*InputHash` on the parent row (caller computes fresh hash; scoped `isStale` compares). Derived at read time.                                            | "What you're looking at was generated from inputs that have since changed. The image / video / sheet itself is fine, but it's no longer the answer to the question you're asking."              |
| **Divergent alternate**      | A `*_variants` row with `divergedAt IS NOT NULL` (sheets, music, shot video/audio) — **not** images (#989). Produced when a workflow finished but inputs changed mid-flight. | "You started a regeneration. While it was running, you (or your collaborator) edited an upstream input. Rather than overwrite the new inputs with old work, we set this aside as an alternate." |
| **Unselected image version** | A `frame_variants` row that exists but is not pointed to by `frames.selectedImageVersionId` — includes mid-flight drift (#989) and explicit model compares.                  | "Another still exists for this shot. Pick it from the version picker / model compare UI." — no `stale:detected` toast; selection is `frameVariants.select`.                                     |

A single shot can be **stale**, **have a divergent alternate** (sheet/music/video), **have unselected image versions**, any combination, or none. The UI handles staleness and divergent alternates as distinct, composable states.

**Per-model image versions** (`frame_variants`, `kind: 'model'`) from explicit "try another model" are neither stale nor divergent alternates — they're normal version history. **`divergedAt`** on `shot_variants` / sheet variants marks workflow-time divergence; `frame_variants` has no `divergedAt`.

## Two new shared primitives

Both are slim, non-modal, sit inline with the artifact they describe, and reuse the project's `<Alert>` shape. Neither blocks interaction.

### `<StalenessIndicator>`

```
[ ⚠  Inputs changed since this was generated.    [ Regenerate ]  [ ✕ ] ]
```

Props:

- `artifact: 'thumbnail' | 'video' | 'audio' | 'sheet' | 'visual-prompt' | 'motion-prompt' | 'music-prompt'`
- `entityType: 'shot' | 'character' | 'location' | 'library-location' | 'talent' | 'sequence'` (matches `StalenessEntityType` in `staleness-indicator.tsx` and `realtimeSchema.generation['stale:detected']`)
- `onRegenerate: () => void`
- `onDismiss?: () => void` — soft-dismiss for this session only; doesn't change DB state.
- `density?: 'inline' | 'corner-dot'` — `inline` for detail views, `corner-dot` for cards / lists.

Single primary action: **Regenerate** with current inputs. Dismiss is for the user who's intentionally keeping a stale render around to compare against the new one — it's session-scoped, no persistence.

The corner-dot variant collapses to an 8px amber dot positioned where `Check`/`Loader2` already render on `scene-list-item.tsx:58-81`. Clicking the dot jumps focus to the matching detail view's full banner.

### `<DivergentAlternateBanner>`

```
[ ⓘ  An alternate was generated with the inputs you had at the time.  [ Compare ]  [ Promote ]  [ Discard ] ]
```

Props:

- `variantId: string`
- `entityType` / `artifact` (same union as above)
- `onCompare: () => void`
- `onPromote: () => void`
- `onDiscard: () => void`
- `density` (same)

Three actions, in this order: **Compare** (opens the comparison dialog — preview before commitment), **Promote** (replace the live primary with this alternate), **Discard** (soft-delete via `discarded_at` column on the variant row; doesn't physically delete the artifact so we can recover from misclicks).

When both states apply at once (the live primary is stale **and** there's a divergent alternate), the divergent banner takes precedence — the alternate is, by definition, generated from the inputs that are now live in the DB. Promoting it resolves both states. The staleness indicator is suppressed in this case to avoid double-banner clutter.

## Divergence resolution flow

The default flow (**sheets / music / shot video-audio only** — not images):

1. Workflow finishes, recomputes current hash, finds it diverges from `snapshotInputHash`. Inserts a `*_variants` row with `divergedAt = now()` (e.g. `sheet-divergence.ts`, `music-workflow.ts`). Emits `generation.stale:detected` with the new `divergedVariantId`.
2. Sonner toast on the affected sequence's view: _"An alternate version is available for Scene 4."_ Click → focuses the shot detail.
3. `<DivergentAlternateBanner>` appears in-place (detail right rail; corner dot on the scene card for sheet/music paths that surface it).
4. User picks one of three branches:

**Image mid-flight drift (#989)** does not use this flow: `image-workflow` retains an unselected `frame_variants` version (the frame's status is its rows', #1942) without emitting `stale:detected`. The user switches primaries via the version picker (`frameVariants.select`).

### Compare

Opens `<DivergenceCompareDialog>`. Two-column layout:

```
┌─────────────────── Compare alternate ──────────────────┐
│                                                          │
│   Live (current inputs)         Alternate (older inputs) │
│   ┌──────────────────┐          ┌──────────────────┐     │
│   │                  │          │                  │     │
│   │   <thumbnail>    │          │   <thumbnail>    │     │
│   │                  │          │                  │     │
│   └──────────────────┘          └──────────────────┘     │
│                                                          │
│   What changed:                                          │
│   • Character "Alex" — sheet regenerated                 │
│   • Location "Warehouse" — recast                        │
│                                                          │
│                         [ Discard ]  [ Promote ] [ Cancel ] │
└──────────────────────────────────────────────────────────┘
```

The "What changed" panel is computed by diffing the snapshot DTO carried in the variant's `input_hash` provenance against the current entity state. For stage 1 we surface only the upstream-entity-level diff (which characters / locations / sheets changed) — not field-level prompt diffs. Field-level lands in stage 4 alongside prompt history.

For non-image artifacts (video, audio): same dialog shape, with `<video>` or `<audio>` controls instead of `<img>`.

### Promote

Reuses the recast-confirm pattern (`src/cast/ui/talent/recast-confirm-dialog.tsx`):

```
Promote alternate?

This will replace the current image with the alternate
version. The motion video, if any, will be marked stale.

[ Cancel ]  [ Promote ]
```

The "motion video, if any, will be marked stale" copy adapts based on which downstream artifacts exist for the entity. The mutation depends on artifact type:

- **Images (#989):** promotion is retired — `buildPromoteUpdate` throws for `variantType === 'image'`. Switching primaries uses `frameVariants.select` (pointer repoint + mirror), not a divergent-alternate promote.
- **Shot video / audio:** copies the `shot_variants` row's `url` / `storagePath` into `shots.videoUrl` / `audioUrl` (and matching `*InputHash`), clears `divergedAt` or sets `discardedAt`, emits `video:progress` / `audio:progress` with `status: completed`.
- **Sheets:** copies into the live entity via `characters.updateSheet` / location/talent equivalents; clears the divergent variant row or sets `discardedAt`; `sheet-divergence.ts` already emitted `stale:detected` at insert time.

### Discard

Soft-delete: set `discarded_at = now()` on the variant row. UI hides discarded variants. We keep the artifact addressable for recovery and audit. No confirmation dialog; instead show a sonner toast with an Undo action that clears `discarded_at`.

## Staleness surfacing matrix

One row per `(entityType, artifact)` from the `stale:detected` payload. "Stage" is the architecture-doc stage that lands the backend support.

| Entity / artifact            | Surface (card)                                                 | Surface (detail)                                                                | Status                                                      |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `shot` / `thumbnail`         | (none — no staleness corner dot on `scene-list-item` today)    | inline banner via `ShotStalenessBanners` / `scene-script-prompts.tsx` image tab | shipped (staleness); image divergence banner retired (#989) |
| `shot` / `video`             | divergent corner dot when `shot_variants` divergent row exists | inline staleness + divergent banner on motion tab in `scene-script-prompts.tsx` | partial                                                     |
| `shot` / `audio`             | (none)                                                         | inline banner on (future) audio tab                                             | deferred                                                    |
| `character` / `sheet`        | corner dot on `talent-card`                                    | inline banner above sheet image in `character-detail-view`                      | shipped                                                     |
| `location` / `sheet`         | corner dot on `location-card`                                  | inline banner above reference image in `location-detail-view`                   | shipped                                                     |
| `library-location` / `sheet` | corner dot on `location-library-card`                          | inline banner in `location-library` edit dialog                                 | shipped                                                     |
| `talent` / `sheet`           | corner dot on `talent-library-card`                            | inline banner in `talent-library` edit dialog                                   | shipped                                                     |
| `sequence` / video (render)  | (none)                                                         | inline banner when segment video is stale (#990)                                | deferred                                                    |
| `sequence` / `music`         | (none)                                                         | inline banner in `music-view` + divergent via `stale:detected`                  | partial                                                     |
| `shot` / `visual-prompt`     | (none)                                                         | staleness corner dot on image-prompt tab (`scene-script-prompts.tsx`)           | shipped                                                     |
| `shot` / `motion-prompt`     | (none)                                                         | staleness corner dot on motion-prompt tab                                       | shipped                                                     |
| `sequence` / `music-prompt`  | (none)                                                         | "prompt stale" badge in `music-view` + history sheet                            | deferred                                                    |

Rows marked **shipped** or **partial** reflect what exists in the codebase today; **deferred** rows are sketched so matching backend/UI tickets have a documented home.

## Bulk operations

Single proposal, deferred to stage 1.5 or stage 2:

- A "Stale" filter pill at the top of the scene list (`scene-list.tsx`) that hides non-stale frames.
- When the filter is active, a "Regenerate all stale" CTA appears next to the filter, triggering one `regenerateShotsWorkflow` for the union of stale shots.

Not in v1. Listed here so it has a documented home when we pick it up.

## Backend prerequisites the UI assumes

Backend implementation details that need to be in place before the divergence UI works correctly:

1. **Divergent indexes live on `shot_variants` (video/audio), not `frame_variants` (images).** `shot_variants` carries `shot_variants_primary_key` (WHERE `divergedAt IS NULL`) and `shot_variants_divergent_key` (WHERE `divergedAt IS NOT NULL`). The comparison dialog and corner-dot queries for video divergence filter `divergedAt IS NOT NULL` on `shot_variants`.

   **`frame_variants` (#989)** has no `divergedAt` — flat image versions indexed by `(frameId, kind, model)`. Mid-flight image drift surfaces as an unselected version, not a divergent alternate banner.

2. **`promptHash` vs `inputHash` on `frame_variants`.** Both columns exist; **`inputHash` is canonical** for staleness. `promptHash` is retained for legacy reads. UI and workflows should compare `inputHash`.

## Out of scope for v1

- Prompt history UI (stage 4 — sketched in matrix, no v1 commitment).
- Sequence-level merged-video / music variant UI (stage 3 — same).
- Library-location variants UI (stage 2 backend doesn't yet differentiate library from per-sequence; the matching UI ticket can decide).
- A sequence-wide "stale audit" page.
- Bulk-regenerate UI (proposed, deferred to stage 1.5 / stage 2).
- Field-level diffing inside `<DivergenceCompareDialog>` (lands with stage 4 prompt history).

## Open questions

- **Toast frequency.** If a long workflow lands many divergent variants in quick succession (a recast that diverges across N shots), do we toast once with a count, or once per shot? Default: debounce to one toast per sequence per 5s with a count.
- **Promote-while-generating.** What happens if the user clicks Promote on a variant while a fresh regenerate is already in flight? Default: confirm dialog warns and offers to cancel the in-flight workflow, then promotes. Implementation depends on tracking the relevant Cloudflare Workflows instance ids and terminating the in-flight run safely before promotion.
