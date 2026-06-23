# Scene → Shot → Frame Redesign — Design & Implementation Plan

Status: **planned** · Branch: `milestone-18-scene-shot-frame` · Supersedes the
1:1 "still-on-the-shot" shape currently on the branch.

## Why

Milestone-18 renamed the old `frames` table → `shots` and baked the still image
onto `shots.thumbnailUrl` — a hard 1:1 (one shot = one image). That's wrong in
**both** directions:

- A shot can need **multiple** stills (first + last frame for i2v conditioning, keyframes).
- A shot can need **zero** generated stills (Seedance-2 reference-driven multi-shot:
  character/location refs + text, no first frame).

So the still is its own unit. The model is genuinely three levels:

| Level     | Is                                                        | Owns                                                                  |
| --------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| **Scene** | narrative unit (one location/time/beat), free length      | grouping; per-segment render selection (`renderPlan`)                 |
| **Shot**  | a continuous take = the **video** unit                    | motion prompt (input), per-shot video selection, 1..N frames          |
| **Frame** | a still keyframe = the **image** unit (1 frame = 1 image) | image selection; `role` first\|last\|key; `source` preview\|generated |

`source = 'preview'` is the cheap turbo stand-in (shown while a real still is
pending, or for reference-driven shots that never get a dedicated first frame);
it upgrades to `'generated'` **in place** so the i2v anchor identity never
changes underneath motion generation.

## Vocabulary (this is binding — two words, not three)

- **variant** — a parallel candidate you select between. Axis = **model** _or_
  **framing** (the 3×3 is `kind: 'framing'`, derived from a model image — not a
  separate concept).
- **version** — the stored generation history _within_ a variant, time-ordered.
  Re-rolls accumulate (we keep them); they never overwrite.
- Prompt history is also **versions**.
- **Selection is a pointer**, not a per-row flag. Reverting / switching model =
  repoint. `divergedAt` is **retired**; `discardedAt` stays (soft-hide a
  version, undoable). Versions are ordered by time (ULID), labelled by a derived
  per-model ordinal ("v3 · 2m ago"), and referenced internally by id (so
  deleting a middle version renumbers labels without breaking references).

DB snake_case == code camelCase == UI Sentence case throughout.

## Data model

### Frames + image versions

`frames` — the still keyframes of a shot.

```
frames
  id                      // ULID; the anchor frame reuses its shot's id (see Backfill)
  shotId  → shots.id  (cascade)
  sequenceId → sequences.id (cascade)   // denormalized for sequence-scoped queries
  orderIndex (0 = first/anchor)
  role:   'first' | 'last' | 'key'
  source: 'preview' | 'generated'
  imageUrl                // cached mirror of the selected image version
  previewImageUrl, imagePath, imageStatus, imageWorkflowRunId,
  imageGeneratedAt, imageError, imageInputHash
  imageModel              // SQL default a frozen literal, never a mutable constant
  selectedImageVersionId → frame_variants.id (set null)
  selectedImagePromptVersionId → frame_prompt_versions.id (set null)
  timestamps
```

`frame_variants` — **flat**: each row is one image generation (a _version_). A
"variant" is the emergent group sharing `(frameId, kind, model, sourceVariantId)`;
its "versions" are those rows by time.

```
frame_variants
  id                      // ULID; the version's stable id
  frameId → frames.id (cascade)
  sequenceId → sequences.id (cascade)
  kind:   'model' | 'framing'
  model
  sourceVariantId?        // for 'framing' rows: which model image's 3×3 this came from
  url, storagePath, previewUrl
  status, workflowRunId, generatedAt, error
  promptHash, inputHash   // staleness of THIS version
  discardedAt?            // soft-hide (undoable)
  timestamps
  // removed vs the old shape: divergedAt, the gridImage* columns
```

The 3×3 grid is a _picker_ that spawns a `kind: 'framing'` row, not stored columns.

### Prompt versions

`frame_prompt_versions` (image prompt) and `shot_prompt_versions` (motion
prompt) — renamed from `*_prompt_variants`; they are version histories of an
authored input. The current value is mirrored on the parent (`frame.imagePrompt`
/ `shot.motionPrompt`) with a `selected…PromptVersionId` pointer.

Symmetry that justifies keeping the motion prompt here (not "shot versions"):

|                    | Image                                  | Motion/Video                           |
| ------------------ | -------------------------------------- | -------------------------------------- |
| Input (authored)   | image prompt → `frame_prompt_versions` | motion prompt → `shot_prompt_versions` |
| Output (generated) | image → `frame_variants`               | video → `video_variants`               |
| Output owner       | frame                                  | scene (per segment)                    |

A shot is a structural container, not a generated artifact — so we version its
_inputs_ (prompt) and _outputs_ (video) separately, never the container.

### Video variants + the 15s constraint _(Phase 3)_

Render models cap a single render at **15s** (multi-shot included). Scenes are
narrative and free-length, so the render unit ≠ the scene. A scene's video is an
ordered tiling of **≤15s segments**, each a contiguous shot-subset. Common case
(scene ≤15s) = one segment = whole scene; long scenes split. Per-shot rendering
is the degenerate case (segment = one shot).

`video_variants` — flat versions, keyed `(sceneId, model, shotSetKey)`, carrying
an ordered **manifest** that snapshots exactly what the render consumed:

```
video_variants
  id, sceneId → scenes.id (cascade), model
  shotSetKey              // hash of the ordered shotIds → segment identity
  manifest: [             // ordered, one entry per covered shot
    { shotId,
      motionPromptVersionId,   // reference to an immutable shot_prompt_versions row
      frameVersionId?,         // reference to an immutable frame_variants row; null = reference-driven
      durationMs }             // value-snapshot of non-versioned render inputs
  ]
  inputHash               // hash of the manifest → O(1) staleness
  url, status, generatedAt, error, discardedAt?, timestamps
```

Because versions are **immutable once completed** (append-only; soft-hide only),
the manifest references version rows instead of copying their contents — the
reference _is_ the snapshot. Staleness = a shot's currently-selected
prompt/frame version no longer matches the manifest's referenced one (or
`inputHash` mismatch).

Segment partition + selection — **lightweight (chosen)**: the scene holds an
ordered `renderPlan: [{ shotIds, selectedVideoVersionId }]`. Revert-a-segment =
repoint its entry. Upgrade path if segment UX gets rich: an explicit
`render_segments` entity (Scene → Segment → Shot). Per-shot video is mirrored on
the shot (`shot.videoUrl` + `selectedVideoVersionId`).

`shot_variants` retires (video → `video_variants`; **audio deferred** — only
sequence music exists for now via `sequence_music_variants`).

### Sequence activity log

`sequence_events` — append-only, **log-over-truth** (not event-sourcing). Domain
tables stay authoritative; this narrates changes and references them. It's the
one linear cross-sequence timeline and captures what version tables can't
(reorders, add/delete, selection/pointer changes).

```
sequence_events
  id                      // ULID → global time order
  sequenceId → sequences.id (cascade)
  actorId?                // user; null = system / AI / workflow
  kind                    // 'image.generated' | 'image.selected' | 'prompt.edited'
                          // | 'video.rendered' | 'shot.added' | 'shot.removed'
                          // | 'shots.reordered' | 'model.added' | ...
  targetType, targetId    // 'frame' | 'shot' | 'scene' | 'sequence' | 'variant'
  summary                 // denormalized human string, cheap to render
  data                    // JSON: model, versionId, from→to, prevPointer (enables undo)
  createdAt
```

Drift is prevented structurally: the event is appended in the **same
`db.batch()` transaction** as the mutation, from the central scoped-db write
layer — change and event commit together or not at all.

## Backfill & migration safety

- **Anchor frame id = its shot id.** The #906 rename preserved old-frame ids onto
  `shots`, so reusing `shot.id` for the anchor frame is deterministic, a real
  ULID (passes `isValidId`, sorts correctly), and lets the cutover backfill be a
  pure in-migration `INSERT … SELECT` whose child copies join on `shot_id`.
  Accepted tradeoff: a shot and its anchor frame **share** a ULID across tables —
  relies on table-scoped query/event keys. Anchor-only: last/key/multi-shot
  frames get fresh `generateId()` ULIDs.
- **Migrations stay additive.** New tables via `CREATE TABLE`; column moves via
  `ALTER … DROP COLUMN` (no table rebuild → no FK-cascade trap, ref #612).
- **Never a mutable imported constant as a SQL `.default()`** — it drifts from
  the deployed column default and forces a full-table rebuild (this is what
  caused a spurious `DROP TABLE sequences`; fixed by pinning the literal
  `'nano_banana_2'` + substituting `DEFAULT_IMAGE_MODEL` in the scoped create).
  Use a frozen literal; resolve the real default in app code.
- **Migrations are still editable** — nothing durable has applied the
  milestone-18 migrations (prod unseen; preview resets via close-PR → D1-delete
  → reopen). So the deterministic cutover data-copy gets folded into the
  additive migration _before_ prod deploy, when the schema is proven and
  testable. It's a no-op on empty dev/preview.

## Implementation plan — one PR per phase

Each phase is its own reviewable PR; typecheck + targeted tests green before the
next. Within a phase, work fans out across **disjoint files** so parallel edits
never collide. **Stop at each phase's diff for review — no commit/push without
sign-off.**

### Phase 0 — Schema + additive migration

Frames, `frame_variants` (flat versions), `frame_prompt_versions`,
`shot_prompt_versions`, `sequence_events`, image selection pointers; narrow
`shots`/retire image columns. Regenerate the clean additive migration.
**Video (`video_variants`) is deliberately NOT here** — see Phase 3.
Gate: `bun db:generate` clean (no rebuild) + schema typechecks.

### Phase 1 — Scoped-db access layer (the frozen contract)

New scoped modules: `frames`, `frame_variants` (append version, list-by-group,
**select/repoint**, discard/undiscard, resolve-current, staleness),
`frame_prompt_versions`, `shot_prompt_versions`, and the `recordEvent` helper
(same-batch emit). Trim image bits out of `scoped/shots.ts`; wire the aggregator.
Gate: typecheck.

### Phase 2 — Image generation

Workflows + server fns that produce/select stills → write frames +
`frame_variants` versions, repoint selection, emit events.
Gate: typecheck + image unit tests.

### Phase 3 — Video variants + 15s segments

`video_variants` (flat versions, `shotSetKey`, manifest of refs +
value-snapshots), `scene.renderPlan`, 15s tiling, per-shot mirror, staleness
re-routed through the primary frame, events. Decide explicit `render_segments`
vs `renderPlan` here (default `renderPlan`).
Gate: typecheck + motion/segment tests.

### Phase 4 — Realtime / hooks / query-cache

Frame image + video progress events, version lists, selection updates.
Gate: typecheck + realtime tests.

### Phase 5 — UI

Frame cards, image panel (versions + model variants + framing picker), motion
panel, version/variant pickers, scene player, **and the sequence activity
timeline** (`sequence_events` feed).
Gate: typecheck + storybook/build.

### Phase 6 — Tests + e2e + cutover

Update seeds/fixtures to the frames + versions shape; e2e green. Fold the
deterministic in-migration data-copy (`frame.id = shot.id` anchors + child
remaps) into the additive migration; reset preview D1.
Gate: full e2e; preview deploy clean.

## Cross-cutting rules

- One reviewable PR per phase; the diff lands as an ordered stack, never a blob.
- Migrations additive/safe; destructive drops gated by
  `check-migrations --allow-destructive` at commit.
- No commit/push without review; stop at each phase's diff.

## Deferred / open

- **Audio grain** — per-shot/scene dialogue/SFX vs sequence-music-only. Deferred;
  `shot_variants` retires for now.
- **Motion treatment variants** — an A/B "movement style" axis on the motion
  prompt (parallel to image model-variants). Versions-only for now.
- **Segments** — `renderPlan` now; explicit `render_segments` entity later if
  per-segment editing/versioning UX warrants it.
- **`imageUrl` mirror vs derive** — chose mirror (consistent with prompt
  mirroring); revisit if drift becomes a problem.
