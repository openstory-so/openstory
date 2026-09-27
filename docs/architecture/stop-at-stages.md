# Stop-at stages and continue (#1408)

Generate asks how far to run. **One ordered list**, `GENERATION_STAGES` in
`src/sequences/pipeline.ts` (script → references → images → dialogue →
motion → music), drives the Generate-dialog slider, the progress banner and the
scene-list continue button. Casting is part of `script` (it emits the Script
phase number); there is no separate stage.

- **`stopAt` is the only word on how far a run goes.** It is chosen per click,
  snapshotted onto `sequences.generationStopAt`, and REQUIRED on the storyboard
  / analyze-script payloads (the launcher resolves it via `resolveStopAt`). The
  legacy `autoGenerateMotion` / `autoGenerateMusic` columns are DERIVED from it
  (`flagsFromStopAt`) and kept only for old readers — never set them on their
  own, and never gate a phase on them inside a workflow.
- **No checkpoint (#1818).** A run persists no stage: `stageComplete` only
  emits the banner's `generation.phase:complete`. What is left to do is the
  generation plan, derived from live D1 (`docs/architecture/generation-plan.md`).
  (`pipelineStage` / `generationCheckpoint` columns are dropped in #1819.)
- **Continue** (`continueGenerationFn`, #1817) reads the generation plan
  (`docs/architecture/generation-plan.md`), never the checkpoint stage. It
  takes `{ stopAt, generateStartFrames, generateVoices, draftMotion }` — no
  `startFrom` — recomputes the plan under the requested switches, and runs
  the `missing | stale` units up to `stopAt`; it refuses only when that set is
  empty (`Nothing to generate up to …`). Turning Start frames or Voices ON is
  allowed at any step (it adds `still` / `dialogue` units); turning one OFF
  after its units exist is refused with the reason. The reservation and the
  footer quote are the same number: `estimatePlanCost` over the unit counts.
  The storyboard then runs exactly those units: it spawns
  `UpdateStaleShotsWorkflow` with the plan frozen at the click
  (`computePlan({ units })` — every input read from D1 then), a references
  wave first (sheets, element references, voices), then the per-shot jobs and
  music, first ones included. A reference that fails holds the stills and
  clips made from it. Credits are a balance check (`requireCredits`), not a
  hold: the per-shot children preflight their own spend. Script stays a
  fresh, whole analyze-script run.
- **The footer** reads `getGenerationPlanFn` (one query, 10s stale time,
  refetch on focus, invalidated by realtime and by any refused continue). The
  first stop with work picks the footer; the continue slider locks the stops
  before it (done) and the button says `Generate 2 references, 12 prompts,
12 images`, with a line per blocked noun (`3 images blocked: waiting on
Maya reference`). The switches show at every step; one whose units exist
  is locked on.
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
- Reference-only has no Images stop.
- Scenes and shots added, edited or deleted during a stop reach the continue:
  every unit is materialised per shot from D1 at the click (#1818).
- **Failed character sheets (#1727).** A miss does not fail the sequence.
  Analyze-script returns after References without persisting that stage.
  The plan reads the sheet as `missing`, so the footer offers it again
  (`Generate 1 reference, …`) and the continue guard accepts it.
- **Generation plan (#1816).** The stage and checkpoint above are being
  replaced by one plan derived from live D1 (units, missing / stale /
  blocked / running, a requires graph) — `docs/architecture/generation-plan.md`.
