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
- **Checkpoint.** After each completed stage the workflow writes
  `sequences.pipelineStage` + `sequences.generationCheckpoint`
  (`persistProgress`). The checkpoint carries the in-memory DAG state the next
  stage needs (bibles, matches, sheet rows, prompts) so a continue never
  re-reads mutable D1 mid-run. A fresh (non-resume) storyboard run nulls both
  alongside its shot wipe.
- **Continue** (`continueGenerationFn`) only starts from `references`,
  `images`, or `dialogue` (`ContinueStage`); Script is a fresh run, motion/music
  have batch footers. It validates `startFrom ≤ stopAt` and that the checkpoint reaches
  `startFrom` BEFORE reserving credits, reserves only the slice
  (`estimateStoryboardPreflightCost({ startFrom, stopAt, referenceOnly })`),
  and triggers storyboard with `resume: true` (no shot wipe, no poster). At
  the trigger, `refreshCheckpointFromCast` re-snapshots the bibles, matches AND
  sheet rows from D1 so edits made while stopped (recast, regenerated sheet)
  survive — the checkpoint's LLM values would otherwise silently revert them.
  A Dialogue or Motion continue also snapshots selected stills and
  motion/music prompts at the trigger and skips the Images stage. The scenes
  slider offers the same start-frames and Voices switches as the initial
  Generate dialog, but only for stages that have not run yet (#1698): start
  frames before Images, Voices before Dialogue. Confirming Continue persists
  those flags with
  `generationStopAt`. After a stage completes, continue starts at the next
  unrun stage (`pipelineStage` is a floor even when shot rows lag) and
  refuses to re-run a completed continue stage. Start frames + Voices share
  one start-frames-and-dialogue slider stop (the two ticks do not fit); the run
  still executes both stages, like Motion & Music.
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
- Reference-only has no Images stop; `pipelineStage` is the only evidence of
  References there (`artifactsFromSequenceState({ referenceOnly })`).
- Known gap: scenes added/edited during a stop are NOT re-snapshotted (the
  full `Scene` lives in `frame.metadata`); the staleness tooling covers them
  after the fact.
- **Failed character sheets (#1727).** A miss does not fail the sequence.
  Analyze-script returns after References without persisting that stage, so
  `pipelineStage` stays `script` (Casting). Continue offers References again;
  the footer shows remaining / total (`Generate 1 / 3 references`). Visual
  prompts that already landed do not count as References-complete while any
  on-screen sheet is still missing.
