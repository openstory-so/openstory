import { describe, expect, it } from 'vitest';
import type { ShotVariant } from '@/lib/db/schema';
import { computeSequenceModelCoverage } from './sequence-model-coverage';

/**
 * Tests for the header dropdowns' sequence-wide per-model coverage (#547):
 * "has this model generated across the whole sequence, and is it the primary".
 */

const baseVariant: ShotVariant = {
  id: 'v',
  shotId: 'f1',
  sequenceId: 'seq1',
  variantType: 'image',
  model: 'nano_banana_2',
  url: 'https://r2/img.png',
  storagePath: 'team/seq/img.png',
  shotVariantUrl: null,
  shotVariantPath: null,
  shotVariantStatus: null,
  shotVariantWorkflowRunId: null,
  status: 'completed',
  workflowRunId: null,
  generatedAt: null,
  error: null,
  promptHash: null,
  inputHash: null,
  divergedAt: null,
  discardedAt: null,
  durationMs: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function variant(overrides: Partial<ShotVariant>): ShotVariant {
  return { ...baseVariant, ...overrides };
}

describe('computeSequenceModelCoverage', () => {
  it('marks the primary model as set and reports partial coverage for an added model', () => {
    const variants = [
      // Primary model: generated for all 3 shots.
      variant({ id: 'a1', shotId: 'f1', model: 'nano_banana_2' }),
      variant({ id: 'a2', shotId: 'f2', model: 'nano_banana_2' }),
      variant({ id: 'a3', shotId: 'f3', model: 'nano_banana_2' }),
      // Added model: generated for only 1 of the 3.
      variant({ id: 'b1', shotId: 'f1', model: 'flux_pro' }),
    ];

    const coverage = computeSequenceModelCoverage({
      variants,
      variantType: 'image',
      primaryModel: 'nano_banana_2',
    });

    expect(coverage.get('nano_banana_2')).toEqual({
      status: 'set',
      completed: 3,
      total: 3,
    });
    expect(coverage.get('flux_pro')).toEqual({
      status: 'completed',
      completed: 1,
      total: 3,
    });
  });

  it('reports generating when an added model has pending rows and nothing completed', () => {
    const variants = [
      variant({ id: 'a1', shotId: 'f1', model: 'nano_banana_2' }),
      variant({
        id: 'b1',
        shotId: 'f1',
        model: 'flux_pro',
        status: 'generating',
        url: null,
      }),
    ];

    const coverage = computeSequenceModelCoverage({
      variants,
      variantType: 'image',
      primaryModel: 'nano_banana_2',
    });

    expect(coverage.get('flux_pro')?.status).toBe('generating');
    expect(coverage.get('flux_pro')?.completed).toBe(0);
  });

  it('reports failed when an added model has only failed rows', () => {
    const variants = [
      variant({ id: 'a1', shotId: 'f1', model: 'nano_banana_2' }),
      variant({
        id: 'b1',
        shotId: 'f1',
        model: 'flux_pro',
        status: 'failed',
        url: null,
      }),
    ];

    const coverage = computeSequenceModelCoverage({
      variants,
      variantType: 'image',
      primaryModel: 'nano_banana_2',
    });

    expect(coverage.get('flux_pro')?.status).toBe('failed');
    expect(coverage.get('flux_pro')?.completed).toBe(0);
  });

  it('reports completed (not generating) when a model has both completed and in-flight rows', () => {
    const variants = [
      variant({ id: 'a1', shotId: 'f1', model: 'nano_banana_2' }),
      variant({ id: 'a2', shotId: 'f2', model: 'nano_banana_2' }),
      // flux_pro: one scene done, another still generating.
      variant({ id: 'b1', shotId: 'f1', model: 'flux_pro' }),
      variant({
        id: 'b2',
        shotId: 'f2',
        model: 'flux_pro',
        status: 'generating',
        url: null,
      }),
    ];

    const coverage = computeSequenceModelCoverage({
      variants,
      variantType: 'image',
      primaryModel: 'nano_banana_2',
    });

    // At least one completed scene wins over a concurrent generating row.
    expect(coverage.get('flux_pro')).toEqual({
      status: 'completed',
      completed: 1,
      total: 2,
    });
  });

  it('ignores divergent and discarded alternates', () => {
    const variants = [
      variant({ id: 'a1', shotId: 'f1', model: 'nano_banana_2' }),
      variant({
        id: 'd1',
        shotId: 'f1',
        model: 'flux_pro',
        divergedAt: new Date(),
      }),
      variant({
        id: 'x1',
        shotId: 'f2',
        model: 'flux_pro',
        discardedAt: new Date(),
      }),
    ];

    const coverage = computeSequenceModelCoverage({
      variants,
      variantType: 'image',
      primaryModel: 'nano_banana_2',
    });

    // flux_pro had only divergent/discarded rows → no live coverage.
    expect(coverage.get('flux_pro')).toBeUndefined();
    expect(coverage.get('nano_banana_2')?.total).toBe(1);
  });

  it('filters by variant type', () => {
    const variants = [
      variant({ id: 'a1', shotId: 'f1', variantType: 'image', model: 'm1' }),
      variant({ id: 'v1', shotId: 'f1', variantType: 'video', model: 'm1' }),
    ];

    const videoCoverage = computeSequenceModelCoverage({
      variants,
      variantType: 'video',
      primaryModel: null,
    });
    expect(videoCoverage.get('m1')).toEqual({
      status: 'completed',
      completed: 1,
      total: 1,
    });
  });

  it('counts distinct scenes (not shots) when given a shot→scene map (#909)', () => {
    const variants = [
      // Scene s1 has two shots; nano covers both → still one covered scene.
      variant({ id: 'a1', shotId: 'f1', model: 'nano_banana_2' }),
      variant({ id: 'a2', shotId: 'f2', model: 'nano_banana_2' }),
      // Scene s2 has one shot, covered by nano only.
      variant({ id: 'a3', shotId: 'f3', model: 'nano_banana_2' }),
      // flux covers one shot of scene s1 → scene s1 is the unit, so 1 of 2.
      variant({ id: 'b1', shotId: 'f1', model: 'flux_pro' }),
    ];
    const shotToScene = new Map([
      ['f1', 's1'],
      ['f2', 's1'],
      ['f3', 's2'],
    ]);

    const coverage = computeSequenceModelCoverage({
      variants,
      variantType: 'image',
      primaryModel: 'nano_banana_2',
      shotToScene,
    });

    // Two scenes total (s1, s2), nano covers both, flux covers only s1.
    expect(coverage.get('nano_banana_2')).toEqual({
      status: 'set',
      completed: 2,
      total: 2,
    });
    expect(coverage.get('flux_pro')).toEqual({
      status: 'completed',
      completed: 1,
      total: 2,
    });
  });

  it('returns an empty map for undefined variants', () => {
    expect(
      computeSequenceModelCoverage({
        variants: undefined,
        variantType: 'image',
      }).size
    ).toBe(0);
  });
});
