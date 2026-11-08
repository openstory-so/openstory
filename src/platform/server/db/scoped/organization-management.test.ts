import { afterAll, describe, expect, it } from 'vitest';
import { generateId } from '@/platform/id';
import { member, organization, user } from '@/platform/server/db/schema';
import { createTestDb } from '@/platform/server/db/test-d1';
import { createOrganizationManagementMethods } from './organization-management';

const { db, close } = await createTestDb();
afterAll(close);

describe('getForUser', () => {
  it('marks only the first organization the user owns as personal', async () => {
    const userId = generateId();
    await db
      .insert(user)
      .values({ id: userId, name: 'U', email: `${userId}@e.com` });
    const orgs = (
      [
        { name: 'Mine', role: 'owner', at: 1 },
        { name: 'Joined', role: 'member', at: 0 },
        { name: 'Second', role: 'owner', at: 2 },
      ] as const
    ).map((o) => ({ ...o, id: generateId() }));
    for (const o of orgs) {
      await db.insert(organization).values({
        id: o.id,
        name: o.name,
        slug: o.name.toLowerCase(),
        createdAt: new Date(o.at * 1000),
      });
      await db.insert(member).values({
        id: generateId(),
        organizationId: o.id,
        userId,
        role: o.role,
        createdAt: new Date(),
      });
    }
    const personal = await Promise.all(
      orgs.map(
        async (o) =>
          (
            await createOrganizationManagementMethods(db, o.id).getForUser(
              userId
            )
          )?.personal
      )
    );
    expect(personal).toEqual([true, false, false]);
    expect(
      await createOrganizationManagementMethods(db, 'missing').getForUser(
        userId
      )
    ).toBeNull();
  });
});
