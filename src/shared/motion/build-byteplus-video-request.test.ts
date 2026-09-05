import { describe, expect, it } from 'vitest';
import { buildBytePlusVideoRequest } from './build-byteplus-video-request';

const base = {
  imageUrl: 'https://cdn.example.com/still.png',
  prompt: 'SCARLETT lifts the CORAL_LIPSTICK to the light',
  aspectRatio: '16:9' as const,
  duration: 5,
};

const references = [
  {
    referenceImageUrl: 'https://cdn.example.com/scarlett.png',
    description: 'Scarlett, red hair',
    token: 'SCARLETT',
    role: 'character' as const,
  },
];

describe('buildBytePlusVideoRequest', () => {
  it('uses the Ark model id, not the fal endpoint', () => {
    const request = buildBytePlusVideoRequest(base, 'seedance_v2_5');
    expect(request.modelId).toBe('dreamina-seedance-2-5-260628');
  });

  it('uses adaptive size so first-frame jobs follow the still', () => {
    expect(buildBytePlusVideoRequest(base, 'seedance_v2_5').size).toBe(
      'adaptive_720p'
    );
    expect(
      buildBytePlusVideoRequest(
        { ...base, aspectRatio: '9:16' },
        'seedance_v2_5'
      ).size
    ).toBe('adaptive_720p');
    expect(
      buildBytePlusVideoRequest(
        { ...base, referenceImages: references },
        'seedance_v2_5'
      ).size
    ).toBe('adaptive_720p');
  });

  it('pins the still as start_frame when there are no references', () => {
    const { prompt } = buildBytePlusVideoRequest(base, 'seedance_v2_5');
    const images = prompt.filter((part) => part.type === 'image');
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      source: { value: base.imageUrl },
      metadata: { role: 'start_frame' },
    });
  });

  // Ark rejects a request mixing frame roles with reference roles, so the
  // still has to become a reference too — never a start_frame alongside them.
  it('sends every image as a reference role when references are present', () => {
    const { prompt } = buildBytePlusVideoRequest(
      { ...base, referenceImages: references },
      'seedance_v2_5'
    );
    const images = prompt.filter((part) => part.type === 'image');
    expect(images).toHaveLength(2);
    expect(images.every((p) => p.metadata?.role === 'reference')).toBe(true);
    expect(images.some((p) => p.metadata?.role === 'start_frame')).toBe(false);
  });

  it('leads the reference list with the still and declares it in the prompt', () => {
    const { prompt } = buildBytePlusVideoRequest(
      { ...base, referenceImages: references },
      'seedance_v2_5'
    );
    const images = prompt.filter((part) => part.type === 'image');
    expect(images[0]?.source.value).toBe(base.imageUrl);
    const text = prompt.find((part) => part.type === 'text');
    expect(text?.content).toContain('@Image1');
    expect(text?.content).not.toMatch(/(^|[^@])image1\b/);
  });

  it('binds a reference token to its image position', () => {
    const { prompt } = buildBytePlusVideoRequest(
      { ...base, referenceImages: references },
      'seedance_v2_5'
    );
    const text = prompt.find((part) => part.type === 'text');
    // The still is @Image1, so the first reference is @Image2.
    expect(text?.content).toContain('@Image2');
    expect(text?.content).not.toContain('SCARLETT');
  });

  it('does not append a Reference images legend', () => {
    const { prompt } = buildBytePlusVideoRequest(
      {
        ...base,
        prompt: 'A slow dolly in',
        referenceImages: references,
      },
      'seedance_v2_5'
    );
    const text = prompt.find((part) => part.type === 'text');
    expect(text?.content).not.toContain('Reference images:');
  });

  // Left implicit, Ark's own default would apply — and for images that default
  // is a burnt-in watermark. State it either way.
  it('always states watermark: false', () => {
    expect(
      buildBytePlusVideoRequest(base, 'seedance_v2_5').modelOptions
    ).toMatchObject({ watermark: false });
  });

  it('forwards generate_audio only when the caller set it', () => {
    expect(
      buildBytePlusVideoRequest(base, 'seedance_v2_5').modelOptions
    ).not.toHaveProperty('generate_audio');
    expect(
      buildBytePlusVideoRequest(
        { ...base, generateAudio: false },
        'seedance_v2_5'
      ).modelOptions
    ).toMatchObject({ generate_audio: false });
  });

  it('throws for a model with no BytePlus route rather than falling back silently', () => {
    expect(() => buildBytePlusVideoRequest(base, 'kling_v3_pro')).toThrow(
      /No BytePlus model id/
    );
  });

  it('truncates a prompt past the model limit', () => {
    const { prompt } = buildBytePlusVideoRequest(
      { ...base, prompt: 'x'.repeat(9000) },
      'seedance_v2_5'
    );
    const text = prompt.find((part) => part.type === 'text');
    expect(text?.content.length).toBe(4096);
    expect(text?.content.endsWith('...')).toBe(true);
  });
});

describe('buildBytePlusVideoRequest — reference-only', () => {
  const referenceOnlyBase = {
    prompt: 'A slow dolly toward SCARLETT at the window',
    aspectRatio: '16:9' as const,
    duration: 5,
    referenceOnly: true,
  };

  it('states a concrete ratio, since nothing is left for adaptive to follow', () => {
    expect(
      buildBytePlusVideoRequest(
        { ...referenceOnlyBase, referenceImages: references },
        'seedance_v2_5'
      ).size
    ).toBe('16:9_720p');
    expect(
      buildBytePlusVideoRequest(
        {
          ...referenceOnlyBase,
          aspectRatio: '9:16',
          referenceImages: references,
        },
        'seedance_v2_5'
      ).size
    ).toBe('9:16_720p');
  });

  it('sends every image as a reference role and no start_frame', () => {
    const request = buildBytePlusVideoRequest(
      { ...referenceOnlyBase, referenceImages: references },
      'seedance_v2_5'
    );
    const images = request.prompt.filter((part) => part.type === 'image');

    expect(images).toHaveLength(1);
    expect(images.every((i) => i.metadata?.role === 'reference')).toBe(true);
    expect(
      request.prompt.some(
        (part) =>
          part.type === 'text' && part.content.includes('starting frame')
      )
    ).toBe(false);
  });

  it('sends a text-only request when nothing matched', () => {
    const request = buildBytePlusVideoRequest(
      { ...referenceOnlyBase, referenceImages: [] },
      'seedance_v2_5'
    );

    expect(request.prompt).toEqual([
      { type: 'text', content: referenceOnlyBase.prompt },
    ]);
    expect(request.size).toBe('16:9_720p');
  });
});
