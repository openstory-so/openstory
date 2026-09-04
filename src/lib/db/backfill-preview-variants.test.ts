/**
 * In-memory DB test for the #1101 preview backfill, which ships inside the
 * column-drop migration (20260808025651_curved_ink).
 *
 * `frames.preview_image_url` is the ONLY copy of every preview the product has
 * — the legacy path wrote the column and minted no row — so this statement is
 * the difference between carrying those images onto `kind: 'preview'` rows and
 * deleting them. The statement order inside that file is therefore
 * load-bearing, and is asserted here too.
 *
 * Migrations run against an empty DB at setup, so the backfill no-ops there and
 * the drop then removes the column. This re-creates the column to reproduce the
 * pre-drop schema the statement really runs against, seeds the legacy shape,
 * and executes the shipped SQL verbatim.
 */

import { generateId } from '@/shared/id';
import {
  frameVariants,
  frames,
  sequences,
  shots,
  styles,
  teams,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';

const MIGRATION_SQL =
  './drizzle/migrations/20260808025651_curved_ink/migration.sql';

/** The shipped statements, comments stripped, in file order. */
function readStatements(): string[] {
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

function required<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`test setup: ${what} insert returned nothing`);
  return row;
}

let client: Client;
let sequenceId = '';
let withPreview = '';
let withoutPreview = '';

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  const db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  // The drop already ran; put the column back so the backfill executes against
  // the schema it actually ships against.
  await client.execute(
    'ALTER TABLE `frames` ADD COLUMN `preview_image_url` text'
  );

  const teamId = generateId();
  sequenceId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
  const style = required(
    (
      await db
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
        .returning()
    )[0],
    'style'
  );
  await db
    .insert(sequences)
    .values({ id: sequenceId, teamId, title: 'S', styleId: style.id });
  const shot = required(
    (
      await db.insert(shots).values({ sequenceId, shotNumber: 1 }).returning()
    )[0],
    'shot'
  );
  const mk = async (orderIndex: number) =>
    required(
      (
        await db
          .insert(frames)
          .values({ shotId: shot.id, sequenceId, orderIndex, role: 'key' })
          .returning()
      )[0],
      'frame'
    ).id;
  withPreview = await mk(0);
  withoutPreview = await mk(1);

  await client.execute({
    sql: 'UPDATE `frames` SET `preview_image_url` = ? WHERE `id` = ?',
    args: ['https://fal.media/files/preview.png', withPreview],
  });

  const backfill = required(readStatements()[0], 'backfill statement');
  await client.execute(backfill);
  // Replay safety: a second application must mint nothing more.
  await client.execute(backfill);
});

afterAll(() => {
  client.close();
});

it('backfills before it drops — the whole point of the shared file', () => {
  const statements = readStatements();
  const backfill = statements.findIndex((s) => s.startsWith('INSERT INTO'));
  const drop = statements.findIndex((s) =>
    s.includes('`frames` DROP COLUMN `preview_image_url`')
  );
  expect(backfill).toBeGreaterThanOrEqual(0);
  expect(drop).toBeGreaterThanOrEqual(0);
  expect(backfill).toBeLessThan(drop);
});

it('carries every preview url onto a kind:preview row, exactly once', async () => {
  const rows = await client.execute(
    'SELECT `id`, `frame_id`, `kind`, `model`, `url`, `storage_path`, `status`, `prompt_version_id` FROM `frame_variants`'
  );

  // One row, for the frame that had a preview — nothing for the one that didn't.
  expect(rows.rows).toHaveLength(1);
  const row = required(rows.rows[0], 'backfilled');
  expect(row.frame_id).toBe(withPreview);
  expect(row.kind).toBe('preview');
  expect(row.model).toBe('flux_2_turbo');
  expect(row.url).toBe('https://fal.media/files/preview.png');
  // Matches `recordPreview`: no R2 upload, never paired with a prompt version.
  expect(row.storage_path).toBeNull();
  expect(row.prompt_version_id).toBeNull();
  // Completed, so the preview reads (which filter on it) actually return it.
  expect(row.status).toBe('completed');

  expect(rows.rows.some((r) => r.frame_id === withoutPreview)).toBe(false);
});

it('sorts older than any real ULID, so a later preview supersedes it', async () => {
  const backfilled = required(
    (
      await client.execute({
        sql: 'SELECT `id` FROM `frame_variants` WHERE `frame_id` = ?',
        args: [withPreview],
      })
    ).rows[0],
    'backfilled'
  );
  const db = drizzle({ client, relations });
  const fresh = generateId();
  await db.insert(frameVariants).values({
    id: fresh,
    frameId: withPreview,
    sequenceId,
    kind: 'preview',
    model: 'flux_2_turbo',
    status: 'completed',
    url: 'https://fal.media/files/newer.png',
  });

  const newest = await client.execute(
    'SELECT `id` FROM `frame_variants` ORDER BY `id` DESC LIMIT 1'
  );
  expect(required(newest.rows[0], 'newest').id).toBe(fresh);

  const backfilledId = backfilled.id;
  if (typeof backfilledId !== 'string') {
    throw new Error(`expected a text id, got ${typeof backfilledId}`);
  }
  // The property the synthetic prefix buys: '00…' sorts below every real ULID.
  expect(backfilledId < fresh).toBe(true);
});
