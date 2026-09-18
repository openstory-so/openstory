/**
 * Tests for the video manifest input-hash (#990) — the O(1) staleness signal
 * for a `video_variants` version. The hash folds in the referenced
 * motion-prompt / anchor-frame version ids, so when a shot's selected prompt or
 * frame version changes the render's hash diverges (→ stale).
 */

import { describe, expect, it } from 'vitest';
import type { VideoManifestEntry } from '@/platform/server/db/schema';
import { computeVideoManifestInputHash } from './input-hash';

const entry = (
  overrides: Partial<VideoManifestEntry> = {}
): VideoManifestEntry => ({
  shotId: 's1',
  motionPromptVersionId: 'mp1',
  frameVersionId: 'fv1',
  usesStartFrame: true,
  durationMs: 3000,
  audioClipIds: [],
  audioSourceKey: null,
  dialogueTakeId: null,
  referenceKeys: [],
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

  it('rejects omitted audioClipIds; empty hashes as voiceless (#1616 DAG)', async () => {
    const voiceless = await computeVideoManifestInputHash(
      [entry({ audioClipIds: [] })],
      'veo3_1'
    );
    const voiced = await computeVideoManifestInputHash(
      [entry({ audioClipIds: ['clip-1'] })],
      'veo3_1'
    );
    expect(voiceless).not.toBe(voiced);
    const { audioClipIds: _dropped, ...without } = entry();
    expect(() =>
      computeVideoManifestInputHash(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- incomplete assembler
        [without] as VideoManifestEntry[],
        'veo3_1'
      )
    ).toThrow();
  });

  it('voice identity re-stales the clip, not via an omitted key (#1554/#1616)', async () => {
    const voiceless = await computeVideoManifestInputHash(
      [entry({ audioSourceKey: null })],
      'veo3_1'
    );
    const voiced = await computeVideoManifestInputHash(
      [entry({ audioSourceKey: 'voice-sarah\tStay down.\t\televen_v3' })],
      'veo3_1'
    );
    expect(voiced).not.toBe(voiceless);
    expect(
      await computeVideoManifestInputHash(
        [entry({ audioSourceKey: 'voice-other\tStay down.\t\televen_v3' })],
        'veo3_1'
      )
    ).not.toBe(voiced);
    const { audioSourceKey: _dropped, ...without } = entry();
    expect(() =>
      computeVideoManifestInputHash(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- incomplete assembler
        [without] as VideoManifestEntry[],
        'veo3_1'
      )
    ).toThrow();
  });
});
