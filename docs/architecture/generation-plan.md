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

Generation preconditions (`PLAN_REQUIRES`), not the invalidation edges in
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

## Status

Phase 1 of 4: built and served, read by nothing yet. Phases: #1817 (footer +
continue read it), #1818 (the run does only its units), #1819 (delete the
stage + checkpoint; Update all = plan filtered to `stale`).
