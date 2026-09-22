import { describe, expect, it } from 'vitest';
import type { GeneratedAsset } from '@/platform/server/db/schema';
import {
  readableStudioPrompt,
  studioGenerationFacts,
  studioReuse,
  studioShownReferences,
} from './prompt-display';

function asset(
  overrides: Partial<GeneratedAsset> &
    Pick<GeneratedAsset, 'activity' | 'input'>
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
    outputs: [{ url: '/r2/a.png', contentType: 'image/png' }],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('readableStudioPrompt', () => {
  it('leaves ordinary prose alone', () => {
    expect(readableStudioPrompt('a red fox in fog')).toBe('a red fox in fog');
  });

  it('turns markdown escapes back into the characters the editor shows', () => {
    expect(
      readableStudioPrompt('the fox \\*turns\\* toward \\[camera\\]')
    ).toBe('the fox *turns* toward [camera]');
    expect(
      readableStudioPrompt('a \\`cut\\` and a \\~tone\\~ and a \\\\path')
    ).toBe('a `cut` and a ~tone~ and a \\path');
  });

  it('drops the backslash a markdown hard break leaves at the end of a line', () => {
    expect(readableStudioPrompt('first line\\\nsecond line')).toBe(
      'first line\nsecond line'
    );
  });

  it('turns JSON newline and quote escapes into real characters', () => {
    expect(readableStudioPrompt('shot one\\nshot two\\"wide\\"')).toBe(
      'shot one\nshot two"wide"'
    );
  });

  it('reads the prompt out of a pasted request JSON blob', () => {
    const raw = JSON.stringify({
      prompt: 'Use Image1 as the start.\\nHold.',
      image_urls: ['https://cdn.example/a.png'],
    });
    expect(readableStudioPrompt(raw)).toBe('Use Image1 as the start.\nHold.');
  });

  it('keeps real newlines', () => {
    expect(readableStudioPrompt('one\ntwo')).toBe('one\ntwo');
  });
});

describe('studioShownReferences', () => {
  it('lists frames, then stills, clips, and audio in prompt order', () => {
    const row = asset({
      activity: 'video',
      input: {
        prompt: 'go',
        startImageUrl: '/r2/start.png',
        endImageUrl: '/r2/end.png',
        referenceImages: ['/r2/a.png', '/r2/b.png'],
        referenceVideos: ['/r2/clip.mp4'],
        referenceAudio: ['/r2/rain.mp3'],
      },
    });
    expect(studioShownReferences(row)).toEqual([
      { kind: 'image', url: '/r2/start.png', label: 'Start', tag: null },
      { kind: 'image', url: '/r2/end.png', label: 'End', tag: null },
      { kind: 'image', url: '/r2/a.png', label: '@Image1', tag: 'Image1' },
      { kind: 'image', url: '/r2/b.png', label: '@Image2', tag: 'Image2' },
      { kind: 'video', url: '/r2/clip.mp4', label: '@Video1', tag: 'Video1' },
      { kind: 'audio', url: '/r2/rain.mp3', label: '@Audio1', tag: 'Audio1' },
    ]);
  });

  it('ignores empty and non-string entries', () => {
    const row = asset({
      activity: 'image',
      input: { prompt: 'go', referenceImages: ['/r2/a.png', '', 3, null] },
    });
    expect(studioShownReferences(row)).toEqual([
      { kind: 'image', url: '/r2/a.png', label: '@Image1', tag: 'Image1' },
    ]);
  });
});

describe('studioGenerationFacts', () => {
  it('spells the settings that produced the clip', () => {
    const row = asset({
      activity: 'video',
      input: {
        prompt: 'go',
        aspectRatio: '9:16',
        resolution: '4k',
        duration: 5,
        mode: 'reference',
        generateAudio: false,
      },
    });
    expect(studioGenerationFacts(row)).toEqual([
      '9:16',
      '4K',
      '5s',
      'Reference to video',
      'Silent',
    ]);
  });
});

describe('studioReuse', () => {
  it('returns the readable prompt and the snapshotted references', () => {
    const row = asset({
      activity: 'video',
      modelName: 'Seedance 2.0',
      input: {
        prompt: 'the fox \\*turns\\*',
        aspectRatio: '16:9',
        resolution: '720p',
        videoModel: 'seedance_v2_5',
        duration: 5,
        mode: 'reference',
        generateAudio: true,
        referenceImages: ['/r2/a.png'],
      },
    });
    expect(studioReuse(row)).toMatchObject({
      prompt: 'the fox *turns*',
      aspectRatio: '16:9',
      resolution: '720p',
      videoModel: 'seedance_v2_5',
      duration: 5,
      mode: 'reference',
      generateAudio: true,
      referenceImages: ['/r2/a.png'],
    });
  });

  it('is null when the generation has no prompt', () => {
    const row = asset({ activity: 'image', input: { aspectRatio: '1:1' } });
    expect(studioReuse(row)).toBeNull();
  });
});
