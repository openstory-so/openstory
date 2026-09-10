/**
 * Recorded e2e fixtures must not keep provider-hosted media URLs.
 *
 * Replay fetches those bytes for real (R2 is not mocked). xAI's
 * `imgen.x.ai` URLs expire in ~24h; fal.media lasts longer but still
 * rots. `scripts/mirror-e2e-fixture-media.ts` vendors them onto
 * `assets.openstory.so/e2e/<sha>.<ext>` after every record (#1562).
 *
 * Same spirit as wiring-consistency.test.ts: cheap structural reads,
 * loud failure the moment a new recording lands a rotting URL.
 */

import { relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  collectRecordedFixtureMedia,
  shouldMirrorFixtureMediaUrl,
} from '../../scripts/e2e-fixture-media';

/**
 * xAI imgen URLs from the 2026-09-08 record. They expired ~24h later and
 * cannot be mirrored — a re-record with a real `XAI_API_KEY` followed by
 * `bun scripts/mirror-e2e-fixture-media.ts` replaces them. Delete this set
 * when that happens (the test fails on stale entries). Fresh provider URLs,
 * including new `imgen.x.ai` ones, are NOT exempt.
 */
const KNOWN_UNMIRRORABLE_URLS = new Set([
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-0ad4a141-7aa1-9d61-bcfa-40afe2fcaf1f-cf4cbb81.png',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-134d25df-c02f-9d06-a6b2-91a917dc3912-668510f0.jpeg',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-18c3a928-354c-999d-ae35-e4a784495dd9-6e39b9a6.png',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-1fb331cd-03de-9fd7-a309-4daeeb214701-6e9c84b0.jpeg',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-201a2df1-9759-9d34-b4c3-b21730598d54-0db2a920.jpeg',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-2b0f5393-53f6-9139-af7e-8c81c6c4918a-19a71f0c.png',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-3adf6647-cacc-9954-a192-5a7ab5783758-725b1832.png',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-41545dc0-f5b5-9ac0-960e-98b33c2df2a2-d5c7680a.jpeg',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-456e5bdf-94ee-94c4-8245-01dc98df2e9a-d7e1c8a3.jpeg',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-48faf017-760d-97e7-9886-bf78abedcf1f-28968a1d.png',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-512c0851-e3c4-91af-b8c6-97047dd3c8ac-4d6d9bcd.jpeg',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-595eb717-1ecb-977f-8466-5e84244dc538-e37df101.png',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-612020f8-02e9-97a2-b368-460e7b462f17-1296ec08.png',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-6682f5b8-8728-9d52-b504-95a5ee63f10c-78971a67.jpeg',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-7178c18b-065f-956d-8d49-6434f159bf5c-4f2a94d5.png',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-76874e7e-cb5b-9716-bb4d-b4bf58a9ba02-5f820ebf.png',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-7849b2bc-490f-99d2-b57f-eaa7f103def2-07a0a8a8.png',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-7d3ed7b4-c9b7-9e61-a170-5f5862accf9e-cc8b238f.png',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-853ab4f9-8864-91a9-8a44-c3d1b20e832d-0a551547.jpeg',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-88eb683e-3608-96b8-a9fc-92bccc7dee23-bbc4ccbd.png',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-962dfa33-ddba-952a-8577-7aa175060853-ec4bb479.png',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-b5297564-d649-9390-8775-3c4554b17340-510aebe5.png',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-c1da1627-fe42-9f3f-aa70-6e5237d1a24a-eaff7161.jpeg',
  'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-d2230e46-3e77-9023-94a1-7f50822e2b26-edbdde24.png',
]);

describe('recorded fixture media URL classification', () => {
  test('mirrors provider hosts even without a file extension, skips our assets domain', () => {
    expect(
      shouldMirrorFixtureMediaUrl('https://v3b.fal.media/files/b/abc/out')
    ).toBe(true);
    expect(
      shouldMirrorFixtureMediaUrl(
        'https://imgen.x.ai/xai-imgen/xai-tmp-imgen-dead'
      )
    ).toBe(true);
    expect(
      shouldMirrorFixtureMediaUrl('https://assets.openstory.so/e2e/abc.mp4')
    ).toBe(false);
  });
});

describe('recorded fixtures do not keep rotting provider media', () => {
  test('every media URL is on assets.openstory.so, except the known-dead xAI set', () => {
    const hits = collectRecordedFixtureMedia();
    const ephemeral = hits.filter((h) => shouldMirrorFixtureMediaUrl(h.url));

    const unexpected = ephemeral.filter(
      (h) => !KNOWN_UNMIRRORABLE_URLS.has(h.url)
    );
    const present = new Set(ephemeral.map((h) => h.url));
    const stale = [...KNOWN_UNMIRRORABLE_URLS].filter(
      (url) => !present.has(url)
    );

    expect(
      unexpected.map((h) => `${relative(process.cwd(), h.file)} → ${h.url}`),
      'New provider media URL in a recorded fixture. Run `bun scripts/mirror-e2e-fixture-media.ts` after recording so replay does not fetch a CDN that will 404.'
    ).toEqual([]);

    expect(
      stale,
      'Allowlisted URL is gone. After re-recording xAI fixtures and mirroring, delete the stale entries from KNOWN_UNMIRRORABLE_URLS.'
    ).toEqual([]);
  });
});
