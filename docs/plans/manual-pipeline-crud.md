# Manual Pipeline Driveability — Full CRUD + DAG Proof

**Status:** implemented on `1108-manual-pipeline-crud` — where this plan and
`docs/architecture/manual-pipeline-crud.md` disagree (e.g. §4.2's "hard clear
video to pending", written pre-#1067), the architecture doc describes what
shipped and is authoritative.  
**Goal:** Make every sequence-pipeline entity fully CRUD-able so filmmakers (and later API/MCP) can drive the whole pipeline manually, with correct downstream-only invalidation.

---

## 1. Goals & non-goals

### Goals

1. **Filmmaker flexibility** — add/edit/delete/reorder scenes, shots, cast, locations, elements; edit script, prompts, metadata; upload/replace stills and videos.
2. **DAG proof** — mutating an entity only invalidates _downstream_ dependents; upstream stays fresh; simultaneous multi-artifact writes can keep intermediate nodes non-stale when intentional.
3. **Recovery after failure/cancel** — every artifact has create/update/generate paths so partial pipelines can be finished without re-running storyboard.
4. **Foundation for API/MCP** — product surface is server-fn-first (already is); later v1/MCP mirrors these ops. **Do not implement public API/MCP in this work.**
5. **Soft-delete by default** — product “delete” is reversible; hard delete is rare/admin/storage-gc only.

### Non-goals (this effort)

- Public HTTP API expansion / MCP tools
- Full structural script merge/split UX (#1037) unless needed for basic scene CRUD
- Per-shot dialogue TTS / SFX library productization (schema-only `audio`/`vfx` tables can stay out of scope)
- Event-sourcing rewrite — keep hash-based staleness + append-only versions
- Permanent purge UI (optional later: empty trash / GC job)

### Delete / undo policy (binding)

**Default: soft delete + undo.** Filmmakers will mis-click; creative pipelines must not lose work.

| Entity class                                                        | “Delete” means                                                            | Undo                                    | Today                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------- |
| **Version rows** (frame/video/music/sheet variants, prompt history) | Set `discardedAt` (or leave history and repoint)                          | `undiscard` / restore selection pointer | ✅ already                              |
| **Sequence**                                                        | `status = 'archived'`                                                     | Unarchive → prior status                | ⚠️ archive SF exists; unarchive/UI gaps |
| **Scene / shot / frame structure**                                  | Set `deletedAt` (or `archivedAt`); **exclude from default lists**         | Clear `deletedAt`; restore orderIndex   | ❌ hard delete today — **change**       |
| **Cast / sequence location**                                        | Soft-remove from sequence (`deletedAt`); keep rows + sheets               | Undelete                                | ❌ hard delete DB only                  |
| **Elements**                                                        | Soft-hide preferred; hard delete OK only if no shot refs or after confirm | Undelete if soft                        | ⚠️ hard delete SF today                 |
| **Library talent / location**                                       | Soft archive preferred for team library                                   | Unarchive                               | mixed                                   |
| **R2 blobs**                                                        | **Never** delete on soft-delete                                           | GC only after retention                 | keep bytes                              |

**Undo UX (decided: toast-only for this effort):**

1. **Immediate toast Undo** (~60s) that calls restore/undiscard — covers mis-clicks.
2. **`sequence_events`** records soft-delete with `data.prevState` (orderIndex, parent ids) so restore re-homes correctly.
3. “Show deleted” trash list → **later**, not this effort.

**Hard delete** is reserved for:

- Admin / support tooling
- Optional “Empty trash” after N days
- Never the primary product Delete button

**Why hard delete is hard to undo today:** `deleteShotFn` / scoped `delete` cascades children via FK (`ON DELETE CASCADE` on frames/variants). Once committed, history rows and media pointers are gone; R2 objects may remain orphaned. Soft-delete avoids that class of data loss entirely.

**Staleness when soft-deleting structure:**

- Soft-deleted shots/scenes are **excluded** from staleness plans, Update all, export, theatre.
- Restoring a shot brings it back with its prior hashes — may immediately show **stale** if upstream changed while it was deleted (correct).
- Soft-deleting a character does **not** rewrite shot continuity tags; prompts that still name them may look odd — product choice: either strip tags on soft-delete (downstream prompts stale) or leave tags and show a “missing cast” warning. Prefer **leave tags + warning** so undo is lossless.

---

## 2. Current architecture (what we already have)

### Hierarchy (post Scene→Shot→Frame redesign)

```
Team
└── Sequence
    ├── Scenes ── scene_script_versions
    │     └── Render segments ── video_variants (manifest)
    ├── Shots ── shot_prompt_versions (motion)
    │     └── Frames ── frame_prompt_versions (visual)
    │              └── frame_variants (kind: model | framing)
    ├── Characters ── character_sheet_variants  ↔ Talent library
    ├── Sequence locations ── location_sheet_variants ↔ Location library
    ├── Sequence elements (uploads + vision)
    ├── Music (prompt versions + music variants)
    ├── Sequence exports
    └── Sequence events (log-over-truth)
```

### Layers

| Layer                 | Role                            | Completeness                                                                            |
| --------------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| `src/lib/db/scoped/*` | Real CRUD on almost every table | **Nearly complete**                                                                     |
| `src/functions/*`     | Product server-fn surface       | **Patchy** — strong on gen/select/prompts; weak on structure + media inject             |
| UI (Scenes editor)    | What filmmakers touch           | **Strong** on prompts/gen; **weak** on structure CRUD, cast/location edit, media upload |
| Public API v1         | Create/poll/export only         | Out of scope                                                                            |

### Staleness model (do not reinvent)

- **No stored `stale` flag.** Derived: `stored inputHash` vs `recompute(now)`.
- Helpers: `src/lib/ai/input-hash.ts`, `src/lib/shots/shot-staleness.ts`
- Cascade plan: `update-stale-plan.ts` / `update-stale-depth.ts` → `UpdateStaleShotsWorkflow`
- Docs: `docs/architecture/prompt-staleness-dependency-graph.md`, `workflow-snapshots-and-content-hash-staleness.md`

### Generation DAG (happy path)

```
script+style+models
  → scene-split (scenes/shots/bibles)
  → talent/location matching
  → character/location/element sheets ∥ visual prompts
  → shot images
  → motion prompts + music prompt (after stills)
  → motion video + music track (optional)
  → export (separate)
```

---

## 3. Full entity inventory + CRUD gaps

Legend: **DB** = scoped layer · **SF** = server fn · **UI** = product UI  
✅ exists · ⚠️ partial · ❌ missing

### 3.1 Core structure

| Entity                   | Create                 | Read                       | Update                                 | Delete                     | Notes / gaps                                                                                                                 |
| ------------------------ | ---------------------- | -------------------------- | -------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Sequence**             | ✅ SF+UI+API           | ✅                         | ⚠️ SF (title/script/style…)            | ⚠️ archive SF only         | ❌ unarchive SF/UI · ❌ title edit UI · style/AR locked post-analysis (Generate Copy). **Soft-delete = archive** (already).  |
| **Scene**                | ⚠️ workflow/DB only    | ✅ SF+UI                   | ⚠️ script only (`updateSceneScriptFn`) | ⚠️ DB hard delete          | ❌ SF/UI create · ❌ reorder · ❌ **soft-delete + undo** · ❌ title/metadata edit SF · dialogue wiped to `[]` on script edit |
| **Scene script version** | ✅ via script edit     | ✅ internal                | append-only                            | n/a                        | Fine (history is undo)                                                                                                       |
| **Shot**                 | ✅ SF (`createShotFn`) | ✅                         | ✅ `updateShotFn` / duration           | ⚠️ **hard** `deleteShotFn` | **UI gap** + convert delete → **soft-delete + undiscard**                                                                    |
| **Frame**                | ⚠️ auto on shot create | ⚠️ via shot projection     | ⚠️ via gen/select                      | cascade hard               | Soft-delete with parent shot; ❌ multi-frame SF · ❌ manual still without gen                                                |
| **Render segment**       | ⚠️ motion pipeline     | ✅ `getSequenceSegmentsFn` | via video select                       | cascade                    | Re-tile on structure soft-delete/restore                                                                                     |

### 3.2 Authored inputs (prompts / script facets)

| Entity              | Create            | Read       | Update                        | Delete       | Gaps                                                                    |
| ------------------- | ----------------- | ---------- | ----------------------------- | ------------ | ----------------------------------------------------------------------- |
| **Visual prompt**   | AI / user-edit SF | ✅ history | ✅ save/restore/regen         | soft history | Solid                                                                   |
| **Motion prompt**   | AI / user-edit SF | ✅         | ✅                            | soft         | Dialogue/audio JSON only on AI path; free-text preserves prior dialogue |
| **Music prompt**    | AI / user         | ✅         | ⚠️ read-only after track done | soft         | Need edit-after-complete without full regen trap                        |
| **Sequence script** | create            | ✅         | full rewrite = storyboard     | n/a          | Structural edits deferred (#1037)                                       |

### 3.3 Generated outputs (media)

| Entity                     | Create        | Read        | Update/Select           | Delete       | Gaps                                                            |
| -------------------------- | ------------- | ----------- | ----------------------- | ------------ | --------------------------------------------------------------- |
| **Still (frame_variants)** | gen SF        | ✅ versions | select / set-from-model | soft discard | ❌ **user upload / replace still** · ❌ stamp `kind` for manual |
| **Video (video_variants)** | gen SF        | ✅          | select / set-from-model | soft         | ❌ **user upload / replace video**                              |
| **Music track**            | gen SF        | ✅          | set/promote             | soft         | ❌ manual audio file as score                                   |
| **Character sheet**        | gen / recast  | ✅          | promote/discard         | soft         | ❌ edit bible SF · ❌ manual sheet upload on sequence character |
| **Location reference**     | gen / recast  | ✅          | promote/discard         | soft         | ❌ edit bible SF · manual only via library                      |
| **Export**                 | browser + API | ✅          | n/a                     | ❌           | delete export optional                                          |

### 3.4 Cast / world

| Entity                         | Create            | Read | Update         | Delete            | Gaps                                                              |
| ------------------------------ | ----------------- | ---- | -------------- | ----------------- | ----------------------------------------------------------------- |
| **Sequence character**         | ⚠️ bible workflow | ✅   | ⚠️ recast only | ⚠️ DB hard        | ❌ SF/UI create · ❌ bible field edit · ❌ **soft-remove + undo** |
| **Sequence location**          | ⚠️ bible workflow | ✅   | ⚠️ recast only | ⚠️ DB hard        | ❌ SF/UI create · ❌ bible edit · ❌ **soft-remove + undo**       |
| **Sequence element**           | ✅ upload SF      | ✅   | rename/replace | ⚠️ hard delete SF | Prefer soft-hide + undo; post-analysis UI thinner than composer   |
| **Talent library**             | ✅ full           | ✅   | ✅             | ✅                | Good reference pattern                                            |
| **Location library**           | ✅ full           | ✅   | ✅             | ✅                | Good                                                              |
| **Styles**                     | ✅ SF             | ✅   | ✅ SF          | ✅ SF             | ❌ team authoring UI (lower priority)                             |
| **VFX / audio library tables** | ❌                | ❌   | ❌             | ❌                | Schema-only — **defer**                                           |

### 3.5 Recovery / orchestration (already strong)

| Action                                 | Status                |
| -------------------------------------- | --------------------- |
| Update all (depth cascade)             | ✅ UI + SF + workflow |
| Smart retry failed                     | ✅                    |
| Retry storyboard / regenerate sequence | ✅                    |
| Cancel pending prompt/image claims     | ✅                    |
| Per-shot gen image/motion/music        | ✅                    |
| Promote/discard divergent variants     | ✅                    |
| Cron reconcile stuck generating        | ✅                    |

---

## 4. DAG invalidation rules (product contract)

### 4.1 Principles

1. **Staleness is derived** — never write a `stale` column; stamp `inputHash` on produce; verify by recompute.
2. **Only downstream edges** — changing X re-stales Y only if Y's hash includes X (or a hard clear is documented).
3. **User intent can skip intermediate staleness** — when replacing prompt _and_ image in one operation, stamp both so the image is **fresh relative to the new prompt**.
4. **Never auto-mutate upstream** — editing a still must not rewrite the visual prompt (unless user opts into "sync prompt from …").
5. **Versions are append-only** — selection is a pointer; soft discard only.

### 4.2 Edge table (authoritative product rules)

| If user changes…                                      | Goes stale / invalidated                                                                              | Stays fresh                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Scene script extract                                  | Visual + motion **prompts** (scene surface in hash)                                                   | Character/location/element **sheets** (no script→bible edge today) |
| Scene location / timeOfDay / storyBeat                | Prompts (in scene input surface)                                                                      | Title (display label); sheets                                      |
| Character bible fields (name, physicalDescription, …) | Visual + motion prompts (projected fields); character sheet                                           | Unrelated characters' artifacts                                    |
| Character sheet image (regen/upload)                  | Still images using that sheet hash                                                                    | Prompts (unless bible text also changed)                           |
| Location bible / sheet                                | Same pattern as character                                                                             | —                                                                  |
| Element image replace                                 | Stills (ref hash); replace-element may edit stills                                                    | Prompts unless description changes                                 |
| Visual prompt only (user-edit)                        | **Image** (prompt TEXT in image hash)                                                                 | Video until image changes (then video)                             |
| Still only (regen or upload + select)                 | **Video** (hard clear to `pending` on promote — keep this); motion prompt (via startingFrameImageUrl) | Visual prompt                                                      |
| Motion prompt only                                    | **Video**                                                                                             | Still, visual prompt                                               |
| Duration only                                         | Video / segment                                                                                       | Prompts, stills                                                    |
| Style / aspect / analysis model                       | Prompts + sheets as per hash inputs                                                                   | —                                                                  |
| Image / video / music model                           | Artifacts of that modality                                                                            | Other modalities                                                   |
| Music prompt                                          | Music track                                                                                           | Shots                                                              |
| Soft-delete shot                                      | Exclude from lists/plan/export/theatre; keep frames/variants/hashes                                   | Other live shots                                                   |
| Soft-delete scene                                     | Soft-delete its shots too; re-tile segments over live only                                            | Unrelated sequences; rows retained for restore                     |

### 4.3 Prompt + image simultaneous replace (user's question)

Your instinct is right with one refinement:

| Operation                                                       | Correct behavior                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Prompt only**                                              | Append `user-edit` prompt version. Stamp prompt `inputHash` from **current** upstream context (existing `saveShotPromptFn` path). Image becomes **stale** (prompt text in image hash). Video unchanged until image moves.                                                 |
| **B. Image only**                                               | Append `frame_variants` version (`kind: 'model'` or new `kind: 'upload'`). Select it. Stamp `imageInputHash` from **current** visual prompt text + sheets. **Clear video** to pending. Motion prompt may go stale via starting frame URL. **Do not** touch visual prompt. |
| **C. Prompt + image together** (single transaction / single SF) | 1) Write prompt version first (stamp prompt hash). 2) Write image version whose `inputHash` is computed from the **new** prompt text (not the old). 3) Select both pointers. 4) Clear video. **Result:** prompt fresh, image **fresh** (not stale), video pending/stale.  |
| **D. Wrong order if separate calls**                            | Prompt save → image stale → if user only uploads image with hash based on _new_ prompt, image can be fresh. If image upload hashes against _old_ selected prompt because selection hasn't flipped yet, false stale/fresh. **→ Prefer one atomic SF for C.**               |

**Implementation rule for C:**  
`replaceFrameStillFn({ frameId, promptText?, image: File|URL, kind?, model? })`

- If `promptText` provided: write prompt + image in one `db.batch()`, both hashes from the post-write state.
- If not: image-only path B.

Same pattern for **motion prompt + video** upload if both provided.

### 4.4 Manual media `kind`

Extend (or map onto) existing discriminators rather than a free-form zoo:

| Surface                         | Proposed `kind` / `source`                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| Frame still upload              | **`frame_variants.kind: 'upload'`** (decided) alongside `model` \| `framing`                    |
| Video upload                    | `video_variants` + manifest of current prompt/frame pointers; model/kind = user-upload analogue |
| Prompt accompanying upload      | `source: 'user-edit'`                                                                           |
| Character/location sheet upload | reuse talent/location `source: 'manual_upload'`                                                 |

Staleness: user-upload versions should stamp `inputHash` from **current** inputs so later upstream changes correctly re-stale them. If product wants "this upload is sacred and never auto-stale," use `inputHash: null` → `untracked` (document explicitly; prefer stamp-for-tracking).

### 4.5 Gaps in today's graph (optional follow-ups, not blockers)

- No script → bible edge (script edit doesn't stale sheets)
- Neighbour scenes under-hashed for continuity
- Music track-level hash weaker than prompt
- Scene delete leaves `shots.sceneId` null — need explicit re-home/re-tile

---

## 5. What to implement (server-fn surface first)

Treat **server functions as the contract** (API/MCP later wraps them). Group by PR-sized phases.

### Phase 0 — Contract doc + matrix test skeleton

- Add `docs/architecture/manual-pipeline-crud.md` (or extend existing staleness doc) with §4 rules as the product contract.
- Add a **matrix unit test** (or table-driven suite) listing each mutation → expected artifact staleness transitions (prompt-only, image-only, both, duration, character bible, etc.). Start with pure hash/plan unit tests; no UI.

### Phase 1 — Structure CRUD (scenes + shots) SF + minimal UI

**Server:**

- `createSceneFn`, `updateSceneFn` (title, location, timeOfDay, storyBeat, continuity tags), `reorderScenesFn`
- **Soft-delete, not hard:** `softDeleteSceneFn` / `restoreSceneFn`, `softDeleteShotFn` / `restoreShotFn` (migrate existing hard `deleteShotFn` to soft, or leave hard as admin-only)
- Additive schema: `deletedAt` (nullable timestamp) on `scenes`, `shots` (and optionally `frames` if multi-frame) — **no table rebuilds**
- Default list/get queries filter `deletedAt IS NULL`; restore clears it and re-inserts into order (use event `data.prevOrderIndex`)
- Soft-deleting a scene **soft-deletes its shots** in the same batch (cascade soft); restore scene offers restore children
- Wire `createShotFn` / `reorderShotsFn` / `updateShotFn` + new soft-delete/restore into Scenes UI
- On structure change: re-tile render segments over **live** shots only; emit `sequence_events`; do **not** auto-regen

**UI:** left-rail add/reorder; delete → confirm → soft-delete + toast **Undo** (calls restore); scene title editable. Optional “Show deleted” later.

**Invalidation:** script/title/metadata edits → prompts stale only. Pure reorder → no hash change for **visual/motion prompts** (hash v5 dropped `sceneNumber`). Deliberate exception: the **music prompt** hashes scene summaries in narrative order, so a scene reorder correctly re-stales it — a score follows the arc. Soft-delete removes from plan/export without destroying hashes.

### Phase 2 — Cast & location bible CRUD SF + UI

- `createSequenceCharacterFn`, `updateSequenceCharacterFn` (bible fields)
- `softDeleteSequenceCharacterFn` / `restoreSequenceCharacterFn` (same for locations)
- Additive `deletedAt` on `characters` / `sequence_locations`
- Optional: create without sheet; **Generate sheet** button uses existing sheet workflows
- Editing projected bible fields → prompts stale; sheet hash stale → images stale after sheet regen
- Soft-remove: hide from cast facet; **do not** strip continuity tags (lossless undo); optional “missing cast” warning
- Wire character/location detail pages from view-only → form edit + Save
- Elements: soft-hide + undo preferred; ensure post-analysis Scenes facet has upload/rename/delete as composer

### Phase 3 — Manual media inject (stills + video + optional music)

**Critical new SFs:**

- `replaceFrameContentFn` — presign or multipart (reuse `/api/storage` + element/talent patterns) → R2 thumbnails → append `frame_variants` (`kind: 'upload'`) → select → clear video (image-only when `promptText` is omitted)
- `uploadShotVideoFn` — R2 videos → append `video_variants` with manifest snapshot of current prompt/frame pointers → select
- Optional: `uploadSequenceMusicFn` for user score
- **`replaceFrameContentFn`** (atomic prompt+image) implementing §4.3 C

**UI:** drop zone / "Replace image" / "Replace video" on canvas + inspector; optional "Update prompt to match" checkbox.

**Staleness tests:** B and C from §4.3.

### Phase 4 — Sequence meta + recovery polish

- Title edit UI; archive/unarchive UI
- Music prompt editable after track exists (save → track stale; don't force regen)
- "Continue" affordances when status failed/partial: ensure every failed leaf has Generate + Update all (mostly exists)
- Character/location sheet manual upload on sequence entities (mirror library `manual_upload`)
- Cancel in-flight video claim if missing parity with image cancel

### Phase 5 — Frame multi-keyframe (if needed for model support)

- Create/delete non-anchor frames (`role: last | key`); orderIndex
- Only if product needs last-frame i2v soon; otherwise defer

### Phase 6 — Hardening (not API)

- Event emission on all new mutations (`sequence_events`)
- Realtime invalidation for new entity types
- E2E: manual edit path that never runs storyboard (create sequence draft → add scene/shot → upload image → upload video → export)
- Keep public API out; document SF inventory as future API map

---

## 6. Implementation patterns to reuse (do not reinvent)

| Need                          | Existing pattern                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| Team-scoped auth              | `authWithTeam` / shot-access middleware                                             |
| Append-only versions + select | `frameVariants.select`, `videoVariants.select`, prompt `write`                      |
| Soft-hide versions            | `discardedAt` + promote/discard/undiscard Fns (sheets, music, frame/video variants) |
| Soft-archive sequence         | `archiveSequenceFn` — extend with unarchive                                         |
| User prompt edit + hash       | `saveShotPromptFn` in `prompt-variants.ts`                                          |
| Image promote clears video    | `setImageFromVariantFn`                                                             |
| Presign upload                | talent / elements / location library                                                |
| Cascade regen                 | `updateStaleShotsFn` depths                                                         |
| Activity log for undo context | `sequence_events` (`data.prevPointer` / prev order)                                 |
| Failure recovery              | `smartRetryFn`, reconcile cron                                                      |
| Scoped DB writes              | `src/lib/db/scoped/*` — prefer extending SF over new services                       |

---

## 7. Priority order (decided)

1. **Phase 3 — media inject** + §4.3 atomic replace — **FIRST**
2. **Phase 2 — cast/location** edit + soft-remove
3. **Phase 1 — structure** soft-delete/reorder/create
4. **Phase 4** polish
5. **Phase 0 tests** land _with_ each phase

PR stack: **3 → 2 → 1 → 4** (tests in each PR).

---

## 8. Risk notes

- **Storyboard hard-deletes all shots** on full regen — separate from soft-delete product path; must confirm destructive wipe. Long-term: storyboard could soft-clear instead (out of scope unless touched).
- **Existing hard `deleteShotFn`** — callers/tests must migrate to soft-delete; do not leave two conflicting semantics without docs.
- **List filters** — every sequence-scoped read (staleness batch, export, theatre, public status doc) must exclude `deletedAt` rows or soft-deleted work “ghosts” into plans.
- **Dialogue: `[]` on scene script edit** — fix when touching `updateSceneScriptFn` (preserve or re-extract).
- **Shared ULID shot/anchor frame** — multi-frame create must use fresh ULIDs for non-anchor frames.
- **D1 FK cascade traps** — no table rebuilds; additive `deletedAt` columns only; never rely on `ON DELETE CASCADE` for product delete.
- **Hash stamp consistency** — upload path must use same `computeFrameImageInputHash` inputs as image workflow or false staleness appears.
- **R2 orphans** — soft-delete leaves objects; optional GC later; do not delete blobs on soft-delete.

---

## 9. Loop prompt (for implementation agents)

Use this as the standing instruction when implementing any phase:

```
You are implementing Manual Pipeline Driveability for OpenStory.

Contract (do not violate):
1. Server functions in src/functions/ are the product API. Extend scoped DB in
   src/lib/db/scoped/ when needed. Do NOT build public API/MCP.
2. Staleness is derived via input hashes (src/lib/ai/input-hash.ts) — never a
   stored stale flag. Only downstream artifacts may become stale.
3. Versions are append-only; selection is a pointer; soft discard only.
4. Product "delete" is SOFT (deletedAt / discardedAt / archived). Always ship a
   restore/undiscard/unarchive path. Toast Undo within ~60s is the minimum UX.
   Hard delete is not the product Delete button (admin/GC only).
5. Soft-deleted rows are excluded from default lists, staleness plans, export,
   and theatre. Restoring may correctly show stale if upstream moved.
6. Simultaneous prompt+image replace MUST be one atomic SF that stamps the
   image hash from the NEW prompt text so the image is not marked stale.
7. Image-only replace must clear shot video to pending (match setImageFromVariantFn).
8. Prompt-only replace must leave image URL intact and mark image stale.
9. Never auto-mutate upstream artifacts.
10. Emit sequence_events for structure and media mutations (include prevState
    for undo).
11. Follow CLAUDE.md: ULID ids, no hand-written migrations, TanStack Query
   suspense, shadcn + layout-only Tailwind, bun run test / typecheck / lint.

Before coding a phase:
- Read docs/architecture/prompt-staleness-dependency-graph.md
- Read existing Fns that you will mirror (saveShotPromptFn, setImageFromVariantFn,
  element/talent upload, createShotFn)
- List exact files you will touch

For each mutation you add, write/extend a unit test that asserts:
- which inputHashes change
- which statuses are cleared (e.g. video → pending)
- which entities are untouched

After implementation:
- bun typecheck
- bun run test <touched tests>
- Summarize CRUD matrix delta (before → after) for the entities you touched
```

### Per-phase loop prompts (short)

**Phase 3 media:**  
"Implement upload/replace still and video SFs + atomic replaceFrameContentFn + canvas UI drop zones. Tests for image-only and prompt+image together. Reuse storage presign patterns."

**Phase 2 cast/location:**  
"Expose create/update + soft-delete/restore for sequence characters and locations; editable detail pages; bible field changes only stale prompts/sheets per input-hash projection; lossless undo (don't strip continuity tags)."

**Phase 1 structure:**  
"Wire create/reorder shots (and scenes) SF+UI; soft-delete + restore (deletedAt) with toast Undo; cascade soft-delete scene→shots; re-tile segments over live rows only; no auto regen; no product hard delete."

---

## 10. Suggested success criteria

A filmmaker (or future agent via SF) can, **without** running storyboard:

1. Create or open a sequence
2. Add a scene and shot
3. Write script + visual/motion prompts
4. Upload a still (optionally with a new prompt in one op) and see image **fresh**, video **pending**
5. Upload or generate video
6. Add/edit cast and location text; see only expected stale dots
7. Use Update all to regenerate only stale downstream work
8. After a failed gen, retry or replace that artifact manually and continue
9. Soft-delete a shot/scene/cast member and **Undo** within the toast window (or restore later) without losing media/history

---

## 11. Decisions (locked)

| #   | Decision              | Choice                                                                             |
| --- | --------------------- | ---------------------------------------------------------------------------------- |
| 1   | Scene/shot delete     | Soft-delete + restore; scene cascades soft-delete to shots; no product hard delete |
| 2   | Upload kind           | **`frame_variants.kind = 'upload'`**                                               |
| 3   | Script → bible/sheets | **No** — keep today (script only stales prompts)                                   |
| 4   | Multi-frame last/key  | **Defer** (Phase 5 optional later)                                                 |
| 5   | Phase order           | **Media first** (Phase 3 → 2 → 1 → 4)                                              |
| 6   | Undo UX               | **Toast Undo only** (~60s); no Show-deleted list this effort                       |

**Ready to implement** starting Phase 3 (media inject).
