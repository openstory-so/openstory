/**
 * `resolveStyleSource` (#1213): which kind of style row a new sequence gets.
 * A copy of a sequence whose automatic style is still deriving must derive its
 * own, never freeze the placeholder.
 */
import { clearVersionRows } from '@/platform/server/test/clear-version-rows';
import { createTestDb } from '@/platform/server/db/test-d1';
import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import {
  sequences,
  styles,
  organization,
  user,
} from '@/platform/server/db/schema';
import { createSequencesMethods } from '@/sequences/server/db/sequences';
import { createStylesMethods } from '@/look/server/db/styles';
import {
  AUTO_STYLE_ID,
  AUTO_STYLE_PLACEHOLDER_NAME,
  placeholderAutoStyleDraft,
} from '@/look/auto-style';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveStyleSource } from './create-sequences';

let closeDb: () => Promise<void>;
let db: Database;
let organizationId = '';
let userId = '';

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await clearVersionRows(db);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(organization);
  await db.delete(user);
  organizationId = generateId();
  userId = generateId();
  await db
    .insert(user)
    .values({ id: userId, name: 'U', email: 'u@example.com' });
  await db
    .insert(organization)
    .values({ id: organizationId, name: 'T', slug: 't' });
});

function scoped(id = organizationId) {
  return {
    styles: createStylesMethods(db, id, userId),
    sequences: createSequencesMethods(db, id, userId),
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
    generationStopAt: 'images',
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
        organizationId,
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

  it("another organization's automatic style is not found", async () => {
    const style = await createAutoSequence(true);
    await expect(
      resolveStyleSource(scoped(generateId()), style.id)
    ).rejects.toThrow(/not found/);
  });
});
