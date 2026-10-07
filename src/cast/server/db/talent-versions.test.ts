/**
 * Talent history (#1862): every change to the likeness appends a
 * `talent_versions` row and moves `talent.selectedVersionId`; a cast keeps
 * the version it was made from.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { generateId } from '@/platform/id';
import {
  talent,
  talentSheets,
  talentVersions,
  teams,
  user,
} from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import type { Database } from '@/platform/server/db/client';
import { ConflictError } from '@/platform/errors';
import { createTalentMethods } from './talent';

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
  await db.delete(talentVersions);
  await db.delete(talentSheets);
  await db.delete(talent);
  await db.delete(teams);
  await db.delete(user);
  teamId = generateId();
  userId = generateId();
  await db.insert(user).values({ id: userId, name: 'U', email: 'u@e.com' });
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
});

const methods = () => createTalentMethods(db, teamId, userId);
const row = async (id: string) =>
  (await db.select().from(talent).where(eq(talent.id, id)))[0];

describe('talent versions (#1862)', () => {
  it('creates a talent with its first version keyed to its own id', async () => {
    const created = await methods().create({
      name: 'Ada',
      description: 'tall',
    });
    expect(created.selectedVersionId).toBe(created.id);
    const versions = await methods().versions.list(created.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      id: created.id,
      name: 'Ada',
      description: 'tall',
      sheetId: null,
      source: 'edit',
    });
  });

  it('a name or description edit appends a version and moves the pointer; a favourite flip does not', async () => {
    const created = await methods().create({
      name: 'Ada',
      description: 'tall',
    });
    await methods().update(created.id, { description: 'tall, freckles' });
    const afterEdit = await row(created.id);
    expect(afterEdit?.selectedVersionId).not.toBe(created.id);
    const versions = await methods().versions.list(created.id);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({
      id: afterEdit?.selectedVersionId,
      name: 'Ada',
      description: 'tall, freckles',
      source: 'edit',
      createdBy: userId,
    });

    await methods().toggleFavorite(created.id);
    await methods().update(created.id, { imageUrl: 'https://x/headshot.png' });
    expect(await methods().versions.list(created.id)).toHaveLength(2);
  });

  it('a landed or picked reference sheet is a version carrying that sheet', async () => {
    const created = await methods().create({ name: 'Ada' });
    const sheetId = generateId();
    expect(
      await methods().claimSheet(
        created.id,
        sheetId,
        { description: null, referenceImageUrls: [] },
        { onlyIfFree: true }
      )
    ).toBe(true);
    const { landed } = await methods().landSheet({
      sheetId,
      talentId: created.id,
      imageUrl: 'https://x/a.png',
      imagePath: 'a.png',
      metadata: null,
      source: 'ai_generated',
      inputHash: null,
    });
    expect(landed).toBe(true);
    const afterLand = await row(created.id);
    const [latest] = await methods().versions.list(created.id);
    expect(latest).toMatchObject({
      id: afterLand?.selectedVersionId,
      sheetId,
      source: 'sheet',
      createdBy: null,
    });

    // Picking an older sheet from the history is a version too.
    const older = generateId();
    await db.insert(talentSheets).values({
      id: older,
      talentId: created.id,
      legacyName: 'x',
      source: 'manual_upload',
    });
    await methods().selectSheet(created.id, older);
    const versions = await methods().versions.list(created.id);
    expect(versions).toHaveLength(3);
    expect(versions[0]).toMatchObject({ sheetId: older, source: 'sheet' });
    expect((await row(created.id))?.selectedVersionId).toBe(versions[0]?.id);
  });

  it('two edits that read the same version cannot both land', async () => {
    const created = await methods().create({ name: 'Ada', description: 'a' });
    const results = await Promise.allSettled([
      methods().update(created.id, { description: 'b' }),
      methods().update(created.id, { name: 'Ada B' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected');
    expect(lost?.status === 'rejected' && lost.reason).toBeInstanceOf(
      ConflictError
    );
    expect(await methods().versions.list(created.id)).toHaveLength(2);
  });

  it('delete removes the history with the row', async () => {
    const created = await methods().create({ name: 'Ada' });
    expect(await methods().delete(created.id)).toBe(true);
    expect(
      await db
        .select()
        .from(talentVersions)
        .where(eq(talentVersions.talentId, created.id))
    ).toEqual([]);
  });
});
