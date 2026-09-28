# Generation plan (#1816)

What a sequence still owes, per entity, as a function of **live D1 only**.
One answer for the scene-list footer, `continueGenerationFn`, the storyboard
run and Update all. There is no stored stage and no checkpoint: the old
`pipelineStage` / `generationCheckpoint` pair was a cache with one writer and
~80 edits that never moved it, and every mismatch was a refused click. The
columns are gone (#1819).

- Pure half (units, requires graph, cascade, Update all's filter, footer
  copy): `src/sequences/generation-plan.ts`.
- Loader (rows + verdicts, one read per table): `src/sequences/server/generation-plan.ts`.
- Wire: `getGenerationPlanFn` (`src/sequences/generation-plan.fn.ts`).

## Stops: how far a run goes

Generate asks how far to run. **One ordered list**, `GENERATION_STAGES` in
`src/sequences/pipeline.ts` (script → references → images → dialogue →
motion → music), drives the Generate-dialog slider, the progress banner and
the continue slider. Casting is part of `script`.

- **`stopAt` is the only word on how far a run goes.** It is chosen per click,
  snapshotted onto `sequences.generationStopAt`, and REQUIRED on the
  storyboard / analyze-script payloads (the launcher resolves it via
  `resolveStopAt`). The legacy `autoGenerateMotion` / `autoGenerateMusic`
  columns are DERIVED from it (`flagsFromStopAt`) and kept only for old
  readers — never set them on their own, and never gate a phase on them.
- Each unit kind has a stop (`PLAN_KIND_STAGE`, below); `stopAt` caps the
  kinds a run makes. Where a run starts is not a choice: it is wherever the
  plan has work.
- **Script is a fresh, whole run** (`AnalyzeScriptWorkflow`). It persists no
  stage: `stageComplete` only emits the banner's `generation.phase:complete`.
  A run whose character sheets failed returns after References (#1727); the
  plan then reads those sheets `missing`.

## Units

`{ kind, id, state, requires, cascaded, blockedBy? }`. Kinds, with the stop that caps them
(`PLAN_KIND_STAGE`):

| kind                                | id        | stop       |
| ----------------------------------- | --------- | ---------- |
| `sheet:character`, `sheet:location` | entity id | references |
| `ref:element`                       | element   | references |
| `voice`                             | character | references |
| `prompt:visual`                     | shot      | references |
| `still`, `prompt:motion`            | shot      | images     |
| `prompt:music`                      | sequence  | images     |
| `dialogue`                          | shot      | dialogue   |
| `clip`                              | shot      | motion     |
| `music`                             | sequence  | music      |

Script is not a unit: it is the root that creates the structure. No shots → an
empty plan. A reference-only shot (`usesStartFrame` false) has no
`prompt:visual` or `still`. A voice-only character has no sheet. `voice` and
`dialogue` exist only for speakers that `usesVoice()`; a shot that already
holds a recording keeps its `dialogue` unit either way.

## States

- `missing` — no artifact. New: today's `untracked` collapses this into "do
  nothing".
- `stale` — the existing verdicts, verbatim: `computeShotStaleness`,
  `readReferenceStaleness`, `readMusicPromptStaleness`, the media verdicts
  (`loadShotMediaStates`). Element refs have no verdict: an image is done.
- `running` — a claim or status column: pending prompt/image claims,
  `shot_dialogue_claims` (live, not demoted), `sheetStatus` /
  `referenceStatus`, `pendingPromote*`, a generating `video_variants` row,
  `musicStatus`. While the storyboard run holds the sequence
  (`status === 'processing'`), every unit with work up to its stop reads
  `running`.
- `blocked` — an upstream is `running` elsewhere or `blocked` itself, or the
  verdict could not be computed (`blockedBy: []`, never read as fresh).
- `done`.

## Requires graph

Generation preconditions (`SHOT_UNITS`, plus `music` ← `prompt:music`), not the invalidation edges in
`src/ui/docs/dependency-graph.ts`:

- `still` ← its `prompt:visual` + the sheets / element refs it references
  (`resolveSceneShotImageReferences`, the same matcher the still's hash uses).
- `prompt:motion` ← `still` (start-frame shots).
- `clip` ← `prompt:motion` + `still` (start frame) or the referenced sheets
  (reference-only) + `dialogue` when the shot has one.
- `dialogue` ← a `voice` on every speaker.
- `music` ← `prompt:music`.

Cascade, in kind order: an upstream `missing` / `stale` turns a `done` unit
`stale` with `cascaded: true` (a sheet in the plan puts its stills in the
plan); an upstream `running` / `blocked` turns a unit with work `blocked`. A
`done` unit keeps its artifact. `requires` is the graph resolved to the
plan's own units.

## What a continue does

`continueGenerationFn` (#1817, #1818) takes `{ stopAt, generateStartFrames,
generateVoices, draftMotion }` — no `startFrom`.

1. It recomputes the plan under the requested switches and runs its
   `missing | stale` units up to `stopAt` (`continueFromPlan`), refusing only
   when that set is empty (`Nothing to generate up to …`). Turning Start
   frames or Voices ON is allowed at any step — it only adds `still` /
   `dialogue` units; turning one OFF after its units exist is refused with
   the reason (`switchLocks`).
2. The quote and the credit check are the same number: `estimatePlanCost`
   over the unit counts. It is a balance check (`requireCredits`), not a
   hold: the run's per-shot children preflight their own spend.
3. The switches save, then the work is frozen as an executor plan
   (`computePlan({ units })` in `src/shots/server/update-stale-plan.ts`:
   flags from the units, first artifacts included, every input read from D1
   now; `buildPlanReferences` for the sheet / element / voice payloads). A
   refused trigger puts the switches back.
4. The storyboard run (mutex, processing status, banner) spawns
   `UpdateStaleShotsWorkflow` with that plan instead of analyze-script: a
   references wave first (sheets, element references, voices — each claimed
   in the run), then the per-shot jobs (prompts, stills, dialogue, clips)
   and music. A reference that fails holds the stills and clips made from it
   (`PlanTarget.referenceIds`) and fails nothing else. Multi-shot shots that
   owe a prompt get the per-shot LLM prompt: the shot-list specs a fresh run
   derives from are not stored.

Scenes and shots edited, added or deleted during a stop reach the continue:
every unit is materialised per shot from D1 at the click.

## What Update all does

Update all is the plan filtered to `stale` (`updateAllUnits`, #1819) up to
the depth picked (`update-stale-depth.ts`), through the same executor. A
unit stale only by the cascade comes along only with the upstream it
cascades from. Sheets and element references are in Update all at
`images`; a shot with voiced lines, every speaker voiced and no reading yet
records its first one at `dialogue` (#1780 §6). A scoped run (scene / shot)
takes along the sheets its shots are made from; music stays sequence-wide.
It never makes a first sheet, still or clip — that is a continue. A shot the
plan could not check is reported as `staleness-unknown`.

## What the footer shows

The scene list reads `getGenerationPlanFn` (one query, 10s stale time,
refetch on focus, invalidated by realtime and by any refused continue —
`refetchAfterRefusedContinue`).

- **The steps show at every step (#1780 §1)**, a finished sequence included:
  one sticky footer, the slider first, then the Motion / Music / Drafts
  controls of whichever step the sequence is at (their own buttons — batch
  motion, Generate Music, Render finals — are unchanged). Stops before the
  first with work are locked (done); with no work left every stop is done.
- **The continue button** (`Generate 2 references, 12 prompts, 12 images`,
  `planWorkLabel`, with a line per blocked noun, `blockedLines`) shows when the
  plan's first work is before Motion.
- **A switch shows only when it changes a step the run takes.** Voices from
  References (voices ride that step), Start frames from Images, Draft first
  from Motion, Music at the Music stop. Turning on one that was skipped caps
  the thumb at its step (Images / Dialogue; `switchStopAt`, shared by the
  footer and the server, so the label, the quote and the run agree) and the
  plan grows its units. The cap is derived, never written: turning the switch
  off again frees the thumb to where it was. One whose units exist is locked
  on (`switchLocks`; a `blocked` unit does not count as existing). Draft
  first is changeable until every clip exists, then shown read-only. With
  the switches flipped the footer asks the plan as if they were saved
  (`getGenerationPlanFn` overrides) and the continue waits for that plan.
- **Music is `sequences.includeMusic`** — the same setting as the Music
  panel's "Include music in playback & export". Off, the plan owes no music
  prompt or track and a fresh run to Music makes none; on, both do, whatever
  the scenes' music presence says. It saves on toggle.
- **Going back never redoes finished work (#1780 §3).** `continueFromPlan`
  caps the stop at the step of a switch turned on (`switchStopAt`: Voices →
  Dialogue, Start frames → Images, the later when both). Clips rendered from
  the old inputs then read stale, and Update all re-renders them with each
  cost shown.
- **Lines from the Video tab (#1780 §7).** `MotionDialoguePanel` shows the
  Dialogue section, with the line editor, on every shot — a shot with no
  lines included.

## Draft first and the ready email

- **Draft first (#1756).** `sequences.draftMotion` is not a stage: with it on,
  the `music` stop renders 480p Ark drafts (music rides along) and the slider
  labels that tick **Drafts** and appends a greyed **Finals** tick the thumb
  cannot reach (`GenerationStopSlider`, six ticks alternate above and below
  the track). A run never renders finals on its own — that would pay for the
  draft and the final with no look in between — so Finals is the scene-list
  footer (`Render N finals` → `renderSequenceDraftsAtQualityFn`, one
  `/motion` run per selected draft segment), which also shows the soonest
  expiry and the expired count. The switch lives under the slider (Generate
  dialog and the continue footer, which persists it through
  `continueGenerationFn`) and a checkbox on the batch footer; it is offered
  only while a chosen model `supportsDraftMode` and
  `useViaAvailability().byteplus` says this team reaches Ark (a team on its
  own fal key does not, and a draft submit there refuses — so every surface
  sends a boolean, never `undefined`, or a hidden switch would inherit the
  saved setting). Draft first pins the resolution picker in the Generate
  dialog to 1080p (`DRAFT_FINAL_RESOLUTION`: the only size Ark renders a
  final at); the batch checkbox and the continue footer leave the stored tier
  alone, and a final is 1080p whatever the tier says. It prices the run's
  motion at 480p per draft-capable shot (`draftMotion` on
  `estimateStoryboardPreflightCost` / `estimateStoryboardCost`, `draft` on
  `estimateBatchMotionCost`). Every
  surface that shows a draft clip says so with `draftBadgeLabel` /
  `shotDraftLabel` / `theatreDraftLabel` (`src/motion/draft-mode.ts`): "Draft"
  until three days remain, then the countdown, then "Draft expired".
- **Ready email** only sends when the run reached motion: the send is a
  one-shot claim per sequence.

## Freshness

The plan refetches when an image, clip or track finishes or fails, a shot
or scene lands, a stale verdict arrives, a sheet or voice moves, a phase
starts or a run ends. The continue quote is keyed on the units the footer
offers, so it moves with the plan.
