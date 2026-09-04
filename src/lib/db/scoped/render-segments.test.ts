/**
 * Behavioural tests for the scoped `render_segments` layer (#990) against a real
 * migrated in-memory D1 (libsql), mirroring the `video-variants.test.ts`
 * harness. Pins `ensureForShot` — the lazy materialization of the degenerate
 * per-shot render segment whose Cloudflare-step-retry idempotency the motion
 * workflow depends on: first-use creation + shot link, the existing-segment
 * short-circuit, the stale-pointer repoint, and the no-scene throw.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/shared/id';
import type { Database } from '@/lib/db/client';
import {
  dbSceneId,
  renderSegments,
  scenes,
  sequences,
  shots,
  styles,
  teams,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { createRenderSegmentsMethods } from './render-segments';

let client: Client;
let db: Database;
let methods: ReturnType<typeof createRenderSegmentsMethods>;

let sequenceId = '';
let sceneId = '';
let shotId = '';

async function seed() {
  await db.delete(shots);
  await db.delete(renderSegments);
  await db.delete(scenes);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);

  const teamId = generateId();
  sequenceId = generateId();
  sceneId = generateId();
  shotId = generateId();

  await db.insert(teams).values([{ id: teamId, name: 'T', slug: 't' }]);
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
    .values([{ id: sequenceId, teamId, title: 'S', styleId: style.id }]);
  await db
    .insert(scenes)
    .values([{ id: dbSceneId(sceneId), sequenceId, orderIndex: 0 }]);
  await db.insert(shots).values([
    {
      id: shotId,
      sequenceId,
      sceneId,
      shotNumber: 1,
      renderSegmentId: null,
    },
  ]);
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  methods = createRenderSegmentsMethods(db);
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
});

describe('ensureForShot', () => {
  it('materializes the degenerate segment (id == shotId) and links the shot', async () => {
    const segmentId = await methods.ensureForShot({
      id: shotId,
      sceneId,
      sequenceId,
      renderSegmentId: null,
    });

    // The degenerate per-shot segment reuses the shot's id.
    expect(segmentId).toBe(shotId);
    const segment = await methods.getById(segmentId);
    expect(segment).toMatchObject({ id: shotId, sceneId, sequenceId });

    // The shot now points at it.
    const [shot] = await db
      .select({ renderSegmentId: shots.renderSegmentId })
      .from(shots)
      .where(eq(shots.id, shotId));
    expect(shot?.renderSegmentId).toBe(shotId);
  });

  it('is idempotent — re-running creates no duplicate segment', async () => {
    await methods.ensureForShot({
      id: shotId,
      sceneId,
      sequenceId,
      renderSegmentId: null,
    });
    await methods.ensureForShot({
      id: shotId,
      sceneId,
      sequenceId,
      renderSegmentId: null,
    });

    const all = await db.select().from(renderSegments);
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(shotId);
  });

  it('short-circuits to an existing segment without creating a per-shot one', async () => {
    // A shared (multi-shot, #910) segment with its own id the shot already
    // belongs to — ensureForShot must return it, not mint a shot-id segment.
    const sharedId = generateId();
    await db
      .insert(renderSegments)
      .values([{ id: sharedId, sceneId, sequenceId }]);

    const resolved = await methods.ensureForShot({
      id: shotId,
      sceneId,
      sequenceId,
      renderSegmentId: sharedId,
    });

    expect(resolved).toBe(sharedId);
    const all = await db.select().from(renderSegments);
    expect(all.map((s) => s.id)).toEqual([sharedId]);
  });

  it('repoints a shot whose pointer is stale (segment no longer exists)', async () => {
    const resolved = await methods.ensureForShot({
      id: shotId,
      sceneId,
      sequenceId,
      renderSegmentId: 'gone-segment',
    });

    // Falls through to the degenerate segment and repoints the shot to it.
    expect(resolved).toBe(shotId);
    const [shot] = await db
      .select({ renderSegmentId: shots.renderSegmentId })
      .from(shots)
      .where(eq(shots.id, shotId));
    expect(shot?.renderSegmentId).toBe(shotId);
  });

  it('throws when the shot has no scene', async () => {
    await expect(
      methods.ensureForShot({
        id: shotId,
        sceneId: null,
        sequenceId,
        renderSegmentId: null,
      })
    ).rejects.toThrow(/no scene/i);
  });
});
