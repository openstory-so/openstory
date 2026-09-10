import { describe, expect, it } from 'vitest';
import {
  motionReferenceSupport,
  overlongReferenceNotice,
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

describe('overlongReferenceNotice', () => {
  const el = (
    token: string,
    kind: 'image' | 'video' | 'audio',
    durationSeconds: number | null
  ) => ({ token, kind, durationSeconds });

  it('names a clip past the model ceiling and how to fix it', () => {
    const notice = overlongReferenceNotice('gemini_omni_flash', [
      el('LONG_TAKE', 'video', 10),
    ]);
    expect(notice).toContain('up to 3s');
    expect(notice).toContain('LONG_TAKE');
    expect(notice).toContain('Trim it');
  });

  it('is silent for a clip inside the ceiling, and for unknown lengths', () => {
    expect(
      overlongReferenceNotice('gemini_omni_flash', [el('SHORT', 'video', 2)])
    ).toBeNull();
    // Unknown length is attached rather than guessed at, so nothing to warn.
    expect(
      overlongReferenceNotice('gemini_omni_flash', [
        el('MYSTERY', 'video', null),
      ])
    ).toBeNull();
  });

  it('is silent on a model with no reference endpoint at all', () => {
    expect(
      overlongReferenceNotice('kling_v3_pro', [el('LONG', 'video', 60)])
    ).toBeNull();
  });
});
