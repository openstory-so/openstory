/**
 * The pre-send guards of `publishSequenceExportFn`. `sequenceExports.getById`
 * does not filter by team, so the sequence check here is the only thing
 * stopping a caller from publishing another team's render.
 */

import { describe, expect, it } from 'vitest';
import {
  assertPublicVideoUrl,
  assertPublishableExport,
} from './publish-guards';

describe('assertPublishableExport', () => {
  it('passes a ready export of this sequence', () => {
    expect(() =>
      assertPublishableExport({ sequenceId: 'seq-1', status: 'ready' }, 'seq-1')
    ).not.toThrow();
  });

  it('refuses a missing export', () => {
    expect(() => assertPublishableExport(null, 'seq-1')).toThrow(
      /not found for this sequence/
    );
  });

  it("refuses another sequence's export", () => {
    expect(() =>
      assertPublishableExport({ sequenceId: 'seq-2', status: 'ready' }, 'seq-1')
    ).toThrow(/not found for this sequence/);
  });

  it.each(['processing', 'failed'] as const)(
    'refuses a %s export',
    (status) => {
      expect(() =>
        assertPublishableExport({ sequenceId: 'seq-1', status }, 'seq-1')
      ).toThrow(/not ready to publish/);
    }
  );
});

describe('assertPublicVideoUrl', () => {
  it('passes a public https URL', () => {
    expect(() =>
      assertPublicVideoUrl('https://cdn.openstory.so/exports/a.mp4')
    ).not.toThrow();
  });

  it.each([
    'http://cdn.openstory.so/exports/a.mp4',
    'https://localhost:3000/r2/a.mp4',
    'https://127.0.0.1/r2/a.mp4',
    'https://0.0.0.0/r2/a.mp4',
    'https://[::1]/r2/a.mp4',
    'https://app.localhost/r2/a.mp4',
  ])('refuses %s', (url) => {
    expect(() => assertPublicVideoUrl(url)).toThrow(/not reachable/);
  });
});
