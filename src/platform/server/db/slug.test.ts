import { afterAll, describe, expect, it } from 'vitest';
import { generateId } from '@/platform/id';
import { organization, styles } from '@/platform/server/db/schema';
import { createTestDb } from '@/platform/server/db/test-d1';
import { freeSlug, resolveSlugOrId } from './slug';

const { db, close } = await createTestDb();
afterAll(close);

const ORG = generateId();
const OTHER = generateId();
await db.insert(organization).values([
  { id: ORG, name: 'A', slug: 'a' },
  { id: OTHER, name: 'B', slug: 'b' },
]);

const addStyle = async (organizationId: string, name: string) => {
  const id = generateId();
  const slug = await freeSlug(db, styles, organizationId, name);
  await db
    .insert(styles)
    .values({ id, organizationId, name, slug, config: { version: 1 } });
  return { id, slug };
};

describe('freeSlug', () => {
  it('takes -2, -3 on collision, per organization', async () => {
    expect((await addStyle(ORG, 'Noir')).slug).toBe('noir');
    expect((await addStyle(ORG, 'Noir!')).slug).toBe('noir-2');
    expect((await addStyle(OTHER, 'Noir')).slug).toBe('noir');
  });

  it('keeps a renamed row its slug while the base is the same, else moves it', async () => {
    const { id } = await addStyle(ORG, 'Noir');
    expect(await freeSlug(db, styles, ORG, 'NOIR', id)).toBe('noir-3');
    expect(await freeSlug(db, styles, ORG, 'Western', id)).toBe('western');
  });
});

describe('resolveSlugOrId', () => {
  it('passes a ULID, finds a slug in the organization only', async () => {
    const { id } = await addStyle(ORG, 'Pastel');
    expect(await resolveSlugOrId(db, styles, ORG, 'pastel')).toBe(id);
    expect(await resolveSlugOrId(db, styles, OTHER, 'pastel')).toBeNull();
    expect(await resolveSlugOrId(db, styles, ORG, id)).toBe(id);
  });
});
