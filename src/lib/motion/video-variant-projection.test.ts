/**
 * Tests for the `video_variants` → legacy `ShotVariant` projection (#990) — the
 * compatibility view the entire video read side depends on (scenes-view
 * switcher, model coverage, the Set-Video UI). Pins the three load-bearing
 * behaviors: latest-per-(shot, model) collapse, multi-shot manifest fan-out,
 * and the always-`null` `divergedAt` the downstream readers filter on.
 */

import type { VideoManifest, VideoVariant } from '@/lib/db/schema';
import { describe, expect, it } from 'vitest';
import { projectVideoVariants } from './video-variant-projection';

let seq = 0;
/**
 * Build a `video_variants` row. `id` is monotonically increasing so the array
 * order the caller passes mirrors the oldest-first ULID order the real
 * `listBySequence` guarantees.
 */
function videoVariant(overrides: Partial<VideoVariant> = {}): VideoVariant {
  seq += 1;
  const manifest: VideoManifest = overrides.manifest ?? [
    {
      shotId: 'shot-1',
      motionPromptVersionId: 'mp-1',
      frameVersionId: 'fv-1',
      durationMs: 3000,
    },
  ];
  return {
    id: `vv-${String(seq).padStart(4, '0')}`,
    renderSegmentId: 'seg-1',
    sequenceId: 'seq-1',
    model: 'veo3_1',
    resolution: null,
    url: 'https://r2/v.mp4',
    storagePath: 'path/v.mp4',
    status: 'completed',
    isPrimary: true,
    workflowRunId: 'run-1',
    generatedAt: new Date('2026-06-01T00:00:00Z'),
    error: null,
    inputHash: 'hash-1',
    discardedAt: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
    manifest,
  };
}

describe('projectVideoVariants', () => {
  it('collapses to the latest version per (shotId, model) — last write wins', () => {
    const older = videoVariant({ url: 'https://r2/old.mp4' });
    const newer = videoVariant({ url: 'https://r2/new.mp4' });

    const rows = projectVideoVariants([older, newer]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.url).toBe('https://r2/new.mp4');
    // The synthetic ShotVariant carries the winning version's id.
    expect(rows[0]?.id).toBe(newer.id);
  });

  it('keeps versions of the same shot but different models separate', () => {
    const veo = videoVariant({ model: 'veo3_1' });
    const kling = videoVariant({ model: 'kling_v3_pro' });

    const rows = projectVideoVariants([veo, kling]);

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.model))).toEqual(
      new Set(['veo3_1', 'kling_v3_pro'])
    );
  });

  it('fans a multi-shot manifest out into one synthetic row per covered shot', () => {
    const segmentVersion = videoVariant({
      manifest: [
        {
          shotId: 'shot-1',
          motionPromptVersionId: 'mp-1',
          frameVersionId: 'fv-1',
          durationMs: 3000,
        },
        {
          shotId: 'shot-2',
          motionPromptVersionId: 'mp-2',
          frameVersionId: 'fv-2',
          durationMs: 4000,
        },
      ],
    });

    const rows = projectVideoVariants([segmentVersion]);

    expect(rows).toHaveLength(2);
    const byShot = new Map(rows.map((r) => [r.shotId, r]));
    expect(byShot.get('shot-1')?.durationMs).toBe(3000);
    expect(byShot.get('shot-2')?.durationMs).toBe(4000);
    // Both synthetic rows reference the one covering version + its model.
    expect(byShot.get('shot-1')?.id).toBe(segmentVersion.id);
    expect(byShot.get('shot-2')?.id).toBe(segmentVersion.id);
  });

  it('always sets divergedAt to null (selection is a pointer; readers filter on this)', () => {
    const rows = projectVideoVariants([videoVariant()]);
    expect(rows[0]?.divergedAt).toBeNull();
    // Video never sets the image-only 3×3 grid fields either.
    expect(rows[0]?.shotVariantUrl).toBeNull();
    expect(rows[0]?.variantType).toBe('video');
  });

  it('passes a failed/in-flight latest through unchanged (status is not filtered)', () => {
    // A newer failed re-roll shadows an older completed one — the projection is
    // a pure view; status-filtering is the reader's job (e.g. setSequenceModel).
    const completed = videoVariant({
      status: 'completed',
      url: 'https://r2/ok.mp4',
    });
    const failedRetry = videoVariant({
      status: 'failed',
      url: null,
      error: 'boom',
    });

    const rows = projectVideoVariants([completed, failedRetry]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.url).toBeNull();
  });

  it('returns nothing for an empty version list', () => {
    expect(projectVideoVariants([])).toEqual([]);
  });
});
