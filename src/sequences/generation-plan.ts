/**
 * The generation plan (#1816): what a sequence still owes, per entity, as a
 * function of live D1 only. The footer, `continueGenerationFn` and the
 * storyboard trigger read this one answer, so there is no second opinion to
 * drift the way the stored pipeline stage and checkpoint did (#1819).
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
import { typedEntries, typedFromEntries } from '@/platform/typed-object';
import {
  UPDATE_STALE_DEPTHS,
  depthIncludes,
  type UpdateStaleDepth,
} from '@/shots/update-stale-depth';

/**
 * Every kind with the stop that caps it — the cap `stopAt` puts on a run.
 * Mirrors what the stage-shaped run does today: visual prompts and voices
 * ride with References, motion and music prompts with Images. Key order is
 * settle order: every upstream comes before its dependents.
 */
const PLAN_KIND_STAGE = {
  'sheet:character': 'references',
  'sheet:location': 'references',
  'ref:element': 'references',
  voice: 'references',
  spec: 'references',
  'prompt:visual': 'references',
  still: 'images',
  'prompt:motion': 'images',
  dialogue: 'dialogue',
  clip: 'motion',
  'prompt:music': 'images',
  music: 'music',
} as const satisfies Record<string, GenerationStage>;

export type PlanUnitKind = keyof typeof PLAN_KIND_STAGE;

const KIND_ORDER = Object.keys(PLAN_KIND_STAGE);

type PlanUnitState = 'done' | 'missing' | 'stale' | 'blocked' | 'running';

/** A unit's identity: the entity is a character, location, element, shot or the sequence. */
export type PlanUnitRef = { kind: PlanUnitKind; id: string };

export type PlanUnit = PlanUnitRef & {
  state: PlanUnitState;
  /**
   * Only on `blocked`: the upstream units that stop this one — running
   * elsewhere, blocked themselves, or (empty) a verdict that could not be
   * computed.
   */
  blockedBy?: PlanUnitRef[];
  /** The plan's units this one is made from (the requires graph, resolved). */
  requires: PlanUnitRef[];
  /**
   * `stale` only because an upstream is owed — its own verdict is fresh.
   * Update all takes such a unit only alongside that upstream.
   */
  cascaded: boolean;
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
  staleness?: ArtifactStaleness;
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
  /** The shot's spec: missing when it has none (#1923). */
  spec: ArtifactVerdict;
  /** A user-written prompt is not rebuilt from the spec. */
  visualWritten: boolean;
  motionWritten: boolean;
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
const ref = (kind: PlanUnitKind, id: string): PlanUnitRef => ({ kind, id });

/** The sheets and element refs a shot is rendered from. */
const sheetRefs = (shot: PlanShot): PlanUnitRef[] => [
  ...shot.references.characterIds.map((id) => ref('sheet:character', id)),
  ...shot.references.locationIds.map((id) => ref('sheet:location', id)),
  ...shot.references.elementIds.map((id) => ref('ref:element', id)),
];

/**
 * A shot's units and the requires graph over them: generation
 * preconditions, distinct from the invalidation edges in
 * `src/ui/docs/dependency-graph.ts` — what must exist before a unit can be
 * generated. A null verdict means the shot has no such unit: a
 * reference-only shot has no visual prompt or still, a silent one no
 * dialogue. The rest of the graph is `music` ← `prompt:music`; sheets,
 * element refs, voices and `prompt:music` hang off the root (the scenes).
 */
const SHOT_UNITS: ReadonlyArray<{
  kind: PlanUnitKind;
  verdict: (shot: PlanShot) => ArtifactVerdict | null;
  requires: (shot: PlanShot) => PlanUnitRef[];
}> = [
  {
    kind: 'spec',
    verdict: (s) => s.spec,
    requires: () => [],
  },
  {
    kind: 'prompt:visual',
    verdict: (s) => (s.usesStartFrame ? s.visualPrompt : null),
    requires: (s) =>
      s.visualWritten || !s.usesStartFrame ? [] : [ref('spec', s.id)],
  },
  {
    kind: 'still',
    verdict: (s) => (s.usesStartFrame ? s.still : null),
    requires: (s) => [ref('prompt:visual', s.id), ...sheetRefs(s)],
  },
  {
    kind: 'prompt:motion',
    verdict: (s) => s.motionPrompt,
    requires: (s) => (s.motionWritten ? [] : [ref('spec', s.id)]),
  },
  {
    kind: 'dialogue',
    verdict: (s) => s.dialogue,
    requires: (s) => s.speakerIds.map((id) => ref('voice', id)),
  },
  {
    kind: 'clip',
    verdict: (s) => s.clip,
    requires: (s) => [
      ref('prompt:motion', s.id),
      ...(s.usesStartFrame ? [ref('still', s.id)] : sheetRefs(s)),
      ...(s.dialogue ? [ref('dialogue', s.id)] : []),
    ],
  },
];

type BaseUnit = PlanUnitRef & {
  verdict: ArtifactVerdict;
  upstream: PlanUnitRef[];
};

const rootUnit = (
  kind: PlanUnitKind,
  id: string,
  verdict: ArtifactVerdict
): BaseUnit => ({ kind, id, verdict, upstream: [] });

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
  const base: BaseUnit[] = [
    ...input.characterSheets.map((c) =>
      rootUnit('sheet:character', c.id, c.sheet)
    ),
    ...input.locationSheets.map((l) =>
      rootUnit('sheet:location', l.id, l.sheet)
    ),
    ...input.elementRefs.map((e) => rootUnit('ref:element', e.id, e.ref)),
    ...input.voices.map((v) => rootUnit('voice', v.id, v.voice)),
    ...input.shots.flatMap((shot) =>
      SHOT_UNITS.flatMap(({ kind, verdict, requires }) => {
        const v = verdict(shot);
        return v === null
          ? []
          : [{ kind, id: shot.id, verdict: v, upstream: requires(shot) }];
      })
    ),
  ];
  if (input.music) {
    base.push(rootUnit('prompt:music', sequenceId, input.music.prompt), {
      kind: 'music',
      id: sequenceId,
      verdict: input.music.track,
      upstream: [ref('prompt:music', sequenceId)],
    });
  }
  base.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));

  const settled = new Map<string, PlanUnit>();
  for (const unit of base) {
    const upstream = unit.upstream.flatMap((up) => {
      const found = settled.get(key(up));
      return found ? [found] : [];
    });
    const self = {
      ...ref(unit.kind, unit.id),
      requires: upstream.map((up) => ref(up.kind, up.id)),
      cascaded: false,
    };
    let result: PlanUnit;
    if (unit.verdict === 'unknown') {
      result = { ...self, state: 'blocked', blockedBy: [] };
    } else {
      const state: PlanUnitState = unit.verdict;
      const holding = upstream.filter(
        (up) => up.state === 'running' || up.state === 'blocked'
      );
      if ((state === 'missing' || state === 'stale') && holding.length > 0) {
        result = {
          ...self,
          state: 'blocked',
          blockedBy: holding.map((up) => ({ kind: up.kind, id: up.id })),
        };
      } else {
        if (
          state === 'done' &&
          upstream.some((up) => up.state === 'missing' || up.state === 'stale')
        ) {
          result = { ...self, state: 'stale', cascaded: true };
        } else {
          result = { ...self, state };
        }
      }
    }
    // The run making the upstream is the run making this unit too: a
    // cascade block inside its stop is its own work, not a wait. An
    // uncomputable verdict (`blockedBy: []`) stays blocked.
    const runBlocked =
      result.state === 'blocked' && (result.blockedBy?.length ?? 0) > 0;
    if (
      input.processing &&
      (result.state === 'missing' || result.state === 'stale' || runBlocked) &&
      includesStage(input.runStopAt, PLAN_KIND_STAGE[result.kind])
    ) {
      result = { ...self, state: 'running' };
    }
    settled.set(key(self), result);
  }
  return [...settled.values()];
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

/**
 * Voices cannot be turned off once a shot has a recording (#1780 §2): the
 * recording would still ride the clip. Start frames can always turn off — the
 * stills stay, shots render from references, and their motion prompts go
 * stale. Turning either ON is always allowed — it only adds units. Draft first is changeable at the
 * Motion step and read-only after: once every clip exists.
 */
export function switchLocks(plan: readonly PlanUnit[]): {
  voices: boolean;
  draft: boolean;
} {
  // A blocked unit is not counted as made: it may be waiting on work that
  // has not produced it yet.
  const exists = (u: PlanUnit) =>
    u.state === 'done' || u.state === 'stale' || u.state === 'running';
  const made = (kind: PlanUnitKind) =>
    plan.some((u) => u.kind === kind && exists(u));
  const clips = plan.filter((u) => u.kind === 'clip');
  return {
    voices: made('dialogue'),
    draft: clips.length > 0 && clips.every(exists),
  };
}

const KIND_NOUN: Record<PlanUnitKind, [one: string, many: string]> = {
  'sheet:character': ['reference', 'references'],
  'sheet:location': ['reference', 'references'],
  'ref:element': ['reference', 'references'],
  voice: ['voice', 'voices'],
  spec: ['shot rewrite', 'shot rewrites'],
  'prompt:visual': ['prompt', 'prompts'],
  still: ['image', 'images'],
  'prompt:motion': ['prompt', 'prompts'],
  dialogue: ['recording', 'recordings'],
  clip: ['video', 'videos'],
  'prompt:music': ['prompt', 'prompts'],
  music: ['music track', 'music tracks'],
};

/**
 * `2 references, 12 prompts, 12 images` — counts per noun, in plan order.
 * Shown under the button, which stays one word so it never overflows.
 */
export function planWorkSummary(units: readonly PlanUnitRef[]): string {
  const counts = new Map<string, { n: number; noun: [string, string] }>();
  for (const unit of units) {
    const noun = KIND_NOUN[unit.kind];
    const entry = counts.get(noun[1]) ?? { n: 0, noun };
    entry.n += 1;
    counts.set(noun[1], entry);
  }
  return [...counts.values()]
    .map(({ n, noun }) => `${n} ${n === 1 ? noun[0] : noun[1]}`)
    .join(', ');
}

/**
 * The line under the continue button. When the run both makes new work and
 * redoes stale work, the redo is named apart — `8 videos · redo 8 images` —
 * so moving the thumb forward never hides a re-roll inside `Generate`.
 */
export function planWorkLine(work: readonly PlanUnit[]): string {
  const fresh = work.filter((u) => u.state !== 'stale');
  const redo = work.filter((u) => u.state === 'stale');
  if (fresh.length === 0 || redo.length === 0) return planWorkSummary(work);
  return `${planWorkSummary(fresh)} · redo ${planWorkSummary(redo)}`;
}

/**
 * Footer button: `Generate`, or `Regenerate` when every unit already exists
 * and is only out of date. {@link planWorkLine} says what.
 */
export function planWorkLabel(work: readonly PlanUnit[]): string {
  if (work.length === 0) return 'Nothing to generate';
  return work.every((u) => u.state === 'stale') ? 'Regenerate' : 'Generate';
}

/**
 * One line per blocked noun up to `stopAt`, naming what it waits on:
 * `3 images blocked: waiting on Maya sheet, Ravi sheet`. `nameOf` resolves a
 * character / location id to its name; anything else is counted.
 */
export function blockedLines(
  plan: readonly PlanUnit[],
  stopAt: GenerationStage,
  nameOf: (ref: PlanUnitRef) => string | undefined
): string[] {
  const blocked = plan.filter(
    (u) =>
      u.state === 'blocked' && includesStage(stopAt, PLAN_KIND_STAGE[u.kind])
  );
  const byNoun = new Map<string, PlanUnit[]>();
  for (const unit of blocked) {
    const noun = KIND_NOUN[unit.kind][1];
    byNoun.set(noun, [...(byNoun.get(noun) ?? []), unit]);
  }
  return [...byNoun.values()].map((units) => {
    const blockers = new Map<string, PlanUnitRef>();
    for (const unit of units)
      for (const ref of unit.blockedBy ?? [])
        blockers.set(`${ref.kind}:${ref.id}`, ref);
    const named: string[] = [];
    const counted: PlanUnitRef[] = [];
    for (const ref of blockers.values()) {
      const name = nameOf(ref);
      if (name) named.push(`${name} ${KIND_NOUN[ref.kind][0]}`);
      else counted.push(ref);
    }
    const reasons = [
      ...named,
      ...(counted.length ? [planWorkSummary(counted)] : []),
    ];
    return `${planWorkSummary(units)} blocked: ${
      reasons.length ? `waiting on ${reasons.join(', ')}` : 'couldn’t check'
    }`;
  });
}

/** Unit counts per kind — what a run up to a stop is priced on. */
export function planCounts(
  work: readonly PlanUnit[]
): Record<PlanUnitKind, number> {
  const counts = typedFromEntries(
    typedEntries(PLAN_KIND_STAGE).map(([kind]) => [kind, 0] as const)
  );
  for (const unit of work) counts[unit.kind] += 1;
  return counts;
}

const SEQUENCE_KINDS = new Set<PlanUnitKind>(['prompt:music', 'music']);
const REFERENCE_KINDS = new Set<PlanUnitKind>([
  'sheet:character',
  'sheet:location',
  'ref:element',
  'voice',
]);

/** What each Update-all depth reaches, cumulatively (#1819). */
const UPDATE_ALL_KINDS: Record<UpdateStaleDepth, readonly PlanUnitKind[]> = {
  prompts: ['spec', 'prompt:visual', 'prompt:motion'],
  images: ['sheet:character', 'sheet:location', 'ref:element', 'still'],
  dialogue: ['dialogue'],
  video: ['clip'],
  music: ['prompt:music', 'music'],
};

/**
 * Update all is the plan filtered to `stale` (#1819): the same units a
 * continue runs, through the same executor — sheets included, which it
 * could not touch before. Up to `depth`; narrowed to `shotIds` when a scene
 * or shot is in scope, taking along the sheets those shots are made from.
 * Music stays sequence-wide. Two `missing` kinds ride along: a shot with
 * voiced lines and every speaker's voice made, but no reading yet, records
 * its first one (#1780 §6); a taken prompt whose spec was never written
 * (a shot from before specs) takes that rewrite so the prompts have
 * something to rebuild from (#1945).
 */
export function updateAllUnits(
  plan: readonly PlanUnit[],
  opts: { depth: UpdateStaleDepth; shotIds: ReadonlySet<string> | null }
): PlanUnitRef[] {
  const kinds = new Set(
    UPDATE_STALE_DEPTHS.filter((d) => depthIncludes(opts.depth, d)).flatMap(
      (d) => UPDATE_ALL_KINDS[d]
    )
  );
  const byKey = new Map(plan.map((u) => [key(u), u]));
  // In kind order, so an upstream is decided before what is made from it.
  const taken = new Set<string>();
  for (const u of plan) {
    const take =
      kinds.has(u.kind) &&
      ((u.state === 'stale' &&
        // Stale only by the cascade: worth it only if the upstream is redone.
        (!u.cascaded || u.requires.some((r) => taken.has(key(r))))) ||
        (u.state === 'missing' &&
          u.kind === 'dialogue' &&
          u.requires.every((r) => byKey.get(key(r))?.state === 'done')));
    if (take) {
      taken.add(key(u));
      // A prompt stale on its own still requires a spec. A missing one is a
      // rewrite, priced as one LLM call; a done spec rebuilds for free.
      for (const req of u.requires) {
        if (req.kind !== 'spec') continue;
        const spec = byKey.get(key(req));
        if (spec?.state === 'missing' && kinds.has('spec'))
          taken.add(key(spec));
      }
    }
  }
  const wanted = (u: PlanUnit) => taken.has(key(u));
  const picked = new Map<string, PlanUnitRef>();
  const take = (u: PlanUnitRef) =>
    picked.set(key(u), { kind: u.kind, id: u.id });
  for (const unit of plan) {
    if (!wanted(unit)) continue;
    if (opts.shotIds === null || SEQUENCE_KINDS.has(unit.kind)) {
      take(unit);
      continue;
    }
    // In a scoped run a sheet comes along only with a shot made from it.
    if (REFERENCE_KINDS.has(unit.kind) || !opts.shotIds.has(unit.id)) continue;
    take(unit);
    for (const ref of unit.requires) {
      const up = byKey.get(key(ref));
      if (up && REFERENCE_KINDS.has(up.kind) && wanted(up)) take(up);
    }
  }
  return [...picked.values()];
}

/**
 * Going back never redoes finished work (#1780 §3): a switch turned on stops
 * the run at its own step — Voices at Dialogue, Start frames at Images (the
 * later of the two when both) — when something past that step already exists
 * (done or stale). With nothing later made, the thumb can still run on to
 * Motion. Clips rendered from the old inputs then read stale, for Update all
 * to re-render with its cost shown.
 */
type PlanSwitches = { generateStartFrames: boolean; generateVoices: boolean };

export function switchStopAt(args: {
  saved: PlanSwitches;
  requested: PlanSwitches;
  stopAt: GenerationStage;
  /**
   * The plan this click would owe. Omit it and the cap always applies.
   * Pass it and the cap applies only when a later unit is already done or
   * stale — a missing clip is work this run may still include.
   */
  plan?: readonly PlanUnit[];
}): GenerationStage {
  const backTo: GenerationStage | null =
    !args.saved.generateVoices && args.requested.generateVoices
      ? 'dialogue'
      : !args.saved.generateStartFrames && args.requested.generateStartFrames
        ? 'images'
        : null;
  if (!backTo || stageIndex(args.stopAt) <= stageIndex(backTo)) {
    return args.stopAt;
  }
  if (
    args.plan &&
    !args.plan.some(
      (unit) =>
        (unit.state === 'done' || unit.state === 'stale') &&
        stageIndex(PLAN_KIND_STAGE[unit.kind]) > stageIndex(backTo)
    )
  ) {
    return args.stopAt;
  }
  return backTo;
}
