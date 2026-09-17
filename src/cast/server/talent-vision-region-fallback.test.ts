/**
 * The upload likeness check (#1581) runs on DEFAULT_VISION_MODEL, which is an
 * Anthropic model — geo-blocked from a mainland-China colo, where it surfaced
 * as `classifyUploadFn failed: "LLM stream error: This model is not available
 * in your region."`. It used to drive `chat()` through its own adapter, which
 * is what left it outside the #1259 fallback; it now goes through
 * `callLLMStream`. These pin the parts that are this helper's own: that the
 * fallback reaches it at all, that the retry re-resolves the key rather than
 * reusing one resolved for the blocked model, and that the answering model
 * (not the requested constant) is what gets billed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as tanstackAi from '@tanstack/ai';
import { REGION_FALLBACK_MODEL } from '@/models/region-policy';

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

vi.doMock('#env', () => ({
  getEnv: () => ({
    OPENROUTER_KEY: 'test-key',
    VITE_APP_URL: 'http://localhost:3000',
    VITE_APP_NAME: 'Test',
  }),
}));

vi.doMock('@/platform/server/storage/external-url', () => ({
  toVisionImageSource: async () => ({
    type: 'url' as const,
    url: 'https://example.test/talent.png',
  }),
}));

vi.doMock('@/platform/server/observability/ai-otel', () => ({
  aiObservabilityMiddleware: () => [],
}));

/** Models handed to createAdapter, in call order. */
const adapterModels: string[] = [];
vi.doMock('@/models/server/create-adapter', () => ({
  createAdapter: (model: string) => {
    adapterModels.push(model);
    return { kind: 'text', name: 'mock' };
  },
  resolveNativeGrokModel: () => undefined,
  resolveNativeGeminiModel: () => undefined,
}));

/** What each successive `chat()` call should do, oldest first. */
const chatBehaviours: Array<'region-block' | 'other-error' | 'ok'> = [];
vi.doMock('@tanstack/ai', () => ({
  ...tanstackAi,
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

// Dynamic import so the vi.doMock calls above are in effect when
// talent-vision (and its transitive `external-url` / `create-adapter` /
// `@tanstack/ai` imports) resolves. A static import here is hoisted above
// them and caches the real modules, defeating every mock in this file.
const { analyzeTalentMedia, TALENT_VISION_MODEL } =
  await import('./talent-vision');

const IMAGES = ['/r2/team-1/uploads/talent.png'];

beforeEach(() => {
  adapterModels.length = 0;
  chatBehaviours.length = 0;
});

describe('analyzeTalentMedia region fallback', () => {
  it('retries a region-blocked call on the fallback model', async () => {
    chatBehaviours.push('region-block', 'ok');

    const result = await analyzeTalentMedia({ imageUrls: IMAGES });

    expect(adapterModels).toEqual([TALENT_VISION_MODEL, REGION_FALLBACK_MODEL]);
    // Billing must follow the model that actually answered, not the default.
    expect(result.model).toBe(REGION_FALLBACK_MODEL);
    expect(result.subjectKind).toBe('human');
  });

  it('re-resolves the key for the model the retry actually calls', async () => {
    chatBehaviours.push('region-block', 'ok');
    // A key resolved for the Anthropic model need not be carried by the via
    // that serves the fallback, so the retry must ask again rather than
    // reuse it (an LLMTR key for an unmapped model is a createAdapter throw).
    const resolveLlmKey = vi.fn(async () => ({
      key: 'k',
      via: 'openrouter' as const,
      source: 'platform' as const,
    }));

    const result = await analyzeTalentMedia({
      imageUrls: IMAGES,
      llmKey: { key: 'k', via: 'llmtr', source: 'team' },
      resolveLlmKey,
    });

    expect(resolveLlmKey).toHaveBeenCalledExactlyOnceWith(
      REGION_FALLBACK_MODEL
    );
    // …and the re-resolved via is what prices the call, not the original.
    expect(result.model).toBe(REGION_FALLBACK_MODEL);
  });

  it('stays on the default model when nothing is blocked', async () => {
    chatBehaviours.push('ok');

    const result = await analyzeTalentMedia({ imageUrls: IMAGES });

    expect(adapterModels).toEqual([TALENT_VISION_MODEL]);
    expect(result.model).toBe(TALENT_VISION_MODEL);
  });

  it('rethrows a non-region failure without a second call', async () => {
    chatBehaviours.push('other-error', 'ok');

    await expect(analyzeTalentMedia({ imageUrls: IMAGES })).rejects.toThrow(
      '402 Insufficient credits'
    );
    expect(adapterModels).toEqual([TALENT_VISION_MODEL]);
  });
});
