/**
 * `listEnforcementFor` is the query both gates run. User-level bans have a
 * null team id; if the predicate becomes AND, every user-level suspension
 * silently stops matching.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@/platform/server/db/test-d1';
import { generateId } from '@/platform/id';
import { enforcementActions, teams, user } from '@/platform/server/db/schema';
import type { Database } from '@/platform/server/db/client';
import { createComplianceReadMethods } from './compliance';

let closeDb: () => Promise<void>;
let db: Database;

const userA = { id: '', name: 'A', email: 'a@example.com' };
const teamA = { id: '', name: 'Team A', slug: 'team-a' };
const teamB = { id: '', name: 'Team B', slug: 'team-b' };

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await db.delete(enforcementActions);
  await db.delete(teams);
  await db.delete(user);

  userA.id = generateId();
  teamA.id = generateId();
  teamB.id = generateId();
  await db
    .insert(user)
    .values([{ id: userA.id, name: userA.name, email: userA.email }]);
  await db.insert(teams).values([teamA, teamB]);
});

describe('listEnforcementFor', () => {
  it('returns a user-level ban when queried with (userId, teamId)', async () => {
    await db.insert(enforcementActions).values({
      id: generateId(),
      subjectUserId: userA.id,
      subjectTeamId: null,
      action: 'generation_suspended',
      reason: 'portrait_rights',
    });

    const rows = await createComplianceReadMethods(db).listEnforcementFor(
      userA.id,
      teamA.id
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('generation_suspended');
  });

  it('returns a team-level action only for that team', async () => {
    await db.insert(enforcementActions).values({
      id: generateId(),
      subjectUserId: null,
      subjectTeamId: teamA.id,
      action: 'account_suspended',
      reason: 'csam',
    });

    const onA = await createComplianceReadMethods(db).listEnforcementFor(
      userA.id,
      teamA.id
    );
    const onB = await createComplianceReadMethods(db).listEnforcementFor(
      userA.id,
      teamB.id
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
      teamA.id
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('warning');
  });
});
