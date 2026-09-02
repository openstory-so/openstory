/**
 * In-memory DB tests for the #990 video-surface backfill.
 *
 * The backfill is a 3-statement data migration that ships inside the
 * `…_nostalgic_expediter` migration: (1) materialize a degenerate
 * `render_segments` row per shot with a video variant, (2) link
 * `shots.render_segment_id`, (3) copy the video slice of `shot_variants` into
 * `video_variants` with a JSON manifest. Because migrations run against an empty
 * DB at setup the in-migration backfill no-ops there — so these tests seed the
 * legacy rows AFTER migrating, then execute the migration's own backfill
 * statements (read verbatim from the shipped SQL) and assert the result.
 *
 * The manifest shape is the #1 risk: its keys must match what
 * `projectVideoVariants` / `computeVideoManifestInputHash` read, or every reader
 * breaks on data that passed SQL.
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/shared/id';
import type { NewShot } from '@/lib/db/schema';
import {
  dbSceneId,
  frames,
  renderSegments,
  scenes,
  sequences,
  shots,
  shotVariants,
  styles,
  teams,
  videoVariants,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = './drizzle/migrations';

let client: Client;
let db: Database;
let sequenceId = '';

/**
 * Pull the backfill statements straight out of the shipped migration SQL so the
 * test runs the exact DML prod applies. Finds the migration containing the
 * `INSERT INTO video_variants … SELECT … FROM shot_variants` backfill, strips
 * comments, and returns the two INSERTs + the UPDATE in file order.
 */
function readBackfillStatements(): string[] {
  for (const dir of readdirSync(MIGRATIONS_DIR)) {
    const file = join(MIGRATIONS_DIR, dir, 'migration.sql');
    let sql: string;
    try {
      sql = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!sql.includes('INSERT INTO `video_variants`')) continue;
    return sql
      .split('--> statement-breakpoint')
      .map((s) =>
        s
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .trim()
      )
      .filter(
        (s) =>
          s.startsWith('INSERT INTO `render_segments`') ||
          s.startsWith('UPDATE `shots` SET `render_segment_id`') ||
          s.startsWith('INSERT INTO `video_variants`')
      );
  }
  throw new Error('test setup: video-variants backfill migration not found');
}

const BACKFILL_STATEMENTS = readBackfillStatements();

/**
 * Columns the shipped backfill reads/writes that a later migration dropped.
 * `migrate()` below brings the DB to HEAD, so re-add them to exercise the SQL
 * against the schema it actually ran on in prod — the same trick
 * backfill-video-segments.test.ts uses for the `shots.video*` mirror. #1101
 * dropped both `preview_url` columns: never populated, only ever copied from
 * one table to the other by this very statement.
 */
const LEGACY_PREVIEW_URL = [
  'ALTER TABLE `shot_variants` ADD COLUMN `preview_url` text',
  'ALTER TABLE `video_variants` ADD COLUMN `preview_url` text',
];

// Fail loud if the parser extracted the wrong statement count (e.g. a future
// db:generate reformat the startsWith filters no longer match). A partial match
// would let some assertions pass while a whole backfill step goes untested.
if (BACKFILL_STATEMENTS.length !== 3) {
  throw new Error(
    `test setup: expected 3 backfill statements (INSERT render_segments + UPDATE shots + INSERT video_variants), got ${BACKFILL_STATEMENTS.length} — migration SQL format likely changed`
  );
}

async function runBackfill(): Promise<void> {
  for (const stmt of BACKFILL_STATEMENTS) {
    await client.execute(stmt);
  }
}

async function seedSequence(): Promise<void> {
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
  if (!style) throw new Error('test setup: style insert returned nothing');
  await db.insert(sequences).values({
    id: sequenceId,
    teamId,
    title: 'S',
    styleId: style.id,
  });
}

/** A shot in a scene, with an anchor frame carrying a selected image version. */
async function insertShotWithAnchor(
  data: Partial<NewShot> & { orderIndex: number },
  anchor: { selectedImageVersionId: string | null }
) {
  const id = data.id ?? generateId();
  const sceneId = data.sceneId === undefined ? generateId() : data.sceneId;
  if (sceneId) {
    await db
      .insert(scenes)
      .values({
        id: dbSceneId(sceneId),
        sequenceId,
        orderIndex: data.orderIndex,
      })
      .onConflictDoNothing();
  }
  const [shot] = await db
    .insert(shots)
    .values({ id, sequenceId, ...data, sceneId } satisfies NewShot)
    .returning();
  if (!shot) throw new Error('test setup: shot insert returned nothing');
  await db.insert(frames).values({
    shotId: shot.id,
    sequenceId,
    orderIndex: 0,
    role: 'first',
    selectedImageVersionId: anchor.selectedImageVersionId,
  });
  return shot;
}

async function insertVideoVariant(data: {
  shotId: string;
  model: string;
  durationMs?: number | null;
  divergedAt?: Date | null;
  status?: 'completed' | 'failed';
  url?: string | null;
}) {
  const [v] = await db
    .insert(shotVariants)
    .values({
      shotId: data.shotId,
      sequenceId,
      variantType: 'video',
      model: data.model,
      status: data.status ?? 'completed',
      url: data.url === undefined ? 'https://r2/v.mp4' : data.url,
      storagePath: 'team/seq/v.mp4',
      inputHash: 'legacy-hash',
      durationMs: data.durationMs ?? null,
      divergedAt: data.divergedAt ?? null,
    })
    .returning();
  if (!v) throw new Error('test setup: shot_variant insert returned nothing');
  return v;
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  for (const stmt of LEGACY_PREVIEW_URL) {
    await client.execute(stmt);
  }
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.delete(videoVariants);
  await db.delete(shotVariants);
  await db.delete(frames);
  await db.delete(shots);
  await db.delete(renderSegments);
  await db.delete(scenes);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await seedSequence();
});

describe('backfill video_variants migration', () => {
  it('materializes one render_segment per shot (id == shot id) and links the shot', async () => {
    const shot = await insertShotWithAnchor(
      { orderIndex: 0, selectedMotionPromptVersionId: 'mp-1' },
      { selectedImageVersionId: 'fv-1' }
    );
    await insertVideoVariant({ shotId: shot.id, model: 'veo3_1' });

    await runBackfill();

    const segs = await db.select().from(renderSegments);
    expect(segs).toHaveLength(1);
    // The degenerate segment reuses the shot's id (the #906 anchor-style rule).
    expect(segs[0]?.id).toBe(shot.id);
    expect(segs[0]?.sceneId).toBe(shot.sceneId);
    expect(segs[0]?.selectedVideoVersionId).toBeNull();

    const [linked] = await db
      .select({ renderSegmentId: shots.renderSegmentId })
      .from(shots)
      .where(eq(shots.id, shot.id));
    expect(linked?.renderSegmentId).toBe(shot.id);
  });

  it('copies the video version with a manifest matching the readers (keys + ids + duration)', async () => {
    const shot = await insertShotWithAnchor(
      {
        orderIndex: 0,
        selectedMotionPromptVersionId: 'mp-1',
        durationMs: 7000,
      },
      { selectedImageVersionId: 'fv-1' }
    );
    const sv = await insertVideoVariant({
      shotId: shot.id,
      model: 'veo3_1',
      durationMs: 5000,
    });

    await runBackfill();

    const rows = await db.select().from(videoVariants);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // Identity + segment linkage are deterministic (id reuse).
    expect(row?.id).toBe(sv.id);
    expect(row?.renderSegmentId).toBe(shot.id);
    expect(row?.model).toBe('veo3_1');
    expect(row?.status).toBe('completed');
    // Manifest = exactly the shape projectVideoVariants / the hash read.
    expect(row?.manifest).toEqual([
      {
        shotId: shot.id,
        motionPromptVersionId: 'mp-1',
        frameVersionId: 'fv-1',
        durationMs: 5000, // sv.duration_ms wins the COALESCE
      },
    ]);
  });

  it('falls back to the shot duration, then 0, when the variant has none', async () => {
    const shot = await insertShotWithAnchor(
      { orderIndex: 0, durationMs: 4000 },
      { selectedImageVersionId: null }
    );
    await insertVideoVariant({
      shotId: shot.id,
      model: 'veo3_1',
      durationMs: null,
    });

    await runBackfill();

    const [row] = await db.select().from(videoVariants);
    expect(row?.manifest).toEqual([
      {
        shotId: shot.id,
        motionPromptVersionId: null,
        frameVersionId: null, // no selected image version on the anchor
        durationMs: 4000, // s.duration_ms fallback
      },
    ]);
  });

  it('copies divergent + discarded history so the per-model switcher keeps its alternates', async () => {
    const shot = await insertShotWithAnchor(
      { orderIndex: 0 },
      { selectedImageVersionId: 'fv-1' }
    );
    await insertVideoVariant({ shotId: shot.id, model: 'veo3_1' });
    await insertVideoVariant({
      shotId: shot.id,
      model: 'kling_v3_pro',
      divergedAt: new Date('2026-06-02T00:00:00Z'),
    });

    await runBackfill();

    const rows = await db.select().from(videoVariants);
    // Both the primary and the divergent alternate are migrated (one segment).
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.model))).toEqual(
      new Set(['veo3_1', 'kling_v3_pro'])
    );
    const segs = await db.select().from(renderSegments);
    expect(segs).toHaveLength(1);
  });

  it('excludes shots with no scene (scene_id IS NULL) from the backfill', async () => {
    const shot = await insertShotWithAnchor(
      { orderIndex: 0, sceneId: null },
      { selectedImageVersionId: 'fv-1' }
    );
    await insertVideoVariant({ shotId: shot.id, model: 'veo3_1' });

    await runBackfill();

    expect(await db.select().from(renderSegments)).toHaveLength(0);
    expect(await db.select().from(videoVariants)).toHaveLength(0);
  });

  it('ignores non-video shot_variants', async () => {
    const shot = await insertShotWithAnchor(
      { orderIndex: 0 },
      { selectedImageVersionId: 'fv-1' }
    );
    await db.insert(shotVariants).values({
      shotId: shot.id,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      status: 'completed',
      url: 'https://r2/i.png',
    });

    await runBackfill();

    expect(await db.select().from(videoVariants)).toHaveLength(0);
    expect(await db.select().from(renderSegments)).toHaveLength(0);
  });
});
