import { describe, expect, it } from 'vitest';
import { BYTEPLUS_CARDS, RATE_CARDS } from './cards';
import { evaluateRateCard, verifyRateCardExamples } from './evaluate';
import { type RateCard, rateCardSchema } from './rate-card.schema';

const MINIMAL_REQUEST: Record<string, Record<string, unknown>> = {
  'xai/grok-imagine-video/v1.5/reference-to-video': {
    reference_image_urls: ['a'],
  },
  // Edit defaults `image_size` to `auto` (sized from the input), which no
  // table prices; the app always sends a size.
  'openai/gpt-image-2.5/flare/edit': { image_size: 'square_hd' },
};

const ALL_CARDS = { ...RATE_CARDS, ...BYTEPLUS_CARDS };

// Pages of different shapes (per-second tiers, per-image multipliers, token
// allowances, size × quality tables, token formulas with a minimum charge,
// pixel tiers). Every worked example reproducing is the proof the vocabulary
// is sufficient before an LLM writes a card.
describe.each(Object.entries(ALL_CARDS))('rate card %s', (endpointId, card) => {
  it('validates against the schema', () => {
    expect(rateCardSchema.safeParse(card).success).toBe(true);
  });

  it('carries at least one worked example from the source', () => {
    expect(card.examples.length).toBeGreaterThan(0);
    expect(card.source.url).toContain('http');
  });

  it('reproduces every worked example within 1%', () => {
    const results = verifyRateCardExamples(card);
    const failures = results.filter((r) => !r.ok);
    expect(
      failures.map((f) => `${endpointId}: ${f.example.quote} → ${f.error}`)
    ).toEqual([]);
  });

  it('prices the smallest request the endpoint accepts', () => {
    // Every input has a default or is a count; a required list param
    // (Grok r2v needs 1–7 reference images) is supplied so the priced
    // request is one fal would actually run.
    const { usd } = evaluateRateCard(card, MINIMAL_REQUEST[endpointId] ?? {});
    expect(usd).toBeGreaterThan(0);
  });
});

const cardFor = (endpointId: string): RateCard => {
  const card = ALL_CARDS[endpointId];
  if (!card) throw new Error(`no card for ${endpointId}`);
  return card;
};

describe('GPT Image 2.5 prices the sizes the app sends at their band row', () => {
  const card = cardFor('openai/gpt-image-2.5/flare/text-to-image');
  const price = (image_size: unknown, quality = 'high') =>
    evaluateRateCard(card, { image_size, quality }).usd;

  it('fal presets land in the row of their orientation', () => {
    expect(price('landscape_16_9')).toBe(0.03612);
    expect(price('portrait_16_9')).toBe(0.04116);
    expect(price('square_hd')).toBe(0.05268);
    expect(price('square')).toBe(0.05268);
  });

  it('tier pixels land in the row of their area band', () => {
    expect(price({ width: 1280, height: 720 })).toBe(0.03612);
    expect(price({ width: 720, height: 1280 })).toBe(0.04116);
    expect(price({ width: 1072, height: 1072 })).toBe(0.05268);
    expect(price({ width: 1080, height: 1920 })).toBe(0.0396);
    expect(price({ width: 2160, height: 2160 })).toBe(0.05529);
    expect(price({ width: 3840, height: 2160 }, 'max')).toBe(0.40026);
  });

  it('the edit endpoint carries the same table', () => {
    const edit = cardFor('openai/gpt-image-2.5/flare/edit');
    expect(
      evaluateRateCard(edit, { image_size: 'landscape_16_9', num_images: 2 })
        .usd
    ).toBe(0.07224);
  });
});

describe('Ark Seedance prices every ratio at the resolution area', () => {
  // Ark sizes a resolution class to the same pixel area whatever the ratio
  // (frame jobs send `adaptive_<resolution>`), so 9:16 and 1:1 are not a
  // refusal — every portrait shot used to fall to the /private/tmp/claude-501/-Users-tom--herdr-worktrees-openstory-1605-cron-should-seed-estimates-from-each-fal-endpoints-llmstxt-pricing-section/9afbb6d8-fef3-443e-9590-97be01658881/scratchpad/cardstest.pl.10 floor.
  it.each(['dreamina-seedance-2-5-260628', 'dreamina-seedance-2-0-260128'])(
    '%s',
    (id) => {
      const card = cardFor(id);
      const at = (aspect_ratio: string) =>
        evaluateRateCard(card, {
          resolution: '720p',
          duration: 5,
          aspect_ratio,
        }).usd;
      expect(at('9:16')).toBe(at('16:9'));
      expect(at('1:1')).toBe(at('16:9'));
    }
  );

  it('Seedance 2.0 prices the 4K tier the Ark route offers', () => {
    const card = cardFor('dreamina-seedance-2-0-260128');
    // 3840 × 2160 × 5 s × 24 / 1024 tokens at $4.0/1M
    expect(
      evaluateRateCard(card, { resolution: '4k', duration: 5 }).usd
    ).toBeCloseTo(3.888, 3);
  });
});

describe('cards refuse what their source does not price', () => {
  it('GPT Image 2.5: quality auto', () => {
    const card = cardFor('openai/gpt-image-2.5/flare/text-to-image');
    expect(() =>
      evaluateRateCard(card, { image_size: 'square_hd', quality: 'auto' })
    ).toThrow(/size_quality/);
  });

  it('Seedance 2.5: a with-video shape outside the transcribed minimum-token rows', () => {
    const card = cardFor('dreamina-seedance-2-5-260628');
    expect(() =>
      evaluateRateCard(card, { duration: 10, input_video_duration: 3 })
    ).toThrow(/min_tokens/);
  });
});
