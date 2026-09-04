/**
 * Public (anonymous) read-boundary tests.
 *
 * The createPublic*ReadMethods factories back unauthenticated endpoints
 * (getPublicTalentFn, getPublicLibraryLocationsFn, …), so their isPublic
 * filters are the entire data-leak barrier: one leak test per factory.
 * The styles equivalent lives in styles.test.ts alongside its other tests.
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/shared/id';
import { locationLibrary, talent, teams } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { createPublicLocationsReadMethods } from '@/lib/db/scoped/location-library';
import { createPublicTalentReadMethods } from '@/lib/db/scoped/talent';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let client: Client;
let db: Database;

const team = { id: '', name: 'T', slug: 't' };

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.delete(talent);
  await db.delete(locationLibrary);
  await db.delete(teams);
  team.id = generateId();
  await db.insert(teams).values([team]);
});

describe('createPublicTalentReadMethods', () => {
  it('returns only public talent, never private team talent', async () => {
    const [pub] = await db
      .insert(talent)
      .values({ teamId: team.id, name: 'Public', isPublic: true })
      .returning();
    const [priv] = await db
      .insert(talent)
      .values({ teamId: team.id, name: 'Private' })
      .returning();
    if (!pub || !priv) throw new Error('seed failed');

    const methods = createPublicTalentReadMethods(db);

    const ids = (await methods.list()).map((t) => t.id);
    expect(ids).toContain(pub.id);
    expect(ids).not.toContain(priv.id);

    expect((await methods.getWithRelations(pub.id))?.id).toBe(pub.id);
    expect(await methods.getWithRelations(priv.id)).toBeUndefined();
  });
});

describe('createPublicLocationsReadMethods', () => {
  it('returns only public locations, never private team locations', async () => {
    const [pub] = await db
      .insert(locationLibrary)
      .values({ teamId: team.id, name: 'Public', isPublic: true })
      .returning();
    const [priv] = await db
      .insert(locationLibrary)
      .values({ teamId: team.id, name: 'Private' })
      .returning();
    if (!pub || !priv) throw new Error('seed failed');

    const methods = createPublicLocationsReadMethods(db);

    const ids = (await methods.list()).map((l) => l.id);
    expect(ids).toContain(pub.id);
    expect(ids).not.toContain(priv.id);

    expect((await methods.getById(pub.id))?.id).toBe(pub.id);
    expect(await methods.getById(priv.id)).toBeNull();
  });
});
