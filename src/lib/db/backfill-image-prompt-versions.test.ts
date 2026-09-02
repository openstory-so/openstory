/**
 * In-memory DB tests for the #1067 image-prompt-version backfill.
 *
 * The image side never had a read path for `selectedImagePromptVersionId` — it
 * was written and never queried, so `frames.imagePrompt` is the read path
 * rather than a mirror of one. This backfill makes the pointer resolvable for
 * every frame that has a prompt, so the column can then be dropped.
 */

import type { Database } from '@/lib/db/client';
import { generateId, isValidId } from '@/shared/id';
import {
  framePromptVersions,
  frames,
  sequences,
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

// Read by explicit path: a scan would match the motion backfill first.
const MIGRATION_SQL =
  './drizzle/migrations/20260805132609_backfill_image_prompt_versions/migration.sql';

const STATEMENTS = readFileSync(MIGRATION_SQL, 'utf8')
  .split('--> statement-breakpoint')
  .map((chunk) =>
    chunk
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim()
  )
  .filter((chunk) => chunk.length > 0);

if (STATEMENTS.length !== 3) {
  throw new Error(
    `expected 3 statements (INSERT versions + UPDATE pointer + tripwire), got ${STATEMENTS.length}`
  );
}

// `runBackfill` applies all three, so every test below also asserts the
// tripwire stays silent. Held separately so one test can evaluate it against a
// deliberately unfinished backfill.
const TRIPWIRE = STATEMENTS[2] ?? '';

let client: Client;
let db: Database;
let sequenceId = '';
let shotId = '';

async function runBackfill(): Promise<void> {
  for (const stmt of STATEMENTS) await client.execute(stmt);
}

async function seed() {
  await db.delete(framePromptVersions);
  await db.delete(frames);
  await db.delete(shots);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);

  const teamId = generateId();
  sequenceId = generateId();
  shotId = generateId();
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
  await db.insert(shots).values({ id: shotId, sequenceId, shotNumber: 1 });
}

// #1067 drops the mirror columns this backfill reads, so drizzle can no longer
// write them: re-add them when the migrated DB lacks them and seed with raw
// SQL. The migration file itself is history and stays verbatim.
async function ensureLegacyMirrorColumns(): Promise<void> {
  const info = await client.execute('PRAGMA table_info(`frames`)');
  const present = new Set(
    info.rows.flatMap((row) => (typeof row.name === 'string' ? [row.name] : []))
  );
  for (const column of ['image_prompt', 'visual_prompt_input_hash']) {
    if (present.has(column)) continue;
    await client.execute(
      `ALTER TABLE \`frames\` ADD COLUMN \`${column}\` text`
    );
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

async function insertFrame(values: {
  orderIndex: number;
  imagePrompt?: string | null;
  visualPromptInputHash?: string | null;
  selectedImagePromptVersionId?: string | null;
}) {
  const {
    imagePrompt = null,
    visualPromptInputHash = null,
    ...frameValues
  } = values;
  const [frame] = await db
    .insert(frames)
    .values({ shotId, sequenceId, role: 'first', ...frameValues })
    .returning();
  if (!frame) throw new Error('seed: frame insert returned nothing');
  await client.execute({
    sql: 'UPDATE `frames` SET `image_prompt` = ?, `visual_prompt_input_hash` = ? WHERE `id` = ?',
    args: [imagePrompt, visualPromptInputHash, frame.id],
  });
  return frame;
}

describe('backfill image prompt versions', () => {
  it('creates a version row and points the frame at it', async () => {
    const frame = await insertFrame({
      orderIndex: 0,
      imagePrompt: 'wide shot of the lab, cold blue light',
      visualPromptInputHash: 'hash-1',
    });

    await runBackfill();

    const [refreshed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frame.id));
    const [version] = await db
      .select()
      .from(framePromptVersions)
      .where(eq(framePromptVersions.frameId, frame.id));

    expect(version?.text).toBe('wide shot of the lab, cold blue light');
    expect(version?.status).toBe('completed');
    expect(version?.inputHash).toBe('hash-1');
    // SQLite does not enforce the enum — a bad literal would reach prod.
    expect(version?.source).toBe('ai-generated');
    expect(refreshed?.selectedImagePromptVersionId).toBe(version?.id);
  });

  it('mints a ULID-shaped id — `ulidSchema` guards every restore path', async () => {
    const frame = await insertFrame({
      orderIndex: 0,
      imagePrompt: 'a lantern in the fog',
    });

    await runBackfill();

    const [version] = await db
      .select()
      .from(framePromptVersions)
      .where(eq(framePromptVersions.frameId, frame.id));
    // A prefixed id (the original `bfip_<ulid>`) fails ulidSchema's 26-char +
    // Crockford-base32 check, so restoreShotPromptVariantFn would reject the
    // very rows this backfill creates.
    expect(isValidId(version?.id ?? '')).toBe(true);
    expect(version?.id).toBe(frame.id);
  });

  it('tripwire aborts when a prompted frame is left without a pointer', async () => {
    await insertFrame({ orderIndex: 0, imagePrompt: 'never pointed at' });

    // INSERT + UPDATE skipped: simulates the backfill failing to reach a frame.
    // The mirror column goes away next, so this must fail the deploy.
    await expect(client.execute(TRIPWIRE)).rejects.toThrow(/integer overflow/);

    await runBackfill();
    // Clean run: the tripwire selects no rows and never evaluates abs().
    await expect(client.execute(TRIPWIRE)).resolves.toBeDefined();
  });

  it('leaves a frame that already has a pointer untouched', async () => {
    const frame = await insertFrame({ orderIndex: 0, imagePrompt: 'mirror' });
    const [existing] = await db
      .insert(framePromptVersions)
      .values({
        frameId: frame.id,
        text: 'the real selected version',
        source: 'ai-generated',
      })
      .returning();
    if (!existing) throw new Error('seed: version insert returned nothing');
    await db
      .update(frames)
      .set({ selectedImagePromptVersionId: existing.id })
      .where(eq(frames.id, frame.id));

    await runBackfill();

    const [refreshed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frame.id));
    expect(refreshed?.selectedImagePromptVersionId).toBe(existing.id);
    expect(
      await db
        .select()
        .from(framePromptVersions)
        .where(eq(framePromptVersions.frameId, frame.id))
    ).toHaveLength(1);
  });

  it('skips frames with no prompt, and empty-string prompts', async () => {
    const none = await insertFrame({ orderIndex: 0, imagePrompt: null });
    const empty = await insertFrame({ orderIndex: 1, imagePrompt: '' });

    await runBackfill();

    expect(await db.select().from(framePromptVersions)).toHaveLength(0);
    for (const id of [none.id, empty.id]) {
      const [row] = await db.select().from(frames).where(eq(frames.id, id));
      expect(row?.selectedImagePromptVersionId).toBeNull();
    }
  });

  it('is idempotent — a second application changes nothing', async () => {
    await insertFrame({ orderIndex: 0, imagePrompt: 'a' });
    await insertFrame({ orderIndex: 1, imagePrompt: 'b' });

    await runBackfill();
    const versionsAfterFirst = await db.select().from(framePromptVersions);
    const framesAfterFirst = await db.select().from(frames);

    await runBackfill();

    expect(await db.select().from(framePromptVersions)).toEqual(
      versionsAfterFirst
    );
    expect(await db.select().from(frames)).toEqual(framesAfterFirst);
  });

  it('backfills every frame, not just the first', async () => {
    for (let i = 0; i < 5; i++) {
      await insertFrame({ orderIndex: i, imagePrompt: `prompt ${i}` });
    }

    await runBackfill();

    const versions = await db.select().from(framePromptVersions);
    expect(versions).toHaveLength(5);
    expect(versions.map((v) => v.text).sort()).toEqual([
      'prompt 0',
      'prompt 1',
      'prompt 2',
      'prompt 3',
      'prompt 4',
    ]);
    const rows = await db.select().from(frames);
    expect(rows.every((r) => r.selectedImagePromptVersionId !== null)).toBe(
      true
    );
  });
});
