/**
 * `resolveStyleSource` (#1213): which kind of style row a new sequence gets.
 * A copy of a sequence whose automatic style is still deriving must derive its
 * own, never freeze the placeholder.
 */
import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import { sequences, styles, teams, user } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { createSequencesMethods } from '@/lib/db/scoped/sequences';
import { createStylesMethods } from '@/lib/db/scoped/styles';
import {
  AUTO_STYLE_ID,
  AUTO_STYLE_PLACEHOLDER_NAME,
  placeholderAutoStyleDraft,
} from '@/lib/style/auto-style';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveStyleSource } from './create-sequences';

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

function scoped(team = teamId) {
  return {
    styles: createStylesMethods(db, team, userId),
    sequences: createSequencesMethods(db, team, userId),
  };
}

async function createAutoSequence(derive: boolean) {
  const scopedDb = scoped();
  const sequenceId = generateId();
  const style = await scopedDb.styles.createForSequence({
    sequenceId,
    draft: placeholderAutoStyleDraft(),
  });
  await scopedDb.sequences.create({
    id: sequenceId,
    title: 'S',
    styleId: style.id,
    deferStyleSnapshot: true,
  });
  if (derive) {
    await scopedDb.styles.setGeneratedForSequence({
      styleId: style.id,
      sequenceId,
      draft: { ...placeholderAutoStyleDraft(), name: 'Derived Noir' },
    });
    await scopedDb.sequences.snapshotAutoStyle({
      id: sequenceId,
      styleId: style.id,
    });
  }
  return style;
}

describe('resolveStyleSource', () => {
  it("'auto' is a fresh pending style", async () => {
    await expect(resolveStyleSource(scoped(), AUTO_STYLE_ID)).resolves.toEqual({
      kind: 'pending',
      draft: placeholderAutoStyleDraft(),
    });
  });

  it('a library row is used as-is', async () => {
    const [row] = await db
      .insert(styles)
      .values({
        teamId,
        name: 'Noir',
        config: placeholderAutoStyleDraft().config,
      })
      .returning();
    if (!row) throw new Error('insert returned nothing');
    await expect(resolveStyleSource(scoped(), row.id)).resolves.toEqual({
      kind: 'library',
    });
  });

  it('a derived automatic style is cloned', async () => {
    const style = await createAutoSequence(true);
    await expect(resolveStyleSource(scoped(), style.id)).resolves.toMatchObject(
      { kind: 'clone', draft: { name: 'Derived Noir' } }
    );
  });

  it('an automatic style still deriving becomes a fresh pending one', async () => {
    const style = await createAutoSequence(false);
    await expect(resolveStyleSource(scoped(), style.id)).resolves.toMatchObject(
      { kind: 'pending', draft: { name: AUTO_STYLE_PLACEHOLDER_NAME } }
    );
  });

  it("another team's automatic style is not found", async () => {
    const style = await createAutoSequence(true);
    await expect(
      resolveStyleSource(scoped(generateId()), style.id)
    ).rejects.toThrow(/not found/);
  });
});
