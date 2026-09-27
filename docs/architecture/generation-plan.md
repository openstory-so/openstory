# Generation plan (#1816)

What a sequence still owes, per entity, as a function of **live D1 only**.
One answer for the scene-list footer, `continueGenerationFn` and the
storyboard trigger, so nothing can drift from it the way `pipelineStage` /
`generationCheckpoint` did (a cache with one writer and ~80 edits that never
moved it).

- Pure half (units, requires graph, cascade): `src/sequences/generation-plan.ts`.
- Loader (rows + verdicts, one read per table): `src/sequences/server/generation-plan.ts`.
- Wire: `getGenerationPlanFn` (`src/sequences/generation-plan.fn.ts`).

## Units

`{ kind, id, state, blockedBy? }`. Kinds, with the stop that caps them
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
`stale` (a sheet in the plan puts its stills in the plan, as Update all's
`cascadeFlags` does per shot); an upstream `running` / `blocked` turns a unit
with work `blocked`. A `done` unit keeps its artifact.

## Readers

- **Footer + continue (#1817).** `getGenerationPlanFn` (optionally with
  `generateStartFrames` / `generateVoices` overrides: the plan as if the
  footer's switches were saved) feeds the scene-list footer;
  `continueFromPlan` (`src/sequences/server/continue-plan.ts`) is the
  continue guard; `estimatePlanCost` prices both the quote and the
  reservation. `switchLocks` says which switch can no longer turn off. See
  `stop-at-stages.md` § Continue.
- **The run (#1818).** `continueGenerationFn` freezes the work as an
  Update-all plan (`computePlan({ units })` in
  `src/shots/server/update-stale-plan.ts`: flags from the units, first
  artifacts included; `buildPlanReferences` for the sheets, element
  references and voices) and the storyboard runs it through
  `UpdateStaleShotsWorkflow`. Multi-shot shots that owe a prompt get the
  per-shot LLM prompt, as Update all does — the shot-list specs the fresh
  run derives from are not stored.

## Status

Phase 3 of 4. #1819 deletes the stage + checkpoint and makes Update all the
plan filtered to `stale`.

Not done: `musicDesign` is still not persisted, so the plan cannot tell a
score whose design is "no music" from one never made; the `music` unit is
owed whenever there are shots.
