/**
 * Public (anonymous) read-boundary tests.
 *
 * The createPublic*ReadMethods factories back unauthenticated endpoints
 * (getPublicTalentFn, …), so their isPublic
 * filters are the entire data-leak barrier: one leak test per factory.
 * The styles equivalent lives in styles.test.ts alongside its other tests.
 */

import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import { talent, teams } from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import { createPublicTalentReadMethods } from './talent';
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
