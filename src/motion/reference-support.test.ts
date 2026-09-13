import { describe, expect, it } from 'vitest';
import {
  assertReferencesUsable,
  motionReferenceSupport,
  referenceUsability,
  unusableReferenceLines,
  unusableShotReferenceLines,
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

// #1559: no fallback. A clip or voice line the selected model cannot use
// refuses the shot, so every surface asks the same question and says why.
describe('unusableReferenceLines', () => {
  const el = (
    token: string,
    kind: 'image' | 'video' | 'audio',
    durationSeconds: number | null
  ) => ({ token, kind, durationSeconds });

  it('is silent when the model can use everything attached', () => {
    expect(
      unusableReferenceLines('seedance_v2_5', [
        el('SHEET', 'image', null),
        el('VOICE', 'audio', 4),
        el('CLIP', 'video', 10),
      ])
    ).toEqual([]);
  });

  it('names a kind the model takes no reference of, and who does', () => {
    const [line] = unusableReferenceLines('kling_v3_pro', [
      el('SMOKE_INK', 'video', 10),
    ]);
    expect(line).toContain("can't use SMOKE_INK");
    expect(line).toContain('takes no reference clips');
    expect(line).toContain('Seedance 2.5');
  });

  it('names a clip past the ceiling, with its real length', () => {
    // The 15.05s clip that failed at fal: 0.05s over, which "15s" hid.
    const [line] = unusableReferenceLines('minimax_h3_max', [
      el('SMOKE_INK', 'video', 15.0465),
    ]);
    expect(line).toContain('15.05s, over its 15s limit');
    expect(line).toContain('Trim it, or use Seedance 2.5');
  });

  it('never refuses a still, or a clip of unknown length', () => {
    expect(
      unusableReferenceLines('kling_v3_pro', [el('SHEET', 'image', null)])
    ).toEqual([]);
    expect(
      unusableReferenceLines('gemini_omni_flash', [
        el('MYSTERY', 'video', null),
      ])
    ).toEqual([]);
  });

  it('refuses a stored format no model takes, and says what to use', () => {
    // The M4A voice memo Ark rejected after Generate ("audio format … not
    // valid for model dreamina-seedance-2-5 in r2v").
    const [line] = unusableReferenceLines('seedance_v2_5', [
      {
        token: 'MATEO_SHOT_1',
        kind: 'audio',
        durationSeconds: 3.75,
        imageUrl: '/r2/elements/t/s/el.m4a',
      },
    ]);
    expect(line).toContain("can't use MATEO_SHOT_1 — it is M4A");
    expect(line).toContain('MP3 or WAV');
    expect(
      unusableReferenceLines('seedance_v2_5', [
        {
          token: 'OK',
          kind: 'audio',
          durationSeconds: 3,
          imageUrl: '/r2/x.wav',
        },
        {
          token: 'CLIP',
          kind: 'video',
          durationSeconds: 5,
          referenceImageUrl: 'https://cdn.example/c.mov?v=1',
        },
      ])
    ).toEqual([]);
  });

  it('refuses at submit with the same words', () => {
    expect(() =>
      assertReferencesUsable('kling_v3_pro', [el('VOICE', 'audio', 3)], true)
    ).toThrow("can't use VOICE — it takes no reference audio");
    expect(() =>
      assertReferencesUsable('seedance_v2_5', [el('VOICE', 'audio', 3)], true)
    ).not.toThrow();
  });

  it('refuses a clip under the model minimum', () => {
    // H3 Max takes clips of 2–15s; Seedance 2.5 takes 1.8–30.2s.
    const [line] = unusableReferenceLines('minimax_h3_max', [
      el('BLINK', 'video', 1.9),
    ]);
    expect(line).toContain('1.9s, under its 2s minimum');
    expect(line).toContain('Seedance 2.5');
    expect(
      unusableReferenceLines('seedance_v2_5', [el('BLINK', 'video', 1.9)])
    ).toEqual([]);
  });
});

// Every reference endpoint that takes audio refuses it as the only reference
// ("At least one reference image or video is required"). It used to be
// described in the prompt instead; now it refuses like any other misfit.
describe('unusableShotReferenceLines — a voice line with nothing to ride on', () => {
  const voice = {
    token: 'NARRATOR',
    kind: 'audio' as const,
    durationSeconds: 4,
  };
  const sheet = {
    token: 'SARAH',
    kind: 'image' as const,
    durationSeconds: null,
  };

  it('refuses a voice line with no start frame and no sheet or clip', () => {
    const [line] = unusableShotReferenceLines('seedance_v2_5', [voice], false);
    expect(line).toContain("can't send NARRATOR on its own");
    expect(line).toContain('or use a start frame');
  });

  it('lets it ride with a start frame, a sheet or a clip', () => {
    expect(unusableShotReferenceLines('seedance_v2_5', [voice], true)).toEqual(
      []
    );
    expect(
      unusableShotReferenceLines('seedance_v2_5', [voice, sheet], false)
    ).toEqual([]);
    expect(
      unusableShotReferenceLines(
        'seedance_v2_5',
        [voice, { token: 'CLIP', kind: 'video', durationSeconds: 5 }],
        false
      )
    ).toEqual([]);
  });

  it('does not count a clip the model refuses as something to ride with', () => {
    const lines = unusableShotReferenceLines(
      'minimax_h3_max',
      [voice, { token: 'LONG', kind: 'video', durationSeconds: 40 }],
      false
    );
    expect(lines.some((line) => line.includes('over its 15s limit'))).toBe(
      true
    );
    expect(lines.some((line) => line.includes('on its own'))).toBe(true);
  });
});

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

  it('names the models a clip is too long for, apart from those it fits', () => {
    // The 15.05s clip that surfaced this: four models take clips but cap them
    // at 15s or less, so the list of models it FITS is only Seedance 2.5 —
    // which read as "only Seedance 2.5 takes clips".
    const usability = referenceUsability({
      kind: 'video',
      durationSeconds: 15.05,
    });
    expect(usability.level).toBe('limited');
    if (usability.level !== 'limited') return;
    expect(usability.models).toEqual(['seedance_v2_5']);
    const tooLong = Object.fromEntries(
      usability.tooLong.map(({ model, maxSeconds }) => [model, maxSeconds])
    );
    expect(tooLong.minimax_h3_max).toBe(15);
    expect(tooLong.gemini_omni_flash).toBe(3);
    // A model with no clip slot is not "too long" — it describes it instead.
    expect(tooLong.kling_v3_pro).toBeUndefined();
  });

  it('errors when no model in the catalog is long enough', () => {
    // Seedance 2.5 is the roomiest at 30.2s.
    const usability = referenceUsability({
      kind: 'video',
      durationSeconds: 120,
    });
    expect(usability.level).toBe('unusable');
    if (usability.level !== 'unusable') return;
    expect(usability.problem).toEqual({ reason: 'too-long', maxSeconds: 30.2 });
  });

  it('warns rather than errors when the length is unknown', () => {
    // Unknown is accepted everywhere, so it can never be "unusable".
    expect(
      referenceUsability({ kind: 'audio', durationSeconds: null }).level
    ).toBe('limited');
  });
});
