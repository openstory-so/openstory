/**
 * Schema-level acceptance test for the input-hash columns. The `isStale`
 * wrappers these columns once fed had no production callers and are gone
 * (#1787): staleness verdicts come from `computeShotStaleness`,
 * `isSelectedVersionStale` and `readReferenceStaleness`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@/platform/server/db/test-d1';
import { eq } from 'drizzle-orm';
import { generateId } from '@/platform/id';
import {
  characters,
  shotVariants,
  shots,
  locationSheetVariants,
  locations,
  sequences,
  styles,
  teams,
  user,
} from '@/platform/server/db/schema';
import type { Database } from '@/platform/server/db/client';

let closeDb: () => Promise<void>;
let db: Database;

const team = { id: '', name: 'T', slug: 't' };
const userRow = { id: '', name: 'U', email: 'u@example.com' };
let sequenceId = '';

async function seed() {
  await db.delete(shotVariants);
  await db.delete(shots);
  await db.delete(characters);
  await db.delete(locationSheetVariants);
  await db.delete(locations);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  team.id = generateId();
  userRow.id = generateId();
  sequenceId = generateId();

  await db.insert(user).values([userRow]);
  await db.insert(teams).values([team]);
  const [style] = await db
    .insert(styles)
    .values({
      teamId: team.id,
      name: 'default',
      config: {
        mood: 'neutral',
        artStyle: 'cinematic',
        lighting: 'natural',
        colorPalette: ['#000', '#fff'],
        cameraWork: 'static',
        referenceFilms: [],
        colorGrading: 'neutral',
      },
    })
    .returning();
  if (!style) throw new Error('test setup: style insert returned nothing');
  await db
    .insert(sequences)
    .values([
      { id: sequenceId, teamId: team.id, title: 'S', styleId: style.id },
    ]);
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await seed();
});

// `shots` owns no input-hash column any more: the still-image hashes moved to
// `frames` in #989, and #1067 phase 2d dropped `video_input_hash` along with the
// rest of the `shots.video*` mirror. Video staleness is now checked against the
// selected version's own hash — see the `videoVariants.isStale` coverage in
// video-variants.test.ts.

describe('shot_variants input-hash + diverged_at columns', () => {
  it('default to null and persist when set', async () => {
    const [shot] = await db
      .insert(shots)
      .values({ sequenceId, shotNumber: 1 })
      .returning();
    if (!shot) throw new Error('test setup: shot insert returned nothing');
    const [variant] = await db
      .insert(shotVariants)
      .values({
        shotId: shot.id,
        sequenceId,
        variantType: 'image',
        model: 'm1',
      })
      .returning();
    if (!variant)
      throw new Error('test setup: variant insert returned nothing');
    expect(variant.inputHash).toBeNull();
    expect(variant.divergedAt).toBeNull();

    const divergedAt = new Date('2026-04-29T00:00:00Z');
    await db
      .update(shotVariants)
      .set({ inputHash: 'h', divergedAt })
      .where(eq(shotVariants.id, variant.id));
    const [refreshed] = await db
      .select()
      .from(shotVariants)
      .where(eq(shotVariants.id, variant.id));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.inputHash).toBe('h');
    expect(refreshed.divergedAt?.getTime()).toBe(divergedAt.getTime());
  });
});

describe('location_sheet_variants.input_hash', () => {
  it('defaults to null and persists when set', async () => {
    const [loc] = await db
      .insert(locations)
      .values({ teamId: team.id, legacyName: 'L' })
      .returning();
    if (!loc) throw new Error('test setup: location insert returned nothing');
    const [sheet] = await db
      .insert(locationSheetVariants)
      .values({ locationId: loc.id, model: 'm1', url: '/r2/l.png' })
      .returning();
    if (!sheet) throw new Error('test setup: sheet insert returned nothing');
    expect(sheet.inputHash).toBeNull();
    // What a row carried over from the old library keeps for verify (#1695).
    expect(loc.legacyLibraryReferenceHash).toBeNull();

    await db
      .update(locationSheetVariants)
      .set({ inputHash: 'h' })
      .where(eq(locationSheetVariants.id, sheet.id));
    const [refreshed] = await db
      .select()
      .from(locationSheetVariants)
      .where(eq(locationSheetVariants.id, sheet.id));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.inputHash).toBe('h');
  });
});
