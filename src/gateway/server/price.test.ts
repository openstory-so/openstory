/** `priceGatewayJob`: the request, the provider's usage by name or by format, and a refusal. */

import { describe, expect, it } from 'vitest';
import { RateCardError } from '@modelschemas/rate-card/evaluator';
import { rateCardSchema } from '@modelschemas/rate-card/schema';
import { priceGatewayJob } from './price';

const SOURCE = {
  url: 'https://docs.example.com/pricing',
  hash: 'a'.repeat(64),
  extractedAt: '2026-11-01T00:00:00.000Z',
};

// $0.08 a second, read off the request.
const PER_SECOND = rateCardSchema.parse({
  inputs: { duration: { param: 'duration', bound: 'request', kind: 'number' } },
  tables: {},
  price: { '*': [{ var: 'duration' }, 0.08] },
  examples: [],
  source: SOURCE,
});

// $10 a million output tokens, read off the usage.
const PER_TOKEN = rateCardSchema.parse({
  inputs: {
    output_tokens: { param: 'output_tokens', bound: 'usage', kind: 'number' },
  },
  tables: {},
  price: { '*': [{ var: 'output_tokens' }, 0.00001] },
  examples: [],
  source: SOURCE,
});

// Seed Audio as modelschemas has it: $0.0025 a second produced, estimated at the 120 second cap.
const SEED_AUDIO = rateCardSchema.parse({
  inputs: {
    original_duration: {
      param: 'original_duration',
      bound: 'usage',
      kind: 'number',
      estimate: { inputs: {}, value: 120, source: SOURCE },
    },
  },
  tables: {},
  price: { '*': [{ var: 'original_duration' }, 0.0025] },
  examples: [],
  source: SOURCE,
});

// A Gemini image model: $0.30 a million in, $30 a million image tokens out.
const GEMINI_IMAGE = rateCardSchema.parse({
  inputs: {
    input_tokens: { param: 'input_tokens', bound: 'usage', kind: 'number' },
    image_output_tokens: {
      param: 'image_output_tokens',
      bound: 'usage',
      kind: 'number',
    },
  },
  tables: {},
  price: {
    '+': [
      { '*': [{ var: 'input_tokens' }, 0.0000003] },
      { '*': [{ var: 'image_output_tokens' }, 0.00003] },
    ],
  },
  examples: [],
  source: SOURCE,
});

// gemini-3.1-flash-lite-image as modelschemas has it (2026-11-26).
const GEMINI_FLASH_LITE_IMAGE = rateCardSchema.parse({
  inputs: {
    input_tokens: { param: 'input_tokens', bound: 'usage', kind: 'number' },
    output_tokens: { param: 'output_tokens', bound: 'usage', kind: 'number' },
    image_output_tokens: {
      param: 'image_output_tokens',
      bound: 'usage',
      kind: 'number',
      default: 0,
    },
  },
  tables: {},
  price: {
    '+': [
      { '*': [{ var: 'input_tokens' }, 0.00000025] },
      { '*': [{ var: 'output_tokens' }, 0.0000015] },
      { '*': [{ var: 'image_output_tokens' }, 0.00003] },
    ],
  },
  examples: [],
  source: SOURCE,
});

const PROMPT =
  'Mara, a ferry mechanic, wipes her hands on a rag in the engine room';

describe('priceGatewayJob', () => {
  it('prices a request-only card off the body, before and after the run', () => {
    const request = { prompt: PROMPT, duration: 5 };
    expect(priceGatewayJob(PER_SECOND, request)).toBe(400_000);
    expect(priceGatewayJob(PER_SECOND, request, null)).toBe(400_000);
    // A usage object the card has no lever for changes nothing.
    expect(
      priceGatewayJob(PER_SECOND, request, { completion_tokens: 108_900 })
    ).toBe(400_000);
  });

  it('takes a usage lever by name and leaves the other counts', () => {
    expect(
      priceGatewayJob(
        PER_TOKEN,
        { prompt: PROMPT },
        { output_tokens: 12_000, input_tokens: 3_000, total_tokens: 15_000 }
      )
    ).toBe(120_000);
  });

  it('maps Gemini usageMetadata onto the card levers', () => {
    expect(
      priceGatewayJob(
        GEMINI_IMAGE,
        { contents: [{ parts: [{ text: PROMPT }] }] },
        {
          promptTokenCount: 1_000,
          candidatesTokenCount: 1_290,
          totalTokenCount: 2_290,
          candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1_290 }],
        }
      )
    ).toBe(39_000);
  });

  it('prices Gemini image tokens apart from text, thinking as text output', () => {
    // Google: a 1K image is 1,120 tokens, $0.0336. Plus 14 in and 6 text + 31 thinking out.
    expect(
      priceGatewayJob(
        GEMINI_FLASH_LITE_IMAGE,
        { contents: [{ parts: [{ text: PROMPT }] }] },
        {
          promptTokenCount: 14,
          candidatesTokenCount: 1_126,
          thoughtsTokenCount: 31,
          totalTokenCount: 1_171,
          candidatesTokensDetails: [
            { modality: 'TEXT', tokenCount: 6 },
            { modality: 'IMAGE', tokenCount: 1_120 },
          ],
        }
      )
    ).toBe(33_659);
  });

  it('prices a per-megapixel fal card off the megapixels the driver reports', () => {
    const SCHNELL = rateCardSchema.parse({
      inputs: {
        megapixels: { param: 'megapixels', bound: 'usage', kind: 'number' },
      },
      tables: {},
      price: { '*': [{ var: 'megapixels' }, 0.003] },
      examples: [],
      source: SOURCE,
    });
    expect(
      priceGatewayJob(SCHNELL, { prompt: PROMPT }, { megapixels: 0.786_432 })
    ).toBe(2_359);
  });

  it('throws RateCardError for a request it cannot price', () => {
    // A usage card before the run, and after it with no usage reported.
    expect(() => priceGatewayJob(PER_TOKEN, { prompt: PROMPT })).toThrow(
      RateCardError
    );
    expect(() => priceGatewayJob(PER_TOKEN, { prompt: PROMPT }, null)).toThrow(
      RateCardError
    );
    // A request lever the body does not carry.
    expect(() => priceGatewayJob(PER_SECOND, { prompt: PROMPT })).toThrow(
      RateCardError
    );
    // Usage in a format the card cannot read.
    expect(() =>
      priceGatewayJob(PER_TOKEN, { prompt: PROMPT }, { seconds: 5 })
    ).toThrow(RateCardError);
  });

  it('holds Seed Audio at its cap and charges the seconds it produced', () => {
    const request = { model: 'seed-audio-1.0', text_prompt: 'Hi' };
    expect(priceGatewayJob(SEED_AUDIO, request)).toBe(300_000);
    expect(
      priceGatewayJob(SEED_AUDIO, request, { original_duration: 3.4 })
    ).toBe(8_500);
  });
});
