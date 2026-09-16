/**
 * The upload likeness check (#1581) runs on DEFAULT_VISION_MODEL, which is an
 * Anthropic model — geo-blocked from a mainland-China colo, where it surfaced
 * as `classifyUploadFn failed: "LLM stream error: This model is not available
 * in your region."`. It builds its own adapter rather than going through
 * `callLLMStream`, so it needs the #1259 fallback wired explicitly; this pins
 * that it is.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REGION_FALLBACK_VISION_MODEL } from '@/models/region-policy';
import { TALENT_VISION_MODEL } from './talent-vision';

const ANALYSIS = {
  isCharacterSheet: false,
  subjectKind: 'human',
  suggestedName: 'Mara',
  description: 'A woman in her 30s with a sharp bob.',
  age: '30s',
  gender: 'female',
  ethnicity: '',
  physicalDescription: 'Sharp bob',
  standardClothing: 'Leather jacket',
  distinguishingFeatures: '',
};

const adapterModels: string[] = [];
/** What each successive `chat()` call should do, oldest first. */
const chatBehaviours: Array<'region-block' | 'other-error' | 'ok'> = [];

vi.mock('@/platform/server/storage/external-url', () => ({
  toVisionImageSource: vi.fn(async () => ({
    type: 'url' as const,
    url: 'https://example.test/talent.png',
  })),
}));

vi.mock('@/platform/server/observability/ai-otel', () => ({
  aiObservabilityMiddleware: () => [],
}));

vi.mock('@/models/server/create-adapter', () => ({
  createAdapter: (model: string) => {
    adapterModels.push(model);
    return { model };
  },
}));

vi.mock('@tanstack/ai', () => ({
  chat: () => {
    const behaviour = chatBehaviours.shift() ?? 'ok';
    return (async function* () {
      if (behaviour !== 'ok') {
        yield {
          type: 'RUN_ERROR',
          message:
            behaviour === 'region-block'
              ? 'This model is not available in your region.'
              : '402 Insufficient credits',
          model: adapterModels.at(-1),
        };
        return;
      }
      yield {
        type: 'CUSTOM',
        name: 'structured-output.complete',
        value: { object: ANALYSIS },
      };
    })();
  },
}));

const { analyzeTalentMedia } = await import('./talent-vision');

beforeEach(() => {
  adapterModels.length = 0;
  chatBehaviours.length = 0;
});

describe('analyzeTalentMedia region fallback', () => {
  it('retries a region-blocked call on the vision fallback model', async () => {
    chatBehaviours.push('region-block', 'ok');

    const result = await analyzeTalentMedia({
      imageUrls: ['/r2/team-1/uploads/talent.png'],
    });

    expect(adapterModels).toEqual([
      TALENT_VISION_MODEL,
      REGION_FALLBACK_VISION_MODEL,
    ]);
    // Billing must follow the model that actually answered, not the default.
    expect(result.model).toBe(REGION_FALLBACK_VISION_MODEL);
    expect(result.subjectKind).toBe('human');
  });

  it('stays on the default model when nothing is blocked', async () => {
    chatBehaviours.push('ok');

    const result = await analyzeTalentMedia({
      imageUrls: ['/r2/team-1/uploads/talent.png'],
    });

    expect(adapterModels).toEqual([TALENT_VISION_MODEL]);
    expect(result.model).toBe(TALENT_VISION_MODEL);
  });

  it('rethrows a non-region failure without a second call', async () => {
    chatBehaviours.push('other-error', 'ok');

    await expect(
      analyzeTalentMedia({ imageUrls: ['/r2/team-1/uploads/talent.png'] })
    ).rejects.toThrow('402 Insufficient credits');
    expect(adapterModels).toEqual([TALENT_VISION_MODEL]);
  });
});
