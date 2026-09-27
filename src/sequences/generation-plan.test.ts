import { describe, expect, it } from 'vitest';
import {
  artifactVerdict,
  firstStageWithWork,
  planUnits,
  planWork,
  type PlanInput,
  type PlanShot,
  type PlanUnit,
} from './generation-plan';

const SEQ = 'seq-1';

function shot(id: string, overrides: Partial<PlanShot> = {}): PlanShot {
  return {
    id,
    usesStartFrame: true,
    references: { characterIds: [], locationIds: [], elementIds: [] },
    speakerIds: [],
    visualPrompt: 'done',
    still: 'done',
    motionPrompt: 'done',
    dialogue: null,
    clip: 'done',
    ...overrides,
  };
}

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    processing: false,
    runStopAt: 'music',
    characterSheets: [],
    locationSheets: [],
    elementRefs: [],
    voices: [],
    shots: [],
    music: null,
    ...overrides,
  };
}

/** `kind:id → state`, plus blockers where present — what each row asserts. */
function states(plan: PlanUnit[]) {
  return Object.fromEntries(
    plan.map((u) => [
      `${u.kind}:${u.id}`,
      u.blockedBy
        ? `${u.state} by ${u.blockedBy.map((b) => `${b.kind}:${b.id}`).join(',') || '-'}`
        : u.state,
    ])
  );
}

const refs = (...characterIds: string[]) => ({
  characterIds,
  locationIds: [],
  elementIds: [],
});

describe('planUnits — scenario table (#1816)', () => {
  it('references done, two hand-added pending characters', () => {
    // The reported bug: the checkpoint says References is done, two
    // characters were added by hand with no sheet.
    const plan = planUnits(
      input({
        characterSheets: [
          { id: 'maya', sheet: 'done' },
          { id: 'ravi', sheet: 'missing' },
          { id: 'ana', sheet: 'missing' },
        ],
        shots: [
          // The bible edit moved these prompts' hashes: stale by verdict.
          shot('s1', {
            references: refs('maya', 'ravi'),
            visualPrompt: 'stale',
          }),
          shot('s2', { references: refs('ana'), visualPrompt: 'stale' }),
          shot('s3', { references: refs('maya') }),
        ],
      }),
      SEQ
    );
    expect(states(plan)).toMatchObject({
      'sheet:character:maya': 'done',
      'sheet:character:ravi': 'missing',
      'sheet:character:ana': 'missing',
      'prompt:visual:s1': 'stale',
      'prompt:visual:s2': 'stale',
      'prompt:visual:s3': 'done',
      // By cascade: their sheets and prompts are in the plan.
      'still:s1': 'stale',
      'still:s2': 'stale',
      'still:s3': 'done',
      'prompt:motion:s1': 'stale',
      'clip:s1': 'stale',
      'clip:s3': 'done',
    });
    expect(firstStageWithWork(plan)).toBe('references');
  });

  it('reference-only: no still or visual prompt; the clip requires the sheets', () => {
    const plan = planUnits(
      input({
        characterSheets: [{ id: 'maya', sheet: 'stale' }],
        shots: [
          shot('s1', {
            usesStartFrame: false,
            references: refs('maya'),
            motionPrompt: 'done',
            clip: 'done',
          }),
          shot('s2', {
            usesStartFrame: false,
            references: refs(),
            motionPrompt: 'missing',
            clip: 'missing',
          }),
        ],
      }),
      SEQ
    );
    const s = states(plan);
    expect(s['still:s1']).toBeUndefined();
    expect(s['prompt:visual:s1']).toBeUndefined();
    expect(s).toMatchObject({
      'sheet:character:maya': 'stale',
      'prompt:motion:s1': 'done',
      'clip:s1': 'stale',
      'prompt:motion:s2': 'missing',
      'clip:s2': 'missing',
    });
  });

  it('Voices off: no voice or dialogue units, the clip does not wait for audio', () => {
    const plan = planUnits(
      input({ shots: [shot('s1', { clip: 'missing' })] }),
      SEQ
    );
    expect(plan.map((u) => u.kind)).not.toContain('voice');
    expect(plan.map((u) => u.kind)).not.toContain('dialogue');
    expect(states(plan)['clip:s1']).toBe('missing');
  });

  it('Voices on: a speaker without a voice owes one before the recording', () => {
    const plan = planUnits(
      input({
        voices: [{ id: 'maya', voice: 'missing' }],
        shots: [
          shot('s1', {
            speakerIds: ['maya'],
            dialogue: 'missing',
            clip: 'done',
          }),
        ],
      }),
      SEQ
    );
    expect(states(plan)).toMatchObject({
      'voice:maya': 'missing',
      'dialogue:s1': 'missing',
      // A new recording makes the rendered clip out of date.
      'clip:s1': 'stale',
    });
  });

  it('a failed sheet is missing and stales the stills that reference it', () => {
    const plan = planUnits(
      input({
        characterSheets: [{ id: 'maya', sheet: 'missing' }],
        shots: [shot('s1', { references: refs('maya') })],
      }),
      SEQ
    );
    expect(states(plan)).toMatchObject({
      'sheet:character:maya': 'missing',
      'prompt:visual:s1': 'done',
      'still:s1': 'stale',
    });
  });

  it('an in-flight claim is running and blocks what is made from it', () => {
    const plan = planUnits(
      input({
        shots: [
          shot('s1', {
            still: 'running',
            motionPrompt: 'missing',
            clip: 'missing',
          }),
        ],
      }),
      SEQ
    );
    expect(states(plan)).toMatchObject({
      'still:s1': 'running',
      'prompt:motion:s1': 'blocked by still:s1',
      'clip:s1': 'blocked by prompt:motion:s1,still:s1',
    });
    // Nothing a run could make yet.
    expect(planWork(plan, 'music')).toEqual([]);
  });

  it('an uncomputable verdict is blocked, never fresh', () => {
    const plan = planUnits(
      input({
        shots: [shot('s1', { visualPrompt: 'unknown', still: 'missing' })],
      }),
      SEQ
    );
    expect(states(plan)).toMatchObject({
      'prompt:visual:s1': 'blocked by -',
      'still:s1': 'blocked by prompt:visual:s1',
    });
  });

  it('while a storyboard run holds the sequence, its kinds read running', () => {
    const plan = planUnits(
      input({
        processing: true,
        runStopAt: 'references',
        characterSheets: [{ id: 'maya', sheet: 'missing' }],
        shots: [shot('s1', { visualPrompt: 'missing', still: 'missing' })],
      }),
      SEQ
    );
    expect(states(plan)).toMatchObject({
      'sheet:character:maya': 'running',
      'prompt:visual:s1': 'running',
      // Past the run's stop: still owed.
      'still:s1': 'blocked by prompt:visual:s1',
    });
  });

  it('music: the track is made from the prompt', () => {
    const plan = planUnits(
      input({ music: { prompt: 'stale', track: 'done' } }),
      SEQ
    );
    expect(states(plan)).toMatchObject({
      'prompt:music:seq-1': 'stale',
      'music:seq-1': 'stale',
    });
  });

  it('an empty sequence has nothing but the script root', () => {
    expect(planUnits(input(), SEQ)).toEqual([]);
    expect(firstStageWithWork([])).toBeNull();
  });
});

describe('planWork', () => {
  it('caps the work at stopAt', () => {
    const plan = planUnits(
      input({
        characterSheets: [{ id: 'maya', sheet: 'missing' }],
        shots: [shot('s1', { still: 'missing', clip: 'missing' })],
      }),
      SEQ
    );
    expect(planWork(plan, 'references').map((u) => u.kind)).toEqual([
      'sheet:character',
    ]);
    expect(planWork(plan, 'motion').map((u) => u.kind)).toEqual([
      'sheet:character',
      'still',
      'prompt:motion',
      'clip',
    ]);
  });
});

describe('artifactVerdict', () => {
  it.each([
    [{ exists: false }, 'missing'],
    [{ exists: false, inFlight: true }, 'running'],
    [{ exists: true, staleness: 'fresh' as const }, 'done'],
    [{ exists: true, staleness: 'untracked' as const }, 'done'],
    [{ exists: true, staleness: 'stale' as const }, 'stale'],
    [{ exists: true, staleness: 'updating' as const }, 'running'],
    [{ exists: true, staleness: 'unknown' as const }, 'unknown'],
    // Mid-run is no opinion: the plan's overlay decides.
    [{ exists: true, staleness: 'generating' as const }, 'done'],
    [{ exists: false, staleness: 'generating' as const }, 'missing'],
  ])('%o → %s', (args, expected) => {
    expect(artifactVerdict(args)).toBe(expected);
  });
});
