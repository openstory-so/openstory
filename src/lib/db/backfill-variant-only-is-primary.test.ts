/**
 * In-memory DB tests for the #1067 `is_primary` demotion backfill.
 *
 * `20260805074838_happy_richard_fisk` added `video_variants.is_primary` with
 * `DEFAULT true`, so every pre-existing row — including added-model
 * (`variantOnly`, #547) renders — became "primary". Since `toShotView` derives a
 * shot's video lifecycle from its newest primary version, a failed added-model
 * experiment would hide a perfectly good selected video behind a failure banner.
 *
 * Migrations run against an empty DB, so the backfill no-ops at setup — these
 * tests seed the legacy shape AFTER migrating, then execute the migration's own
 * SQL (read verbatim from the shipped file) and assert what it did and, just as
 * importantly, what it left alone.
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/shared/id';
import {
  dbSceneId,
  renderSegments,
  scenes,
  sequences,
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

// Read by explicit path: a scan would match an earlier backfill first.
const MIGRATION_SQL =
  './drizzle/migrations/20260806180000_backfill_variant_only_is_primary/migration.sql';

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

// Pinned so a silent re-shape of the migration file fails loudly here rather
// than quietly running a different backfill than the one under test.
if (STATEMENTS.length !== 1) {
  throw new Error(
    `expected 1 backfill statement (UPDATE is_primary), got ${STATEMENTS.length}`
  );
}

let client: Client;
let db: Database;
let sequenceId = '';
let segmentId = '';

async function runBackfill(): Promise<void> {
  for (const stmt of STATEMENTS) await client.execute(stmt);
}

async function seed() {
  await db.delete(videoVariants);
  await db.delete(renderSegments);
  await db.delete(scenes);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);

  const teamId = generateId();
  sequenceId = generateId();
  segmentId = generateId();
  const sceneId = generateId();
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
  await db
    .insert(scenes)
    .values({ id: dbSceneId(sceneId), sequenceId, orderIndex: 0 });
  await db
    .insert(renderSegments)
    .values({ id: segmentId, sceneId, sequenceId });
}

async function insertVersion(values: {
  model: string;
  status: 'completed' | 'failed' | 'generating' | 'pending';
  url?: string | null;
}) {
  const [version] = await db
    .insert(videoVariants)
    .values({
      renderSegmentId: segmentId,
      sequenceId,
      model: values.model,
      manifest: [],
      status: values.status,
      url: values.url ?? null,
      // The legacy shape this backfill exists to correct.
      isPrimary: true,
    })
    .returning();
  if (!version) throw new Error('insertVersion returned nothing');
  return version;
}

async function selectVersion(versionId: string) {
  await db
    .update(renderSegments)
    .set({ selectedVideoVersionId: versionId })
    .where(eq(renderSegments.id, segmentId));
}

async function isPrimaryOf(versionId: string): Promise<boolean> {
  const [row] = await db
    .select()
    .from(videoVariants)
    .where(eq(videoVariants.id, versionId));
  if (!row) throw new Error(`version ${versionId} not found`);
  return row.isPrimary;
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
});

describe('backfill variant-only is_primary (#1067)', () => {
  it('demotes a failed added-model render sitting behind a good selection', async () => {
    const good = await insertVersion({
      model: 'veo3',
      status: 'completed',
      url: 'https://r2/good.mp4',
    });
    await selectVersion(good.id);
    const addedModelFailure = await insertVersion({
      model: 'kling',
      status: 'failed',
    });

    await runBackfill();

    // This is the whole point: the shot keeps reading 'completed' off the
    // selection instead of inheriting another model's failure.
    expect(await isPrimaryOf(addedModelFailure.id)).toBe(false);
    expect(await isPrimaryOf(good.id)).toBe(true);
  });

  it('leaves a failed re-roll of the SAME model primary', async () => {
    const good = await insertVersion({
      model: 'veo3',
      status: 'completed',
      url: 'https://r2/good.mp4',
    });
    await selectVersion(good.id);
    const sameModelRetry = await insertVersion({
      model: 'veo3',
      status: 'failed',
    });

    await runBackfill();

    // Re-rolling the primary model over a good video SHOULD surface as failed —
    // that is the #1067 design, not the bug being corrected.
    expect(await isPrimaryOf(sameModelRetry.id)).toBe(true);
  });

  it('leaves a failure alone when the segment has no selection', async () => {
    const onlyAttempt = await insertVersion({
      model: 'veo3',
      status: 'failed',
    });

    await runBackfill();

    // No playable video to hide, so 'failed' is the honest status.
    expect(await isPrimaryOf(onlyAttempt.id)).toBe(true);
  });

  it('leaves completed added-model renders alone', async () => {
    const good = await insertVersion({
      model: 'veo3',
      status: 'completed',
      url: 'https://r2/good.mp4',
    });
    await selectVersion(good.id);
    const addedModelOk = await insertVersion({
      model: 'kling',
      status: 'completed',
      url: 'https://r2/alt.mp4',
    });

    await runBackfill();

    // Not selected and not failed — it changes no status either way, so the
    // backfill has no business touching it.
    expect(await isPrimaryOf(addedModelOk.id)).toBe(true);
  });

  it('is idempotent', async () => {
    const good = await insertVersion({
      model: 'veo3',
      status: 'completed',
      url: 'https://r2/good.mp4',
    });
    await selectVersion(good.id);
    const addedModelFailure = await insertVersion({
      model: 'kling',
      status: 'failed',
    });

    await runBackfill();
    await runBackfill();

    expect(await isPrimaryOf(addedModelFailure.id)).toBe(false);
    expect(await isPrimaryOf(good.id)).toBe(true);
  });
});
