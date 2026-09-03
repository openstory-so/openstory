/**
 * Guards that keep reference-only from degrading into a different kind of
 * render. Each one covers a path where "no start frame" had to stop meaning
 * "the image failed" — the review of #1405 found all four unprotected.
 */

import { describe, expect, it } from 'vitest';
import { canRenderReferenceOnly } from './motion-generation';
import { estimateFalCost } from '@/lib/ai/fal-cost';
import { estimateVideoCost } from '@/lib/billing/cost-estimation';
import { micros } from '@/lib/billing/money';
import {
  isBatchMotionEligible,
  isMotionGenerating,
} from '@/lib/shots/shot-view';
import {
  referenceOnlyCapableWith,
  referenceOnlyMotionModels,
} from '@/lib/ai/models';
import {
  createSequenceSchema,
  REFERENCE_ONLY_MODEL_ERROR,
  REFERENCE_ONLY_REQUIRES_MOTION_ERROR,
  updateSequenceSchema,
} from '@/lib/schemas/sequence.schemas';

const xaiKeyDb = {
  userId: 'u1',
  resolveKey: () => Promise.resolve({ key: 'k', source: 'platform' as const }),
  resolveOptionalKey: (p: string) =>
    Promise.resolve(
      p === 'xai' ? { key: 'xai-key', source: 'platform' as const } : undefined
    ),
};
const noKeysDb = {
  ...xaiKeyDb,
  resolveOptionalKey: () => Promise.resolve(undefined),
};

describe('canRenderReferenceOnly', () => {
  it('accepts Seedance on any via — it has a fal reference-to-video route', async () => {
    expect(await canRenderReferenceOnly('seedance_v2_5', noKeysDb)).toBe(true);
    expect(await canRenderReferenceOnly('seedance_v2', noKeysDb)).toBe(true);
  });

  it('accepts Grok Imagine only when an xAI key resolves', async () => {
    // Grok DOES take references without a start frame — but only on the native
    // xAI route. Its fal id is an image-to-video endpoint that needs image_url.
    expect(
      await canRenderReferenceOnly('grok_imagine_video_1_5', xaiKeyDb)
    ).toBe(true);
    expect(
      await canRenderReferenceOnly('grok_imagine_video_1_5', noKeysDb)
    ).toBe(false);
  });

  it('rejects a model with no reference route on either via', async () => {
    expect(await canRenderReferenceOnly('kling_v3_pro', xaiKeyDb)).toBe(false);
    expect(await canRenderReferenceOnly('veo3_1', xaiKeyDb)).toBe(false);
  });
});

describe('referenceOnlyCapableWith / referenceOnlyMotionModels', () => {
  it('is the same rule canRenderReferenceOnly enforces, minus the key lookup', async () => {
    expect(
      referenceOnlyCapableWith('grok_imagine_video_1_5', { xai: true })
    ).toBe(true);
    expect(referenceOnlyCapableWith('grok_imagine_video_1_5', {})).toBe(false);
    expect(
      await canRenderReferenceOnly('grok_imagine_video_1_5', xaiKeyDb)
    ).toBe(referenceOnlyCapableWith('grok_imagine_video_1_5', { xai: true }));
  });

  it('BytePlus adds nothing — Seedance already qualifies on fal', () => {
    expect(referenceOnlyMotionModels({ byteplus: true })).toEqual(
      referenceOnlyMotionModels()
    );
  });

  it('the xAI list is the conservative list plus Grok', () => {
    const conservative = referenceOnlyMotionModels();
    const withXai = referenceOnlyMotionModels({ xai: true });
    expect(withXai).toContain('grok_imagine_video_1_5');
    expect(conservative).not.toContain('grok_imagine_video_1_5');
    expect(withXai.length).toBe(conservative.length + 1);
  });
});

describe('estimateVideoCost', () => {
  const pricing: Parameters<typeof estimateVideoCost>[2]['pricing'] = {
    'bytedance/seedance-2.5/reference-to-video': {
      unit: 'seconds',
      unitPrice: micros(1000),
    },
    'bytedance/seedance-2.5/image-to-video': {
      unit: 'seconds',
      unitPrice: micros(2000),
    },
  };

  it('prices reference-to-video even with no matched sheets', () => {
    // The shot routes to r2v regardless; resolving on hasReferenceImages alone
    // priced the i2v row for a job that never runs there.
    const withFlag = estimateVideoCost('seedance_v2_5', 5, {
      pricing,
      hasReferenceImages: false,
      referenceOnly: true,
    });
    const withoutFlag = estimateVideoCost('seedance_v2_5', 5, {
      pricing,
      hasReferenceImages: false,
    });
    // Pinned to the r2v row, not merely "different from i2v": any wrong route
    // that happens to differ would pass an inequality.
    const at = (endpointId: string) =>
      Number(estimateFalCost(endpointId, { durationSeconds: 5 }, pricing));
    expect(Number(withFlag)).toBe(
      at('bytedance/seedance-2.5/reference-to-video')
    );
    expect(Number(withoutFlag)).toBe(
      at('bytedance/seedance-2.5/image-to-video')
    );
    expect(Number(withFlag)).toBeGreaterThan(0);
  });

  it('does not throw for a model with no fal reference-to-video route', () => {
    // resolveMotionEndpoint throws there; an estimator must not.
    expect(() =>
      estimateVideoCost('grok_imagine_video_1_5', 5, {
        pricing,
        referenceOnly: true,
      })
    ).not.toThrow();
  });
});

describe('isBatchMotionEligible', () => {
  const refOnlyShot = {
    frame: { imageStatus: 'pending' as const },
    image: null,
    videoStatus: 'pending' as const,
  };

  it('needs no still in reference-only mode', () => {
    // imageStatus stays 'pending' forever when the image pass never runs, so
    // the still half of the rule used to exclude every shot — hiding the
    // "Generate all motion" button outright.
    expect(isBatchMotionEligible(refOnlyShot, true)).toBe(true);
    expect(isBatchMotionEligible(refOnlyShot, false)).toBe(false);
  });

  it('still requires a completed still on the image-to-video path', () => {
    expect(
      isBatchMotionEligible(
        { ...refOnlyShot, frame: { imageStatus: 'completed' }, image: null },
        false
      )
    ).toBe(false);
    expect(
      isBatchMotionEligible(
        {
          ...refOnlyShot,
          frame: { imageStatus: 'completed' },
          image: { url: 'https://x/a.png' },
        },
        false
      )
    ).toBe(true);
  });

  it('reports an in-flight render without a still', () => {
    expect(
      isMotionGenerating({ ...refOnlyShot, videoStatus: 'generating' }, true)
    ).toBe(true);
  });
});

describe('sequence schemas', () => {
  const base = {
    script: 'a'.repeat(20),
    styleId: 'st_1',
    videoModels: ['seedance_v2_5'],
  };

  it('rejects reference-only with motion off — it would render nothing', () => {
    const r = createSequenceSchema.safeParse({
      ...base,
      generateStartFrames: false,
      autoGenerateMotion: false,
      autoGenerateMusic: false,
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain(
      REFERENCE_ONLY_REQUIRES_MOTION_ERROR
    );
  });

  it('rejects reference-only with an incapable variant model', () => {
    const r = createSequenceSchema.safeParse({
      ...base,
      videoModels: ['seedance_v2_5', 'kling_v3_pro'],
      generateStartFrames: false,
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain(REFERENCE_ONLY_MODEL_ERROR);
  });

  it('accepts reference-only with motion on and capable models', () => {
    expect(
      createSequenceSchema.safeParse({ ...base, generateStartFrames: false })
        .success
    ).toBe(true);
  });

  it('lets Grok through — the schema cannot see vias, createSequences re-asks', () => {
    // Isomorphic and pure, so it asks the widest question. The team-scoped
    // answer needs an xAI key and lives in `createSequences`.
    expect(
      createSequenceSchema.safeParse({
        ...base,
        videoModels: ['grok_imagine_video_1_5'],
        generateStartFrames: false,
      }).success
    ).toBe(true);
  });

  it('refuses to update generateStartFrames on an existing sequence', () => {
    // Toggling it past the create-time model gate rewrites what every already
    // rendered shot means — on, approved stills are dropped from the request
    // while their prompts still assume one.
    const parsed = updateSequenceSchema.parse({ generateStartFrames: true });
    expect(Object.keys(parsed)).not.toContain('generateStartFrames');
  });
});
