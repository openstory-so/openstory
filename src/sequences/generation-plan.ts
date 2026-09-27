/**
 * The generation plan (#1816): what a sequence still owes, per entity, as a
 * function of live D1 only. The footer, `continueGenerationFn` and the
 * storyboard trigger read this one answer, so there is no second opinion to
 * drift the way `pipelineStage` / `generationCheckpoint` did.
 *
 * This half is pure and client-safe: the unit vocabulary, the requires graph
 * and the cascade over it. `server/generation-plan.ts` loads the live rows and
 * the existing staleness verdicts and hands them to `planUnits`.
 *
 * Script is not a unit — it is the root that creates the structure. A
 * sequence with no scenes has an empty plan.
 */

import {
  includesStage,
  stageIndex,
  type GenerationStage,
} from '@/sequences/pipeline';
import type { ArtifactStaleness } from '@/shots/server/shot-staleness';

const PLAN_UNIT_KINDS = [
  'sheet:character',
  'sheet:location',
  'ref:element',
  'voice',
  'prompt:visual',
  'still',
  'prompt:motion',
  'dialogue',
  'clip',
  'prompt:music',
  'music',
] as const;

type PlanUnitKind = (typeof PLAN_UNIT_KINDS)[number];

type PlanUnitState = 'done' | 'missing' | 'stale' | 'blocked' | 'running';

/** A unit's identity: the entity is a character, location, element, shot or the sequence. */
type PlanUnitRef = { kind: PlanUnitKind; id: string };

export type PlanUnit = PlanUnitRef & {
  state: PlanUnitState;
  /**
   * Only on `blocked`: the upstream units that stop this one — running
   * elsewhere, blocked themselves, or (empty) a verdict that could not be
   * computed.
   */
  blockedBy?: PlanUnitRef[];
};

/**
 * The stop each kind belongs to — the cap `stopAt` puts on a run. Mirrors
 * what the stage-shaped run does today: visual prompts and voices ride with
 * References, motion and music prompts with Images.
 */
const PLAN_KIND_STAGE: Record<PlanUnitKind, GenerationStage> = {
  'sheet:character': 'references',
  'sheet:location': 'references',
  'ref:element': 'references',
  voice: 'references',
  'prompt:visual': 'references',
  still: 'images',
  'prompt:motion': 'images',
  dialogue: 'dialogue',
  clip: 'motion',
  'prompt:music': 'images',
  music: 'music',
};

/**
 * Generation preconditions: which kinds a unit is made from. Distinct from
 * the invalidation edges in `src/ui/docs/dependency-graph.ts` — these say
 * what must exist before a unit can be generated. Which entities of the
 * upstream kind apply (the sheets a still references, the voices a shot's
 * speakers need) is resolved per unit by `upstreamOf`.
 *
 * - `still` ← its `prompt:visual` + every sheet / element it references
 *   (start-frame shots only; a reference-only shot has no still).
 * - `prompt:motion` ← its `still` in start-frame mode, else the scene alone.
 * - `clip` ← `prompt:motion` + `still` (start frame) or the referenced sheets
 *   (reference-only) + `dialogue` when the shot has voiced lines.
 * - `dialogue` ← a `voice` on every speaker.
 * - `music` ← `prompt:music`; `prompt:music` ← the scenes (the root).
 */
const PLAN_REQUIRES: Record<PlanUnitKind, readonly PlanUnitKind[]> = {
  'sheet:character': [],
  'sheet:location': [],
  'ref:element': [],
  voice: [],
  'prompt:visual': [],
  still: ['prompt:visual', 'sheet:character', 'sheet:location', 'ref:element'],
  'prompt:motion': ['still'],
  dialogue: ['voice'],
  clip: [
    'prompt:motion',
    'still',
    'sheet:character',
    'sheet:location',
    'ref:element',
    'dialogue',
  ],
  'prompt:music': [],
  music: ['prompt:music'],
};

/**
 * One artifact's live reading, before the graph is applied: the row's
 * existence folded with the existing staleness verdict and claims.
 * `unknown` is a comparison that failed — never read as fresh.
 */
export type ArtifactVerdict =
  | 'done'
  | 'missing'
  | 'stale'
  | 'running'
  | 'unknown';

/**
 * One artifact: does it exist, what does its staleness verdict say, is a
 * claim or status column saying someone is making it now. `'generating'` (the
 * storyboard run holds the sequence) is not an opinion about the artifact —
 * the plan's own processing overlay decides what that run owns.
 */
export function artifactVerdict(args: {
  exists: boolean;
  staleness?: ArtifactStaleness | 'generating';
  inFlight?: boolean;
}): ArtifactVerdict {
  const { exists, staleness, inFlight } = args;
  if (staleness === 'updating' || inFlight) return 'running';
  if (!exists) return 'missing';
  if (staleness === 'stale') return 'stale';
  if (staleness === 'unknown') return 'unknown';
  return 'done';
}

export type PlanShot = {
  id: string;
  /** `usesStartFrame(shot, sequence)` — the mode is per shot. */
  usesStartFrame: boolean;
  /** Entities the shot's still (or reference-only clip) is rendered from. */
  references: {
    characterIds: readonly string[];
    locationIds: readonly string[];
    elementIds: readonly string[];
  };
  /** Characters whose lines in this shot are spoken by a voice. */
  speakerIds: readonly string[];
  /** Ignored on a reference-only shot. */
  visualPrompt: ArtifactVerdict;
  /** Ignored on a reference-only shot. */
  still: ArtifactVerdict;
  motionPrompt: ArtifactVerdict;
  /** Null when the shot has no voiced lines and no recording. */
  dialogue: ArtifactVerdict | null;
  clip: ArtifactVerdict;
};

export type PlanInput = {
  /** The storyboard run holds the sequence (`status === 'processing'`). */
  processing: boolean;
  /** The stop of the run in flight — its kinds read `running`. */
  runStopAt: GenerationStage;
  /** Characters that need a sheet (voice-only ones never do). */
  characterSheets: ReadonlyArray<{ id: string; sheet: ArtifactVerdict }>;
  locationSheets: ReadonlyArray<{ id: string; sheet: ArtifactVerdict }>;
  elementRefs: ReadonlyArray<{ id: string; ref: ArtifactVerdict }>;
  /** Speaking characters that use a voice. */
  voices: ReadonlyArray<{ id: string; voice: ArtifactVerdict }>;
  shots: readonly PlanShot[];
  /** Null when the sequence has no scenes yet. */
  music: { prompt: ArtifactVerdict; track: ArtifactVerdict } | null;
};

const key = (ref: PlanUnitRef) => `${ref.kind}:${ref.id}`;

function upstreamOf(
  kind: PlanUnitKind,
  shot: PlanShot | undefined,
  sequenceId: string
): PlanUnitRef[] {
  const allowed = new Set(PLAN_REQUIRES[kind]);
  const refs: PlanUnitRef[] = [];
  const add = (k: PlanUnitKind, id: string) => {
    if (allowed.has(k)) refs.push({ kind: k, id });
  };
  if (kind === 'music') add('prompt:music', sequenceId);
  if (!shot) return refs;
  const sheets = () => {
    for (const id of shot.references.characterIds) add('sheet:character', id);
    for (const id of shot.references.locationIds) add('sheet:location', id);
    for (const id of shot.references.elementIds) add('ref:element', id);
  };
  switch (kind) {
    case 'still':
      add('prompt:visual', shot.id);
      sheets();
      break;
    case 'prompt:motion':
      if (shot.usesStartFrame) add('still', shot.id);
      break;
    case 'dialogue':
      for (const id of shot.speakerIds) add('voice', id);
      break;
    case 'clip':
      add('prompt:motion', shot.id);
      if (shot.usesStartFrame) add('still', shot.id);
      else sheets();
      if (shot.dialogue) add('dialogue', shot.id);
      break;
  }
  return refs;
}

/**
 * Apply the requires graph to the live verdicts, in kind order so every
 * upstream is settled before its dependents:
 *
 * - An upstream the plan will (re)make — `missing` / `stale` — turns a `done`
 *   unit `stale`: a sheet in the plan puts its stills in the plan, the way
 *   Update all's `cascadeFlags` does per shot.
 * - An upstream that is `running` elsewhere or `blocked` turns a unit that
 *   still has work (`missing` / `stale`) `blocked`: making it now would read
 *   inputs that are about to move. A `done` unit keeps its artifact.
 * - While the storyboard run holds the sequence, every unit with work up to
 *   that run's stop is `running`.
 */
export function planUnits(input: PlanInput, sequenceId: string): PlanUnit[] {
  const base: Array<
    PlanUnitRef & { verdict: ArtifactVerdict; shot?: PlanShot }
  > = [];
  for (const c of input.characterSheets)
    base.push({ kind: 'sheet:character', id: c.id, verdict: c.sheet });
  for (const l of input.locationSheets)
    base.push({ kind: 'sheet:location', id: l.id, verdict: l.sheet });
  for (const e of input.elementRefs)
    base.push({ kind: 'ref:element', id: e.id, verdict: e.ref });
  for (const v of input.voices)
    base.push({ kind: 'voice', id: v.id, verdict: v.voice });
  for (const shot of input.shots) {
    if (shot.usesStartFrame) {
      base.push({
        kind: 'prompt:visual',
        id: shot.id,
        verdict: shot.visualPrompt,
        shot,
      });
      base.push({ kind: 'still', id: shot.id, verdict: shot.still, shot });
    }
    base.push({
      kind: 'prompt:motion',
      id: shot.id,
      verdict: shot.motionPrompt,
      shot,
    });
    if (shot.dialogue)
      base.push({
        kind: 'dialogue',
        id: shot.id,
        verdict: shot.dialogue,
        shot,
      });
    base.push({ kind: 'clip', id: shot.id, verdict: shot.clip, shot });
  }
  if (input.music) {
    base.push({
      kind: 'prompt:music',
      id: sequenceId,
      verdict: input.music.prompt,
    });
    base.push({ kind: 'music', id: sequenceId, verdict: input.music.track });
  }
  base.sort(
    (a, b) => PLAN_UNIT_KINDS.indexOf(a.kind) - PLAN_UNIT_KINDS.indexOf(b.kind)
  );

  const settled = new Map<string, PlanUnit>();
  for (const unit of base) {
    const ref = { kind: unit.kind, id: unit.id };
    let result: PlanUnit;
    if (unit.verdict === 'unknown') {
      result = { ...ref, state: 'blocked', blockedBy: [] };
    } else {
      let state: PlanUnitState = unit.verdict;
      const upstream = upstreamOf(unit.kind, unit.shot, sequenceId).flatMap(
        (up) => {
          const found = settled.get(key(up));
          return found ? [found] : [];
        }
      );
      const holding = upstream.filter(
        (up) => up.state === 'running' || up.state === 'blocked'
      );
      if ((state === 'missing' || state === 'stale') && holding.length > 0) {
        result = {
          ...ref,
          state: 'blocked',
          blockedBy: holding.map((up) => ({ kind: up.kind, id: up.id })),
        };
      } else {
        if (
          state === 'done' &&
          upstream.some((up) => up.state === 'missing' || up.state === 'stale')
        ) {
          state = 'stale';
        }
        result = { ...ref, state };
      }
    }
    if (
      input.processing &&
      (result.state === 'missing' || result.state === 'stale') &&
      includesStage(input.runStopAt, PLAN_KIND_STAGE[result.kind])
    ) {
      result = { ...ref, state: 'running' };
    }
    settled.set(key(ref), result);
  }
  return base.map(
    (unit) => settled.get(key(unit)) ?? { ...unit, state: 'done' }
  );
}

/** Units a run up to `stopAt` would make. */
export function planWork(
  plan: readonly PlanUnit[],
  stopAt: GenerationStage
): PlanUnit[] {
  return plan.filter(
    (unit) =>
      (unit.state === 'missing' || unit.state === 'stale') &&
      includesStage(stopAt, PLAN_KIND_STAGE[unit.kind])
  );
}

/** The earliest stop with work, or null when the plan is finished. */
export function firstStageWithWork(
  plan: readonly PlanUnit[]
): GenerationStage | null {
  let first: GenerationStage | null = null;
  for (const unit of planWork(plan, 'music')) {
    const stage = PLAN_KIND_STAGE[unit.kind];
    if (first === null || stageIndex(stage) < stageIndex(first)) first = stage;
  }
  return first;
}
