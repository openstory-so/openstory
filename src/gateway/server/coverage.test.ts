/** Gateway coverage on the recorded cards (#2432): which product models can be held and charged, and every gap listed. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { productGatewayModels } from '@/gateway/product-models';
import { z } from 'zod';
import {
  coverageGap,
  modelCoverage,
  recordedModelSchema,
  unlistedGaps,
} from './coverage';

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
const coverages = recorded.map(modelCoverage);
const gapOf = (key: string) => {
  const coverage = coverages.find((c) => `${c.provider}/${c.id}` === key);
  if (!coverage) throw new Error(`${key} is not recorded`);
  return coverageGap(coverage);
};

describe('gateway coverage', () => {
  it('has a recording for every product model; re-record when the list changes', () => {
    const key = (m: { provider: string; id: string }) =>
      `${m.provider}/${m.id}`;
    expect(recorded.map(key).toSorted()).toEqual(
      productGatewayModels().map(key).toSorted()
    );
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
});
