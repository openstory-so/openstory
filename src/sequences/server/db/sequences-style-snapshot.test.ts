/**
 * Sequence-owned style snapshot: create/style-change copy the catalog recipe
 * so later catalog edits cannot stale existing sequences.
 */
import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import { sequences, styles, teams, user } from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import { createSequencesMethods } from './sequences';
import { isStyleConfigV2, parseStyleConfig } from '@/look/style-config';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const V1_A = {
  mood: 'tense and paranoid',
  artStyle: 'high-contrast neo-noir',
  lighting: 'low-key with hard shadows',
  colorPalette: ['#0a0a14', '#e8322f'],
  cameraWork: 'slow dolly, dutch angles',
  referenceFilms: ['rain-slicked neon-noir cityscapes'],
  colorGrading: 'crushed blacks, neon accents',
};

const V1_B = {
  ...V1_A,
  mood: 'bright and playful energy',
  artStyle: 'clean commercial product photography',
};

let client: Client;
let db: Database;
let teamId = '';
let userId = '';

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);
  teamId = generateId();
  userId = generateId();
  await db
    .insert(user)
    .values({ id: userId, name: 'U', email: 'u@example.com' });
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
});

async function insertStyle(name: string, config: typeof V1_A) {
  const [row] = await db
    .insert(styles)
    .values({ teamId, name, config })
    .returning();
  if (!row) throw new Error('style insert returned nothing');
  return row;
}

describe('createSequencesMethods style snapshot', () => {
  it('copies a parsed v2 recipe onto the sequence at create', async () => {
    const style = await insertStyle('Noir', V1_A);
    const methods = createSequencesMethods(db, teamId, userId);
    const sequence = await methods.create({
      title: 'S',
      styleId: style.id,
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    expect(sequence.styleConfig).toBeTruthy();
    expect(isStyleConfigV2(sequence.styleConfig)).toBe(true);
    expect(parseStyleConfig(sequence.styleConfig).look.mood).toBe(V1_A.mood);
  });

  it('keeps the snapshot when the catalog row is later edited', async () => {
    const style = await insertStyle('Noir', V1_A);
    const methods = createSequencesMethods(db, teamId, userId);
    const sequence = await methods.create({
      title: 'S',
      styleId: style.id,
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    await db
      .update(styles)
      .set({ config: V1_B })
      .where(eq(styles.id, style.id));

    const reread = await methods.getById(sequence.id);
    expect(parseStyleConfig(reread?.styleConfig).look.mood).toBe(V1_A.mood);
  });

  it('replaces the snapshot when the sequence changes style', async () => {
    const styleA = await insertStyle('Noir', V1_A);
    const styleB = await insertStyle('Product', V1_B);
    const methods = createSequencesMethods(db, teamId, userId);
    const sequence = await methods.create({
      title: 'S',
      styleId: styleA.id,
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const updated = await methods.update({
      id: sequence.id,
      styleId: styleB.id,
    });
    expect(parseStyleConfig(updated.styleConfig).look.mood).toBe(V1_B.mood);
  });

  it('keeps every snapshot as a version and points at the live one (#1600)', async () => {
    const styleA = await insertStyle('Noir', V1_A);
    const styleB = await insertStyle('Product', V1_B);
    const methods = createSequencesMethods(db, teamId, userId);
    const sequence = await methods.create({
      title: 'S',
      styleId: styleA.id,
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    const updated = await methods.update({
      id: sequence.id,
      styleId: styleB.id,
    });

    const versions = await methods.listStyleVersions(sequence.id);
    expect(versions.map((v) => [v.source, v.styleId])).toEqual([
      ['created', styleA.id],
      ['switched', styleB.id],
    ]);
    expect(updated.selectedStyleVersionId).toBe(versions[1]?.id);
    expect(parseStyleConfig(versions[0]?.config).look.mood).toBe(V1_A.mood);
  });

  it('a deferred snapshot has no version until the automatic style lands', async () => {
    const style = await insertStyle('Auto', V1_A);
    const methods = createSequencesMethods(db, teamId, userId);
    const sequence = await methods.create({
      title: 'S',
      styleId: style.id,
      deferStyleSnapshot: true,
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    expect(sequence.styleConfig).toBeNull();
    expect(await methods.listStyleVersions(sequence.id)).toEqual([]);

    expect(
      await methods.snapshotAutoStyle({ id: sequence.id, styleId: style.id })
    ).toBe(true);
    const [derived] = await methods.listStyleVersions(sequence.id);
    expect(derived?.source).toBe('derived');
    expect((await methods.getById(sequence.id))?.selectedStyleVersionId).toBe(
      derived?.id
    );
  });
});
