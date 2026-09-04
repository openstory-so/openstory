/**
 * In-memory DB test for the #1101 reclassify migration.
 *
 * The migration is a single data statement: legacy preview renders were filed
 * as `kind: 'model'` (the kind predates them), and this moves them to
 * `kind: 'preview'`. Because migrations run against an empty DB at setup, the
 * statement no-ops there — so this seeds the legacy row shapes AFTER migrating,
 * then executes the shipped SQL verbatim and asserts exactly which rows moved.
 *
 * The discriminators are the whole risk: get one wrong and a real still becomes
 * unselectable, or a preview stays in the user's model dropdown.
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
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';

const MIGRATION_SQL =
  './drizzle/migrations/20260808000000_reclassify_preview_variants/migration.sql';

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
  const frame = required(
    (
      await db
        .insert(frames)
        .values({ shotId: shot.id, sequenceId, orderIndex: 0, role: 'first' })
        .returning()
    )[0],
    'frame'
  );

  const base = { frameId: frame.id, sequenceId } as const;
  await db.insert(frameVariants).values([
    // Moves: the shape every one of the legacy rows has — the old preview path
    // opened a 'generating' row, skipped the R2 upload, and never completed it.
    {
      ...base,
      id: 'legacy-preview',
      kind: 'model',
      model: 'flux_2_turbo',
      status: 'generating',
      url: null,
      storagePath: null,
    },
    // Stays: a real still from a user-pickable model.
    { ...base, id: 'real-still', kind: 'model', model: 'nano_banana_2' },
    // Stays: a 3x3 grid sheet was never a preview, whatever rendered it.
    { ...base, id: 'framing', kind: 'framing', model: 'flux_2_turbo' },
    // Stays: a render OF a prompt version is a still, not a preview.
    {
      ...base,
      id: 'with-prompt',
      kind: 'model',
      model: 'flux_2_turbo',
      promptVersionId: 'pv-1',
    },
    // Stays: a frame points at it, so it is that frame's still by definition —
    // moving it would strand the pointer against the new `select` guard.
    { ...base, id: 'selected', kind: 'model', model: 'flux_2_turbo' },
    // Stays: #989 step 3 synthesised primary rows from `shots.image_model`,
    // which pre-#989 preview runs left at flux_2_turbo, paired with a REAL
    // thumbnail url. Every other discriminator passes, so the url/path guard is
    // the only thing between this still and an irreversible misfiling.
    {
      ...base,
      id: 'synthetic-still',
      kind: 'model',
      model: 'flux_2_turbo',
      status: 'completed',
      url: 'https://cdn.example/real-still.png',
      storagePath: 'frames/real-still.png',
    },
    // Stays: url-less like a husk, but a live auto-promote claim points at it.
    // `selectIfPendingPromoteIs` clears the claim BEFORE calling the throwing
    // `select`, so reclassifying this would discard the claim and then fail.
    {
      ...base,
      id: 'promote-target',
      kind: 'model',
      model: 'flux_2_turbo',
      status: 'generating',
      url: null,
      storagePath: null,
    },
  ]);
  await db
    .update(frames)
    .set({
      selectedImageVersionId: 'selected',
      pendingPromoteVersionId: 'promote-target',
    })
    .where(eq(frames.id, frame.id));

  const sql = readMigration();
  await client.execute(sql);
  // Replay safety: a second application must move nothing more.
  await client.execute(sql);
});

afterAll(() => {
  client.close();
});

it('reclassifies only the legacy preview rows', async () => {
  const rows = await client.execute(
    'SELECT id, kind FROM frame_variants ORDER BY id'
  );
  expect(Object.fromEntries(rows.rows.map((r) => [r.id, r.kind]))).toEqual({
    framing: 'framing',
    'legacy-preview': 'preview',
    'promote-target': 'model',
    'real-still': 'model',
    selected: 'model',
    'synthetic-still': 'model',
    'with-prompt': 'model',
  });
});
