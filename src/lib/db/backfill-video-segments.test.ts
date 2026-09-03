/**
 * In-memory DB tests for the #1067 phase-2a backfill.
 *
 * The #990 cutover left two gaps that make `shots.video*` the primary record
 * rather than a mirror: shots whose video predates `shot_variants` got no
 * `render_segments` row at all, and legacy segments were created with a NULL
 * `selected_video_version_id` on purpose. This migration closes both so the
 * mirror can be dropped later without blanking a video.
 *
 * Migrations run against an empty DB at setup, so the in-migration backfill
 * no-ops there — these tests seed the legacy shapes AFTER migrating, then
 * execute the migration's own statements (read verbatim from the shipped SQL)
 * and assert the result.
 *
 * The manifest shape is the #1 risk: its keys must match what
 * `projectVideoVariants` / `computeVideoManifestInputHash` read, or every reader
 * breaks on data that passed SQL.
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import {
  dbSceneId,
  frames,
  renderSegments,
  scenes,
  sequences,
  shots,
  styles,
  teams,
  videoVariants,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const MIGRATION_SQL =
  './drizzle/migrations/20260805044544_backfill_video_segments_and_selection/migration.sql';

/**
 * The `shots.video*` mirror this migration reads. Phase 2d dropped it
 * (`20260805070159_fearless_frightful_four`) and `migrate()` below brings the
 * DB to HEAD, so re-add the columns to exercise the shipped SQL against the
 * schema it actually ran on in prod. The drizzle `shots` model no longer
 * declares them, so the fixtures write and read them over raw SQL.
 */
const LEGACY_VIDEO_MIRROR = [
  'ALTER TABLE `shots` ADD COLUMN `video_url` text',
  'ALTER TABLE `shots` ADD COLUMN `video_path` text',
  'ALTER TABLE `shots` ADD COLUMN `video_generated_at` integer',
  'ALTER TABLE `shots` ADD COLUMN `motion_model` text',
  'ALTER TABLE `shots` ADD COLUMN `video_status` text',
  'ALTER TABLE `shots` ADD COLUMN `video_workflow_run_id` text',
  // #1101 dropped `video_variants.preview_url` — never populated, only ever
  // written as the literal NULL this backfill passes positionally. Same reason
  // as above: restore the era's shape so the shipped SQL runs verbatim.
  'ALTER TABLE `video_variants` ADD COLUMN `preview_url` text',
];

let client: Client;
let db: Database;
let sequenceId = '';

/**
 * Pull the statements straight out of the shipped migration so the test runs the
 * exact DML prod applies. Read by explicit path, not by scanning for a matching
 * INSERT — the #990 backfill also inserts into `video_variants`, and a scan
 * would silently pick whichever sorted first.
 */
function readBackfillStatements(): string[] {
  return readFileSync(MIGRATION_SQL, 'utf8')
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim()
        .replace(/;$/, '')
    )
    .filter((s) => s.length > 0);
}

const BACKFILL_STATEMENTS = readBackfillStatements();

// Fail loud if the parser extracted the wrong count — a partial match would let
// assertions pass while a whole step goes untested.
if (BACKFILL_STATEMENTS.length !== 5) {
  throw new Error(
    `test setup: expected 5 backfill statements, got ${BACKFILL_STATEMENTS.length} — migration SQL format likely changed`
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

/** A shot in its own scene, with an anchor frame at orderIndex 0. */
async function insertShot(data: {
  orderIndex: number;
  videoUrl?: string | null;
  videoStatus?: 'completed' | 'failed';
  motionModel?: string | null;
  renderSegmentId?: string | null;
  selectedMotionPromptVersionId?: string | null;
  selectedImageVersionId?: string | null;
  durationMs?: number | null;
}) {
  const id = generateId();
  const sceneId = generateId();
  await db
    .insert(scenes)
    .values({
      id: dbSceneId(sceneId),
      sequenceId,
      orderIndex: data.orderIndex,
    })
    .onConflictDoNothing();
  const [shot] = await db
    .insert(shots)
    .values({
      id,
      sequenceId,
      sceneId,
      shotNumber: 1,
      durationMs: data.durationMs ?? 3000,
      renderSegmentId: data.renderSegmentId ?? null,
      selectedMotionPromptVersionId: data.selectedMotionPromptVersionId ?? null,
    })
    .returning();
  if (!shot) throw new Error('test setup: shot insert returned nothing');
  const videoUrl = data.videoUrl ?? null;
  await client.execute({
    sql: 'UPDATE `shots` SET `video_url` = ?, `video_path` = ?, `video_generated_at` = ?, `motion_model` = ?, `video_status` = ?, `video_workflow_run_id` = ? WHERE `id` = ?',
    args: [
      videoUrl,
      videoUrl ? 'team/seq/v.mp4' : null,
      videoUrl ? Math.floor(Date.now() / 1000) : null,
      data.motionModel ?? 'kling_v2_5_turbo_pro',
      data.videoStatus ?? 'completed',
      videoUrl ? 'run-1' : null,
      id,
    ],
  });
  await db.insert(frames).values({
    shotId: shot.id,
    sequenceId,
    orderIndex: 0,
    role: 'first',
    selectedImageVersionId: data.selectedImageVersionId ?? null,
  });
  return shot;
}

/** A #990-shaped legacy segment: variants exist, selection pointer is NULL. */
async function insertLegacySegment(opts: {
  shotOrderIndex: number;
  liveUrl: string;
  otherUrls?: string[];
}) {
  const segmentId = generateId();
  // Segment before link: `shots.render_segment_id` is a real FK, so the shot
  // cannot reference a segment row that does not exist yet.
  const shot = await insertShot({
    orderIndex: opts.shotOrderIndex,
    videoUrl: opts.liveUrl,
  });
  await db.insert(renderSegments).values({
    id: segmentId,
    sceneId: shot.sceneId ?? '',
    sequenceId,
    selectedVideoVersionId: null,
  });
  await db
    .update(shots)
    .set({ renderSegmentId: segmentId })
    .where(eq(shots.id, shot.id));
  const created: string[] = [];
  for (const url of [...(opts.otherUrls ?? []), opts.liveUrl]) {
    const [v] = await db
      .insert(videoVariants)
      .values({
        renderSegmentId: segmentId,
        sequenceId,
        model: 'kling_v2_5_turbo_pro',
        manifest: [
          {
            shotId: shot.id,
            motionPromptVersionId: null,
            frameVersionId: null,
            usesStartFrame: true,
            durationMs: 3000,
          },
        ],
        url,
        status: 'completed',
      })
      .returning();
    if (!v) throw new Error('test setup: variant insert returned nothing');
    created.push(v.id);
  }
  return { segmentId, shot, liveVariantId: created[created.length - 1] };
}

/** The legacy `shots.video*` rows the migration keys off, read over raw SQL. */
async function shotsWithLegacyVideo(): Promise<
  { id: string; renderSegmentId: string | null; videoUrl: string }[]
> {
  const { rows } = await client.execute(
    'SELECT `id`, `render_segment_id`, `video_url` FROM `shots` WHERE `video_url` IS NOT NULL'
  );
  return rows.map((row) => {
    const { id, render_segment_id: segmentId, video_url: videoUrl } = row;
    if (typeof id !== 'string' || typeof videoUrl !== 'string') {
      throw new Error('test setup: unexpected shots row shape');
    }
    if (segmentId !== null && typeof segmentId !== 'string') {
      throw new Error('test setup: unexpected render_segment_id');
    }
    return { id, renderSegmentId: segmentId, videoUrl };
  });
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  for (const stmt of LEGACY_VIDEO_MIRROR) {
    await client.execute(stmt);
  }
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  // Child-before-parent: `shots.render_segment_id` and
  // `video_variants.render_segment_id` both reference `render_segments`.
  await client.execute('DELETE FROM video_variants');
  await client.execute('DELETE FROM frames');
  await client.execute('DELETE FROM shots');
  await client.execute('DELETE FROM render_segments');
  await client.execute('DELETE FROM scenes');
  await client.execute('DELETE FROM sequences');
  await client.execute('DELETE FROM styles');
  await client.execute('DELETE FROM teams');
  await seedSequence();
});

describe('#1067 phase-2a backfill — orphan shots (video, no segment)', () => {
  it('materializes a segment, a variant, the link and the selection', async () => {
    const shot = await insertShot({
      orderIndex: 0,
      videoUrl: 'https://r2/live.mp4',
      selectedMotionPromptVersionId: 'mpv-1',
      selectedImageVersionId: 'fv-1',
      durationMs: 5000,
    });

    await runBackfill();

    const [segment] = await db
      .select()
      .from(renderSegments)
      .where(eq(renderSegments.id, shot.id));
    expect(segment).toBeDefined();
    expect(segment?.sceneId).toBe(shot.sceneId);

    const [variant] = await db
      .select()
      .from(videoVariants)
      .where(eq(videoVariants.renderSegmentId, shot.id));
    expect(variant?.url).toBe('https://r2/live.mp4');
    expect(variant?.model).toBe('kling_v2_5_turbo_pro');
    expect(variant?.status).toBe('completed');
    // input_hash stays NULL — fabricating one would read as "freshly verified".
    expect(variant?.inputHash).toBeNull();

    // Manifest keys must match VideoManifestEntry or every reader breaks.
    // `usesStartFrame` is absent here on purpose: this migration predates the
    // stamp, and in the real chain `20260902235109_backfill_manifest_uses_start_frame`
    // runs after it and stamps these rows.
    expect(variant?.manifest).toEqual([
      {
        shotId: shot.id,
        motionPromptVersionId: 'mpv-1',
        frameVersionId: 'fv-1',
        durationMs: 5000,
      },
    ]);

    const [linked] = await db.select().from(shots).where(eq(shots.id, shot.id));
    expect(linked?.renderSegmentId).toBe(shot.id);
    expect(segment && variant && segment.id).toBe(variant?.renderSegmentId);

    const [pointed] = await db
      .select()
      .from(renderSegments)
      .where(eq(renderSegments.id, shot.id));
    expect(pointed?.selectedVideoVersionId).toBe(variant?.id);
  });

  it("carries a failed-status shot's playable asset as a completed variant", async () => {
    // 14 prod rows have video_status 'failed' but a real url/path/generated_at:
    // a later attempt failed without clearing the asset. The variant records the
    // asset that exists, so the video keeps playing after the re-route.
    const shot = await insertShot({
      orderIndex: 0,
      videoUrl: 'https://r2/still-plays.mp4',
      videoStatus: 'failed',
    });

    await runBackfill();

    const [variant] = await db
      .select()
      .from(videoVariants)
      .where(eq(videoVariants.renderSegmentId, shot.id));
    expect(variant?.status).toBe('completed');
    expect(variant?.error).toBeNull();
    const [segment] = await db
      .select()
      .from(renderSegments)
      .where(eq(renderSegments.id, shot.id));
    expect(segment?.selectedVideoVersionId).toBe(variant?.id);
  });

  it('leaves a shot with no video entirely alone', async () => {
    const shot = await insertShot({ orderIndex: 0, videoUrl: null });

    await runBackfill();

    expect(await db.select().from(renderSegments)).toHaveLength(0);
    expect(await db.select().from(videoVariants)).toHaveLength(0);
    const [untouched] = await db
      .select()
      .from(shots)
      .where(eq(shots.id, shot.id));
    expect(untouched?.renderSegmentId).toBeNull();
  });
});

describe('#1067 phase-2a backfill — legacy segments with no selection', () => {
  it('points the segment at the variant whose url the shot serves', async () => {
    const { segmentId, liveVariantId } = await insertLegacySegment({
      shotOrderIndex: 0,
      liveUrl: 'https://r2/live.mp4',
      otherUrls: ['https://r2/alternate.mp4'],
    });

    await runBackfill();

    const [segment] = await db
      .select()
      .from(renderSegments)
      .where(eq(renderSegments.id, segmentId));
    expect(segment?.selectedVideoVersionId).toBe(liveVariantId);
  });

  it('ignores a discarded variant even when its url matches', async () => {
    const segmentId = generateId();
    const shot = await insertShot({
      orderIndex: 0,
      videoUrl: 'https://r2/live.mp4',
    });
    await db.insert(renderSegments).values({
      id: segmentId,
      sceneId: shot.sceneId ?? '',
      sequenceId,
      selectedVideoVersionId: null,
    });
    await db
      .update(shots)
      .set({ renderSegmentId: segmentId })
      .where(eq(shots.id, shot.id));
    await db.insert(videoVariants).values({
      renderSegmentId: segmentId,
      sequenceId,
      model: 'kling_v2_5_turbo_pro',
      manifest: [],
      url: 'https://r2/live.mp4',
      status: 'completed',
      discardedAt: new Date(),
    });

    await runBackfill();

    const [segment] = await db
      .select()
      .from(renderSegments)
      .where(eq(renderSegments.id, segmentId));
    expect(segment?.selectedVideoVersionId).toBeNull();
  });

  it('does not disturb a segment that already has a selection', async () => {
    const { segmentId, liveVariantId } = await insertLegacySegment({
      shotOrderIndex: 0,
      liveUrl: 'https://r2/live.mp4',
      otherUrls: ['https://r2/alternate.mp4'],
    });
    const [first] = await db
      .select()
      .from(videoVariants)
      .where(eq(videoVariants.renderSegmentId, segmentId));
    if (!first) throw new Error('test setup: expected a variant');
    await db
      .update(renderSegments)
      .set({ selectedVideoVersionId: first.id })
      .where(eq(renderSegments.id, segmentId));

    await runBackfill();

    const [segment] = await db
      .select()
      .from(renderSegments)
      .where(eq(renderSegments.id, segmentId));
    expect(segment?.selectedVideoVersionId).toBe(first.id);
    expect(segment?.selectedVideoVersionId).not.toBe(liveVariantId);
  });
});

describe('#1067 phase-2a backfill — replay safety', () => {
  it('is a no-op when run twice', async () => {
    await insertShot({ orderIndex: 0, videoUrl: 'https://r2/a.mp4' });
    await insertLegacySegment({
      shotOrderIndex: 1,
      liveUrl: 'https://r2/b.mp4',
    });

    await runBackfill();
    const segmentsAfterFirst = await db.select().from(renderSegments);
    const variantsAfterFirst = await db.select().from(videoVariants);

    await runBackfill();

    expect(await db.select().from(renderSegments)).toHaveLength(
      segmentsAfterFirst.length
    );
    expect(await db.select().from(videoVariants)).toHaveLength(
      variantsAfterFirst.length
    );
    expect(
      (await db.select().from(renderSegments)).map(
        (s) => s.selectedVideoVersionId
      )
    ).toEqual(segmentsAfterFirst.map((s) => s.selectedVideoVersionId));
  });

  it('leaves every shot that has a video with a resolvable selection', async () => {
    await insertShot({ orderIndex: 0, videoUrl: 'https://r2/a.mp4' });
    await insertShot({ orderIndex: 1, videoUrl: 'https://r2/b.mp4' });
    await insertLegacySegment({
      shotOrderIndex: 2,
      liveUrl: 'https://r2/c.mp4',
    });
    await insertShot({ orderIndex: 3, videoUrl: null });

    await runBackfill();

    // This is the condition phase 2d depends on: no shot with a video may be
    // left without a segment whose selection resolves to a variant with a url.
    const withVideo = await shotsWithLegacyVideo();
    expect(withVideo).toHaveLength(3);
    for (const shot of withVideo) {
      expect(shot.renderSegmentId).not.toBeNull();
      const [segment] = await db
        .select()
        .from(renderSegments)
        .where(eq(renderSegments.id, shot.renderSegmentId ?? ''));
      expect(segment?.selectedVideoVersionId).not.toBeNull();
      const [selected] = await db
        .select()
        .from(videoVariants)
        .where(eq(videoVariants.id, segment?.selectedVideoVersionId ?? ''));
      expect(selected?.url).toBe(shot.videoUrl);
    }
  });
});
