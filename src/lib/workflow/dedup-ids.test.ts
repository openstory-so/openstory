/**
 * Pins the two invariants of the child-spawn deduplication ids (issue #846
 * RC2): replay-stability (a retried `step.do` reuses the existing child
 * instead of spawning a second paid job) and hash-first ordering (the
 * run-scoping hash must survive `buildInstanceId`'s end-of-suffix truncation,
 * or two different runs would silently collapse onto one stale instance).
 */

import { describe, expect, test } from 'vitest';
import { previewImageDedupId, shotVariantDedupId } from './dedup-ids';
import { buildInstanceId } from './instance-id';

const RUN_A = 'openstory-so_scene-split_01JX3YZABCDEFGHJKMNPQRSTVW';
const RUN_B = 'openstory-so_scene-split_01JX3YZABCDEFGHJKMNPQRSTVX';
const SHOT_ID = '01JX4FRAMEABCDEFGHJKMNPQRS';
const OTHER_SHOT_ID = '01JX4FRAMEABCDEFGHJKMNPQRT';

// Realistic worst-case namespacing: PR-preview env slugs are the longest.
const previewEnv = { VITE_APP_URL: 'https://pr-1234.openstory.dev' };

describe('previewImageDedupId', () => {
  test('is stable across calls with the same inputs (replay-safe)', () => {
    expect(previewImageDedupId(RUN_A, SHOT_ID)).toBe(
      previewImageDedupId(RUN_A, SHOT_ID)
    );
  });

  test('distinct frames get distinct ids within one run', () => {
    expect(previewImageDedupId(RUN_A, SHOT_ID)).not.toBe(
      previewImageDedupId(RUN_A, OTHER_SHOT_ID)
    );
  });

  test('distinct runs get distinct ids for the same frame (re-split spawns fresh previews)', () => {
    expect(previewImageDedupId(RUN_A, SHOT_ID)).not.toBe(
      previewImageDedupId(RUN_B, SHOT_ID)
    );
  });

  test('survives buildInstanceId untruncated for realistic inputs', () => {
    const suffix = previewImageDedupId(RUN_A, SHOT_ID);
    const id = buildInstanceId({
      env: previewEnv,
      workflowName: 'image',
      suffix,
    });
    expect(id.endsWith(suffix)).toBe(true);
    expect(id.length).toBeLessThanOrEqual(100);
  });
});

describe('shotVariantDedupId', () => {
  test('is stable across calls with the same inputs (replay-safe)', () => {
    expect(shotVariantDedupId(RUN_A, SHOT_ID, 'nano_banana_2')).toBe(
      shotVariantDedupId(RUN_A, SHOT_ID, 'nano_banana_2')
    );
  });

  test('distinct frames and models get distinct ids within one run', () => {
    const base = shotVariantDedupId(RUN_A, SHOT_ID, 'nano_banana_2');
    expect(base).not.toBe(
      shotVariantDedupId(RUN_A, OTHER_SHOT_ID, 'nano_banana_2')
    );
    expect(base).not.toBe(shotVariantDedupId(RUN_A, SHOT_ID, 'seedream'));
  });

  test('survives buildInstanceId untruncated for realistic inputs', () => {
    const suffix = shotVariantDedupId(RUN_A, SHOT_ID, 'nano_banana_2');
    const id = buildInstanceId({
      env: previewEnv,
      workflowName: 'variant-image',
      suffix,
    });
    expect(id.endsWith(suffix)).toBe(true);
    expect(id.length).toBeLessThanOrEqual(100);
  });

  test('run-scoping hash survives truncation even with absurdly long discriminators', () => {
    // Force buildInstanceId to truncate the suffix. Because the hash leads,
    // truncation shears the tail (frame/model), never the run discriminator —
    // two different runs must NEVER collapse onto the same instance id, or
    // the second run would silently reuse the first run's (possibly stale or
    // failed) child instance.
    const longModel = 'x'.repeat(120);
    const idA = buildInstanceId({
      env: previewEnv,
      workflowName: 'variant-image',
      suffix: shotVariantDedupId(RUN_A, SHOT_ID, longModel),
    });
    const idB = buildInstanceId({
      env: previewEnv,
      workflowName: 'variant-image',
      suffix: shotVariantDedupId(RUN_B, SHOT_ID, longModel),
    });
    expect(idA.length).toBe(100); // truncation actually occurred
    expect(idB.length).toBe(100);
    expect(idA).not.toBe(idB); // ...and the run hash survived it
  });
});
