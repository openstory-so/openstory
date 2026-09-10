import { describe, expect, it } from 'vitest';
import {
  motionReferenceSupport,
  overlongReferenceNotice,
  referenceUsability,
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
    // Pre-flight warning: the submit path refuses these, so the line must say
    // the shot will not render rather than promising a graceful degrade.
    expect(notice).toContain('will not render');
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

// #1559 — what the element badge reads off.
describe('referenceUsability', () => {
  it('is silent for a still — every model takes one', () => {
    expect(
      referenceUsability({ kind: 'image', durationSeconds: null })
    ).toEqual({ level: 'ok' });
  });

  it('warns for a clip, naming the models that will carry it', () => {
    const usability = referenceUsability({ kind: 'video', durationSeconds: 5 });
    expect(usability.level).toBe('limited');
    if (usability.level !== 'limited') return;
    // Omni Flash caps clips at 3s, so a 5s clip is past it.
    expect(usability.models).not.toContain('gemini_omni_flash');
    expect(usability.models).toContain('seedance_v2_5');
    expect(usability.models).toContain('minimax_h3_max');
    // Never a model that takes no reference clip at all.
    expect(usability.models).not.toContain('kling_v3_pro');
  });

  it('errors when no model in the catalog is long enough', () => {
    // Seedance 2.5 is the roomiest at 30.2s.
    const usability = referenceUsability({
      kind: 'video',
      durationSeconds: 120,
    });
    expect(usability.level).toBe('unusable');
    if (usability.level !== 'unusable') return;
    expect(usability.maxSeconds).toBe(30.2);
  });

  it('warns rather than errors when the length is unknown', () => {
    // Unknown is accepted everywhere, so it can never be "unusable".
    expect(
      referenceUsability({ kind: 'audio', durationSeconds: null }).level
    ).toBe('limited');
  });
});
