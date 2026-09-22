import { describe, expect, it } from 'vitest';
import type { GeneratedAsset } from '@/platform/server/db/schema';
import {
  studioAspectRatio,
  studioDownloadFilename,
  studioDownloadHref,
  studioPosterOutput,
  studioPrimaryOutput,
  studioPrompt,
  studioShareUrl,
} from './outputs';

function asset(
  overrides: Partial<GeneratedAsset> &
    Pick<GeneratedAsset, 'activity' | 'outputs' | 'input'>
): GeneratedAsset {
  return {
    id: '01STUDIOASSET000000000000',
    teamId: 'team',
    userId: 'user',
    provider: 'fal',
    endpointId: 'fal-ai/example',
    modelName: 'Example',
    source: 'studio',
    isFavorite: false,
    status: 'completed',
    error: null,
    workflowRunId: 'wf',
    costMicros: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('studioPrimaryOutput', () => {
  it('prefers the video file for a video asset that also stored its still', () => {
    const row = asset({
      activity: 'video',
      input: { prompt: 'fox' },
      outputs: [
        { url: '/r2/still.png', contentType: 'image/png' },
        { url: '/r2/clip.mp4', contentType: 'video/mp4' },
      ],
    });
    expect(studioPrimaryOutput(row)?.url).toBe('/r2/clip.mp4');
    expect(studioPosterOutput(row)?.url).toBe('/r2/still.png');
  });

  it('reads prompt and aspect ratio from the snapshotted input', () => {
    const row = asset({
      activity: 'image',
      input: { prompt: 'a red fox', aspectRatio: '9:16' },
      outputs: [{ url: '/r2/a.png', contentType: 'image/png' }],
    });
    expect(studioPrompt(row)).toBe('a red fox');
    expect(studioAspectRatio(row)).toBe('9:16');
  });
});

describe('studio share and download', () => {
  it('absolutizes an origin-relative media URL for the clipboard', () => {
    expect(
      studioShareUrl('/r2/videos/team/clip.mp4', 'https://app.example.com')
    ).toBe('https://app.example.com/r2/videos/team/clip.mp4');
  });

  it('leaves an already-absolute URL unchanged', () => {
    expect(
      studioShareUrl(
        'https://storage.openstory.so/videos/clip.mp4',
        'https://app.example.com'
      )
    ).toBe('https://storage.openstory.so/videos/clip.mp4');
  });

  it('asks the worker to attach the file instead of playing it', () => {
    expect(studioDownloadHref('/r2/videos/team/clip.mp4')).toBe(
      '/r2/videos/team/clip.mp4?download'
    );
    expect(studioDownloadHref('/r2/a.png?v=1')).toBe('/r2/a.png?v=1&download');
  });

  it('names the download from the asset id and content type', () => {
    expect(studioDownloadFilename('01ASSET', 'video/mp4')).toBe(
      'openstory-01ASSET.mp4'
    );
    expect(studioDownloadFilename('01ASSET', 'image/png; charset=binary')).toBe(
      'openstory-01ASSET.png'
    );
  });
});
