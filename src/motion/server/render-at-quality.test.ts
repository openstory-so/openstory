/**
 * Render an approved Ark draft at quality (#1756): the blockers, the
 * already-rendering refusal before any hold, the payload the run gets, the
 * shared (draft, attempt) key on the hold and the trigger, and the hold
 * released when the trigger throws.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_FAL_PRICING } from '@/billing/fal-pricing-fixture';
import { estimateVideoCost, gateEstimate } from '@/billing/cost-estimation';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { VideoVariant } from '@/platform/server/db/schema';

const mockReserve = vi.fn(async () => 'res-final');
const mockTrigger = vi.fn(
  async (_path: string, _body: object, _opts?: object) => 'wf-final'
);

vi.doMock('@/billing/server/preflight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/billing/server/preflight')>()),
  reserveRunCredits: mockReserve,
}));
vi.doMock('@/billing/server/fal-pricing-live', () => ({
  getEffectiveFalPricing: async () => TEST_FAL_PRICING,
}));
vi.doMock('@/platform/server/workflow/client', () => ({
  triggerWorkflow: mockTrigger,
}));

const { ALREADY_RENDERING, draftRenderBlocker, renderDraftAtQuality } =
  await import('./render-at-quality');

const DAY_MS = 24 * 60 * 60 * 1000;
const manifest: VideoVariant['manifest'] = [
  {
    shotId: 'shot-1',
    motionPromptVersionId: 'spv-1',
    frameVersionId: null,
    usesStartFrame: false,
    durationMs: 5000,
    audioClipIds: [],
    audioSourceKey: null,
    dialogueKey: null,
    referenceKeys: ['ref-a'],
  },
];

function makeVersion(extra: Partial<VideoVariant> = {}): VideoVariant {
  return {
    id: 'vv-draft',
    renderSegmentId: 'seg-1',
    sequenceId: 'seq-1',
    model: 'seedance_v2_5',
    resolution: '480p',
    draftTaskId: 'cgt-1',
    manifest,
    url: '/r2/videos/draft.mp4',
    storagePath: 'draft.mp4',
    status: 'completed',
    workflowRunId: 'wf-draft',
    generatedAt: new Date(),
    error: null,
    isPrimary: true,
    inputHash: null,
    discardedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  };
}

function makeScopedDb(siblings: VideoVariant[]) {
  const zeroReservation = vi.fn(async () => {});
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the surface the module touches
  const scopedDb = {
    teamId: 'team-1',
    videoVariants: { listBySegment: vi.fn(async () => siblings) },
    shotPromptVersions: {
      getByIdForShot: vi.fn(async () => ({ text: 'the draft prompt' })),
    },
    billing: { zeroReservation },
  } as unknown as ScopedDb;
  return { scopedDb, zeroReservation };
}

const sequence = { id: 'seq-1', title: 'Seq', aspectRatio: '16:9' as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockReserve.mockResolvedValue('res-final');
  mockTrigger.mockResolvedValue('wf-final');
});

describe('draftRenderBlocker', () => {
  it('names why a version cannot be rendered at quality', () => {
    expect(draftRenderBlocker(makeVersion())).toBeNull();
    expect(draftRenderBlocker(makeVersion({ draftTaskId: null }))).toBe(
      'This clip is not a draft'
    );
    expect(draftRenderBlocker(makeVersion({ status: 'generating' }))).toBe(
      'The draft has not finished'
    );
    expect(
      draftRenderBlocker(
        makeVersion({ createdAt: new Date(Date.now() - 8 * DAY_MS) })
      )
    ).toMatch(/seven days/);
    expect(
      draftRenderBlocker(makeVersion({ model: 'retired_model_key' }))
    ).toMatch(/no longer available/);
  });
});

describe('renderDraftAtQuality', () => {
  it('refuses a segment already rendering before holding credits', async () => {
    const draft = makeVersion();
    const { scopedDb } = makeScopedDb([
      draft,
      makeVersion({ id: 'vv-final', draftTaskId: null, status: 'generating' }),
    ]);

    await expect(
      renderDraftAtQuality({
        scopedDb,
        userId: 'u1',
        sequence,
        version: draft,
        sceneId: 'scene-1',
      })
    ).rejects.toThrow(ALREADY_RENDERING);
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it('holds at 1080p and triggers the final on the draft segment with the draft manifest', async () => {
    const draft = makeVersion();
    const { scopedDb } = makeScopedDb([draft]);

    const result = await renderDraftAtQuality({
      scopedDb,
      userId: 'u1',
      sequence,
      version: draft,
      sceneId: 'scene-1',
    });

    expect(result).toEqual({
      workflowRunId: 'wf-final',
      versionId: 'vv-draft',
    });
    // One hold and one instance per (draft, attempt): the same key on both.
    const key = 'motion-final-vv-draft-1';
    expect(mockReserve).toHaveBeenCalledWith(
      scopedDb,
      gateEstimate(
        estimateVideoCost('seedance_v2_5', 5, {
          pricing: TEST_FAL_PRICING,
          resolution: '1080p',
          hasReferenceImages: true,
          referenceOnly: true,
        }),
        { model: 'seedance_v2_5', operation: 'motion' }
      ),
      expect.objectContaining({ idempotencyKey: key, sequenceId: 'seq-1' })
    );
    expect(mockTrigger).toHaveBeenCalledWith(
      '/motion',
      expect.objectContaining({
        userId: 'u1',
        teamId: 'team-1',
        sequenceId: 'seq-1',
        shotId: 'shot-1',
        sceneId: 'scene-1',
        referenceOnly: true,
        prompt: 'the draft prompt',
        model: 'seedance_v2_5',
        duration: 5,
        reservationId: 'res-final',
        ownsReservation: true,
        finalFromDraft: {
          taskId: 'cgt-1',
          renderSegmentId: 'seg-1',
          manifest,
        },
      }),
      { deduplicationId: key }
    );
    // Never a draft flag on a final: its task id must not be stamped.
    expect(mockTrigger.mock.calls[0]?.[1]).not.toHaveProperty('draft');
  });

  it('a second attempt after a failed final gets a fresh key', async () => {
    const draft = makeVersion();
    const { scopedDb } = makeScopedDb([
      draft,
      makeVersion({ id: 'vv-final-1', draftTaskId: null, status: 'failed' }),
    ]);

    await renderDraftAtQuality({
      scopedDb,
      userId: 'u1',
      sequence,
      version: draft,
      sceneId: 'scene-1',
    });

    expect(mockTrigger).toHaveBeenCalledWith('/motion', expect.anything(), {
      deduplicationId: 'motion-final-vv-draft-2',
    });
  });

  it('zeros the hold when the trigger throws', async () => {
    mockTrigger.mockRejectedValueOnce(new Error('binding down'));
    const draft = makeVersion();
    const { scopedDb, zeroReservation } = makeScopedDb([draft]);

    await expect(
      renderDraftAtQuality({
        scopedDb,
        userId: 'u1',
        sequence,
        version: draft,
        sceneId: 'scene-1',
      })
    ).rejects.toThrow('binding down');
    expect(zeroReservation).toHaveBeenCalledWith('res-final');
  });
});
