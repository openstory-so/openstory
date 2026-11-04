/**
 * `listEnforcementFor` is the query both gates run. User-level bans have a
 * null organization id; if the predicate becomes AND, every user-level suspension
 * silently stops matching.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@/platform/server/db/test-d1';
import { generateId } from '@/platform/id';
import {
  enforcementActions,
  organization,
  user,
} from '@/platform/server/db/schema';
import type { Database } from '@/platform/server/db/client';
import { createComplianceReadMethods } from './compliance';

let closeDb: () => Promise<void>;
let db: Database;

const userA = { id: '', name: 'A', email: 'a@example.com' };
const organizationA = {
  id: '',
  name: 'Organization A',
  slug: 'organization-a',
};
const organizationB = {
  id: '',
  name: 'Organization B',
  slug: 'organization-b',
};

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await db.delete(enforcementActions);
  await db.delete(organization);
  await db.delete(user);

  userA.id = generateId();
  organizationA.id = generateId();
  organizationB.id = generateId();
  await db
    .insert(user)
    .values([{ id: userA.id, name: userA.name, email: userA.email }]);
  await db.insert(organization).values([organizationA, organizationB]);
});

describe('listEnforcementFor', () => {
  it('returns a user-level ban when queried with (userId, organizationId)', async () => {
    await db.insert(enforcementActions).values({
      id: generateId(),
      subjectUserId: userA.id,
      subjectOrganizationId: null,
      action: 'generation_suspended',
      reason: 'portrait_rights',
    });

    const rows = await createComplianceReadMethods(db).listEnforcementFor(
      userA.id,
      organizationA.id
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('generation_suspended');
  });

  it('returns an organization-level action only for that organization', async () => {
    await db.insert(enforcementActions).values({
      id: generateId(),
      subjectUserId: null,
      subjectOrganizationId: organizationA.id,
      action: 'account_suspended',
      reason: 'csam',
    });

    const onA = await createComplianceReadMethods(db).listEnforcementFor(
      userA.id,
      organizationA.id
    );
    const onB = await createComplianceReadMethods(db).listEnforcementFor(
      userA.id,
      organizationB.id
    );
    expect(onA).toHaveLength(1);
    expect(onB).toHaveLength(0);
  });

  it('excludes revoked rows and leaves expiry to resolve-time', async () => {
    const expired = new Date(Date.now() - 60_000);
    await db.insert(enforcementActions).values([
      {
        id: generateId(),
        subjectUserId: userA.id,
        action: 'generation_suspended',
        reason: 'portrait_rights',
        revokedAt: new Date(),
      },
      {
        id: generateId(),
        subjectUserId: userA.id,
        action: 'warning',
        reason: 'copyright',
        expiresAt: expired,
      },
    ]);

    const rows = await createComplianceReadMethods(db).listEnforcementFor(
      userA.id,
      organizationA.id
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('warning');
  });
});
