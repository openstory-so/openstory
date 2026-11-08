import { afterAll, describe, expect, it, vi } from 'vitest';
import { generateIdAt } from '@/platform/id';
import { user } from '@/platform/server/db/schema';
import { createTestDb } from '@/platform/server/db/test-d1';

const { db, close } = await createTestDb();
vi.doMock('#db-client', () => ({ getDb: () => db }));
const { createDefaultOrganization } = await import('./scoped');

afterAll(close);

describe('createDefaultOrganization', () => {
  it('gives two sign-ups in the same millisecond distinct slugs', async () => {
    const ids = [generateIdAt(1), generateIdAt(1)];
    expect(ids[0]?.slice(0, 10)).toBe(ids[1]?.slice(0, 10));
    await db
      .insert(user)
      .values(ids.map((id) => ({ id, name: id, email: `${id}@e.com` })));
    const created = await Promise.all(
      ids.map((userId) =>
        createDefaultOrganization({ userId, organizationName: 'Personal' })
      )
    );
    expect(new Set(created.map((org) => org.slug)).size).toBe(2);
  });
});
