import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHOT_PREVIEW_IMAGE_MODEL } from '@/models/models';
import { simpleHash } from '@/platform/hash';
import { buildPreviewPrompt } from '@/sequences/server/poster-prompt';
import type { ShotContext } from '@/shots/shot-access.fn';
import { asStub } from '@/test/as-stub';

const mocks = vi.hoisted(() => ({ trigger: vi.fn() }));
vi.mock('@/platform/server/workflow/client', () => ({
  triggerWorkflow: mocks.trigger,
}));
vi.mock('@/billing/server/fal-pricing-live', () => ({
  getEffectiveFalPricing: vi.fn(async () => ({})),
}));
import { redrawShotPreview } from './shot-preview';

const MOTION = 'Wide shot. Mara crosses the hall. Camera: slow push in';
const getLatestPreview = vi.fn();
const hasEnoughCredits = vi.fn();

const contextFor = (useStartFrame: boolean) =>
  // only the fields read by this helper are needed in the fixture
  asStub<ShotContext>({
    shot: { id: 'shot-1', useStartFrame },
    frame: { id: 'frame-1' },
    sequence: {
      id: 'sequence-1',
      generateStartFrames: false,
      aspectRatio: '16:9',
    },
    user: { id: 'user-1' },
    teamId: 'team-1',
    scene: null,
    scopedDb: {
      characters: { list: vi.fn(async () => []) },
      frameVariants: { getLatestPreview },
      apiKeys: { hasUsableKey: vi.fn(async () => false) },
      billing: { hasEnoughCredits },
    },
  });

beforeEach(() => {
  vi.clearAllMocks();
  getLatestPreview.mockResolvedValue(null);
  hasEnoughCredits.mockResolvedValue(true);
  mocks.trigger.mockResolvedValue('run-1');
});

describe('redrawShotPreview', () => {
  it('draws a reference-only shot from its motion prompt', async () => {
    await redrawShotPreview(contextFor(false), MOTION);

    expect(mocks.trigger).toHaveBeenCalledWith(
      '/image',
      expect.objectContaining({
        prompt: buildPreviewPrompt(MOTION, []),
        model: SHOT_PREVIEW_IMAGE_MODEL,
        shotId: 'shot-1',
        frameId: 'frame-1',
        skipStorage: true,
      }),
      undefined
    );
  });

  it('leaves a shot with a start frame alone', async () => {
    await redrawShotPreview(contextFor(true), MOTION);
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('does not redraw a sketch of the same prompt', async () => {
    getLatestPreview.mockResolvedValue({
      promptHash: simpleHash(buildPreviewPrompt(MOTION, [])),
    });
    await redrawShotPreview(contextFor(false), MOTION);
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('spends nothing and keeps the edit when credits run out', async () => {
    hasEnoughCredits.mockResolvedValue(false);
    await expect(
      redrawShotPreview(contextFor(false), MOTION)
    ).resolves.toBeUndefined();
    expect(mocks.trigger).not.toHaveBeenCalled();
  });
});
