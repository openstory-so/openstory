import { describe, expect, it } from 'vitest';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import { buildGeminiVideoRequest } from './build-gemini-video-request';

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

describe('buildGeminiVideoRequest', () => {
  it('sends the still + prompt with the task pinned to image_to_video', () => {
    const { endpointId, input } = buildGeminiVideoRequest({
      prompt: 'A person walking',
      imageUrl: STILL,
      duration: 5,
      aspectRatio: '16:9',
    });
    expect(endpointId).toBe('gemini-omni-1.1-flash');
    expect(input).toEqual({
      prompt: [
        { type: 'image', source: { type: 'url', value: STILL } },
        { type: 'text', content: 'A person walking' },
      ],
      duration: 5,
      size: '16:9',
      modelOptions: {
        generation_config: { video_config: { task: 'image_to_video' } },
        response_format: {
          type: 'video',
          delivery: 'uri',
          duration: '5s',
          aspect_ratio: '16:9',
        },
      },
    });
  });

  it('tags library refs as <IMAGE_REF_n> and pins reference_to_video', () => {
    const { input } = buildGeminiVideoRequest({
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
    // Google numbers refs from zero: the still is <IMAGE_REF_0>, the cast
    // follows in image order.
    expect(input.prompt.at(-1)).toEqual({
      type: 'text',
      content: expect.stringMatching(
        /Use <IMAGE_REF_0> as the starting frame\.\n<IMAGE_REF_1> lifts the <IMAGE_REF_2>/
      ),
    });
    expect(input.prompt.slice(0, -1)).toEqual([
      { type: 'image', source: { type: 'url', value: STILL } },
      {
        type: 'image',
        source: { type: 'url', value: 'https://example.com/scarlett.png' },
      },
      {
        type: 'image',
        source: { type: 'url', value: 'https://example.com/lipstick.png' },
      },
    ]);
    expect(input.size).toBe('9:16');
    expect(input.modelOptions).toEqual({
      generation_config: { video_config: { task: 'reference_to_video' } },
      response_format: {
        type: 'video',
        delivery: 'uri',
        duration: '6s',
        aspect_ratio: '9:16',
      },
    });
  });

  it('decomposes data URIs into inline base64 — Google won’t fetch them', () => {
    const { input } = buildGeminiVideoRequest({
      prompt: 'A person walking',
      imageUrl: 'data:image/png;base64,aGVsbG8=',
    });
    expect(input.prompt[0]).toEqual({
      type: 'image',
      source: { type: 'data', value: 'aGVsbG8=', mimeType: 'image/png' },
    });
  });

  it('rejects aspect ratios Omni Flash cannot output', () => {
    expect(() =>
      buildGeminiVideoRequest({
        prompt: 'A person walking',
        imageUrl: STILL,
        aspectRatio: '1:1',
      })
    ).toThrow(/only outputs 16:9 or 9:16/);
  });

  it('snaps duration onto the Omni 3–10s grid', () => {
    expect(
      buildGeminiVideoRequest({
        prompt: 'A person walking',
        imageUrl: STILL,
        duration: 1,
      }).input.duration
    ).toBe(3);
    expect(
      buildGeminiVideoRequest({
        prompt: 'A person walking',
        imageUrl: STILL,
        duration: 15,
      }).input.modelOptions.response_format.duration
    ).toBe('10s');
  });
});

describe('buildGeminiVideoRequest — reference-only', () => {
  // Omni Flash carries a fal reference-to-video route, so it qualifies for
  // reference-only on the model alone and a shot can reach the native google
  // via with no still at all.
  it('binds refs from slot 0 and pins reference_to_video with no still', () => {
    const { input } = buildGeminiVideoRequest({
      prompt: 'SCARLETT crosses the roof',
      duration: 5,
      aspectRatio: '16:9',
      referenceImages: [
        ref(
          'https://example.com/scarlett.png',
          'Scarlett',
          'character',
          'SCARLETT'
        ),
      ],
    });
    // Slot 0 is the reference, not a still: Google numbers from zero, so the
    // still occupying it would push every tag down one.
    expect(input.prompt).toContainEqual({
      type: 'image',
      source: { type: 'url', value: 'https://example.com/scarlett.png' },
    });
    const text = input.prompt.find((p) => p.type === 'text');
    expect(text?.content).toContain('<IMAGE_REF_0>');
    // No still to open on, so the starting-frame line must not appear.
    expect(text?.content).not.toContain('starting frame');
    expect(input.modelOptions.generation_config.video_config.task).toBe(
      'reference_to_video'
    );
  });

  it('is text_to_video when nothing matched at all', () => {
    const { input } = buildGeminiVideoRequest({
      prompt: 'A wide shot of the empty roof',
      duration: 5,
    });
    expect(input.prompt.every((p) => p.type === 'text')).toBe(true);
    expect(input.modelOptions.generation_config.video_config.task).toBe(
      'text_to_video'
    );
  });
});
