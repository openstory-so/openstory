import { describe, expect, it } from 'vitest';
import {
  BYTEPLUS_RATE_CARD,
  bytePlusVideoUnitsBilled,
  isBytePlusPricedModel,
} from './byteplus-pricing';
import { IMAGE_MODELS, IMAGE_TO_VIDEO_MODELS } from '@/models/models';

describe('BYTEPLUS_RATE_CARD', () => {
  // A catalog entry routed to Ark with no rate bills $0 — #1069's exact
  // failure mode, just on a different provider.
  it('prices every BytePlus id the catalog can route to', () => {
    const routed = [
      ...Object.values(IMAGE_MODELS),
      ...Object.values(IMAGE_TO_VIDEO_MODELS),
    ]
      .filter((model) => 'byteplusId' in model)
      .map((model) => model.byteplusId);

    expect(routed.length).toBeGreaterThan(0);
    for (const id of routed) {
      expect(isBytePlusPricedModel(id)).toBe(true);
    }
  });

  it('denominates video per 1000 tokens, matching what Ark reports', () => {
    expect(BYTEPLUS_RATE_CARD['dreamina-seedance-2-5-260628']?.unit).toBe(
      '1000 tokens'
    );
  });

  // Without a card a per-call id returns null, which gates on the $0.10
  // floor instead of the real price (#1605).
  it('carries a verified rate card on every entry', () => {
    for (const [id, entry] of Object.entries(BYTEPLUS_RATE_CARD)) {
      expect(entry.rateCard?.verified, id).toBe(true);
    }
  });
});

describe('bytePlusVideoUnitsBilled', () => {
  // Ark reports raw tokens; the rate is quoted per 1000. Skipping the divide
  // would overcharge by 1000x.
  it('converts a token count into the rate card denomination', () => {
    expect(bytePlusVideoUnitsBilled(308_880)).toBe(308.88);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    'returns undefined for an unusable count (%s)',
    (value) => {
      expect(bytePlusVideoUnitsBilled(value)).toBeUndefined();
    }
  );
});
