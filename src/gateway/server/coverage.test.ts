/** Gateway coverage on the recorded cards (#2432): which product models can be held and charged, and every gap listed. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { productGatewayModels } from '@/gateway/product-models';
import { z } from 'zod';
import { usdToMicros } from '@/billing/money';
import { rateCardSchema } from '@modelschemas/rate-card/schema';
import {
  coverageGap,
  modelCoverage,
  productGap,
  recordedModelSchema,
  unlistedGaps,
} from './coverage';
import { productBodies } from './coverage-bodies';
import { priceGatewayJob } from './price';

const ROOT = resolve(import.meta.dirname, '../../..');
const recorded = z
  .array(recordedModelSchema)
  .parse(
    JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, 'coverage.fixture.json'),
        'utf8'
      )
    )
  );
const bodies = productBodies();
const coverages = recorded.map((m) =>
  modelCoverage(m, bodies.get(`${m.provider}/${m.id}`))
);
const coverageOf = (key: string) => {
  const coverage = coverages.find((c) => `${c.provider}/${c.id}` === key);
  if (!coverage) throw new Error(`${key} is not recorded`);
  return coverage;
};
const gapOf = (key: string) => coverageGap(coverageOf(key));

describe('gateway coverage', () => {
  it('has a recording for every product model; re-record when the list changes', () => {
    const key = (m: { provider: string; id: string }) =>
      `${m.provider}/${m.id}`;
    expect(new Set(recorded.map(key))).toEqual(
      new Set(productGatewayModels().map(key))
    );
    expect(recorded).toHaveLength(productGatewayModels().length);
  });

  it('builds the product body for every model but these 18; a builder that starts throwing fails here', () => {
    expect(
      coverages
        .filter((c) => productGap(c) === undefined)
        .map((c) => `${c.provider}/${c.id}`)
        .sort()
    ).toEqual(
      [
        'fal/xai/grok-imagine-video/v1.5/text-to-video',
        'fal/fal-ai/kling-video/v3/pro/text-to-video',
        'fal/xai/grok-imagine-video/v1.5/reference-to-video',
        'fal/fal-ai/ace-step-1.5',
        'fal/fal-ai/ace-step/prompt-to-audio',
        'fal/fal-ai/sync-lipsync/v3',
        'byteplus/dola-seedream-5-0-pro-260628',
        'byteplus/dreamina-seedance-2-0-260128',
        'byteplus/dreamina-seedance-2-5-260628',
        'byteplus/dreamina-seedance-2-0-mini-260615',
        'byteplus/seed-audio-1.0',
        'grok/grok-imagine-image-2.0',
        'grok/grok-imagine-image-quality',
        'gemini/gemini-nano-banana-2.1',
        'gemini/gemini-3.1-flash-image',
        'gemini/gemini-3.1-flash-lite-image',
        'gemini/gemini-3-pro-image',
        'gemini/gemini-omni-1.2-flash',
      ].sort()
    );
  });

  it('prices a reference-to-video endpoint on the body that carries a reference', () => {
    expect(bodies.get('fal/kling/v4/reference-to-video')).toMatchObject({
      image_urls: ['https://media.example.com/mara-sheet.png'],
    });
  });

  it('lists every gap in model-gateway.md with its upstream issue', () => {
    const doc = readFileSync(
      resolve(ROOT, 'docs/architecture/model-gateway.md'),
      'utf8'
    );
    expect(
      unlistedGaps(coverages, doc).map((c) => `${c.provider}/${c.id}`)
    ).toEqual([]);
  });

  it('holds and charges the models the real runs held', () => {
    for (const key of [
      'grok/grok-imagine-image-2.0',
      'grok/grok-imagine-video-1.5',
      'byteplus/seed-audio-1.0',
      'fal/fal-ai/nano-banana-pro',
      'fal/bytedance/seedance-2.5/text-to-video',
    ]) {
      expect([key, gapOf(key)]).toEqual([key, null]);
    }
  });

  it('refuses a card that needs a usage number with no estimate, never guessing one', () => {
    expect(gapOf('fal/fal-ai/flux-2')).toContain('megapixels');
    expect(gapOf('byteplus/dola-seedream-5-0-pro-260628')).toContain(
      'input_images'
    );
    expect(gapOf('fal/google/nano-banana-2.1')).toContain('evaluated to 0');
  });

  it('refuses the body the product sends where the card types a field differently (TanStack/schemas#766)', () => {
    const refused = {
      'fal/xai/grok-imagine-video/v1.5/image-to-video': /image_url.*boolean/,
      'fal/fal-ai/kling-video/v3/pro/image-to-video': /generate_audio.*true/,
      'fal/minimax/h3-max/image-to-video': /resolution.*"768P"/,
      'fal/minimax/h3-max/text-to-video': /resolution.*"768P"/,
      'fal/minimax/h3-max/reference-to-video': /resolution.*"768P"/,
    };
    for (const [key, reason] of Object.entries(refused)) {
      expect([key, gapOf(key)]).toEqual([key, null]);
      expect(productGap(coverageOf(key))).toMatch(reason);
    }
  });

  it('holds native Grok video 1.5 at the 480p rate whatever size the product asks (TanStack/schemas#767)', () => {
    const record = recorded.find((m) => m.id === 'grok-imagine-video-1.5');
    const card = rateCardSchema.parse(record?.record?.pricing);
    const body = bodies.get('grok/grok-imagine-video-1.5');
    if (!body) throw new Error('no Grok video body');
    expect(body.size).toBe('16:9_720p');
    expect(priceGatewayJob(card, body)).toBe(usdToMicros(0.4));
    expect(priceGatewayJob(card, { ...body, size: '16:9_480p' })).toBe(
      priceGatewayJob(card, body)
    );
  });
});
