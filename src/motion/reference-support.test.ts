import { describe, expect, it } from 'vitest';
import {
  motionReferenceSupport,
  unsupportedReferenceNotice,
} from './reference-support';

describe('motionReferenceSupport', () => {
  it('reports clips and audio on the Seedance / H3 Max reference endpoints', () => {
    expect(motionReferenceSupport('seedance_v2_5')).toEqual({
      image: true,
      video: true,
      audio: true,
    });
    expect(motionReferenceSupport('minimax_h3_max')).toEqual({
      image: true,
      video: true,
      audio: true,
    });
  });

  it('reports images only where the model binds stills but no media', () => {
    // Kling carries stills inline on its image-to-video endpoint.
    expect(motionReferenceSupport('kling_v3_pro')).toMatchObject({
      image: true,
      video: false,
      audio: false,
    });
  });

  it('reports clips but not audio on Omni Flash', () => {
    // Google: "Video references support a maximum of 3 clips, up to 3 seconds
    // each", but "Uploading audio references is unsupported in the current
    // version of the API" — so this split is the provider's, on both vias.
    expect(motionReferenceSupport('gemini_omni_flash')).toEqual({
      image: true,
      video: true,
      audio: false,
    });
  });
});

describe('unsupportedReferenceNotice', () => {
  it('is silent when everything attached is carried', () => {
    expect(
      unsupportedReferenceNotice('seedance_v2_5', ['image', 'audio', 'video'])
    ).toBeNull();
  });

  it('names the kinds that will be described instead of sent', () => {
    const notice = unsupportedReferenceNotice('kling_v3_pro', [
      'image',
      'audio',
      'video',
    ]);
    expect(notice).toContain('audio or clips');
  });
});
