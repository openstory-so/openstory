/**
 * The loader half of the generation plan (#1816): live rows → verdicts. The
 * cascade itself is covered by `../generation-plan.test.ts`; this pins the
 * mapping for the reported bug, where the hand-added characters exist only
 * as `pending` rows with no sheet.
 */

import type { ScopedDb } from '@/platform/server/db/scoped';
import { describe, expect, it, vi } from 'vitest';

const frame = { id: 'f1', shotId: 's1', pendingPromoteVersionId: null };

vi.doMock('@/shots/server/shot-staleness', () => ({
  UNTRACKED_STALENESS: {},
  loadShotStalenessBatch: vi.fn(() =>
    Promise.resolve({
      anchorsByShot: new Map([['s1', frame]]),
      sceneContext: new Map(),
      selectedByFrame: new Map([['f1', { url: 'https://x/still.jpg' }]]),
      refs: { characters: [], locations: [], elements: [], style: null },
    })
  ),
  loadShotStalenessReads: vi.fn(() =>
    Promise.resolve({
      selectedPromptByFrame: new Map([
        ['f1', { text: 'Maya hands Ravi a cup of tea' }],
      ]),
      latestHashedMotionByShot: new Map(),
      selectedMotionByShot: new Map([['s1', {}]]),
      liveVisualClaimsByFrame: new Map(),
      liveImageClaimsByFrame: new Map(),
      liveMotionClaimsByShot: new Map(),
      dialogueOf: () => ({ dialogue: { presence: false, lines: [] } }),
    })
  ),
  // The bible edit moved the prompt's hash; the still's own hash still holds.
  computeShotStaleness: vi.fn(() =>
    Promise.resolve({
      thumbnail: 'fresh',
      visualPrompt: 'stale',
      motionPrompt: 'fresh',
    })
  ),
}));
vi.doMock('@/shots/server/shot-media-staleness', () => ({
  loadShotMediaStates: vi.fn(() =>
    Promise.resolve(
      new Map([
        [
          's1',
          {
            staleness: { dialogue: 'untracked', video: 'untracked' },
            clipInFlight: false,
          },
        ],
      ])
    )
  ),
}));
vi.doMock('@/shots/server/scene-script', () => ({
  resolveSceneForShot: () => ({ scene: null, script: null }),
}));
vi.doMock('@/audio/server/music-staleness', () => ({
  readMusicPromptStaleness: () =>
    Promise.resolve({ musicPrompt: 'untracked', musicTrack: 'untracked' }),
}));
vi.doMock('@/cast/server/production-staleness', () => ({
  readReferenceStaleness: () => Promise.resolve({ status: 'fresh' }),
}));

const { computeGenerationPlan } = await import('./generation-plan');

function character(id: string, name: string, sheetImageUrl: string | null) {
  return {
    id,
    name,
    characterId: id,
    consistencyTag: null,
    voiceOnly: false,
    useVoice: null,
    voiceId: null,
    sheetStatus: sheetImageUrl ? 'completed' : 'pending',
    sheetImageUrl,
    pendingPromoteSheetVersionId: null,
    pendingPromoteVoiceVersionId: null,
  };
}

function asScopedDb<T>(stub: T): ScopedDb {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub
  return stub as unknown as ScopedDb;
}

describe('computeGenerationPlan', () => {
  const planStates = async (
    includeMusic: boolean,
    existingMusic = false,
    ownProcessing = false
  ) => {
    const plan = await computeGenerationPlan(
      asScopedDb({
        sequences: {
          getById: () =>
            Promise.resolve({
              id: 'seq-1',
              status: ownProcessing ? 'processing' : 'completed',
              generateStartFrames: true,
              generateVoices: false,
              includeMusic,
              generationStopAt: 'references',
              musicPrompt: existingMusic ? 'Saved score' : null,
              musicUrl: existingMusic ? 'https://x/score.mp3' : null,
              musicStatus: 'pending',
            }),
        },
        shots: {
          listBySequence: () =>
            Promise.resolve([{ id: 's1', sceneId: null, audioClips: null }]),
        },
        characters: {
          list: () =>
            Promise.resolve([
              character('maya', 'Maya', 'https://x/maya.png'),
              character('ravi', 'Ravi', null),
            ]),
        },
        sequenceLocations: { list: () => Promise.resolve([]) },
        frameVariants: {
          getPrimaryByFrameIds: () => Promise.resolve(new Map()),
        },
        shotDialogue: {
          listShotIdsWithLiveClaim: () => Promise.resolve(new Set()),
        },
      }),
      'seq-1',
      undefined,
      { ignoreOwnProcessing: ownProcessing }
    );
    return Object.fromEntries(plan.map((u) => [`${u.kind}:${u.id}`, u.state]));
  };

  it('a hand-added pending character owes a sheet and stales the stills that name it', async () => {
    expect(await planStates(true)).toMatchObject({
      'sheet:character:maya': 'done',
      'sheet:character:ravi': 'missing',
      'prompt:visual:s1': 'stale',
      'still:s1': 'stale',
      'prompt:motion:s1': 'done',
      'clip:s1': 'missing',
      'prompt:music:seq-1': 'missing',
      'music:seq-1': 'missing',
    });
  });

  it('an existing track and prompt are done, so continuing to Music does not regenerate them', async () => {
    expect(await planStates(true, true)).toMatchObject({
      'prompt:music:seq-1': 'done',
      'music:seq-1': 'done',
    });
  });

  it('with the Music switch off the sequence owes no music', async () => {
    const state = await planStates(false);
    expect(state).not.toHaveProperty(['music:seq-1']);
    expect(state).not.toHaveProperty(['prompt:music:seq-1']);
  });

  it('the fresh handoff sees pending materialized rows as owed work, never its own processing banner', async () => {
    const states = await planStates(true, false, true);
    expect(states['sheet:character:ravi']).toBe('missing');
    expect(Object.values(states)).not.toContain('running');
  });

  it('a sequence with no shots has an empty plan', async () => {
    const plan = await computeGenerationPlan(
      asScopedDb({
        sequences: { getById: () => Promise.resolve({ id: 'seq-1' }) },
        shots: { listBySequence: () => Promise.resolve([]) },
      }),
      'seq-1'
    );
    expect(plan).toEqual([]);
  });
});
