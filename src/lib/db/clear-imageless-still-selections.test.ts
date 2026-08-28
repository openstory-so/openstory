/**
 * In-memory DB test for the #1133 selection repair.
 *
 * Executes the shipped SQL verbatim against seeded rows. The discriminator is
 * the whole risk: too wide and it clears a good selection, too narrow and the
 * 58 frames keep claiming a finished still that renders nothing.
 */

import { generateId } from '@/lib/db/id';
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
  './drizzle/migrations/20260811010200_clear_imageless_still_selections/migration.sql';

/** The shipped statement, comments stripped. */
function readMigration(): string {
  return readFileSync(MIGRATION_SQL, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .trim();
}

function required<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`test setup: ${what} insert returned nothing`);
  return row;
}

let client: Client;
let broken = '';
let healthy = '';
let inflight = '';

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  const db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });

  const teamId = generateId();
  const sequenceId = generateId();
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
  const mkFrame = async (orderIndex: number) =>
    required(
      (
        await db
          .insert(frames)
          .values({
            shotId: shot.id,
            sequenceId,
            orderIndex,
            role: 'key',
            imageStatus: 'completed',
          })
          .returning()
      )[0],
      'frame'
    ).id;
  broken = await mkFrame(0);
  healthy = await mkFrame(1);
  inflight = await mkFrame(2);

  await db.insert(frameVariants).values([
    // The corruption: marked completed, produced nothing.
    {
      id: 'v-husk',
      frameId: broken,
      sequenceId,
      kind: 'model',
      model: 'flux_2_turbo',
      status: 'completed',
      url: null,
      storagePath: null,
    },
    // A real still — its frame must be left completely alone.
    {
      id: 'v-good',
      frameId: healthy,
      sequenceId,
      kind: 'model',
      model: 'nano_banana_2',
      status: 'completed',
      url: 'https://cdn.example/still.png',
      storagePath: 'r2/still.png',
    },
    // Not selected by anyone, just in flight — must not be touched either.
    {
      id: 'v-inflight',
      frameId: inflight,
      sequenceId,
      kind: 'model',
      model: 'nano_banana_2',
      status: 'generating',
      url: null,
    },
  ]);

  await client.execute({
    sql: 'UPDATE `frames` SET `selected_image_version_id` = ? WHERE `id` = ?',
    args: ['v-husk', broken],
  });
  await client.execute({
    sql: 'UPDATE `frames` SET `selected_image_version_id` = ? WHERE `id` = ?',
    args: ['v-good', healthy],
  });

  const sql = readMigration();
  await client.execute(sql);
  // Replay safety: a second application must change nothing more.
  await client.execute(sql);
});

afterAll(() => {
  client.close();
});

it('clears only the selection that points at an image-less version', async () => {
  const rows = await client.execute(
    'SELECT `id`, `selected_image_version_id` AS sel, `image_status` FROM `frames` ORDER BY `order_index`'
  );
  const byId = Object.fromEntries(
    rows.rows.map((r) => [r.id, { sel: r.sel, status: r.image_status }])
  );

  // Repaired: pointer dropped, status tells the truth.
  expect(byId[broken]).toEqual({ sel: null, status: 'pending' });
  // Untouched — a real still keeps its selection AND its completed status.
  expect(byId[healthy]).toEqual({
    sel: 'v-good',
    status: 'completed',
  });
  // Untouched — an in-flight version nobody selected is not a broken pointer.
  expect(byId[inflight]).toEqual({ sel: null, status: 'completed' });
});
