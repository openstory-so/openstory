/**
 * The upload rights ledger (#1581): one classifier call per URL, its verdict
 * written so the next ask is free; a real person refused until signed;
 * rights carried across a move.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import { teams, uploadAttestations, user } from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import { sha256Hex } from '@/platform/compliance/hash';
import {
  LIKENESS_CLEARED_V1,
  LIKENESS_DETECTED_V1,
  PORTRAIT_RIGHTS_V1,
  statementHash,
} from '@/platform/compliance/attestations';
import { AttestationRequiredError } from '@/platform/errors';

let db: Database;
const mockAnalyze = vi.fn();

vi.doMock('#db-client', () => ({ getDb: () => db }));
vi.doMock('@/cast/server/talent/analyze-talent-media', () => ({
  analyzeTalentMediaForTeam: mockAnalyze,
}));

const {
  attestUploads,
  carryUploadRights,
  classifyUpload,
  likenessFromLedger,
  recordLikenessFinding,
  requireUploadRights,
} = await import('./upload-rights');
const { registersWithArk } = await import('@/cast/likeness');
const { createScopedDb } = await import('@/platform/server/db/scoped');

const TEAM_ID = generateId();
const USER_ID = 'user-1';
const request = { ipAddress: '203.0.113.9', userAgent: 'vitest' };
const url = `/r2/talent/${TEAM_ID}/temp/01ABC.png`;

function verdict(subjectKind: 'human' | 'animated' | 'other') {
  mockAnalyze.mockResolvedValueOnce({ subjectKind, isCharacterSheet: false });
}

beforeAll(async () => {
  const client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  await db.insert(user).values([{ id: USER_ID, name: 'U', email: 'u@e.com' }]);
  await db.insert(teams).values([{ id: TEAM_ID, name: 'T', slug: 't' }]);
});

beforeEach(async () => {
  await db.delete(uploadAttestations);
  vi.clearAllMocks();
});

describe('classifyUpload', () => {
  it('clears a non-person and records the finding, once', async () => {
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);
    verdict('other');

    const first = await classifyUpload({
      scopedDb,
      userId: USER_ID,
      url,
      filename: 'logo.png',
      request,
    });
    expect(first).toEqual({ status: 'cleared' });
    expect(mockAnalyze).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrls: [url],
        filenames: ['logo.png'],
        idempotencyKey: `likeness:${url}`,
      })
    );
    expect(await db.select().from(uploadAttestations)).toMatchObject([
      {
        teamId: TEAM_ID,
        userId: USER_ID,
        subjectType: 'uploaded_image',
        subjectId: await sha256Hex(url),
        statementVersion: LIKENESS_CLEARED_V1.version,
        statementSha256: await statementHash(LIKENESS_CLEARED_V1),
        depictsRealPerson: false,
        authorizationBasis: null,
        ipAddress: '203.0.113.9',
        userAgent: 'vitest',
      },
    ]);

    const second = await classifyUpload({
      scopedDb,
      userId: USER_ID,
      url,
      request,
    });
    expect(second).toEqual({ status: 'cleared' });
    expect(mockAnalyze).toHaveBeenCalledTimes(1);
    expect(await requireUploadRights(scopedDb, [url])).toEqual(
      new Map([[url, { depictsRealPerson: false }]])
    );
  });

  it('records a detected person and asks for the sign-off, without re-running vision', async () => {
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);
    verdict('human');

    expect(
      await classifyUpload({ scopedDb, userId: USER_ID, url, request })
    ).toEqual({ status: 'needs_portrait' });
    expect(await db.select().from(uploadAttestations)).toMatchObject([
      {
        statementVersion: LIKENESS_DETECTED_V1.version,
        depictsRealPerson: true,
      },
    ]);
    expect(
      await classifyUpload({ scopedDb, userId: USER_ID, url, request })
    ).toEqual({ status: 'needs_portrait' });
    expect(mockAnalyze).toHaveBeenCalledTimes(1);
    await expect(requireUploadRights(scopedDb, [url])).rejects.toBeInstanceOf(
      AttestationRequiredError
    );
  });

  it('leaves no row when the classifier fails, so the gate keeps refusing', async () => {
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);
    mockAnalyze.mockRejectedValueOnce(new Error('vision down'));

    await expect(
      classifyUpload({ scopedDb, userId: USER_ID, url, request })
    ).rejects.toThrow('vision down');
    expect(await db.select().from(uploadAttestations)).toEqual([]);
    await expect(requireUploadRights(scopedDb, [url])).rejects.toBeInstanceOf(
      AttestationRequiredError
    );
  });
});

describe('attestUploads', () => {
  it('records the portrait statement with the basis; a repeat is a no-op', async () => {
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);
    await recordLikenessFinding(scopedDb, [url], 'human', request);

    const claim = {
      url,
      statementVersion: PORTRAIT_RIGHTS_V1.version,
      authorizationBasis: 'this is me',
    };
    await attestUploads(scopedDb, [claim], request);
    await attestUploads(
      scopedDb,
      [{ ...claim, authorizationBasis: 'again' }],
      request
    );

    const rows = await db.select().from(uploadAttestations);
    expect(rows).toHaveLength(2);
    expect(rows.at(-1)).toMatchObject({
      statementVersion: PORTRAIT_RIGHTS_V1.version,
      statementSha256: await statementHash(PORTRAIT_RIGHTS_V1),
      depictsRealPerson: true,
      authorizationBasis: 'this is me',
    });
    expect(
      await classifyUpload({ scopedDb, userId: USER_ID, url, request })
    ).toEqual({ status: 'signed' });
    expect(await requireUploadRights(scopedDb, [url])).toEqual(
      new Map([[url, { depictsRealPerson: true }]])
    );
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it('keeps a same-second portrait sign-off as signed even if the finding row is inserted later', async () => {
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);
    const subjectId = await sha256Hex(url);
    const attestedAt = new Date('2026-09-14T12:00:00.000Z');
    const findingId = generateId();
    const portraitId = generateId();

    const base = {
      userId: USER_ID,
      teamId: TEAM_ID,
      subjectType: 'uploaded_image' as const,
      subjectId,
      attestedAt,
      depictsRealPerson: true,
    };
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

    expect(
      await classifyUpload({ scopedDb, userId: USER_ID, url, request })
    ).toEqual({ status: 'signed' });
    expect(await requireUploadRights(scopedDb, [url])).toEqual(
      new Map([[url, { depictsRealPerson: true }]])
    );
  });
});

describe('likenessFromLedger', () => {
  it('maps cleared to none, signed to real, unknown to null (#1674, #1682)', async () => {
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);
    const cleared = `/r2/talent/${TEAM_ID}/temp/cleared.png`;
    const signed = `/r2/talent/${TEAM_ID}/temp/signed.png`;
    const unknown = `/r2/talent/${TEAM_ID}/temp/unknown.png`;
    verdict('other');
    expect(
      await classifyUpload({
        scopedDb,
        userId: USER_ID,
        url: cleared,
        request,
      })
    ).toEqual({ status: 'cleared' });
    verdict('human');
    expect(
      await classifyUpload({
        scopedDb,
        userId: USER_ID,
        url: signed,
        request,
      })
    ).toEqual({ status: 'needs_portrait' });
    expect(await likenessFromLedger(scopedDb, signed)).toBe('fictional');
    expect(registersWithArk('fictional')).toBe(true);
    await attestUploads(
      scopedDb,
      [
        {
          url: signed,
          statementVersion: PORTRAIT_RIGHTS_V1.version,
          authorizationBasis: 'self',
        },
      ],
      request
    );

    expect(await likenessFromLedger(scopedDb, cleared)).toBe('none');
    expect(registersWithArk(await likenessFromLedger(scopedDb, cleared))).toBe(
      false
    );
    expect(await likenessFromLedger(scopedDb, signed)).toBe('real');
    expect(registersWithArk(await likenessFromLedger(scopedDb, signed))).toBe(
      true
    );
    expect(await likenessFromLedger(scopedDb, unknown)).toBeNull();
    expect(registersWithArk(await likenessFromLedger(scopedDb, unknown))).toBe(
      true
    );
  });
});

describe('carryUploadRights', () => {
  it('covers the moved URL with the same evidence', async () => {
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);
    const libraryUrl = `/r2/talent/${TEAM_ID}/tal1/01ABC.png`;
    await recordLikenessFinding(scopedDb, [url], 'human', request);
    await attestUploads(
      scopedDb,
      [
        {
          url,
          statementVersion: PORTRAIT_RIGHTS_V1.version,
          authorizationBasis: 'release #7',
        },
      ],
      request
    );

    await carryUploadRights(scopedDb, url, libraryUrl);

    expect(await requireUploadRights(scopedDb, [libraryUrl])).toEqual(
      new Map([[libraryUrl, { depictsRealPerson: true }]])
    );
    const rows = await db.select().from(uploadAttestations);
    expect(rows.at(-1)).toMatchObject({
      subjectId: await sha256Hex(libraryUrl),
      statementVersion: PORTRAIT_RIGHTS_V1.version,
      authorizationBasis: 'release #7',
      ipAddress: '203.0.113.9',
    });
  });

  it('refuses to carry an unchecked URL', async () => {
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);
    await expect(
      carryUploadRights(scopedDb, url, `/r2/talent/${TEAM_ID}/tal1/x.png`)
    ).rejects.toBeInstanceOf(AttestationRequiredError);
  });
});
