/**
 * Schema-level acceptance tests for the partial-index split on `shot_variants`.
 *
 * The schema lays down two unique indexes keyed on `divergedAt IS NULL` vs.
 * `divergedAt IS NOT NULL`, so:
 *   - At most one primary row may exist per (shot, type, model).
 *   - Multiple divergent alternates may coexist as long as they have distinct
 *     `inputHash` values.
 * Plus the scoped wrappers (`getByShotAndModel`, `insertDivergent`) must
 * respect that split: the getter returns the primary, the inserter is
 * idempotent on retry.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/shared/id';
import {
  shotVariants,
  shots,
  sequences,
  styles,
  teams,
  user,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import type { Database } from '@/lib/db/client';
import { createShotVariantsMethods } from './shot-variants';

let client: Client;
let db: Database;

const team = { id: '', name: 'T', slug: 't' };
const userRow = { id: '', name: 'U', email: 'u@example.com' };
let sequenceId = '';
let shotId = '';

async function seed() {
  await db.delete(shotVariants);
  await db.delete(shots);
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
  const [shot] = await db
    .insert(shots)
    .values({ sequenceId, shotNumber: 1 })
    .returning();
  if (!shot) throw new Error('test setup: shot insert returned nothing');
  shotId = shot.id;
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

describe('shot_variants partial-index uniqueness', () => {
  it('allows one primary plus N divergent alternates for the same (shot, type, model)', async () => {
    // Primary: divergedAt IS NULL.
    await db.insert(shotVariants).values({
      shotId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/primary.png',
      status: 'completed',
      inputHash: 'primary-hash',
    });

    // Two divergent alternates with distinct input hashes — both legal under
    // the divergent partial unique index because the index keys on
    // (shotId, variantType, model, inputHash) WHERE divergedAt IS NOT NULL.
    await db.insert(shotVariants).values({
      shotId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/divergent-a.png',
      status: 'completed',
      inputHash: 'divergent-hash-a',
      divergedAt: new Date('2026-04-29T00:00:00Z'),
    });
    await db.insert(shotVariants).values({
      shotId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/divergent-b.png',
      status: 'completed',
      inputHash: 'divergent-hash-b',
      divergedAt: new Date('2026-04-30T00:00:00Z'),
    });

    const rows = await db.select().from(shotVariants);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.divergedAt === null)).toHaveLength(1);
    expect(rows.filter((r) => r.divergedAt !== null)).toHaveLength(2);
  });

  it('rejects a second primary row for the same (shot, type, model)', async () => {
    await db.insert(shotVariants).values({
      shotId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/primary-1.png',
      status: 'completed',
    });

    let threw = false;
    try {
      await db.insert(shotVariants).values({
        shotId,
        sequenceId,
        variantType: 'image',
        model: 'nano_banana_2',
        url: 'https://example.com/primary-2.png',
        status: 'completed',
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('rejects a second divergent row with the same (shot, type, model, inputHash)', async () => {
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    await db.insert(shotVariants).values({
      shotId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/divergent-1.png',
      status: 'completed',
      inputHash: 'shared-hash',
      divergedAt,
    });

    let threw = false;
    try {
      await db.insert(shotVariants).values({
        shotId,
        sequenceId,
        variantType: 'image',
        model: 'nano_banana_2',
        url: 'https://example.com/divergent-2.png',
        status: 'completed',
        inputHash: 'shared-hash',
        divergedAt,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe('createShotVariantsMethods', () => {
  it('getByShotAndModel returns the primary row even when divergent alternates exist', async () => {
    const methods = createShotVariantsMethods(db);

    await db.insert(shotVariants).values({
      shotId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/primary.png',
      status: 'completed',
    });
    await db.insert(shotVariants).values({
      shotId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/divergent.png',
      status: 'completed',
      inputHash: 'divergent-hash',
      divergedAt: new Date('2026-04-29T00:00:00Z'),
    });

    const result = await methods.getByShotAndModel(
      shotId,
      'image',
      'nano_banana_2'
    );

    expect(result).not.toBeNull();
    expect(result?.url).toBe('https://example.com/primary.png');
    expect(result?.divergedAt).toBeNull();
  });

  it('insertDivergent is idempotent on the same (shot, type, model, inputHash)', async () => {
    const methods = createShotVariantsMethods(db);

    // Primary must exist first — image-workflow's dual-write writes it.
    await db.insert(shotVariants).values({
      shotId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/primary.png',
      status: 'completed',
    });

    const divergedAt = new Date('2026-04-29T00:00:00Z');

    const first = await methods.insertDivergent({
      shotId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/divergent.png',
      status: 'completed',
      inputHash: 'divergent-hash',
      divergedAt,
    });
    expect(first.id).toBeDefined();

    // Second call — simulates a retry of the reconcile step. Must not
    // throw and must not create a second row, and must return the existing
    // row so callers (e.g. realtime emitters) can reference its id.
    const second = await methods.insertDivergent({
      shotId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/divergent.png',
      status: 'completed',
      inputHash: 'divergent-hash',
      divergedAt,
    });
    expect(second.id).toBe(first.id);

    const rows = await db.select().from(shotVariants);
    expect(rows.filter((r) => r.divergedAt !== null)).toHaveLength(1);
  });
});

describe('shot_variants discard / undiscard / listDivergent', () => {
  async function insertDivergent(opts: {
    inputHash: string;
    divergedAt: Date;
    discardedAt?: Date;
  }) {
    const [variant] = await db
      .insert(shotVariants)
      .values({
        shotId,
        sequenceId,
        variantType: 'image',
        model: 'm1',
        url: `https://example.com/${opts.inputHash}.png`,
        status: 'completed',
        inputHash: opts.inputHash,
        divergedAt: opts.divergedAt,
        discardedAt: opts.discardedAt ?? null,
      })
      .returning();
    if (!variant) {
      throw new Error('test setup: shotVariants insert returned nothing');
    }
    return variant;
  }

  it('discard sets discardedAt; undiscard clears it', async () => {
    const v = await insertDivergent({
      inputHash: 'h1',
      divergedAt: new Date('2026-04-29T00:00:00Z'),
    });
    const methods = createShotVariantsMethods(db);

    const ts = await methods.discard(v.id);
    expect(ts).toBeInstanceOf(Date);
    const after = await methods.getById(v.id);
    // SQLite timestamp(0) drops sub-second precision on round-trip, so compare seconds.
    expect(Math.floor((after?.discardedAt?.getTime() ?? 0) / 1000)).toBe(
      Math.floor(ts.getTime() / 1000)
    );

    await methods.undiscard(v.id);
    const restored = await methods.getById(v.id);
    expect(restored?.discardedAt).toBeNull();
  });

  it('listDivergentByShot excludes discarded rows and orders by divergedAt', async () => {
    const a = await insertDivergent({
      inputHash: 'h-a',
      divergedAt: new Date('2026-04-29T00:00:00Z'),
    });
    const b = await insertDivergent({
      inputHash: 'h-b',
      divergedAt: new Date('2026-04-30T00:00:00Z'),
    });
    const c = await insertDivergent({
      inputHash: 'h-c',
      divergedAt: new Date('2026-05-01T00:00:00Z'),
      discardedAt: new Date('2026-05-02T00:00:00Z'),
    });

    const methods = createShotVariantsMethods(db);
    const rows = await methods.listDivergentByShot(shotId, 'image');
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([a.id, b.id]);
    expect(ids).not.toContain(c.id);
  });
});
