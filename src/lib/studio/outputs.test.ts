import { describe, expect, it } from 'vitest';
import type { GeneratedAsset } from '@/lib/db/schema';
import {
  studioAspectRatio,
  studioPosterOutput,
  studioPrimaryOutput,
  studioPrompt,
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
