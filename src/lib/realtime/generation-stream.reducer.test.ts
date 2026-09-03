import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  generationStreamReducer,
  type GenerationStreamAction,
  type GenerationStreamState,
} from './generation-stream.reducer';

const SHOT_ID = 'shot-1';

function apply(
  state: GenerationStreamState,
  ...actions: GenerationStreamAction[]
): GenerationStreamState {
  return actions.reduce(generationStreamReducer, state);
}

function withCreatedShot(): GenerationStreamState {
  return apply(createInitialState(), {
    type: 'SHOT_CREATED',
    payload: { shotId: SHOT_ID, sceneId: 'scene-1', orderIndex: 0 },
  });
}

describe('generationStreamReducer — shot retry tracking (#882)', () => {
  it('records image retry state from an IMAGE_PROGRESS retry signal', () => {
    const state = apply(withCreatedShot(), {
      type: 'IMAGE_PROGRESS',
      payload: {
        shotId: SHOT_ID,
        status: 'generating',
        retry: { attempt: 2, maxAttempts: 3 },
      },
    });

    expect(state.shotRetries.get(SHOT_ID)).toEqual({
      image: { attempt: 2, maxAttempts: 3 },
    });
  });

  it('tracks retry even without a preceding SHOT_CREATED (regenerating an existing shot)', () => {
    const state = apply(createInitialState(), {
      type: 'IMAGE_PROGRESS',
      payload: {
        shotId: SHOT_ID,
        status: 'generating',
        retry: { attempt: 2, maxAttempts: 3 },
      },
    });

    // Shot isn't in the shots map, but its retry state is still surfaced.
    expect(state.shots.has(SHOT_ID)).toBe(false);
    expect(state.shotRetries.get(SHOT_ID)).toEqual({
      image: { attempt: 2, maxAttempts: 3 },
    });
  });

  it('clears image retry state on a terminal IMAGE_PROGRESS', () => {
    const state = apply(
      withCreatedShot(),
      {
        type: 'IMAGE_PROGRESS',
        payload: {
          shotId: SHOT_ID,
          status: 'generating',
          retry: { attempt: 2, maxAttempts: 3 },
        },
      },
      {
        type: 'IMAGE_PROGRESS',
        payload: {
          shotId: SHOT_ID,
          status: 'completed',
          thumbnailUrl: 'https://example.com/i.jpg',
        },
      }
    );

    expect(state.shotRetries.has(SHOT_ID)).toBe(false);
    expect(state.shots.get(SHOT_ID)?.imageStatus).toBe('completed');
  });

  it('keeps image and video retry state independent', () => {
    const state = apply(
      withCreatedShot(),
      {
        type: 'IMAGE_PROGRESS',
        payload: {
          shotId: SHOT_ID,
          status: 'generating',
          retry: { attempt: 2, maxAttempts: 3 },
        },
      },
      {
        type: 'VIDEO_PROGRESS',
        payload: {
          shotId: SHOT_ID,
          status: 'generating',
          retry: { attempt: 3, maxAttempts: 3 },
        },
      }
    );

    expect(state.shotRetries.get(SHOT_ID)).toEqual({
      image: { attempt: 2, maxAttempts: 3 },
      video: { attempt: 3, maxAttempts: 3 },
    });

    // Clearing the video retry leaves the image retry intact.
    const next = apply(state, {
      type: 'VIDEO_PROGRESS',
      payload: { shotId: SHOT_ID, status: 'completed' },
    });
    expect(next.shotRetries.get(SHOT_ID)).toEqual({
      image: { attempt: 2, maxAttempts: 3 },
    });
  });

  it('no-ops (returns same state) on a non-retry update with no prior retry', () => {
    const base = withCreatedShot();
    const next = apply(base, {
      type: 'IMAGE_PROGRESS',
      payload: { shotId: SHOT_ID, status: 'generating' },
    });
    // shots map updates, but shotRetries reference is unchanged.
    expect(next.shotRetries).toBe(base.shotRetries);
  });

  it('records a retry with no maxAttempts (image side leans on CF default budget)', () => {
    const state = apply(withCreatedShot(), {
      type: 'IMAGE_PROGRESS',
      payload: {
        shotId: SHOT_ID,
        status: 'generating',
        retry: { attempt: 2 },
      },
    });

    expect(state.shotRetries.get(SHOT_ID)).toEqual({
      image: { attempt: 2 },
    });
  });

  it('clears all retry state on PREVIEW_REPLACED', () => {
    const state = apply(withCreatedShot(), {
      type: 'IMAGE_PROGRESS',
      payload: {
        shotId: SHOT_ID,
        status: 'generating',
        retry: { attempt: 2, maxAttempts: 3 },
      },
    });
    expect(state.shotRetries.size).toBe(1);

    const cleared = apply(state, {
      type: 'PREVIEW_REPLACED',
      payload: { newSceneCount: 4 },
    });
    expect(cleared.shotRetries.size).toBe(0);
  });
});

describe('generationStreamReducer — stop-at banner (#1408)', () => {
  it('does not grow a Script-only banner when Casting is announced', () => {
    const scriptOnly = createInitialState({ stopAt: 'script' });
    expect(scriptOnly.phases.map((p) => p.shortName)).toEqual(['Casting']);

    // Casting rides on the Script phase number — it recaptions, never sprouts.
    const next = apply(scriptOnly, {
      type: 'PHASE_START',
      payload: {
        phase: 1,
        phaseName: 'Casting characters & locations…',
      },
    });

    expect(next.phases.map((p) => p.shortName)).toEqual(['Casting']);
    expect(next.phases[0]?.phaseName).toBe('Casting characters & locations…');
  });

  it('grows a banner sized for an early stop when a Continue runs past it', () => {
    const references = createInitialState({ stopAt: 'references' });
    expect(references.phases.map((p) => p.shortName)).toEqual([
      'Casting',
      'References',
    ]);

    const next = apply(references, {
      type: 'PHASE_START',
      payload: { phase: 4, phaseName: 'Generating motion & music…' },
    });

    expect(next.phases.map((p) => p.shortName)).toEqual([
      'Casting',
      'References',
      'Music & Motion',
    ]);
    expect(next.phases.map((p) => p.status)).toEqual([
      'completed',
      'completed',
      'active',
    ]);
    expect(next.currentPhase).toBe(4);
  });
});

describe('progress phases in reference-only', () => {
  const shortNames = (config?: Parameters<typeof createInitialState>[0]) =>
    createInitialState(config).phases.map((p) => p.shortName);

  it('drops the shot-images phase entirely', () => {
    // Nothing is left in the images stage: the stills are skipped and the
    // motion prompts finished back in references. Relabelling it would leave
    // a step the user watches while it does nothing; the workflow emits no
    // images event at all, so the chip would sit pending until motion swept it.
    expect(shortNames({ stopAt: 'music', referenceOnly: true })).toEqual([
      'Casting',
      'References',
      'Music & Motion',
    ]);

    expect(
      createInitialState({ stopAt: 'music', referenceOnly: true }).phases.map(
        (p) => p.phase
      )
    ).toEqual([1, 2, 4]);
  });

  it('leaves the image-rendering modes alone', () => {
    expect(shortNames({ stopAt: 'music' })).toEqual([
      'Casting',
      'References',
      'Images',
      'Music & Motion',
    ]);
  });

  it('sweeps the earlier steps complete when motion starts', () => {
    // The rail has a gap where images would be; motion arriving must still
    // mark the earlier stages completed rather than leaving them mid-flight.
    const state = apply(
      createInitialState({ stopAt: 'music', referenceOnly: true }),
      {
        type: 'PHASE_START',
        payload: { phase: 4, phaseName: 'Generating motion & music…' },
      }
    );

    expect(state.phases.map((p) => p.status)).toEqual([
      'completed',
      'completed',
      'active',
    ]);
  });
});
