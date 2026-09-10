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
  test('every media URL is on assets.openstory.so', () => {
    const hits = collectRecordedFixtureMedia();
    const ephemeral = hits.filter((h) => shouldMirrorFixtureMediaUrl(h.url));

    expect(
      ephemeral.map((h) => `${relative(process.cwd(), h.file)} → ${h.url}`),
      'Provider media URL in a recorded fixture. Run `bun scripts/mirror-e2e-fixture-media.ts` after recording so replay does not fetch a CDN that will 404.'
    ).toEqual([]);
  });
});
