/**
 * In-memory DB tests for `sequenceLocations.createBulk` upsert semantics
 * (issue #846 RC4).
 *
 * LocationBibleWorkflow's `create-location-records` step inserts in batches
 * of 3; a retry after a partial batch commit used to hit a UNIQUE violation
 * on `(sequence_id, location_id)` on every replay — exhausting the retry
 * budget and stranding locations in `referenceStatus='generating'`. The
 * upsert keeps replays converging: existing rows keep their `id` (and their
 * reference-image columns, owned by the child LocationSheetWorkflow) while
 * bible fields refresh from the incoming row.
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import type { NewSequenceLocation } from '@/lib/db/schema';
import {
  locationSheetVariants,
  sequenceLocations,
  sequences,
  styles,
  teams,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSequenceLocationsMethods } from './sequence-locations';

let client: Client;
let db: Database;
let teamId = '';
let sequenceId = '';

async function seed() {
  await db.delete(sequenceLocations);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);

  teamId = generateId();
  sequenceId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
  const [style] = await db
    .insert(styles)
    .values({
      teamId,
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
  await db.insert(sequences).values({
    id: sequenceId,
    teamId,
    title: 'S',
    styleId: style.id,
  });
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
});

function locationInsert(locationId: string): NewSequenceLocation {
  return {
    id: generateId(),
    sequenceId,
    locationId,
    name: `Location ${locationId}`,
    description: `Description for ${locationId}`,
    referenceStatus: 'generating',
  };
}

describe('createBulk', () => {
  it('a full replay converges instead of throwing UNIQUE violations', async () => {
    const methods = createSequenceLocationsMethods(db);
    // 4 rows > BATCH_SIZE (3) so the replay crosses a batch boundary.
    const inserts = ['loc_001', 'loc_002', 'loc_003', 'loc_004'].map(
      locationInsert
    );

    const first = await methods.createBulk(inserts);
    expect(first).toHaveLength(4);

    // Workflow-step retry replays the whole closure with fresh ULIDs but the
    // same (sequenceId, locationId) pairs.
    const replayInserts = ['loc_001', 'loc_002', 'loc_003', 'loc_004'].map(
      locationInsert
    );
    const replay = await methods.createBulk(replayInserts);

    // Same row count (the workflow's `created.length` guard keeps working)
    // and the original ids survive — the replay updates, it doesn't insert.
    expect(replay).toHaveLength(4);
    const firstIds = new Set(first.map((row) => row.id));
    expect(replay.every((row) => firstIds.has(row.id))).toBe(true);

    const all = await db
      .select()
      .from(sequenceLocations)
      .where(eq(sequenceLocations.sequenceId, sequenceId));
    expect(all).toHaveLength(4);
  });

  it('refreshes bible fields but leaves reference-image columns untouched', async () => {
    const methods = createSequenceLocationsMethods(db);
    const [created] = await methods.createBulk([locationInsert('loc_001')]);
    if (!created) throw new Error('test setup: createBulk returned nothing');

    // Child LocationSheetWorkflow completes the reference in the meantime.
    // The image lands on the version row, not the parent (#1419).
    await db
      .update(sequenceLocations)
      .set({ referenceStatus: 'completed' })
      .where(eq(sequenceLocations.id, created.id));
    await db.insert(locationSheetVariants).values({
      id: created.id,
      parentType: 'sequence_location',
      parentId: created.id,
      model: 'prior',
      url: 'https://r2/loc_001.png',
      storagePath: 'locations/loc_001.png',
      status: 'completed',
    });

    const [upserted] = await methods.createBulk([
      { ...locationInsert('loc_001'), description: 'fresher description' },
    ]);

    expect(upserted?.id).toBe(created.id);
    expect(upserted?.description).toBe('fresher description');
    // Owned by the child workflow — must not be clobbered by a parent replay.
    expect(upserted?.referenceStatus).toBe('completed');
    // `createBulk` returns raw rows; the reference reads back resolved.
    const live = await methods.getById(created.id);
    expect(live?.referenceImageUrl).toBe('https://r2/loc_001.png');
    expect(live?.referenceImagePath).toBe('locations/loc_001.png');
  });

  it('returns [] for an empty input', async () => {
    const methods = createSequenceLocationsMethods(db);
    await expect(methods.createBulk([])).resolves.toEqual([]);
  });
});
