/**
 * Schema-level acceptance tests for the partial-index split on
 * `sequence_music_variants`, plus the divergence routing in `writeMusicVariant`
 * (the contract that keeps a re-run with a different `inputHash` from silently
 * replacing the previous primary).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { generateId } from '@/shared/id';
import {
  sequenceMusicVariants,
  sequences,
  styles,
  teams,
  user,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import type { Database } from '@/lib/db/client';
import { createSequenceVariantsMethods } from './sequence-variants';

let client: Client;
let db: Database;

const team = { id: '', name: 'T', slug: 't' };
const userRow = { id: '', name: 'U', email: 'u@example.com' };
let sequenceId = '';

async function seed() {
  await db.delete(sequenceMusicVariants);
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

describe('createSequenceVariantsMethods — music', () => {
  it('writeMusicVariant forks to divergent on hash mismatch', async () => {
    const methods = createSequenceVariantsMethods(db);
    await methods.writeMusicVariant({
      sequenceId,
      url: 'https://example.com/m1.mp3',
      storagePath: null,
      prompt: 'p',
      tags: 't',
      durationSeconds: 60,
      model: 'cassette',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'm-hash-1',
    });
    const second = await methods.writeMusicVariant({
      sequenceId,
      url: 'https://example.com/m2.mp3',
      storagePath: null,
      prompt: 'p2',
      tags: 't2',
      durationSeconds: 90,
      model: 'cassette',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'm-hash-2',
    });
    expect(second.divergent).toBe(true);

    const primary = await methods.getMusicPrimary(sequenceId, 'cassette');
    expect(primary?.url).toBe('https://example.com/m1.mp3');
  });

  it('promoteMusicVariant copies prompt/tags/url onto sequences.music* AND soft-deletes the source row in one batch', async () => {
    const methods = createSequenceVariantsMethods(db);
    // Seed a divergent alternate via the divergence-routing path so the
    // variant has divergedAt set — then promote it.
    await methods.upsertMusicPrimary({
      sequenceId,
      url: 'https://example.com/old.mp3',
      storagePath: null,
      prompt: 'old',
      tags: 'old',
      durationSeconds: 60,
      model: 'cassette',
      status: 'completed',
      generatedAt: new Date('2026-04-01T00:00:00Z'),
      error: null,
      inputHash: 'old-hash',
    });
    const divergent = await methods.insertDivergentMusic({
      sequenceId,
      url: 'https://example.com/m.mp3',
      storagePath: '/p/m.mp3',
      prompt: 'jazzy',
      tags: 'lofi',
      durationSeconds: 60,
      model: 'cassette',
      status: 'completed',
      generatedAt: new Date('2026-04-29T00:00:00Z'),
      error: null,
      inputHash: 'new-hash',
      divergedAt: new Date('2026-04-29T00:00:00Z'),
    });

    const { discardedAt } = await methods.promoteMusicVariant(divergent.id);

    const rows = await db.select().from(sequences);
    const updated = rows.find((s) => s.id === sequenceId);
    expect(updated).toBeDefined();
    expect(updated?.musicUrl).toBe('https://example.com/m.mp3');
    expect(updated?.musicPrompt).toBe('jazzy');
    expect(updated?.musicModel).toBe('cassette');
    expect(updated?.musicStatus).toBe('completed');

    // Atomic-promote leg: source row must be soft-deleted in the same batch.
    // SQLite stores timestamps at second resolution.
    const variantRow = await methods.getMusicById(divergent.id);
    expect(variantRow?.discardedAt).not.toBeNull();
    expect(Math.floor((variantRow?.discardedAt?.getTime() ?? 0) / 1000)).toBe(
      Math.floor(discardedAt.getTime() / 1000)
    );
    const stillDivergent = await methods.listDivergentMusic(sequenceId);
    expect(stillDivergent).toHaveLength(0);
  });

  it('promoteMusicVariant throws when the variant id does not exist', async () => {
    const methods = createSequenceVariantsMethods(db);
    let error: Error | null = null;
    try {
      await methods.promoteMusicVariant(generateId());
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      error = e;
    }
    expect(error?.message).toMatch(/not found/);
  });

  it('insertDivergentMusic idempotent on retry', async () => {
    const methods = createSequenceVariantsMethods(db);
    await methods.upsertMusicPrimary({
      sequenceId,
      url: 'https://example.com/p.mp3',
      storagePath: null,
      prompt: 'p',
      tags: 't',
      durationSeconds: 60,
      model: 'cassette',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'p-hash',
    });
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const first = await methods.insertDivergentMusic({
      sequenceId,
      url: 'https://example.com/d.mp3',
      storagePath: null,
      prompt: 'd',
      tags: 't',
      durationSeconds: 60,
      model: 'cassette',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'd-hash',
      divergedAt,
    });
    const second = await methods.insertDivergentMusic({
      sequenceId,
      url: 'https://example.com/d.mp3',
      storagePath: null,
      prompt: 'd',
      tags: 't',
      durationSeconds: 60,
      model: 'cassette',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'd-hash',
      divergedAt,
    });
    expect(second.id).toBe(first.id);
  });
});

describe('createSequenceVariantsMethods — markMusicFailed (#547)', () => {
  it('flips a pre-stamped pending variant row to failed', async () => {
    const methods = createSequenceVariantsMethods(db);
    await methods.upsertMusicPrimary({
      sequenceId,
      model: 'cassette',
      prompt: 'p',
      tags: 't',
      durationSeconds: 60,
      status: 'pending',
    });

    await methods.markMusicFailed(sequenceId, 'cassette', 'boom');

    const row = await methods.getMusicPrimary(sequenceId, 'cassette');
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('boom');
  });

  it('is update-only — never inserts a row for a model that has none', async () => {
    const methods = createSequenceVariantsMethods(db);

    await methods.markMusicFailed(sequenceId, 'cassette', 'boom');

    const rows = await methods.listMusicBySequence(sequenceId);
    expect(rows).toHaveLength(0);
  });

  it('never overwrites a completed alternate', async () => {
    const methods = createSequenceVariantsMethods(db);
    await methods.upsertMusicPrimary({
      sequenceId,
      model: 'cassette',
      url: 'https://example.com/done.mp3',
      prompt: 'p',
      tags: 't',
      durationSeconds: 60,
      status: 'completed',
    });

    await methods.markMusicFailed(sequenceId, 'cassette', 'boom');

    const row = await methods.getMusicPrimary(sequenceId, 'cassette');
    expect(row?.status).toBe('completed');
    expect(row?.error).toBeNull();
  });
});

describe('listDivergentByTeam', () => {
  it('excludes variants belonging to a different team and excludes discarded rows', async () => {
    const methods = createSequenceVariantsMethods(db);

    // Build a second team with its own sequence sharing the same style.
    const otherTeamId = generateId();
    await db.insert(teams).values({
      id: otherTeamId,
      name: 'Other',
      slug: 'other',
    });
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
      throw new Error('test setup: otherStyle insert returned nothing');
    const otherSequenceId = generateId();
    await db.insert(sequences).values({
      id: otherSequenceId,
      teamId: otherTeamId,
      title: 'Other',
      styleId: otherStyle.id,
    });

    // Add a second sequence on the seed team so we can test the
    // "two sequences => two rows" axis.
    const secondSeedSequenceId = generateId();
    const [seedStyle] = await db
      .select()
      .from(styles)
      .where(eq(styles.teamId, team.id));
    if (!seedStyle)
      throw new Error('test setup: seedStyle lookup returned nothing');
    await db.insert(sequences).values({
      id: secondSeedSequenceId,
      teamId: team.id,
      title: 'S2',
      styleId: seedStyle.id,
    });

    const divergedAt = new Date('2026-04-29T00:00:00Z');

    // Live divergent music on the seed team's primary sequence.
    await db.insert(sequenceMusicVariants).values({
      sequenceId,
      model: 'cassette',
      url: 'https://example.com/m-divergent.mp3',
      status: 'completed',
      inputHash: 'm-hash',
      divergedAt,
    });

    // Live divergent music on the second seed-team sequence (separate row).
    await db.insert(sequenceMusicVariants).values({
      sequenceId: secondSeedSequenceId,
      model: 'cassette',
      url: 'https://example.com/m2-divergent.mp3',
      status: 'completed',
      inputHash: 'm2-hash',
      divergedAt,
    });

    // Discarded divergent music on the seed team — must be excluded.
    await db.insert(sequenceMusicVariants).values({
      sequenceId: secondSeedSequenceId,
      model: 'cassette',
      url: 'https://example.com/m-discarded.mp3',
      status: 'completed',
      inputHash: 'discarded-hash',
      divergedAt,
      discardedAt: new Date('2026-04-30T00:00:00Z'),
    });

    // Live divergent music on the OTHER team — must be excluded by team scope.
    await db.insert(sequenceMusicVariants).values({
      sequenceId: otherSequenceId,
      model: 'cassette',
      url: 'https://example.com/other.mp3',
      status: 'completed',
      inputHash: 'other-hash',
      divergedAt,
    });

    const rows = await methods.listDivergentByTeam(team.id);
    const byId = new Map(rows.map((r) => [r.sequenceId, r]));

    expect(rows).toHaveLength(2);
    expect(byId.get(sequenceId)).toEqual({
      sequenceId,
      hasMusic: true,
    });
    expect(byId.get(secondSeedSequenceId)).toEqual({
      sequenceId: secondSeedSequenceId,
      hasMusic: true,
    });
    // Other team's sequence must not appear.
    expect(byId.has(otherSequenceId)).toBe(false);
  });
});
