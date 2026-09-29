import { describe, expect, it } from 'vitest';
import {
  artifactVerdict,
  blockedLines,
  firstStageWithWork,
  planCounts,
  planWorkLabel,
  planWorkLine,
  planWorkSummary,
  switchLocks,
  updateAllUnits,
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

  it('a run whose stop covers the dependents owns them too', () => {
    const plan = planUnits(
      input({
        processing: true,
        runStopAt: 'music',
        characterSheets: [{ id: 'maya', sheet: 'missing' }],
        shots: [
          shot('s1', {
            references: refs('maya'),
            visualPrompt: 'missing',
            still: 'missing',
            motionPrompt: 'missing',
            clip: 'missing',
          }),
          shot('s2', { visualPrompt: 'unknown', still: 'missing' }),
        ],
        music: { prompt: 'missing', track: 'missing' },
      }),
      SEQ
    );
    expect(states(plan)).toMatchObject({
      'sheet:character:maya': 'running',
      'still:s1': 'running',
      'prompt:motion:s1': 'running',
      'clip:s1': 'running',
      'music:seq-1': 'running',
      // No verdict is not the run's work.
      'prompt:visual:s2': 'blocked by -',
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

describe('footer helpers', () => {
  const plan: PlanUnit[] = [
    {
      kind: 'sheet:character',
      id: 'maya',
      state: 'running',
      requires: [],
      cascaded: false,
    },
    {
      kind: 'sheet:character',
      id: 'ravi',
      state: 'missing',
      requires: [],
      cascaded: false,
    },
    {
      kind: 'prompt:visual',
      id: 's1',
      state: 'stale',
      requires: [],
      cascaded: false,
    },
    {
      kind: 'prompt:motion',
      id: 's1',
      state: 'missing',
      requires: [],
      cascaded: false,
    },
    {
      kind: 'still',
      id: 's1',
      state: 'blocked',
      blockedBy: [{ kind: 'sheet:character', id: 'maya' }],
      requires: [],
      cascaded: false,
    },
    {
      kind: 'still',
      id: 's2',
      state: 'blocked',
      blockedBy: [{ kind: 'prompt:visual', id: 's2' }],
      requires: [],
      cascaded: false,
    },
    {
      kind: 'clip',
      id: 's1',
      state: 'blocked',
      blockedBy: [],
      requires: [],
      cascaded: false,
    },
    {
      kind: 'dialogue',
      id: 's1',
      state: 'done',
      requires: [],
      cascaded: false,
    },
  ];

  it('names the count and the noun', () => {
    expect(planWorkLabel(planWork(plan, 'images'))).toBe('Generate');
    expect(planWorkSummary(planWork(plan, 'images'))).toBe(
      '1 reference, 2 prompts'
    );
    expect(planWorkLabel([])).toBe('Nothing to generate');
    expect(
      planWorkLabel([
        {
          kind: 'still',
          id: 's1',
          state: 'stale',
          requires: [],
          cascaded: false,
        },
      ])
    ).toBe('Regenerate');
  });

  it('names redone work apart only when new work rides with it', () => {
    const unit = (
      kind: PlanUnit['kind'],
      id: string,
      state: PlanUnit['state']
    ): PlanUnit => ({ kind, id, state, requires: [], cascaded: false });
    const stale = [unit('still', 's1', 'stale'), unit('still', 's2', 'stale')];
    const fresh = [unit('clip', 's1', 'missing')];
    expect(planWorkLine([...stale, ...fresh])).toBe('1 video · redo 2 images');
    expect(planWorkLine(stale)).toBe('2 images');
    expect(planWorkLine(fresh)).toBe('1 video');
  });

  it('says what a blocked unit waits on', () => {
    const names: Record<string, string> = { maya: 'Maya' };
    expect(blockedLines(plan, 'images', (ref) => names[ref.id])).toEqual([
      '2 images blocked: waiting on Maya reference, 1 prompt',
    ]);
    expect(blockedLines(plan, 'music', () => undefined)).toContain(
      '1 video blocked: couldn’t check'
    );
  });

  it('locks a switch once its units exist', () => {
    expect(switchLocks(plan)).toEqual({
      voices: true,
      // s1's clip is blocked, so it may not exist yet: Draft first stays open.
      draft: false,
    });
    expect(
      switchLocks([
        {
          kind: 'clip',
          id: 's1',
          state: 'done',
          requires: [],
          cascaded: false,
        },
      ]).draft
    ).toBe(true);
  });

  it('counts units per kind', () => {
    const counts = planCounts(planWork(plan, 'music'));
    expect(counts['sheet:character']).toBe(1);
    expect(counts['prompt:visual'] + counts['prompt:motion']).toBe(2);
    expect(counts.still).toBe(0);
  });
});

describe('updateAllUnits — Update all is the plan filtered to stale (#1819)', () => {
  const plan = planUnits(
    input({
      characterSheets: [
        { id: 'maya', sheet: 'stale' },
        { id: 'ravi', sheet: 'missing' },
      ],
      voices: [
        { id: 'maya', voice: 'done' },
        { id: 'ana', voice: 'missing' },
      ],
      shots: [
        // Maya's sheet moved: the still and clip read stale by cascade.
        shot('s1', { references: refs('maya') }),
        // A first reading, every speaker voiced.
        shot('s2', { speakerIds: ['maya'], dialogue: 'missing' }),
        // A first reading whose speaker has no voice yet: not Update all's.
        shot('s3', { speakerIds: ['ana'], dialogue: 'missing' }),
        // Never a first still: missing work is a continue's.
        shot('s4', { still: 'missing', clip: 'missing' }),
      ],
      music: { prompt: 'stale', track: 'done' },
    }),
    SEQ
  );
  const keys = (units: ReturnType<typeof updateAllUnits>) =>
    units.map((u) => `${u.kind}:${u.id}`);

  it('reaches only as deep as asked', () => {
    expect(
      keys(updateAllUnits(plan, { depth: 'prompts', shotIds: null }))
    ).toEqual([]);
    expect(
      keys(updateAllUnits(plan, { depth: 'images', shotIds: null }))
    ).toEqual([
      'sheet:character:maya',
      'still:s1',
      // The new still re-conditions its motion prompt (#929).
      'prompt:motion:s1',
    ]);
  });

  it('records a first reading only when every speaker has a voice (#1780 §6)', () => {
    const units = keys(
      updateAllUnits(plan, { depth: 'dialogue', shotIds: null })
    );
    expect(units).toContain('dialogue:s2');
    expect(units).not.toContain('dialogue:s3');
    expect(units).not.toContain('voice:ana');
  });

  it('never makes a first sheet, still or clip — those are a continue', () => {
    const units = keys(updateAllUnits(plan, { depth: 'music', shotIds: null }));
    expect(units).not.toContain('sheet:character:ravi');
    expect(units).not.toContain('still:s4');
    expect(units).not.toContain('clip:s4');
    expect(units).toEqual(
      expect.arrayContaining(['clip:s1', 'prompt:music:seq-1', 'music:seq-1'])
    );
  });

  it('a scoped run takes along the sheets its shots are made from; music stays sequence-wide', () => {
    const units = keys(
      updateAllUnits(plan, { depth: 'music', shotIds: new Set(['s1']) })
    );
    expect(units).toEqual(
      expect.arrayContaining([
        'still:s1',
        'sheet:character:maya',
        'clip:s1',
        'prompt:music:seq-1',
        'music:seq-1',
      ])
    );
    expect(units).not.toContain('dialogue:s2');
    const other = keys(
      updateAllUnits(plan, { depth: 'images', shotIds: new Set(['s4']) })
    );
    expect(other).toEqual([]);
  });
});

it('keeps initial derived direction done while its still is missing, then restores the dependency for LLM regeneration', () => {
  const derived = planUnits(
    input({
      shots: [
        shot('s', {
          motionPromptDerived: true,
          still: 'missing',
          clip: 'missing',
        }),
      ],
    }),
    SEQ
  );
  expect(derived.find((unit) => unit.kind === 'prompt:motion')).toMatchObject({
    state: 'done',
    requires: [],
  });
  const regenerated = planUnits(
    input({
      shots: [shot('s', { motionPromptDerived: false, still: 'missing' })],
    }),
    SEQ
  );
  expect(
    regenerated.find((unit) => unit.kind === 'prompt:motion')
  ).toMatchObject({ state: 'stale', requires: [{ kind: 'still', id: 's' }] });
});
