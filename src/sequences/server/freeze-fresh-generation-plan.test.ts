import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { StoryboardWorkflowInput } from '@/platform/server/workflow/types';
import type { StyleConfig } from '@/look/style-config';
import { asStub } from '@/test/as-stub';

const computeGenerationPlan = vi.fn(async () => [
  {
    kind: 'sheet:character',
    id: 'cast',
    state: 'missing',
    requires: [],
    cascaded: false,
    reused: false,
  },
  {
    kind: 'clip',
    id: 'shot',
    state: 'missing',
    requires: [],
    cascaded: false,
    reused: false,
  },
]);
const computePlan = vi.fn(async () => ({
  targets: [],
  references: null,
  music: null,
}));
vi.doMock('./generation-plan', () => ({ computeGenerationPlan }));
vi.doMock('@/shots/server/update-stale-plan', () => ({ computePlan }));
vi.doMock('@/billing/server/fal-pricing-live', () => ({
  getEffectiveFalPricing: vi.fn(async () => ({})),
}));
vi.doMock('@/billing/cost-estimation', () => ({
  estimatePlanCost: vi.fn(() => 0),
}));
const { freezeFreshGenerationPlan } =
  await import('./freeze-fresh-generation-plan');

const styleConfig: StyleConfig = {
  version: 2,
  look: {
    artStyle: 'watercolor',
    mood: 'quiet',
    lighting: 'soft',
    colorPalette: ['blue'],
    colorGrading: 'cool',
  },
  motion: { camera: 'locked' },
  references: [],
};
const input: StoryboardWorkflowInput & { sequenceId: string } = {
  title: 'Test',
  script: 'Hello',
  elementIds: [],
  cast: [],
  sequenceUrl: '/sequence',
  teamId: 'team',
  sequenceId: 'sequence',
  userId: 'user',
  referenceOnly: true,
  generateVoices: true,
  includeMusic: false,
  stopAt: 'references',
  imageModel: 'nano_banana_2',
  videoModel: 'grok_imagine_video_1_5',
  analysisModelId: 'google/gemini-3-flash-preview',
  aspectRatio: '16:9',
  styleConfig,
  musicPromptSource: 'ai-generated',
};
// focused planning read surface
const db = asStub<ScopedDb>({
  shots: { listBySequence: vi.fn(async () => []) },
});

describe('fresh planning checkpoint', () => {
  it('caps the materialized work and freezes click switches, style and models', async () => {
    await freezeFreshGenerationPlan(db, input);
    expect(computeGenerationPlan).toHaveBeenCalledWith(
      db,
      'sequence',
      { generateStartFrames: false, generateVoices: true, includeMusic: false },
      expect.objectContaining({
        ignoreOwnProcessing: true,
        sequenceOverrides: expect.objectContaining({
          styleConfig,
          analysisModel: input.analysisModelId,
        }),
      })
    );
    expect(computePlan).toHaveBeenLastCalledWith(
      expect.objectContaining({
        units: [
          expect.objectContaining({ kind: 'sheet:character', id: 'cast' }),
        ],
        sequenceOverrides: expect.objectContaining({
          status: 'completed',
          generateStartFrames: false,
          generateVoices: true,
          includeMusic: false,
          styleConfig,
          analysisModel: input.analysisModelId,
        }),
        renderOptions: expect.objectContaining({
          imageModels: ['nano_banana_2'],
          videoModels: ['grok_imagine_video_1_5'],
        }),
      })
    );
  });
  it('uses the auto style materialized by analysis when the original snapshot was a placeholder', async () => {
    await freezeFreshGenerationPlan(db, {
      ...input,
      pendingAutoStyleId: 'style',
    });
    expect(computePlan).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sequenceOverrides: expect.not.objectContaining({ styleConfig }),
      })
    );
  });
});
