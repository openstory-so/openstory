import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBillingMethods } from '@/billing/server/db/billing';
import { createApiKeysReadMethods } from '@/models/server/db/api-keys';
import {
  FREE_ANALYSIS_MODEL,
  FREE_IMAGE_MODEL,
  FREE_SEQUENCE_LIMIT,
  freeSketchRefusal,
  isFreeSketchRetry,
} from '@/billing/free-sketch';
import { micros } from '@/billing/money';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import { organization, user } from '@/platform/server/db/schema';
import { createTestDb } from '@/platform/server/db/test-d1';
import { freeSequencesLeft } from './free-sketch';

let db: Database;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
});

afterAll(async () => {
  await closeDb();
});

async function newOrganization() {
  const organizationId = generateId();
  const userId = generateId();
  await db
    .insert(user)
    .values({ id: userId, name: 'U', email: `${userId}@e.com` });
  await db
    .insert(organization)
    .values({ id: organizationId, name: 'F', slug: organizationId });
  return {
    apiKeys: createApiKeysReadMethods(db, organizationId),
    billing: createBillingMethods(db, organizationId, userId),
  };
}

describe('free sketches (#2390)', () => {
  it('gives an unfunded organization three slots, never a fourth', async () => {
    const scoped = await newOrganization();
    expect(await freeSequencesLeft(scoped)).toBe(FREE_SEQUENCE_LIMIT);
    for (let i = 0; i < FREE_SEQUENCE_LIMIT; i++) {
      expect(await scoped.billing.claimFreeSequence(FREE_SEQUENCE_LIMIT)).toBe(
        true
      );
    }
    expect(await scoped.billing.claimFreeSequence(FREE_SEQUENCE_LIMIT)).toBe(
      false
    );
    expect(await freeSequencesLeft(scoped)).toBe(0);

    await scoped.billing.releaseFreeSequence();
    expect(await freeSequencesLeft(scoped)).toBe(1);
  });

  it('offers none once the organization has credits', async () => {
    const scoped = await newOrganization();
    await scoped.billing.addCredits(micros(1_000_000), {
      idempotencyKey: generateId(),
    });
    expect(await freeSequencesLeft(scoped)).toBe(0);
  });

  it('refuses a run past dialogue, with start frames, or over length', () => {
    const ok = {
      stopAt: 'dialogue',
      generateStartFrames: false,
      script: 'x',
    } as const;
    expect(freeSketchRefusal(ok)).toBeNull();
    expect(freeSketchRefusal({ ...ok, stopAt: 'motion' })).toMatch(/dialogue/);
    expect(freeSketchRefusal({ ...ok, generateStartFrames: true })).toMatch(
      /start frames/
    );
    expect(freeSketchRefusal({ ...ok, script: 'x'.repeat(3001) })).toMatch(
      /3,000/
    );
  });

  it('retries free only on the free terms', () => {
    const sketch = {
      freeSketch: true,
      generateStartFrames: false,
      script: 'INT. ROOM',
      analysisModel: FREE_ANALYSIS_MODEL,
      imageModel: FREE_IMAGE_MODEL,
    };
    expect(isFreeSketchRetry(sketch, 'dialogue')).toBe(true);
    expect(isFreeSketchRetry(sketch, 'motion')).toBe(false);
    expect(
      isFreeSketchRetry({ ...sketch, freeSketch: false }, 'dialogue')
    ).toBe(false);
    expect(
      isFreeSketchRetry({ ...sketch, imageModel: 'nano_banana_2' }, 'dialogue')
    ).toBe(false);
    expect(
      isFreeSketchRetry({ ...sketch, script: 'x'.repeat(3001) }, 'dialogue')
    ).toBe(false);
  });
});
