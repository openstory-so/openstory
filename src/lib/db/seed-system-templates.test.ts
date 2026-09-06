/**
 * Seed-sync invariants for the runtime self-seed (#897):
 *
 *   - Idempotent by-name sync: re-running never duplicates templates.
 *   - `sampleVideos` is NEVER overwritten on update — prod carries seeded
 *     sample-video rows that a one-line "complete the update set" change
 *     would wipe.
 *   - RENAMES update rows in place (same id), not insert-new/orphan-old.
 *   - Hash gate: a matching stored hash skips the sync entirely.
 *   - Lock: a fresh foreign lock makes the caller skip WITHOUT writing the
 *     hash (a loser that wrote the hash would mark seeding complete when it
 *     never ran); a stale lock is stolen; a failed sync releases the lock
 *     and leaves the hash unwritten so a retry can succeed.
 *
 * Runs real SQL against in-memory libSQL with the actual migrations applied
 * (same harness as src/lib/db/scoped/styles.test.ts).
 */

import type { Database } from '@/lib/db/client';
import {
  appMetadata,
  locationLibrary,
  styles,
  talent,
  talentSheets,
  teams,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { ensureSystemTemplatesSeeded } from '@/lib/db/seed-system-templates';
import { DEFAULT_SYSTEM_LOCATIONS } from '@/lib/location/location-templates';
import { DEFAULT_SYSTEM_STYLES } from '@/lib/style/style-templates';
import { DEFAULT_SYSTEM_TALENT } from '@/lib/talent/talent-templates';
import { createClient, type Client } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// DB-contract literals (also what production rows contain) — the module
// keeps its constants private, so tests assert against the stored strings.
const HASH_KEY = 'system-templates-seed-hash';
const LOCK_KEY = 'system-templates-seed-lock';

let client: Client;
let db: Database;

async function getMetaRow(key: string) {
  const rows = await db
    .select()
    .from(appMetadata)
    .where(eq(appMetadata.key, key));
  return rows[0] ?? null;
}

async function templateCounts() {
  return {
    styles: (await db.select().from(styles)).length,
    talent: (await db.select().from(talent)).length,
    locations: (await db.select().from(locationLibrary)).length,
    talentSheets: (await db.select().from(talentSheets)).length,
  };
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

describe('ensureSystemTemplatesSeeded', () => {
  it('seeds a fresh database: templates, sheets, hash row; lock released', async () => {
    const logs: string[] = [];
    await ensureSystemTemplatesSeeded(db, (m) => logs.push(m));

    const [systemTeam] = await db
      .select()
      .from(teams)
      .where(eq(teams.slug, 'system-templates'));
    expect(systemTeam).toBeDefined();

    const counts = await templateCounts();
    expect(counts.styles).toBe(DEFAULT_SYSTEM_STYLES.length);
    expect(counts.talent).toBe(DEFAULT_SYSTEM_TALENT.length);
    expect(counts.locations).toBe(DEFAULT_SYSTEM_LOCATIONS.length);
    expect(counts.talentSheets).toBe(DEFAULT_SYSTEM_TALENT.length);

    expect(await getMetaRow(HASH_KEY)).not.toBeNull();
    expect(await getMetaRow(LOCK_KEY)).toBeNull();
  });

  it('skips on hash match without touching rows', async () => {
    const before = await templateCounts();
    const logs: string[] = [];
    await ensureSystemTemplatesSeeded(db, (m) => logs.push(m));

    expect(logs.join('\n')).toContain('up to date');
    expect(await templateCounts()).toEqual(before);
  });

  it('re-sync is idempotent and never overwrites sampleVideos', async () => {
    const sentinel = [
      {
        url: 'https://example.com/keep.mp4',
        kind: 'bespoke' as const,
        label: 'sentinel',
        durationSeconds: 5,
        order: 0,
      },
    ];
    const [victim] = await db.select().from(styles).limit(1);
    expect(victim).toBeDefined();
    if (!victim) return;
    await db
      .update(styles)
      .set({ sampleVideos: sentinel })
      .where(eq(styles.id, victim.id));

    // Stale the hash so the full sync runs again.
    await db.delete(appMetadata).where(eq(appMetadata.key, HASH_KEY));
    const before = await templateCounts();
    await ensureSystemTemplatesSeeded(db);

    expect(await templateCounts()).toEqual(before);
    const [after] = await db
      .select()
      .from(styles)
      .where(eq(styles.id, victim.id));
    expect(after?.sampleVideos).toEqual(sentinel);
  });

  it('renames legacy template names in place (same row id)', async () => {
    const [current] = await db
      .select()
      .from(styles)
      .where(eq(styles.name, 'Award Season'));
    expect(current).toBeDefined();
    if (!current) return;

    // Simulate a legacy DB: the row still carries the pre-rename name.
    await db
      .update(styles)
      .set({ name: 'Cinematic Drama' })
      .where(eq(styles.id, current.id));
    await db.delete(appMetadata).where(eq(appMetadata.key, HASH_KEY));

    const before = await templateCounts();
    await ensureSystemTemplatesSeeded(db);

    // Renamed in place — same id, no duplicate row under either name.
    expect(await templateCounts()).toEqual(before);
    const renamed = await db
      .select()
      .from(styles)
      .where(eq(styles.name, 'Award Season'));
    expect(renamed).toHaveLength(1);
    expect(renamed[0]?.id).toBe(current.id);
    expect(
      await db.select().from(styles).where(eq(styles.name, 'Cinematic Drama'))
    ).toHaveLength(0);
  });

  it('a fresh foreign lock makes the caller skip without writing the hash', async () => {
    await db.delete(appMetadata).where(eq(appMetadata.key, HASH_KEY));
    await db.insert(appMetadata).values({
      key: LOCK_KEY,
      value: 'foreign-holder',
      updatedAt: new Date(),
    });

    const logs: string[] = [];
    await ensureSystemTemplatesSeeded(db, (m) => logs.push(m));

    expect(logs.join('\n')).toContain('already running elsewhere');
    // The loser must NOT mark seeding complete.
    expect(await getMetaRow(HASH_KEY)).toBeNull();
    // And must not have touched the foreign lock.
    const lock = await getMetaRow(LOCK_KEY);
    expect(lock?.value).toBe('foreign-holder');
  });

  it('steals a stale lock, syncs, and releases', async () => {
    // Lock from the previous test, aged past the 10-minute TTL.
    await db
      .update(appMetadata)
      .set({ updatedAt: new Date(Date.now() - 11 * 60 * 1000) })
      .where(eq(appMetadata.key, LOCK_KEY));

    await ensureSystemTemplatesSeeded(db);

    expect(await getMetaRow(HASH_KEY)).not.toBeNull();
    expect(await getMetaRow(LOCK_KEY)).toBeNull();
  });

  it('a failed sync releases the lock and leaves the hash unwritten', async () => {
    // Dedicated DB so the breakage doesn't leak into other tests.
    const brokenClient = createClient({ url: ':memory:' });
    const brokenDb: Database = drizzle({ client: brokenClient, relations });
    await migrate(brokenDb, { migrationsFolder: './drizzle/migrations' });
    // Location sheets are the sync's final step (5b) — failing there proves
    // a partial sync doesn't get marked complete.
    await brokenClient.execute('DROP TABLE location_sheets');

    await expect(ensureSystemTemplatesSeeded(brokenDb)).rejects.toThrow();

    const rows = await brokenDb.select().from(appMetadata);
    expect(rows.find((r) => r.key === HASH_KEY)).toBeUndefined();
    expect(rows.find((r) => r.key === LOCK_KEY)).toBeUndefined();

    brokenClient.close();
  });
});
