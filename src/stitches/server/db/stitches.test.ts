/**
 * `scopedDb.stitches` and the public read (#2127), on in-memory libSQL with
 * the real migrations. What is pinned: an unpublished row is not a page,
 * only its own team can read or publish it, publish happens once, and the
 * public read answers only after it.
 */
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import { teams, user } from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import type { StitchCut } from '@/stitches/cut';
import { createPublicStitchReads, createStitchesMethods } from './stitches';

let client: Client;
let db: Database;
const teamId = generateId();
const otherTeamId = generateId();
const actorId = generateId();

const cut: StitchCut = {
  clips: [{ videoUrl: '/r2/stitches/t/s/0.mp4', posterUrl: null, cues: [] }],
  frameWidth: 16,
  frameHeight: 9,
  musicUrl: null,
  musicGainDb: 0,
};

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  await db.insert(user).values({ id: actorId, name: 'U', email: 'u@e.com' });
  await db.insert(teams).values([
    { id: teamId, name: 'T', slug: 't' },
    { id: otherTeamId, name: 'O', slug: 'o' },
  ]);
});

afterAll(() => {
  client.close();
});

describe('stitches rows', () => {
  it('is a page only once its own team has published it', async () => {
    const own = createStitchesMethods(db, teamId, actorId);
    const other = createStitchesMethods(db, otherTeamId, actorId);
    const pub = createPublicStitchReads(db);
    const id = generateId();
    const created = await own.create({ id, cut, publishedAt: null });
    expect(created).toMatchObject({ id, teamId, userId: actorId, cut });

    // Unpublished: the owner sees it, the public and another team do not.
    expect(await pub.getById(id)).toBeNull();
    expect(await own.getById(id)).toMatchObject({ id, publishedAt: null });
    expect(await other.getById(id)).toBeNull();

    // Another team cannot publish it; the page stays dark.
    expect(await other.publish(id)).toBeNull();
    expect(await pub.getById(id)).toBeNull();

    // The owner publishes once; the second call finds nothing to do.
    const published = await own.publish(id);
    expect(published?.publishedAt).toBeInstanceOf(Date);
    expect(await own.publish(id)).toBeNull();
    expect((await pub.getById(id))?.cut).toEqual(cut);
  });

  it('a row born published is a page at once', async () => {
    const own = createStitchesMethods(db, teamId, actorId);
    const id = generateId();
    await own.create({ id, cut, publishedAt: new Date() });
    expect((await createPublicStitchReads(db).getById(id))?.id).toBe(id);
  });
});
