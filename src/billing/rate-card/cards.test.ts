import { describe, expect, it } from 'vitest';
import { RATE_CARDS } from './cards';
import { evaluateRateCard, verifyRateCardExamples } from './evaluate';
import { type RateCard, rateCardSchema } from './rate-card.schema';

// Six pages of different shapes (per-second tiers, per-image multipliers,
// token allowances, size × quality tables, token formulas with a minimum
// charge). Every worked example reproducing is the proof the vocabulary is
// sufficient before an LLM writes a card.
describe.each(Object.entries(RATE_CARDS))(
  'rate card %s',
  (endpointId, card) => {
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

    it('prices the default request from input defaults alone', () => {
      // Every input either has a default or is a count (0 when absent).
      const { usd } = evaluateRateCard(card, {});
      expect(usd).toBeGreaterThan(0);
    });
  }
);

const cardFor = (endpointId: string): RateCard => {
  const card = RATE_CARDS[endpointId];
  if (!card) throw new Error(`no card for ${endpointId}`);
  return card;
};

describe('cards refuse what their source does not price', () => {
  it('GPT Image 2.5: a size outside the canonical table', () => {
    const card = cardFor('openai/gpt-image-2.5/flare/text-to-image');
    expect(() =>
      evaluateRateCard(card, { image_size: { width: 1536, height: 1024 } })
    ).toThrow(/size_quality/);
  });

  it('Seedance 2.5: a ratio the page publishes no dimensions for', () => {
    const card = cardFor('dreamina-seedance-2-5-260628');
    expect(() => evaluateRateCard(card, { ratio: '9:16' })).toThrow(/dims/);
  });

  it('Seedance 2.5: a with-video shape outside the transcribed minimum-token rows', () => {
    const card = cardFor('dreamina-seedance-2-5-260628');
    expect(() =>
      evaluateRateCard(card, { duration: 10, input_video_duration: 3 })
    ).toThrow(/min_tokens/);
  });
});
