/**
 * `listForSubject` is the query `latestRow` in upload-rights.ts reads. The
 * image is already in the WHERE clause (`subjectType` + `subjectId`); when a
 * finding and a later sign-off share a second-resolution `attestedAt`, the
 * remaining order key is the attestation row's monotonic ULID, not the image
 * id (every tied row is the same image).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/platform/id';
import {
  LIKENESS_DETECTED_V1,
  PORTRAIT_RIGHTS_V1,
  statementHash,
} from '@/platform/compliance/attestations';
import { teams, uploadAttestations, user } from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import type { Database } from '@/platform/server/db/client';
import { createComplianceMethods } from './compliance';

let client: Client;
let db: Database;

const owner = { id: '', name: 'A', email: 'a@example.com' };
const team = { id: '', name: 'Team A', slug: 'team-a' };

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.delete(uploadAttestations);
  await db.delete(teams);
  await db.delete(user);

  owner.id = generateId();
  team.id = generateId();
  await db
    .insert(user)
    .values([{ id: owner.id, name: owner.name, email: owner.email }]);
  await db.insert(teams).values([team]);
});

describe('listForSubject', () => {
  it('returns a later ULID first when two rows for the same image share a timestamp', async () => {
    const subjectId = 'a'.repeat(64);
    const attestedAt = new Date('2026-09-14T12:00:00.000Z');
    const findingId = generateId();
    const portraitId = generateId();
    expect(portraitId > findingId).toBe(true);

    const base = {
      userId: owner.id,
      teamId: team.id,
      subjectType: 'uploaded_image' as const,
      subjectId,
      attestedAt,
      depictsRealPerson: true,
    };

    // Insert the later ULID first so a timestamp-only ORDER BY that follows
    // rowid / insertion would surface the finding and the gate would re-ask.
    await db.insert(uploadAttestations).values({
      ...base,
      id: portraitId,
      statementVersion: PORTRAIT_RIGHTS_V1.version,
      statementSha256: await statementHash(PORTRAIT_RIGHTS_V1),
      authorizationBasis: 'self',
    });
    await db.insert(uploadAttestations).values({
      ...base,
      id: findingId,
      statementVersion: LIKENESS_DETECTED_V1.version,
      statementSha256: await statementHash(LIKENESS_DETECTED_V1),
    });

    const rows = await createComplianceMethods(
      db,
      team.id,
      owner.id
    ).attestations.listForSubject('uploaded_image', subjectId);

    expect(rows.map((row) => row.statementVersion)).toEqual([
      PORTRAIT_RIGHTS_V1.version,
      LIKENESS_DETECTED_V1.version,
    ]);
  });
});
