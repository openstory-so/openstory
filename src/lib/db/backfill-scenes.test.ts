/**
 * In-memory DB tests for the #907 scenes backfill.
 *
 * The backfill is a data migration (INSERT … SELECT + UPDATE) that ships inside
 * the `…_jazzy_whiplash` migration. Because migrations run against an empty DB
 * at setup, the in-migration backfill no-ops there — so these tests seed shots
 * AFTER migrating, then execute the migration's own backfill statements (read
 * verbatim from the shipped SQL file) and assert the result. Reading the real
 * SQL keeps the test honest: it exercises exactly what runs in prod.
 *
 * The last test guards the milestone's #1 QA risk: the backfill must write only
 * sceneId + shotNumber and perturb nothing else on the shot. It asserted that
 * through `shots.isStale`/`video_input_hash` until #1067 phase 2d dropped both.
 *
 * #1067 also dropped `shots.metadata`, the backfill's own input, and
 * `scenes.original_script`, one of its outputs. The migrated DB therefore no
 * longer has columns the shipped SQL names, so the harness re-adds whichever
 * are missing — the migration file itself is history and stays verbatim.
 */

import {
  musicDesignSchema,
  originalScriptSchema,
  type Scene,
} from '@/lib/ai/scene-analysis.schema';
import type { Database } from '@/lib/db/client';
import { generateId } from '@/shared/id';
import type { NewShot } from '@/lib/db/schema';
import {
  dbSceneId,
  scenes,
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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = './drizzle/migrations';

let client: Client;
let db: Database;
let teamId = '';
let sequenceId = '';

/**
 * Pull the backfill statements straight out of the shipped migration SQL so the
 * test runs the exact DML that prod applies. Finds the migration that contains
 * the `INSERT INTO scenes … SELECT … FROM shots` backfill, splits on drizzle's
 * statement breakpoint, and returns just the INSERT + UPDATE.
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
    if (!sql.includes('INSERT INTO `scenes`')) continue;
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
          s.startsWith('INSERT INTO `scenes`') ||
          s.startsWith('UPDATE `shots` SET `scene_id`')
      );
  }
  throw new Error('test setup: backfill migration not found');
}

const BACKFILL_STATEMENTS = readBackfillStatements();

// Fail loud if the parser extracted the wrong number of statements (e.g. a
// future db:generate reformat that the startsWith filters no longer match).
// Without this, a partial match — INSERT found but UPDATE missed — would let
// the scene-only assertions pass while shot-linking goes untested.
if (BACKFILL_STATEMENTS.length !== 2) {
  throw new Error(
    `test setup: expected 2 backfill statements (INSERT scenes + UPDATE shots), got ${BACKFILL_STATEMENTS.length} — migration SQL format likely changed`
  );
}

/** Raw read of the dropped `scenes.original_script` — drizzle no longer maps it. */
async function readSceneOriginalScript(sceneId: string) {
  const { rows } = await client.execute({
    sql: 'SELECT `original_script` AS script FROM `scenes` WHERE `id` = ?',
    args: [sceneId],
  });
  const value = rows[0]?.script;
  return typeof value === 'string'
    ? originalScriptSchema.parse(JSON.parse(value))
    : null;
}

async function readSceneMusicDesign(sceneId: string) {
  const { rows } = await client.execute({
    sql: 'SELECT `music_design` AS design FROM `scenes` WHERE `id` = ?',
    args: [sceneId],
  });
  const value = rows[0]?.design;
  return typeof value === 'string'
    ? musicDesignSchema.parse(JSON.parse(value))
    : null;
}

async function runBackfill(): Promise<void> {
  for (const stmt of BACKFILL_STATEMENTS) {
    await client.execute(stmt);
  }
}

function sceneFixture(overrides: Partial<Scene> = {}): Scene {
  return {
    sceneId: 'scene-1',
    sceneNumber: 1,
    originalScript: { extract: 'INT. OFFICE - DAY', dialogue: [] },
    metadata: {
      title: 'The meeting',
      durationSeconds: 5,
      location: 'INT. OFFICE - DAY',
      timeOfDay: 'day',
      storyBeat: 'Setup',
    },
    continuity: {
      characterTags: ['sarah'],
      environmentTag: 'office',
      elementTags: [],
      colorPalette: 'cool blues',
      lightingSetup: 'overhead fluorescent',
      styleTag: 'corporate',
    },
    musicDesign: {
      presence: 'minimal',
      style: 'ambient',
      mood: 'tense',
      atmosphere: 'office hum',
    },
    ...overrides,
  };
}

async function seedSequence(): Promise<void> {
  teamId = generateId();
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

async function insertShot(
  { orderIndex, ...data }: Partial<NewShot> & { orderIndex: number },
  metadata: Scene | null = null
) {
  const [shot] = await db
    .insert(shots)
    .values({ sequenceId, ...data } satisfies NewShot)
    .returning();
  if (!shot) throw new Error('test setup: shot insert returned nothing');
  await client.execute({
    sql: 'UPDATE `shots` SET `metadata` = ?, `order_index` = ? WHERE `id` = ?',
    args: [metadata ? JSON.stringify(metadata) : null, orderIndex, shot.id],
  });
  return { ...shot, orderIndex };
}

/** Re-add a column the shipped SQL names but the current schema dropped. */
async function restoreDroppedColumn(
  table: string,
  column: string,
  type: string
): Promise<void> {
  const info = await client.execute(`PRAGMA table_info(\`${table}\`)`);
  if (info.rows.some((row) => row.name === column)) return;
  await client.execute(
    `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`
  );
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await restoreDroppedColumn('shots', 'metadata', 'text');
  await restoreDroppedColumn('shots', 'order_index', 'integer');
  await restoreDroppedColumn('scenes', 'original_script', 'text');
  await restoreDroppedColumn('scenes', 'music_design', 'text');
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.delete(shots);
  await db.delete(scenes);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await seedSequence();
});

describe('backfill scenes migration', () => {
  it('creates one scene per shot, reusing the shot id, linked with shotNumber=1', async () => {
    const a = await insertShot({ orderIndex: 0 }, sceneFixture());
    const b = await insertShot(
      { orderIndex: 1 },
      sceneFixture({ sceneId: 'scene-2', sceneNumber: 2 })
    );

    await runBackfill();

    const allScenes = await db.select().from(scenes);
    expect(allScenes).toHaveLength(2);

    const rereadById = new Map(
      (await db.select().from(shots)).map((s) => [s.id, s])
    );
    for (const shot of [a, b]) {
      const reread = rereadById.get(shot.id);
      // The scene REUSES the shot's ULID — the 1:1 expand rule.
      expect(reread?.sceneId).toBe(shot.id);
      expect(reread?.shotNumber).toBe(1);
      const scene = allScenes.find((s) => s.id === shot.id);
      expect(scene?.orderIndex).toBe(shot.orderIndex);
    }
    // Explicit id-reuse assertion against the known shots.
    expect(allScenes.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('splits scene-level fields out of the shot metadata onto the scene row', async () => {
    const shot = await insertShot({ orderIndex: 3 }, sceneFixture());
    await runBackfill();

    const [scene] = await db
      .select()
      .from(scenes)
      // The scene reuses the shot's ULID (1:1 backfill), so the shot id doubles
      // as the scene's branded id — convert it explicitly at this boundary.
      .where(eq(scenes.id, dbSceneId(shot.id)));
    expect(scene?.orderIndex).toBe(3);
    expect(scene?.location).toBe('INT. OFFICE - DAY');
    expect(scene?.timeOfDay).toBe('day');
    expect(scene?.storyBeat).toBe('Setup');
    expect(scene?.title).toBe('The meeting');
    // JSON subtrees survive the json_extract round-trip with their shape intact.
    expect(scene?.continuity?.environmentTag).toBe('office');
    expect(scene?.continuity?.characterTags).toEqual(['sarah']);
    expect((await readSceneMusicDesign(shot.id))?.presence).toBe('minimal');
    expect((await readSceneOriginalScript(shot.id))?.extract).toBe(
      'INT. OFFICE - DAY'
    );
    // Dropped: the "shot metadata survives the backfill" assertion — #1067
    // removed the column entirely.
  });

  it('backfills a null-metadata shot without crashing (null scene fields)', async () => {
    const shot = await insertShot({ orderIndex: 0 });
    await runBackfill();

    const [scene] = await db.select().from(scenes);
    expect(scene?.id).toBe(shot.id);
    expect(scene?.location).toBeNull();
    expect(scene?.title).toBeNull();
    expect(scene?.continuity).toBeNull();
    expect(await readSceneMusicDesign(shot.id)).toBeNull();
    expect(await readSceneOriginalScript(shot.id)).toBeNull();

    const [reread] = await db.select().from(shots).where(eq(shots.id, shot.id));
    expect(reread?.sceneId).toBe(shot.id);
    expect(reread?.shotNumber).toBe(1);
  });

  it('is idempotent: a second run creates no duplicate scenes', async () => {
    await insertShot({ orderIndex: 0 }, sceneFixture());
    await insertShot({ orderIndex: 1 }, sceneFixture({ sceneId: 'scene-2' }));

    await runBackfill();
    expect(await db.select().from(scenes)).toHaveLength(2);

    // Second run: every shot already has a scene_id, so WHERE scene_id IS NULL
    // matches nothing — no new scenes, no constraint violation.
    await runBackfill();
    expect(await db.select().from(scenes)).toHaveLength(2);
    const allShots = await db.select().from(shots);
    expect(allShots.every((s) => s.sceneId === s.id)).toBe(true);
  });

  it('leaves the shot’s other columns untouched', async () => {
    // The backfill writes only sceneId + shotNumber. This pinned the video and
    // motion-prompt mirrors until #1067 dropped them (video state derives from
    // the segment's `video_variants`, the motion prompt from the selected
    // `shot_prompt_versions` row); the surviving columns carry the same
    // guarantee.
    const selectedMotionPromptVersionId = generateId();
    const shot = await insertShot(
      {
        orderIndex: 0,
        durationMs: 4200,
        selectedMotionPromptVersionId,
      },
      sceneFixture()
    );

    await runBackfill();

    const [reread] = await db.select().from(shots).where(eq(shots.id, shot.id));
    expect(reread?.selectedMotionPromptVersionId).toBe(
      selectedMotionPromptVersionId
    );
    expect(reread?.durationMs).toBe(4200);
  });
});
