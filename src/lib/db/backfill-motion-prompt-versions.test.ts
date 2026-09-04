/**
 * In-memory DB tests for the #1067 motion-prompt-version backfill.
 *
 * Shots whose last motion prompt predates `mirrorSelection` carry text in
 * `motion_prompt` with a NULL `selected_motion_prompt_version_id`. Reads fall
 * back to the mirror today; once it is dropped they resolve to an empty prompt
 * and submit a blank render rather than failing, so every such shot needs a
 * version row to point at first.
 *
 * Migrations run against an empty DB, so the backfill no-ops at setup — these
 * tests seed the legacy shape AFTER migrating, then execute the migration's own
 * statements (read verbatim from the shipped SQL) and assert the result.
 *
 * #1067 removes the mirror columns this backfill reads, so drizzle can no
 * longer write them: the harness re-adds them when the migrated DB lacks them
 * and seeds them with raw SQL. The migration file itself is history and stays
 * verbatim.
 */

import type { Database } from '@/lib/db/client';
import { generateId, isValidId } from '@/shared/id';
import {
  sequences,
  shotPromptVersions,
  shots,
  styles,
  teams,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Read by explicit path: a scan would match an earlier backfill first.
const MIGRATION_SQL =
  './drizzle/migrations/20260805115709_backfill_motion_prompt_versions/migration.sql';

function backfillStatements(): string[] {
  return readFileSync(MIGRATION_SQL, 'utf8')
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter((chunk) => chunk.length > 0);
}

const STATEMENTS = backfillStatements();
// `runBackfill` applies all three, so every test below also asserts the
// tripwire stays silent. Held separately so one test can evaluate it against a
// deliberately unfinished backfill.
const TRIPWIRE = STATEMENTS[2] ?? '';

if (STATEMENTS.length !== 3) {
  throw new Error(
    `expected 3 backfill statements (INSERT versions + UPDATE pointer + tripwire), got ${STATEMENTS.length}`
  );
}

let client: Client;
let db: Database;
let sequenceId = '';

async function runBackfill(): Promise<void> {
  for (const stmt of STATEMENTS) await client.execute(stmt);
}

async function seed() {
  await db.delete(shotPromptVersions);
  await db.delete(shots);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);

  const teamId = generateId();
  sequenceId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: `t-${teamId}` });
  const [style] = await db
    .insert(styles)
    .values({
      teamId,
      name: 'default',
      config: {
        mood: 'neutral',
        artStyle: 'cinematic',
        lighting: 'natural',
        colorPalette: ['#000', '#fff'],
        cameraWork: 'static',
        referenceFilms: [],
        colorGrading: 'neutral',
      },
    })
    .returning();
  if (!style) throw new Error('seed: style insert returned nothing');
  await db
    .insert(sequences)
    .values({ id: sequenceId, teamId, title: 'S', styleId: style.id });
}

async function ensureLegacyMirrorColumns(): Promise<void> {
  const info = await client.execute('PRAGMA table_info(`shots`)');
  const present = new Set(
    info.rows.flatMap((row) => (typeof row.name === 'string' ? [row.name] : []))
  );
  for (const column of ['motion_prompt', 'motion_prompt_input_hash']) {
    if (present.has(column)) continue;
    await client.execute(`ALTER TABLE \`shots\` ADD COLUMN \`${column}\` text`);
  }
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  await ensureLegacyMirrorColumns();
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
});

async function insertShot(values: {
  orderIndex: number;
  motionPrompt?: string | null;
  motionPromptInputHash?: string | null;
  selectedMotionPromptVersionId?: string | null;
}) {
  const {
    motionPrompt = null,
    motionPromptInputHash = null,
    ...shotValues
  } = values;
  const [shot] = await db
    .insert(shots)
    .values({ sequenceId, ...shotValues })
    .returning();
  if (!shot) throw new Error('seed: shot insert returned nothing');
  await client.execute({
    sql: 'UPDATE `shots` SET `motion_prompt` = ?, `motion_prompt_input_hash` = ? WHERE `id` = ?',
    args: [motionPrompt, motionPromptInputHash, shot.id],
  });
  return shot;
}

describe('backfill motion prompt versions', () => {
  it('creates a version row and points the shot at it', async () => {
    const shot = await insertShot({
      orderIndex: 0,
      motionPrompt: 'slow push-in on the door',
      motionPromptInputHash: 'hash-1',
    });

    await runBackfill();

    const [refreshed] = await db
      .select()
      .from(shots)
      .where(eq(shots.id, shot.id));
    expect(refreshed?.selectedMotionPromptVersionId).toBeTruthy();

    const [version] = await db
      .select()
      .from(shotPromptVersions)
      .where(eq(shotPromptVersions.shotId, shot.id));
    expect(version?.text).toBe('slow push-in on the door');
    expect(version?.promptType).toBe('motion');
    expect(version?.status).toBe('completed');
    // The hash carries over so staleness does not reset for every shot.
    expect(version?.inputHash).toBe('hash-1');
    // SQLite does not enforce the enum — a bad literal here would reach prod.
    expect(version?.source).toBe('ai-generated');
    expect(refreshed?.selectedMotionPromptVersionId).toBe(version?.id);
  });

  it('mints a ULID-shaped id — `ulidSchema` guards every restore path', async () => {
    const shot = await insertShot({
      orderIndex: 0,
      motionPrompt: 'slow push-in on the door',
    });

    await runBackfill();

    const [version] = await db
      .select()
      .from(shotPromptVersions)
      .where(eq(shotPromptVersions.shotId, shot.id));
    // A prefixed id (the original `bfmp_<ulid>`) fails ulidSchema's 26-char +
    // Crockford-base32 check, so restoreShotPromptVariantFn would reject the
    // very rows this backfill creates.
    expect(isValidId(version?.id ?? '')).toBe(true);
    expect(version?.id).toBe(shot.id);
  });

  it('tripwire aborts when a prompted shot is left without a pointer', async () => {
    await insertShot({ orderIndex: 0, motionPrompt: 'never pointed at' });

    // INSERT + UPDATE skipped: simulates the backfill failing to reach a shot.
    // The next migration removes `motion_prompt`, so this must fail the deploy.
    await expect(client.execute(TRIPWIRE)).rejects.toThrow(/integer overflow/);

    await runBackfill();
    // Clean run: the tripwire selects no rows and never evaluates abs().
    await expect(client.execute(TRIPWIRE)).resolves.toBeDefined();
  });

  it('leaves a shot that already has a pointer untouched', async () => {
    const shot = await insertShot({
      orderIndex: 0,
      motionPrompt: 'mirror text',
    });
    const [existing] = await db
      .insert(shotPromptVersions)
      .values({
        shotId: shot.id,
        promptType: 'motion',
        text: 'the real selected version',
        source: 'ai-generated',
      })
      .returning();
    if (!existing) throw new Error('seed: version insert returned nothing');
    await db
      .update(shots)
      .set({ selectedMotionPromptVersionId: existing.id })
      .where(eq(shots.id, shot.id));

    await runBackfill();

    const [refreshed] = await db
      .select()
      .from(shots)
      .where(eq(shots.id, shot.id));
    expect(refreshed?.selectedMotionPromptVersionId).toBe(existing.id);
    expect(
      await db
        .select()
        .from(shotPromptVersions)
        .where(eq(shotPromptVersions.shotId, shot.id))
    ).toHaveLength(1);
  });

  it('skips shots with no motion prompt, and empty-string prompts', async () => {
    const none = await insertShot({ orderIndex: 0, motionPrompt: null });
    const empty = await insertShot({ orderIndex: 1, motionPrompt: '' });

    await runBackfill();

    expect(await db.select().from(shotPromptVersions)).toHaveLength(0);
    for (const id of [none.id, empty.id]) {
      const [row] = await db.select().from(shots).where(eq(shots.id, id));
      expect(row?.selectedMotionPromptVersionId).toBeNull();
    }
  });

  it('is idempotent — a second application changes nothing', async () => {
    await insertShot({ orderIndex: 0, motionPrompt: 'a' });
    await insertShot({ orderIndex: 1, motionPrompt: 'b' });

    await runBackfill();
    const afterFirst = await db.select().from(shotPromptVersions);
    const shotsAfterFirst = await db.select().from(shots);

    await runBackfill();

    expect(await db.select().from(shotPromptVersions)).toEqual(afterFirst);
    expect(await db.select().from(shots)).toEqual(shotsAfterFirst);
  });

  it('backfills every shot of a sequence, not just the first', async () => {
    for (let i = 0; i < 5; i++) {
      await insertShot({ orderIndex: i, motionPrompt: `prompt ${i}` });
    }

    await runBackfill();

    const versions = await db.select().from(shotPromptVersions);
    expect(versions).toHaveLength(5);
    expect(versions.map((v) => v.text).sort()).toEqual([
      'prompt 0',
      'prompt 1',
      'prompt 2',
      'prompt 3',
      'prompt 4',
    ]);
    const rows = await db.select().from(shots);
    expect(rows.every((r) => r.selectedMotionPromptVersionId !== null)).toBe(
      true
    );
  });
});
