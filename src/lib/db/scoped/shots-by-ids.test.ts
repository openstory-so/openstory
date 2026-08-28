/**
 * In-memory DB tests for `sequences.listShotsByIds` (#957).
 *
 * The sequences/eval list pages fetch shots for every sequence on a team in
 * one batched call. Once a team grew past ~500 sequences the request tripped a
 * `z.array().max(500)` cap, and the underlying `inArray` would overflow D1's
 * 100-bound-parameter limit. `listShotsByIds` now chunks the ids; these tests
 * cover a list larger than the chunk size to prove every shot still comes back
 * grouped and in per-sequence order.
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import { shots, sequences, styles, teams } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createSequencesMethods } from './sequences';
import { createShotsMethods } from './shots';

let client: Client;
let db: Database;
let teamId = '';

async function seed() {
  await db.delete(shots);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);

  teamId = generateId();
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
  return style.id;
}

/** Insert `count` sequences, each with 3 shots; returns the sequence ids. */
async function seedSequences(
  styleId: string,
  count: number
): Promise<string[]> {
  const seqIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const seqId = generateId();
    seqIds.push(seqId);
    await db.insert(sequences).values({
      id: seqId,
      teamId,
      title: `S${i}`,
      styleId,
    });
    await db.insert(shots).values([
      { sequenceId: seqId, shotNumber: 1 },
      { sequenceId: seqId, shotNumber: 2 },
      { sequenceId: seqId, shotNumber: 3 },
    ]);
  }
  return seqIds;
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

let styleId = '';
beforeEach(async () => {
  styleId = await seed();
});

describe('listShotsByIds', () => {
  it('returns [] for an empty input', async () => {
    const methods = createSequencesMethods(db, teamId, generateId());
    await expect(methods.listShotsByIds([])).resolves.toEqual([]);
  });

  it('returns every shot when the id list spans multiple chunks', async () => {
    // 250 sequences > the 90-id chunk size, so the query fans out across 3
    // batches. The old single-query path would also blow past D1's 100-param
    // limit here.
    const seqIds = await seedSequences(styleId, 250);
    const methods = createSequencesMethods(db, teamId, generateId());

    const result = await methods.listShotsByIds(seqIds);

    expect(result).toHaveLength(250 * 3);
    // Every requested sequence is represented with all 3 of its shots.
    const bySeq = new Map<string, number[]>();
    for (const shot of result) {
      const existing = bySeq.get(shot.sequenceId) ?? [];
      existing.push(shot.shotNumber ?? 0);
      bySeq.set(shot.sequenceId, existing);
    }
    expect(bySeq.size).toBe(250);
    for (const seqId of seqIds) {
      expect(bySeq.get(seqId)).toEqual([1, 2, 3]);
    }
  });

  it('never leaks shots from another team', async () => {
    const mySeqIds = await seedSequences(styleId, 2);

    // A second team with its own sequence — its id is requested but must not
    // resolve, because the join filters on teamId.
    const otherTeamId = generateId();
    await db.insert(teams).values({ id: otherTeamId, name: 'O', slug: 'o' });
    const [otherStyle] = await db
      .insert(styles)
      .values({
        teamId: otherTeamId,
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
    if (!otherStyle)
      throw new Error('test setup: style insert returned nothing');
    const otherSeqId = generateId();
    await db.insert(sequences).values({
      id: otherSeqId,
      teamId: otherTeamId,
      title: 'X',
      styleId: otherStyle.id,
    });
    await db.insert(shots).values({ sequenceId: otherSeqId, shotNumber: 1 });

    const methods = createSequencesMethods(db, teamId, generateId());
    const result = await methods.listShotsByIds([...mySeqIds, otherSeqId]);

    expect(result).toHaveLength(2 * 3);
    expect(result.every((f) => f.sequenceId !== otherSeqId)).toBe(true);
  });
});

describe('shots.getByIds (#1322)', () => {
  it("chunks the id list under D1's 100-param ceiling and returns every row", async () => {
    // 70 sequences × 3 shots = 210 ids → 3 batches of ≤90. libsql has no
    // bound-param cap, so the spy is what pins the fan-out.
    await seedSequences(styleId, 70);
    const all = await db.select({ id: shots.id }).from(shots);
    const ids = all.map((s) => s.id);
    expect(ids).toHaveLength(210);

    const select = vi.spyOn(db, 'select');
    const rows = await createShotsMethods(db).getByIds(ids);
    expect(rows).toHaveLength(210);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(ids));
    expect(select).toHaveBeenCalledTimes(3);
    select.mockRestore();
  });
});
