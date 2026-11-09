import { describe, expect, it, vi } from 'vitest';
import { TEST_FAL_PRICING } from '@/billing/fal-pricing-fixture';
import { ZERO_MICROS } from '@/billing/money';
import { asStub } from '@/test/as-stub';

const triggerWorkflow = vi.fn(async () => 'wf_image');
vi.doMock('@/platform/server/workflow/client', () => ({ triggerWorkflow }));
vi.doMock('@/billing/server/fal-pricing-live', () => ({
  getEffectiveFalPricing: async () => TEST_FAL_PRICING,
}));
const scene = {
  sceneId: 'scn_1',
  metadata: { location: 'INT. BAKERY KITCHEN', timeOfDay: 'morning' },
  continuity: {},
  originalScript: { extract: 'MARA\nWe open in five minutes.', dialogue: [] },
};
vi.doMock('@/shots/server/scene-script', async () => ({
  ...(await vi.importActual('@/shots/server/scene-script')),
  loadSceneContextBySequence: async () => new Map(),
  resolveSceneForShot: () => ({ scene, script: scene.originalScript }),
}));

const { addModelToSequence } = await import('./sequence-models');

type Context = Parameters<typeof addModelToSequence>[0];

describe('add image model (#2291)', () => {
  it('counts a shot with no image prompt and no spec as skipped, never sends the script', async () => {
    const context = asStub<Context>({
      user: { id: 'u1' },
      sequence: {
        id: 'seq_1',
        organizationId: 't1',
        aspectRatio: '16:9',
        resolution: '720p',
        styleId: null,
        styleConfig: null,
      },
      scopedDb: {
        inputManifests: { record: vi.fn(async () => undefined) },
        apiKeys: { hasUsableKey: vi.fn(async () => false) },
        frameVariants: { listModelsForSequence: vi.fn(async () => []) },
        shots: {
          listBySequence: vi.fn(async () => [
            { id: 'sht_written', sceneId: 'scn_1' },
            { id: 'sht_added', sceneId: 'scn_1' },
          ]),
          ensureAnchorFrames: vi.fn(async () => {}),
        },
        frames: {
          listBySequence: vi.fn(async () => [
            { id: 'frm_written', shotId: 'sht_written' },
            { id: 'frm_added', shotId: 'sht_added' },
          ]),
        },
        framePromptVersions: {
          getSelectedByFrameIds: vi.fn(
            async () =>
              new Map([['frm_written', { id: 'fpv_1', text: 'A baker' }]])
          ),
        },
        shotSpecVersions: { getSelected: vi.fn(async () => null) },
        characters: { listWithSheets: vi.fn(async () => []) },
        locations: { listWithReferences: vi.fn(async () => []) },
        sequenceElements: { list: vi.fn(async () => []) },
        billing: {
          createReservation: vi.fn(async () => ({
            ok: true,
            reservationId: 'res_1',
            remaining: ZERO_MICROS,
            replay: false,
          })),
        },
      },
    });

    const result = await addModelToSequence(context, {
      variantType: 'image',
      model: 'seedream_v5',
    });

    expect(result).toMatchObject({ count: 1, failed: 0, skipped: 1 });
    expect(triggerWorkflow).toHaveBeenCalledTimes(1);
    expect(triggerWorkflow).toHaveBeenCalledWith(
      '/image',
      expect.objectContaining({ shotId: 'sht_written', prompt: 'A baker' }),
      expect.anything()
    );
  });
});
