import { describe, expect, it, vi } from 'vitest';
import { TEST_FAL_PRICING } from '@/billing/fal-pricing-fixture';
import { frameFixture, frameVariantFixture } from '@/mocks/frame-fixtures';
import { asStub } from '@/test/as-stub';

const triggerWorkflow = vi.fn(async () => 'wf_motion');
vi.doMock('@/platform/server/workflow/client', () => ({ triggerWorkflow }));
vi.doMock('@/billing/server/fal-pricing-live', () => ({
  getEffectiveFalPricing: async () => TEST_FAL_PRICING,
}));
vi.doMock('@/look/server/sequence-style', () => ({
  loadSequenceStyle: async () => null,
}));
vi.doMock('@/shots/server/scene-script', async () => ({
  ...(await vi.importActual('@/shots/server/scene-script')),
  loadSceneContextBySequence: async () => new Map(),
  resolveSceneForShot: () => ({ scene: null, script: null }),
}));

const { addModelToSequence } = await import('./sequence-models');

type Context = Parameters<typeof addModelToSequence>[0];

describe('add video model (#2272)', () => {
  it('refuses before reserving when the model cannot take a shot’s reference audio', async () => {
    const shot = {
      id: 'sht_1',
      sceneId: null,
      shotNumber: 1,
      durationMs: 3000,
    };
    const frame = frameFixture({
      id: 'frm_1',
      shotId: 'sht_1',
      sequenceId: 'seq_1',
    });
    const createReservation = vi.fn();
    const context = asStub<Context>({
      user: { id: 'u1' },
      sequence: {
        id: 'seq_1',
        organizationId: 't1',
        aspectRatio: '16:9',
        resolution: '720p',
        generateStartFrames: true,
        draftMotion: false,
      },
      scopedDb: {
        apiKeys: { hasUsableKey: vi.fn(async () => false) },
        videoVariants: {
          listBySequence: vi.fn(async () => []),
          getSelectedByShotIds: vi.fn(async () => new Map()),
          getPrimaryByShotIds: vi.fn(async () => new Map()),
        },
        shots: {
          listBySequence: vi.fn(async () => [shot]),
          ensureAnchorFrames: vi.fn(async () => {}),
        },
        frames: { listAnchorsBySequence: vi.fn(async () => [frame]) },
        frameVariants: {
          getSelectedByFrameIds: vi.fn(
            async () =>
              new Map([
                [
                  'frm_1',
                  frameVariantFixture({
                    id: 'fv_1',
                    frameId: 'frm_1',
                    sequenceId: 'seq_1',
                    url: 'https://cdn/still.jpg',
                  }),
                ],
              ])
          ),
          getPrimaryByFrameIds: vi.fn(async () => new Map()),
        },
        framePromptVersions: {
          getSelectedByFrameIds: vi.fn(async () => new Map()),
        },
        characters: {
          listWithSheets: vi.fn(async () => []),
          list: vi.fn(async () => []),
        },
        locations: { listWithReferences: vi.fn(async () => []) },
        sequenceElements: {
          list: vi.fn(async () => [
            {
              id: 'el_festival',
              token: 'FESTIVAL',
              description: null,
              imageUrl: 'https://cdn/festival.wav',
              consistencyTag: null,
              kind: 'audio',
              durationSeconds: 4,
              personInMedia: false,
            },
          ]),
        },
        shotDialogue: { getSelectedBySequence: vi.fn(async () => []) },
        shotPromptVersions: {
          getSelectedMotionByShots: vi.fn(
            async () =>
              new Map([
                [
                  'sht_1',
                  {
                    id: 'mv_1',
                    shotId: 'sht_1',
                    text: 'The crowd cheers to FESTIVAL',
                    components: null,
                    parameters: null,
                    dialogue: null,
                    audio: null,
                  },
                ],
              ])
          ),
        },
        billing: { createReservation },
      },
    });

    await expect(
      addModelToSequence(context, { variantType: 'video', model: 'kling_v4' })
    ).rejects.toThrow(
      "Kling 4.0 can't use FESTIVAL — it takes no reference audio"
    );
    expect(createReservation).not.toHaveBeenCalled();
    expect(triggerWorkflow).not.toHaveBeenCalled();
  });
});
