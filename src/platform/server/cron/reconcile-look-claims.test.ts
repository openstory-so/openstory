/**
 * The look sheet claim pass (#2015) against real SQLite: it promotes a sheet
 * an older worker landed on the legacy columns mid-deploy, and fails a claim
 * no run is behind.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDb } from '@/platform/server/db/test-d1';
import { eq } from 'drizzle-orm';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  characterLooks,
  characterSheetVariants,
  characters,
  teams,
} from '@/platform/server/db/schema';
import { reconcileLookSheetClaimsPass } from './reconcile-all';

const TEAM_ID = generateId();
let closeDb: () => Promise<void>;
let db: Database;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  await db.insert(teams).values({ id: TEAM_ID, name: 'T', slug: 't' });
});
afterAll(() => closeDb());
beforeEach(async () => {
  await db.delete(characterSheetVariants);
  await db.delete(characterLooks);
  await db.delete(characters);
});

const HOUR = 60 * 60 * 1000;
async function look(id: string, claim: string | null, ageMs: number) {
  // A bare character row: the pass reads only the look and its sheets.
  await db.insert(characters).values({
    id,
    teamId: TEAM_ID,
    legacyName: 'unused',
    selectedBibleVersionId: id,
  });
  await db.insert(characterLooks).values({
    id,
    characterId: id,
    isDefault: true,
    sortOrder: 0,
    selectedLookVersionId: id,
    selectedSheetVersionId: null,
    pendingPromoteSheetVersionId: claim,
    sheetStatus: claim ? 'generating' : 'completed',
    updatedAt: new Date(Date.now() - ageMs),
  });
}
const sheet = (id: string, characterId: string, divergedAt: Date | null) =>
  db.insert(characterSheetVariants).values({
    id,
    characterId,
    model: 'm',
    url: '/r2/x.png',
    status: 'completed',
    divergedAt,
  });
const read = async (id: string) => {
  const [row] = await db
    .select()
    .from(characterLooks)
    .where(eq(characterLooks.id, id));
  if (!row) throw new Error('look gone');
  return row;
};

it('promotes a claimed sheet an older worker landed, and leaves a live claim alone', async () => {
  // Landed by the old worker: the row exists under the claimed id, no look id.
  await look('landed', 'claim-landed', 5 * 60 * 1000);
  await sheet('claim-landed', 'landed', null);
  // Still running: claimed minutes ago, no row yet.
  await look('running', 'claim-running', 5 * 60 * 1000);
  // Parked by a run that lost a newer claim: divergent, so not promoted.
  await look('parked', 'claim-newer', 5 * 60 * 1000);
  await sheet('claim-older', 'parked', new Date());

  expect(await reconcileLookSheetClaimsPass(db)).toBe(1);
  expect(await read('landed')).toMatchObject({
    selectedSheetVersionId: 'claim-landed',
    pendingPromoteSheetVersionId: null,
    sheetStatus: 'completed',
  });
  expect(await read('running')).toMatchObject({
    pendingPromoteSheetVersionId: 'claim-running',
    sheetStatus: 'generating',
  });
  expect((await read('parked')).pendingPromoteSheetVersionId).toBe(
    'claim-newer'
  );
  // Nothing left to do.
  expect(await reconcileLookSheetClaimsPass(db)).toBe(0);
});

it('fails a claim older than any run, and nothing without a claim', async () => {
  await look('dead', 'claim-dead', 2 * HOUR);
  await look('idle', null, 2 * HOUR);

  expect(await reconcileLookSheetClaimsPass(db)).toBe(1);
  expect(await read('dead')).toMatchObject({
    pendingPromoteSheetVersionId: null,
    sheetStatus: 'failed',
    sheetError: 'Generation died before completing',
  });
  expect((await read('idle')).sheetStatus).toBe('completed');
});
