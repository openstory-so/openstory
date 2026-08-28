/**
 * Acceptance test for the shared `ShotView` assembly query. In-memory libSQL
 * with the real migrations.
 *
 * The preview follow-up read (#1101) is the reason this file exists: nothing
 * else covered `assembleShotViews`, so deleting its `getLatestPreviewByFrameIds`
 * call left every shot with `previewThumbnailUrl: null` and the whole suite
 * still passed — on the path that feeds `sequences.listShotViewsBySequenceIds`
 * and the public API's readiness counts.
 */

import type { Database } from '@/lib/db/client';
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
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assembleShotViews, selectShotViewRows } from './shot-view-query';

let client: Client;
let db: Database;
let frameId = '';

function required<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`test setup: ${what} insert returned nothing`);
  return row;
}

async function assemble() {
  const rows = await selectShotViewRows(db);
  return await assembleShotViews(db, rows);
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
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
  frameId = frame.id;
});

afterAll(() => {
  client.close();
});

it('resolves previewThumbnailUrl through the whole assembly path', async () => {
  // A frame with no preview row reads null — the value `frames.preview_image_url`
  // used to carry by default.
  expect((await assemble())[0]?.previewThumbnailUrl).toBeNull();

  const sequenceId = required(
    (await db.select().from(sequences))[0],
    'sequence'
  ).id;
  // Ids stand in for ULIDs, so they must sort in creation order.
  await db.insert(frameVariants).values({
    id: 'preview-1',
    frameId,
    sequenceId,
    kind: 'preview',
    model: 'flux_2_turbo',
    status: 'completed',
    url: 'https://cdn.example/old.png',
  });
  expect((await assemble())[0]?.previewThumbnailUrl).toBe(
    'https://cdn.example/old.png'
  );

  // Newest non-discarded wins.
  await db.insert(frameVariants).values({
    id: 'preview-2',
    frameId,
    sequenceId,
    kind: 'preview',
    model: 'flux_2_turbo',
    status: 'completed',
    url: 'https://cdn.example/new.png',
  });
  expect((await assemble())[0]?.previewThumbnailUrl).toBe(
    'https://cdn.example/new.png'
  );

  // A url-less husk (what the #1101 migration retags) sorts newest but must not
  // shadow the real preview.
  await db.insert(frameVariants).values({
    id: 'preview-3',
    frameId,
    sequenceId,
    kind: 'preview',
    model: 'flux_2_turbo',
    status: 'generating',
    url: null,
  });
  expect((await assemble())[0]?.previewThumbnailUrl).toBe(
    'https://cdn.example/new.png'
  );

  // The shape that actually shipped: the reclassify retagged url-less rows
  // WITHOUT regard to status, so 2150 of them were already 'completed'. Those
  // carry real ULIDs while backfilled rows carry synthetic `00…` ids, so the
  // husk outranks the image and `status` alone let it win — 2150 of 3009
  // frames lost their preview in production. Only `url IS NOT NULL` stops it.
  await db.insert(frameVariants).values({
    id: 'preview-4',
    frameId,
    sequenceId,
    kind: 'preview',
    model: 'flux_2_turbo',
    status: 'completed',
    url: null,
  });
  expect((await assemble())[0]?.previewThumbnailUrl).toBe(
    'https://cdn.example/new.png'
  );

  // Discarded rows fall back to the older one.
  await db
    .update(frameVariants)
    .set({ discardedAt: new Date() })
    .where(eq(frameVariants.id, 'preview-2'));
  expect((await assemble())[0]?.previewThumbnailUrl).toBe(
    'https://cdn.example/old.png'
  );

  // A preview is never the still.
  expect((await assemble())[0]?.image).toBeNull();
});

it('projects pendingUpscaleUrl from a generating pending-promote version', async () => {
  const sequenceId = required(
    (await db.select().from(sequences))[0],
    'sequence'
  ).id;
  await db.insert(frameVariants).values({
    id: 'upscale-crop-1',
    frameId,
    sequenceId,
    kind: 'framing',
    model: 'nano_banana_2',
    status: 'generating',
    url: '/r2/thumbnails/crop.png',
  });
  await db
    .update(frames)
    .set({ pendingPromoteVersionId: 'upscale-crop-1' })
    .where(eq(frames.id, frameId));

  expect((await assemble())[0]?.pendingUpscaleUrl).toBe(
    '/r2/thumbnails/crop.png'
  );

  await db
    .update(frames)
    .set({ pendingPromoteVersionId: null })
    .where(eq(frames.id, frameId));
  expect((await assemble())[0]?.pendingUpscaleUrl).toBeNull();
});

/**
 * The regression guard for #1135. libSQL (and every other SQLite this suite
 * runs on) happily returns a 104-column row, so nothing here would ever fail on
 * width — only D1 rejects it, and only in production. Assert the count instead.
 */
it('projects fewer columns than D1 accepts, including a caller join', async () => {
  const { sql } = selectShotViewRows(db)
    // What `sequences.listShotsByIds` adds for its team filter. Under a bare
    // `db.select()` this join dragged in every `sequences` column too.
    .innerJoin(sequences, eq(shots.sequenceId, sequences.id))
    .toSQL();
  const projected = sql
    .slice('select '.length, sql.indexOf(' from '))
    .split(', ');
  expect(projected.length).toBeLessThanOrEqual(100);

  // A left-joined group with no matching row must be null, not an object of
  // nulls: `assembleShotViews` branches on truthiness, so the latter would
  // rebuild a motion prompt out of nothing.
  expect((await selectShotViewRows(db))[0]?.shot_prompt_versions).toBeNull();
});
