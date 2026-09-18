/**
 * Behavioural tests for the asset generation workflow (#458).
 *
 * The fal call itself is exercised end-to-end elsewhere; here we pin the two
 * seams the workflow owns: extracting output files from an arbitrary fal
 * queue result (shapes vary per endpoint), and the row status transitions on
 * completion/failure (`generated_assets` is the only DB surface this
 * workflow writes).
 */

import { describe, expect, it } from 'vitest';
import type { GeneratedAssetOutput } from '@/platform/server/db/schema';
import {
  extractAssetOutputs,
  isFalValidationError,
  outputExtension,
  persistAssetCompletion,
  persistAssetFailure,
  type AssetPersistScopedDb,
} from './asset-generation-workflow';

describe('extractAssetOutputs', () => {
  it('collects file objects from an images array (multi-output)', () => {
    const refs = extractAssetOutputs({
      images: [
        { url: 'https://fal.media/a.png', content_type: 'image/png' },
        { url: 'https://fal.media/b.png', content_type: 'image/png' },
      ],
      seed: 42,
    });
    expect(refs).toEqual([
      { url: 'https://fal.media/a.png', contentType: 'image/png' },
      { url: 'https://fal.media/b.png', contentType: 'image/png' },
    ]);
  });

  it('collects a single video file object', () => {
    const refs = extractAssetOutputs({
      video: { url: 'https://fal.media/clip.mp4', content_type: 'video/mp4' },
    });
    expect(refs).toEqual([
      { url: 'https://fal.media/clip.mp4', contentType: 'video/mp4' },
    ]);
  });

  it('accepts a bare URL string and reports no content type', () => {
    const refs = extractAssetOutputs({ audio: 'https://fal.media/track.mp3' });
    expect(refs).toEqual([
      { url: 'https://fal.media/track.mp3', contentType: null },
    ]);
  });

  it('falls through to the generic output field', () => {
    const refs = extractAssetOutputs({
      output: { url: 'https://fal.media/asset.bin' },
    });
    expect(refs).toEqual([
      { url: 'https://fal.media/asset.bin', contentType: null },
    ]);
  });

  it('ignores non-URL strings and objects without a url', () => {
    const refs = extractAssetOutputs({
      image: 'base64-not-a-url',
      output: { path: 'no-url-here' },
    });
    expect(refs).toEqual([]);
  });

  it('returns empty for results with no known media fields', () => {
    expect(extractAssetOutputs({ text: 'hello' })).toEqual([]);
    expect(extractAssetOutputs(null)).toEqual([]);
    expect(extractAssetOutputs('flat string')).toEqual([]);
    expect(extractAssetOutputs([{ url: 'https://x/y.png' }])).toEqual([]);
  });

  it('dedupes the same file surfaced under two fields (video + output)', () => {
    const refs = extractAssetOutputs({
      video: { url: 'https://fal.media/clip.mp4', content_type: 'video/mp4' },
      output: { url: 'https://fal.media/clip.mp4' },
    });
    expect(refs).toEqual([
      { url: 'https://fal.media/clip.mp4', contentType: 'video/mp4' },
    ]);
  });
});

describe('isFalValidationError', () => {
  it('matches an Error carrying status 422', () => {
    const error = Object.assign(new Error('Unprocessable Entity'), {
      status: 422,
    });
    expect(isFalValidationError(error)).toBe(true);
  });

  it('rejects other statuses and non-errors', () => {
    expect(
      isFalValidationError(
        Object.assign(new Error('rate limited'), { status: 429 })
      )
    ).toBe(false);
    expect(isFalValidationError(new Error('no status'))).toBe(false);
    expect(isFalValidationError({ status: 422 })).toBe(false);
  });
});

describe('outputExtension', () => {
  it('prefers the URL extension when present', () => {
    expect(outputExtension('https://fal.media/a.PNG', 'video/mp4')).toBe('png');
  });

  it('derives from content type for extension-less URLs', () => {
    expect(outputExtension('https://fal.media/v3/files/abc', 'video/mp4')).toBe(
      'mp4'
    );
    expect(
      outputExtension('https://fal.media/x', 'audio/mpeg; charset=binary')
    ).toBe('mp3');
  });

  it('falls back to bin when neither source knows', () => {
    expect(outputExtension('https://fal.media/x', null)).toBe('bin');
    expect(outputExtension('https://fal.media/x', 'application/mystery')).toBe(
      'bin'
    );
  });
});

type CompletedCall = {
  id: string;
  fields: { outputs: GeneratedAssetOutput[]; costMicros?: number | null };
};
type FailedCall = { id: string; error: string };

function buildScopedDbSpy(): {
  scopedDb: AssetPersistScopedDb;
  running: string[];
  completed: CompletedCall[];
  failed: FailedCall[];
} {
  const running: string[] = [];
  const completed: CompletedCall[] = [];
  const failed: FailedCall[] = [];
  const scopedDb: AssetPersistScopedDb = {
    generatedAssets: {
      markRunning: async (id) => {
        running.push(id);
      },
      markCompleted: async (id, fields) => {
        completed.push({ id, fields });
      },
      markFailed: async (id, error) => {
        failed.push({ id, error });
      },
    },
  };
  return { scopedDb, running, completed, failed };
}

describe('persistAssetCompletion / persistAssetFailure', () => {
  it('completes the row with its uploaded outputs and a null cost (no charging yet)', async () => {
    const { scopedDb, completed, failed } = buildScopedDbSpy();
    const outputs: GeneratedAssetOutput[] = [
      {
        url: '/r2/thumbnails/teams/t/assets/a/output-0.png',
        contentType: 'image/png',
      },
    ];

    await persistAssetCompletion({ scopedDb, assetId: 'asset-1', outputs });

    expect(completed).toEqual([
      { id: 'asset-1', fields: { outputs, costMicros: null, provider: 'fal' } },
    ]);
    expect(failed).toEqual([]);
  });

  it('fails the row with the sanitized error message', async () => {
    const { scopedDb, completed, failed } = buildScopedDbSpy();

    await persistAssetFailure({
      scopedDb,
      assetId: 'asset-2',
      error: 'Model run failed: NSFW content detected',
    });

    expect(failed).toEqual([
      { id: 'asset-2', error: 'Model run failed: NSFW content detected' },
    ]);
    expect(completed).toEqual([]);
  });
});
