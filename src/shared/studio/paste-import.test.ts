import { describe, expect, it } from 'vitest';
import { parseStudioPaste } from './paste-import';

describe('parseStudioPaste', () => {
  it('ignores plain text and JSON without a prompt', () => {
    expect(parseStudioPaste('a fox in fog')).toBeNull();
    expect(parseStudioPaste('{"image_urls":["https://x/a.png"]}')).toBeNull();
  });

  it('reads a Seedance reference request', () => {
    const result = parseStudioPaste(
      JSON.stringify({
        prompt: 'Use @Image1 as the start. @Image2 walks in as @Audio1 plays.',
        image_urls: ['https://x/still.png', 'https://x/ava.png'],
        audio_urls: ['https://x/rain.mp3'],
        duration: '5',
      })
    );
    expect(result).toEqual({
      prompt: 'Use Image1 as the start. Image2 walks in as Audio1 plays.',
      images: ['https://x/still.png', 'https://x/ava.png'],
      videos: [],
      audio: ['https://x/rain.mp3'],
    });
  });

  it('reads an H3 Max reference request with spaced Image N tags', () => {
    const result = parseStudioPaste(
      JSON.stringify({
        prompt:
          'Image 1 is the lead. Video 1 is the walk cycle. Audio 1 is rain.',
        reference_image_urls: ['https://x/ava.png'],
        reference_video_urls: ['https://x/walk.mp4'],
        reference_audio_urls: ['https://x/rain.mp3'],
      })
    );
    expect(result).toEqual({
      prompt: 'Image1 is the lead. Video1 is the walk cycle. Audio1 is rain.',
      images: ['https://x/ava.png'],
      videos: ['https://x/walk.mp4'],
      audio: ['https://x/rain.mp3'],
    });
  });

  it('reads a Grok reference request with zero-based tags', () => {
    const result = parseStudioPaste(
      JSON.stringify({
        prompt: 'The person from <IMAGE_0> greets <IMAGE_1>.',
        reference_image_urls: ['https://x/a.png', 'https://x/b.png'],
      })
    );
    expect(result?.prompt).toBe('The person from Image1 greets Image2.');
    expect(result?.images).toEqual(['https://x/a.png', 'https://x/b.png']);
  });

  it('maps Kling elements to images and frames to start/end', () => {
    const result = parseStudioPaste(
      JSON.stringify({
        prompt: '@Element1 lifts @Element2.',
        start_image_url: 'https://x/start.png',
        end_image_url: 'https://x/end.png',
        elements: [
          {
            frontal_image_url: 'https://x/ava.png',
            reference_image_urls: ['https://x/ava-side.png'],
          },
          { frontal_image_url: 'https://x/cup.png' },
        ],
      })
    );
    expect(result?.prompt).toBe('Image1 lifts Image2.');
    expect(result?.images).toEqual([
      'https://x/ava.png',
      'https://x/cup.png',
      'https://x/ava-side.png',
    ]);
    expect(result?.startImageUrl).toBe('https://x/start.png');
    expect(result?.endImageUrl).toBe('https://x/end.png');
  });
});
