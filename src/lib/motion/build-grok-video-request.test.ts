import { describe, expect, it } from 'vitest';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import { buildGrokVideoRequest } from './build-grok-video-request';

const STILL = 'https://example.com/still.jpg';

const ref = (
  url: string,
  description: string,
  role: ReferenceImageDescription['role'],
  token?: string
): ReferenceImageDescription => ({
  referenceImageUrl: url,
  description,
  role,
  token,
});

describe('buildGrokVideoRequest', () => {
  it('sends the still as a start_frame when there are no library refs', () => {
    const { endpointId, input } = buildGrokVideoRequest({
      prompt: 'A person walking',
      imageUrl: STILL,
      duration: 5,
      aspectRatio: '16:9',
    });
    expect(endpointId).toBe('grok-imagine-video-1.5');
    expect(input).toEqual({
      prompt: [
        { type: 'text', content: 'A person walking' },
        {
          type: 'image',
          source: { type: 'url', value: STILL },
          metadata: { role: 'start_frame' },
        },
      ],
      duration: 5,
      size: '16:9_720p',
    });
  });

  it('tags library refs as <IMAGE_n> and does not keep a start_frame role', () => {
    const { input } = buildGrokVideoRequest({
      prompt: 'SCARLETT lifts the CORAL_LIPSTICK',
      imageUrl: STILL,
      duration: 6,
      aspectRatio: '9:16',
      referenceImages: [
        ref(
          'https://example.com/scarlett.png',
          'Scarlett - athletic',
          'character',
          'SCARLETT'
        ),
        ref(
          'https://example.com/lipstick.png',
          'CORAL_LIPSTICK - a coral tube',
          'element',
          'CORAL_LIPSTICK'
        ),
      ],
    });
    expect(input.prompt[0]).toEqual({
      type: 'text',
      content: expect.stringMatching(
        /Use <IMAGE_0> as the starting frame\.\n<IMAGE_1> lifts the <IMAGE_2>/
      ),
    });
    expect(input.prompt.slice(1)).toEqual([
      {
        type: 'image',
        source: { type: 'url', value: STILL },
        metadata: { role: 'reference' },
      },
      {
        type: 'image',
        source: { type: 'url', value: 'https://example.com/scarlett.png' },
        metadata: { role: 'character' },
      },
      {
        type: 'image',
        source: { type: 'url', value: 'https://example.com/lipstick.png' },
        metadata: { role: 'reference' },
      },
    ]);
    expect(input.size).toBe('9:16_720p');
  });
});
