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
- A stop the continue slider does not offer is the next tick it does
  (`sliderCommittedStop`). Reference-only has no Images tick, and the music
  prompt's stop is Images, so that thumb is Motion & Music — the quote and
  the click run through music, including missing clips. Stale units stay in
  the work and regenerate.
- **Script is a fresh, whole run** (`AnalyzeScriptWorkflow`). It persists no
  stage: `stageComplete` only emits the banner's `generation.phase:complete`.
  Analysis ends after scene split, matching, persisted bibles and initial
  derived multi-shot prompts. All subsequent work runs through the plan
  executor; failed references hold only their dependent renders.

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
   (`PlanTarget.referenceIds`) and fails nothing else. A shot that owes a
   prompt follows the spec rule below: Rebuild when its spec is current,
   Rewrite shot when it is stale or missing.

Scenes and shots edited, added or deleted during a stop reach the continue:
every unit is materialised per shot from D1 at the click.

## Shot specs and prompts (#1923, #1929)

A shot's still and motion prompts are built from its selected spec. The plan
has a `spec` unit per shot, and both prompt units require it unless the prompt
is written (`user-edit`). One rule decides what a prompt costs, and a fresh
run, Continue, Update all and the inspector all apply it:

- **Spec current, prompt stale: Rebuild.** The prompt digest includes the
  spec's content, so editing the spec, or anything else the prompt reads,
  makes the derived prompt stale. Rebuild re-derives it. No LLM, no cost.
- **Spec stale or missing: Rewrite shot.** A spec is stale when what it was
  written from moved: the shot's script slice, its lines, or the scene's
  cast / continuity tags (`shot-spec-currency.ts`). Missing means the shot
  predates specs. One LLM call refills the spec, then its prompts rebuild.
  Every pre-spec shot owes one rewrite on its first Continue or Update all.
- **A written prompt is never replaced without the user.** It reads fresh
  and the plan leaves it. In the inspector, saving a spec or clicking
  Rebuild / Rewrite shot asks whether to replace written text or keep it.
- **A user's spec edit is current.** Saving stamps it with the live currency
  hash, so it never turns into a paid rewrite on its own. Saving a stale spec
  unchanged says it still fits and stamps it current too.

Cost quotes count only the rewrites: a rebuild is free.

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

- **The steps show at every step (#1780 §1)** until every unit is done — a
  finished sequence hides them: one sticky footer, the slider first, then the Motion / Music / Drafts
  controls of whichever step the sequence is at (their own buttons — batch
  motion, Generate Music, Render finals — are unchanged). Stops before the
  first with work are locked (done).
- **SFX & dialogue is always on for a batch.** Only a single shot's editor can
  turn it off.
- **The continue button** (`Generate`, or `Regenerate` when every unit it owes
  exists and is only stale — `planWorkLabel`; under it `2 references, 12
prompts, 12 images`, `planWorkLine` — a Generate that also redoes stale
  work names it apart, `8 videos, 1 music track · redo 15 prompts, 8 images` —
  and a line per blocked noun,
  `blockedLines`) shows when the
  plan's first work is before Motion.
- **A switch shows only when it changes a step the run takes.** Voices from
  References (voices ride that step), Start frames from Images, Draft first
  from Motion, Music at the Music stop. Turning on one that was skipped caps
  the thumb at its step (Images / Dialogue; `switchStopAt`, shared by the
  footer and the server, so the label, the quote and the run agree) only when
  a later unit is already done or stale. Nothing past that step yet — no clip,
  no track — and the thumb can still run on to Motion. The cap is derived,
  never written: turning the switch off again frees the thumb to where it was. Voices is locked on once a shot has a recording
  (`switchLocks`; a `blocked` unit does not count as existing): the recording
  would still ride the clip. Start frames can always turn off — the stills
  stay, shots render from references, and their motion prompts go stale. Draft
  first is changeable until every clip exists, then shown read-only. With
  the switches flipped the footer asks the plan as if they were saved
  (`getGenerationPlanFn` overrides) and the continue waits for that plan.
- **Music is `sequences.includeMusic`** — the same setting as the Music
  panel's "Include music in playback & export". Off, the plan owes no music
  prompt or track and a fresh run to Music makes none; on, both do, whatever
  the scenes' music presence says. It saves on toggle.
- **Going back never redoes finished work (#1780 §3).** `continueFromPlan`
  caps the stop at the step of a switch turned on (`switchStopAt`: Voices →
  Dialogue, Start frames → Images, the later when both) when a later unit is
  already done or stale. A missing clip stays in the run. Clips rendered from
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

## Shared motion requests (#1888)

Fresh generation, the shot and batch motion actions, and the plan executor
use `buildMotionRender` in `src/motion/server/build-motion-render.ts`. Its
sources require a scene header and carry the selected prompt, resolved shot
dialogue, still and reference snapshots. It tiles siblings into render
segments and assembles the same header, shot bodies and model guards for
all callers. Multiple stale members of a packed segment produce one job.
Server actions gather these sources from scoped D1; the executor uses its
frozen plan and the results named by its claims. The plan includes every
member of a selected segment, even when only one member was requested, while
preserving the other members' existing prompts and stills. `renderRefs` freezes
the reference rows at the click; successful reference children replace only
the rows this run generated. A missing or failed member holds the whole
selected segment.

An edited prompt links its character, element and location tags when it is
saved, before capturing its upstream hash. The standalone Save and a typed
motion render share `saveShotPrompt`; rendering an existing version does not
rewrite scene continuity. This also ensures a voiced render snapshots the
new selected prompt text before recording and assembling dialogue.

Reference builders order characters by their logical `characterId`, locations
by `locationId`, and elements by `token` before assigning image numbers. This
keeps fresh, continued and manual requests consistent regardless of database
row order. Each role retains its existing priority, including the primary image;
labels and URLs are assembled from the same ordered references.

## Executor parity for a fresh handoff (#1891)

`computePlan` accepts optional `renderOptions` with the fresh run's
`imageModels`, `videoModels` and `audioModels`. Those choices are frozen with
its units; absent choices retain continue and Update all's single-model
behavior. Each model gets its own durable child id. The first image/video
model owns promotion, while alternatives stay selectable history; the first
music model is primary. A leftover Grok shot remains a single Grok job even
when the fresh run requests several video models. Draft motion remains on
the payload and draft-capable models preflight at 480p.

The executor's `freshRun` flag orders and completes every phase with work:
references, images/prompts, dialogue, motion, music. Existing continue and
Update all retain their parallel schedule. Update all rebuilds a prompt from the selected spec when that spec is current. It spawns Rewrite shot when the spec is stale or missing. A user-edited prompt is left as written.

All spending children inherit the parent's `reservationId`. A preflight can
spend the remaining own envelope plus unheld balance, excluding other runs'
holds. This is checked in one billing read: a missing or exhausted envelope
never bypasses the balance check. The references wave gates the combined
sheet and voice liability immediately before its fan-out (a fal key covers
only sheets); another per-child gate would repeat that same check without
reserving anything further.

Music prompt and track flags come only from the chosen units. A completed,
non-stale track is `done` and is not remade just because the stop is Music.
Track-only regeneration uses the prompt and tags frozen on `MusicPlan`;
a prompt child replaces them with its own returned text.

## Fresh analysis handoff (#1892)

After analysis materializes scenes, shots, cast and first derived prompts,
Storyboard freezes the same plan a Continue click uses and spawns the same
`spawn-continue` executor. Its one `freeze-generation-plan` checkpoint uses
`generationPlanning`: a narrowly pinned hatch for reading the rows this run
just created. The loader ignores this parent run's processing banner, while
retaining actual artifact claims. Frozen stop-at, switches and model choices
remain authoritative. The reservation grows from this materialized plan before
rendering. Missing first character sheets reuse a compatible matched talent
sheet, with zero generation cost; explicit regeneration still renders the edit.
Voice-only cast never owes a sheet.

Analysis persists each shot's spec as its first `shot_spec_versions` row
(#1915), and the visual and motion directions derived from it as ordinary
first prompt versions that record its `specVersionId`. Every shot takes this
path, one-shot scenes included (#1919): a fresh run makes no per-shot prompt
LLM call. Motion source
`derived` hashes the inputs derivation consumed, excluding a starting still;
the first still therefore does not invalidate it or add a still prerequisite.
Scene and style changes still invalidate it. A current motion digest does not include the still URL, so rendering the first still does not stale the motion prompt. Restore copies the source and spec of the row being restored. An element rename writes `renamed` on the prompt and `rename` on a new spec version. A content-checker rescue writes `softened` or `shortened`. A user edit uses the ordinary current-input provenance and Update all does not overwrite it.

Planning and prompt staleness load every active character/location bible, even
before its first sheet exists. The selected sheet fields on these rows remain
optional. Filtering these inputs to completed sheets changes a derived prompt's
hash during the fresh handoff and loses the reference IDs needed to attach the
executor's newly generated sheets. Sheet-only readers keep their narrower APIs;
prompt contexts and frozen plan reference membership use the complete bible.

Fresh analysis can persist scenes before the browser subscribes to creation
events. Terminal generation events therefore reconcile the scene list and
composed script as well as shots and generated media, so the scene rail recovers
without a reload even when those early events were missed.

A fresh run also starts a framing grid after each successful still/model, using
the completed still and its frozen prompt/reference inputs. These replay-deduplicated
grids remain independent enrichment workflows: they can finish after the parent
and retain their own idempotent debit, outside its reservation envelope. Cancelled
or empty still results never start a grid; Continue and Update retain their existing behavior.
