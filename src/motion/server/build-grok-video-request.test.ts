import { describe, expect, it } from 'vitest';
import type { ReferenceImageDescription } from '@/stills/reference-image-prompt';
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

  it('pins the still as the opening frame and numbers refs from <IMAGE_0>', () => {
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
    // The still is the pinned first frame, not a reference: it takes no slot,
    // so the first sheet is <IMAGE_0>, and there is no "starting frame" line
    // pointing the model at a character sheet.
    expect(input.prompt[0]).toEqual({
      type: 'text',
      content: '<IMAGE_0> lifts the <IMAGE_1>',
    });
    expect(input.prompt.slice(1)).toEqual([
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
    // The still rides modelOptions so the adapter's stale
    // `startFrame && hasReference` guard does not reject the combination.
    expect(input.modelOptions).toEqual({ image: { url: STILL } });
    expect(input.size).toBe('9:16_720p');
  });

  it('uses the full 7-slot budget now that the still takes none', () => {
    const { input } = buildGrokVideoRequest({
      prompt: 'A crowd scene',
      imageUrl: STILL,
      referenceImages: Array.from({ length: 9 }, (_, i) =>
        ref(`https://example.com/${i}.png`, `Ref ${i}`, 'character', `REF_${i}`)
      ),
    });
    const images = input.prompt.filter((part) => part.type === 'image');
    expect(images).toHaveLength(7);
    expect(input.modelOptions).toEqual({ image: { url: STILL } });
  });

  it('sends no modelOptions in reference-only mode', () => {
    const { input } = buildGrokVideoRequest({
      prompt: 'SCARLETT walks',
      referenceImages: [
        ref(
          'https://example.com/scarlett.png',
          'Scarlett - athletic',
          'character',
          'SCARLETT'
        ),
      ],
    });
    expect(input.modelOptions).toBeUndefined();
    expect(input.prompt[0]).toEqual({
      type: 'text',
      content: '<IMAGE_0> walks',
    });
  });
});
