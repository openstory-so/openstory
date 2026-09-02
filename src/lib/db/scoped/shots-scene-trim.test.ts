/**
 * Behavioral test for `shots.deleteByScenesFromOrderIndex` — the tail trim the
 * scene-split workflow runs when a re-analyze produces FEWER scenes than the
 * previous run.
 *
 * `shots.scene_id` is a bare `REFERENCES scenes(id)` (RESTRICT), so
 * `scenes.deleteFromOrderIndex` cannot trim the tail while shots still point at
 * it. This method is the companion that clears the way, and it does it as a
 * single predicate DELETE precisely so the workflow never has to read live rows
 * to find its targets (a live listing also returns rows a concurrent run just
 * created, and would delete them).
 *
 * The two ways this can go wrong are opposites: trimming too little (the scene
 * delete then fails on the FK) and trimming too much (a surviving scene's shots,
 * or another sequence's, go with it).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/shared/id';
import {
  dbSceneId,
  type DbSceneId,
  frames,
  scenes,
  sequences,
  shots,
  styles,
  teams,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import type { Database } from '@/lib/db/client';
import { createScenesMethods } from './scenes';
import { createShotsMethods } from './shots';

let client: Client;
let db: Database;
let sequenceId = '';
let otherSequenceId = '';
/** Scenes of `sequenceId`, indexed by orderIndex (0, 1, 2). */
let sceneIds: DbSceneId[] = [];
/** Scene at orderIndex 1 of a DIFFERENT sequence — must never be touched. */
let otherSceneId: DbSceneId = dbSceneId('');

async function createSequence(teamId: string, styleId: string) {
  const id = generateId();
  await db.insert(sequences).values({ id, teamId, title: 'S', styleId });
  return id;
}

async function seed() {
  await db.delete(frames);
  // Shots before scenes: the scene FK is RESTRICT, not cascade.
  await db.delete(shots);
  await db.delete(scenes);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);

  const teamId = generateId();
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

  sequenceId = await createSequence(teamId, style.id);
  otherSequenceId = await createSequence(teamId, style.id);

  const shotsMethods = createShotsMethods(db);

  sceneIds = [];
  for (const orderIndex of [0, 1, 2]) {
    const sceneId = dbSceneId(generateId());
    await db.insert(scenes).values({ id: sceneId, sequenceId, orderIndex });
    sceneIds.push(sceneId);
    // Two shots per scene, so a partial trim is visible.
    await shotsMethods.bulkUpsert([
      { sequenceId, sceneId, shotNumber: 1 },
      { sequenceId, sceneId, shotNumber: 2 },
    ]);
  }

  otherSceneId = dbSceneId(generateId());
  await db.insert(scenes).values({
    id: otherSceneId,
    sequenceId: otherSequenceId,
    orderIndex: 1,
  });
  await shotsMethods.bulkUpsert([
    { sequenceId: otherSequenceId, sceneId: otherSceneId, shotNumber: 1 },
  ]);
}

/** Scene ids that still have at least one shot, in scene order. */
async function survivingSceneIds(forSequenceId: string): Promise<string[]> {
  const rows = await db
    .select({ sceneId: shots.sceneId, orderIndex: scenes.orderIndex })
    .from(shots)
    .innerJoin(scenes, eq(shots.sceneId, scenes.id))
    .where(eq(shots.sequenceId, forSequenceId))
    .orderBy(asc(scenes.orderIndex));
  // `shots.sceneId` is nullable in the schema; the inner join already dropped
  // the null rows, so this narrows rather than filters.
  return [...new Set(rows.flatMap((r) => (r.sceneId ? [r.sceneId] : [])))];
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

describe('shots.deleteByScenesFromOrderIndex', () => {
  it('deletes shots of trailing scenes only', async () => {
    const methods = createShotsMethods(db);

    // Re-analyze produced 1 scene where there were 3 → trim from index 1.
    const deleted = await methods.deleteByScenesFromOrderIndex(sequenceId, 1);

    expect(deleted).toBe(4);
    expect(await survivingSceneIds(sequenceId)).toEqual([sceneIds[0]]);
  });

  it('leaves earlier scenes and other sequences untouched', async () => {
    const methods = createShotsMethods(db);

    // The other sequence has a scene at orderIndex 1 too — the predicate must
    // filter on sequence, not on orderIndex alone.
    await methods.deleteByScenesFromOrderIndex(sequenceId, 1);

    expect(await survivingSceneIds(otherSequenceId)).toEqual([otherSceneId]);
    const survivorShots = await db
      .select()
      .from(shots)
      .where(eq(shots.sceneId, sceneIds[0] ?? ''));
    expect(survivorShots).toHaveLength(2);
  });

  it('clears the RESTRICT FK so the scene trim itself succeeds', async () => {
    // The whole reason this method exists: `scenes.deleteFromOrderIndex` throws
    // on the FK if shots still point at the tail.
    const shotsMethods = createShotsMethods(db);
    const scenesMethods = createScenesMethods(db);

    await shotsMethods.deleteByScenesFromOrderIndex(sequenceId, 1);
    await scenesMethods.deleteFromOrderIndex(sequenceId, 1);

    const remaining = await db
      .select({ orderIndex: scenes.orderIndex })
      .from(scenes)
      .where(eq(scenes.sequenceId, sequenceId));
    expect(remaining.map((r) => r.orderIndex)).toEqual([0]);
  });

  it('is a no-op when nothing trails the cut', async () => {
    const methods = createShotsMethods(db);

    // Scene count unchanged (3 scenes, cut at 3) — the common case.
    const deleted = await methods.deleteByScenesFromOrderIndex(sequenceId, 3);

    expect(deleted).toBe(0);
    expect(await survivingSceneIds(sequenceId)).toEqual(sceneIds);
  });

  it('deletes every shot when the cut is at 0', async () => {
    const methods = createShotsMethods(db);

    const deleted = await methods.deleteByScenesFromOrderIndex(sequenceId, 0);

    expect(deleted).toBe(6);
    expect(await survivingSceneIds(sequenceId)).toEqual([]);
    // Scoping still holds at the extreme.
    expect(await survivingSceneIds(otherSequenceId)).toEqual([otherSceneId]);
  });

  it('cascades the deleted shots’ anchor frames away', async () => {
    const methods = createShotsMethods(db);

    const before = await db.select().from(frames);
    expect(before.length).toBeGreaterThan(0);

    await methods.deleteByScenesFromOrderIndex(sequenceId, 1);

    const remainingShotIds = new Set(
      (await db.select({ id: shots.id }).from(shots)).map((r) => r.id)
    );
    const orphanFrames = (await db.select().from(frames)).filter(
      (f) => !remainingShotIds.has(f.shotId)
    );
    expect(orphanFrames).toEqual([]);
  });
});
