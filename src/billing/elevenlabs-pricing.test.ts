import { describe, expect, it } from 'vitest';
import {
  ELEVENLABS_RATE_CARD,
  ELEVENLABS_TTS_ENDPOINT,
  ELEVENLABS_VOICE_DESIGN_ENDPOINT,
  elevenLabsTtsUnitsBilled,
  estimateTtsCost,
  isElevenLabsPricedModel,
} from './elevenlabs-pricing';

describe('ELEVENLABS_RATE_CARD', () => {
  it('prices TTS and Voice Design so a fresh deploy never bills $0', () => {
    expect(isElevenLabsPricedModel(ELEVENLABS_TTS_ENDPOINT)).toBe(true);
    expect(isElevenLabsPricedModel(ELEVENLABS_VOICE_DESIGN_ENDPOINT)).toBe(
      true
    );
    expect(isElevenLabsPricedModel('fal-ai/elevenlabs/music')).toBe(false);
  });

  it('denominates TTS per 1000 characters so billing can divide a char count', () => {
    expect(ELEVENLABS_RATE_CARD[ELEVENLABS_TTS_ENDPOINT]?.unit).toBe(
      '1000 characters'
    );
    expect(ELEVENLABS_RATE_CARD[ELEVENLABS_TTS_ENDPOINT]?.unitPrice).toBe(
      100_000
    );
  });

  // `per_call` estimation returns null without a unit-count signal, which
  // gates on the $0.10 floor instead of the real price.
  it('gives both products an exact units-per-call signal', () => {
    expect(
      ELEVENLABS_RATE_CARD[ELEVENLABS_TTS_ENDPOINT]?.typicalUnitsPerCall
    ).toBe(1);
    expect(
      ELEVENLABS_RATE_CARD[ELEVENLABS_VOICE_DESIGN_ENDPOINT]
        ?.typicalUnitsPerCall
    ).toBe(1);
  });
});

describe('elevenLabsTtsUnitsBilled', () => {
  // ElevenLabs reports raw characters; the rate is quoted per 1000.
  // Skipping the divide would overcharge by 1000x.
  it('converts a character count into the rate card denomination', () => {
    expect(elevenLabsTtsUnitsBilled(2500)).toBe(2.5);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    'returns undefined for an unusable count (%s)',
    (value) => {
      expect(elevenLabsTtsUnitsBilled(value)).toBeUndefined();
    }
  );
});

describe('estimateTtsCost', () => {
  it('prices 1000 characters at the card’s $0.10', () => {
    expect(estimateTtsCost(1000)).toBe(100_000);
  });
  it('is zero for empty dialogue', () => {
    expect(estimateTtsCost(0)).toBe(0);
  });
});
