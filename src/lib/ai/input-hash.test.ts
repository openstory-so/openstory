/**
 * Tests for the video manifest input-hash (#990) — the O(1) staleness signal
 * for a `video_variants` version. The hash folds in the referenced
 * motion-prompt / anchor-frame version ids, so when a shot's selected prompt or
 * frame version changes the render's hash diverges (→ stale).
 */

import { describe, expect, it } from 'vitest';
import type { VideoManifestEntry } from '@/lib/db/schema';
import { computeVideoManifestInputHash } from './input-hash';

const entry = (
  overrides: Partial<VideoManifestEntry> = {}
): VideoManifestEntry => ({
  shotId: 's1',
  motionPromptVersionId: 'mp1',
  frameVersionId: 'fv1',
  usesStartFrame: true,
  durationMs: 3000,
  ...overrides,
});

describe('computeVideoManifestInputHash', () => {
  it('is deterministic for the same manifest + model', async () => {
    const a = await computeVideoManifestInputHash([entry()], 'veo3_1');
    const b = await computeVideoManifestInputHash([entry()], 'veo3_1');
    expect(a).toBe(b);
  });

  it('changes when a referenced version id changes (staleness signal)', async () => {
    const base = await computeVideoManifestInputHash([entry()], 'veo3_1');
    const newFrame = await computeVideoManifestInputHash(
      [entry({ frameVersionId: 'fv2' })],
      'veo3_1'
    );
    const newPrompt = await computeVideoManifestInputHash(
      [entry({ motionPromptVersionId: 'mp2' })],
      'veo3_1'
    );
    expect(newFrame).not.toBe(base);
    expect(newPrompt).not.toBe(base);
  });

  it('returns null when every entry lacks pinned version ids (#1380)', async () => {
    // A hash over null/null immediately diverges from a live hash built
    // from the selected still + prompt — that's how storyboard clips were
    // born Stale. Unknown provenance is a null hash (never stale), matching
    // `videoVariants.isStale` for legacy rows.
    expect(
      await computeVideoManifestInputHash(
        [entry({ motionPromptVersionId: null, frameVersionId: null })],
        'veo3_1'
      )
    ).toBeNull();
  });

  it('changes with the model and with shot order (ordered manifest)', async () => {
    const base = await computeVideoManifestInputHash([entry()], 'veo3_1');
    expect(
      await computeVideoManifestInputHash([entry()], 'kling_v3_pro')
    ).not.toBe(base);

    const ab = await computeVideoManifestInputHash(
      [entry({ shotId: 'a' }), entry({ shotId: 'b' })],
      'veo3_1'
    );
    const ba = await computeVideoManifestInputHash(
      [entry({ shotId: 'b' }), entry({ shotId: 'a' })],
      'veo3_1'
    );
    expect(ab).not.toBe(ba);
  });
});
