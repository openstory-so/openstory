/**
 * The look sheet claim pass (#2015) against real SQLite: it promotes a sheet
 * an older worker landed on the legacy columns mid-deploy, and fails a claim
 * no run is behind.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { Database } from '@/platform/server/db/client';
import {
  characterLooks,
  characterSheetVariants,
} from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import { reconcileLookSheetClaimsPass } from './reconcile-all';

let client: Client;
let db: Database;

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  // The looks' characters are outside this pass; they are not built.
  await client.execute('PRAGMA foreign_keys = OFF');
});
afterAll(() => client.close());
beforeEach(async () => {
  await db.delete(characterSheetVariants);
  await db.delete(characterLooks);
});

const HOUR = 60 * 60 * 1000;
async function look(id: string, claim: string | null, ageMs: number) {
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
