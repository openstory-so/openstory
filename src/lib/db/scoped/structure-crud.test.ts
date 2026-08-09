/**
 * Acceptance tests for structure CRUD (#1108 Phase 1): scene/shot soft-delete
 * with cascade + lossless restore, reorder over live rows with deleted rows
 * renumbered into the tail band, and re-analysis revival — in-memory libSQL
 * with the real migrations.
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import {
  frames,
  scenes,
  sequenceEvents,
  sequences,
  shots,
  styles,
  teams,
  user,
} from '@/lib/db/schema';
import type { SceneRow, Shot } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createScenesMethods } from './scenes';
import { createShotsMethods } from './shots';

let client: Client;
let db: Database;
let sequenceId = '';
let actorId = '';

async function seed() {
  await db.delete(sequenceEvents);
  await db.delete(frames);
  await db.delete(shots);
  await db.delete(scenes);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  const teamId = generateId();
  sequenceId = generateId();
  actorId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
  await db.insert(user).values({ id: actorId, name: 'U', email: 'u@e.com' });
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
  await db
    .insert(sequences)
    .values({ id: sequenceId, teamId, title: 'S', styleId: style.id });
}

/** A scene with `count` live shots (shotNumber 1..count). */
async function seedScene(
  orderIndex: number,
  shotCount = 1
): Promise<{ scene: SceneRow; sceneShots: Shot[] }> {
  const sceneMethods = createScenesMethods(db);
  const shotMethods = createShotsMethods(db);
  const scene = await sceneMethods.create({
    sequenceId,
    orderIndex,
    title: `Scene ${orderIndex}`,
  });
  const sceneShots: Shot[] = [];
  for (let n = 1; n <= shotCount; n++) {
    sceneShots.push(
      await shotMethods.create({ sequenceId, sceneId: scene.id, shotNumber: n })
    );
  }
  return { scene, sceneShots };
}

async function eventKinds(): Promise<string[]> {
  return (await db.select().from(sequenceEvents)).map((r) => r.kind);
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

describe('scene soft-delete cascade + restore', () => {
  it('hides the scene AND its live shots; restore brings back exactly those shots, even when a separate shot delete shares the same second', async () => {
    const sceneMethods = createScenesMethods(db);
    const shotMethods = createShotsMethods(db);
    const { scene, sceneShots } = await seedScene(0, 2);
    await seedScene(1, 1);

    // One shot was deleted SEPARATELY, immediately before the scene delete —
    // NO sleep. `deletedAt` is second-precision, so both writes land on the
    // identical stored value; the cascade set is resolved from the
    // `scene.deleted` event's recorded ids, not by comparing timestamps, so
    // this shot must NOT ride back on the scene restore.
    const [preDeleted, survivor] = sceneShots;
    if (!preDeleted || !survivor) throw new Error('setup');
    await shotMethods.softDelete(preDeleted.id, { actorId });

    const { deletedAt, shotIds } = await sceneMethods.softDeleteCascade(
      scene.id,
      { actorId }
    );
    // Only the live shot was cascaded.
    expect(shotIds).toEqual([survivor.id]);

    // Hidden from the default lists (editor, plans, export, theatre).
    expect(await sceneMethods.listBySequence(sequenceId)).toHaveLength(1);
    expect(await shotMethods.listBySequence(sequenceId)).toHaveLength(1);
    // Rows retained, same timestamp on scene + cascaded shot.
    const [sceneRow] = await db
      .select()
      .from(scenes)
      .where(eq(scenes.id, scene.id));
    const [shotRow] = await db
      .select()
      .from(shots)
      .where(eq(shots.id, survivor.id));
    // Integer timestamp columns round-trip at second precision — which is
    // exactly why the cascade set cannot be derived from them.
    const seconds = Math.floor(deletedAt.getTime() / 1000);
    expect(
      sceneRow?.deletedAt && Math.floor(sceneRow.deletedAt.getTime() / 1000)
    ).toBe(seconds);
    expect(
      shotRow?.deletedAt && Math.floor(shotRow.deletedAt.getTime() / 1000)
    ).toBe(seconds);
    expect(sceneRow?.deletedAt?.getTime()).toBe(shotRow?.deletedAt?.getTime());

    const restored = await sceneMethods.restoreCascade(scene.id, { actorId });
    expect(restored.deletedAt).toBeNull();
    const liveShots = await shotMethods.listBySequence(sequenceId);
    // The cascaded shot came back; the separately-deleted one stayed hidden.
    expect(liveShots.map((s) => s.id)).toContain(survivor.id);
    expect(liveShots.map((s) => s.id)).not.toContain(preDeleted.id);

    const kinds = await eventKinds();
    expect(kinds).toContain('scene.deleted');
    expect(kinds).toContain('scene.restored');
    expect(kinds).toContain('shot.deleted');
  });

  it('records prevState (orderIndex + shotIds) on the scene.deleted event', async () => {
    const sceneMethods = createScenesMethods(db);
    const { scene, sceneShots } = await seedScene(3, 1);
    await sceneMethods.softDeleteCascade(scene.id, { actorId });
    const [event] = await db
      .select()
      .from(sequenceEvents)
      .where(eq(sequenceEvents.kind, 'scene.deleted'));
    expect(event?.data).toEqual({
      prevState: { orderIndex: 3, title: 'Scene 3' },
      shotIds: sceneShots.map((s) => s.id),
    });
  });

  it('restoreCascade with restoreShots:false restores the scene only', async () => {
    const sceneMethods = createScenesMethods(db);
    const shotMethods = createShotsMethods(db);
    const { scene } = await seedScene(0, 1);
    await sceneMethods.softDeleteCascade(scene.id, { actorId });
    await sceneMethods.restoreCascade(scene.id, {
      actorId,
      restoreShots: false,
    });
    expect(await sceneMethods.listBySequence(sequenceId)).toHaveLength(1);
    expect(await shotMethods.listBySequence(sequenceId)).toHaveLength(0);
  });

  it('refuses to restore a shot while its scene is deleted', async () => {
    const sceneMethods = createScenesMethods(db);
    const shotMethods = createShotsMethods(db);
    const { scene, sceneShots } = await seedScene(0, 1);
    await sceneMethods.softDeleteCascade(scene.id, { actorId });
    const [shot] = sceneShots;
    if (!shot) throw new Error('setup');
    await expect(shotMethods.restore(shot.id, { actorId })).rejects.toThrow(
      /restore the scene instead/
    );
  });
});

describe('reorder over live rows (deleted rows renumbered into the tail band)', () => {
  it('scenes: live rows get 0..n-1 in the requested order; deleted rows follow', async () => {
    const sceneMethods = createScenesMethods(db);
    const a = (await seedScene(0, 0)).scene;
    const b = (await seedScene(1, 0)).scene;
    const c = (await seedScene(2, 0)).scene;
    await sceneMethods.softDeleteCascade(b.id, { actorId });

    await sceneMethods.reorder(sequenceId, [c.id, a.id], { actorId });

    const rows = await db
      .select({ id: scenes.id, orderIndex: scenes.orderIndex })
      .from(scenes)
      .where(eq(scenes.sequenceId, sequenceId));
    const byId = new Map(rows.map((r) => [r.id, r.orderIndex]));
    expect(byId.get(c.id)).toBe(0);
    expect(byId.get(a.id)).toBe(1);
    expect(byId.get(b.id)).toBe(2);

    // Live listing reflects the new order; the deleted scene stays hidden.
    const live = await sceneMethods.listBySequence(sequenceId);
    expect(live.map((s) => s.id)).toEqual([c.id, a.id]);
    expect(await eventKinds()).toContain('scenes.reordered');
  });

  it('scenes: rejects an order that is not exactly the live set', async () => {
    const sceneMethods = createScenesMethods(db);
    const a = (await seedScene(0, 0)).scene;
    await seedScene(1, 0);
    await expect(
      sceneMethods.reorder(sequenceId, [a.id], { actorId })
    ).rejects.toThrow(/every live scene/);
  });

  it('shots: live rows get 1..n; a deleted sibling is renumbered after them', async () => {
    const shotMethods = createShotsMethods(db);
    const { sceneShots, scene } = await seedScene(0, 3);
    const [s1, s2, s3] = sceneShots;
    if (!s1 || !s2 || !s3) throw new Error('setup');
    await shotMethods.softDelete(s2.id, { actorId });

    await shotMethods.reorderInScene(scene.id, [s3.id, s1.id], { actorId });

    const rows = await db
      .select({ id: shots.id, shotNumber: shots.shotNumber })
      .from(shots)
      .where(eq(shots.sceneId, scene.id));
    const byId = new Map(rows.map((r) => [r.id, r.shotNumber]));
    expect(byId.get(s3.id)).toBe(1);
    expect(byId.get(s1.id)).toBe(2);
    expect(byId.get(s2.id)).toBe(3);
    expect(await eventKinds()).toContain('shots.reordered');
  });
});

describe('re-analysis revival + shot soft-delete details', () => {
  it('scenes.upsert on a deleted row’s orderIndex slot revives it', async () => {
    const sceneMethods = createScenesMethods(db);
    const { scene } = await seedScene(0, 0);
    await sceneMethods.softDeleteCascade(scene.id, { actorId });
    await sceneMethods.upsert({
      sequenceId,
      orderIndex: 0,
      title: 'Re-split scene',
    });
    const live = await sceneMethods.listBySequence(sequenceId);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(scene.id);
    expect(live[0]?.title).toBe('Re-split scene');
  });

  it('shots.upsert on a deleted (sceneId, shotNumber) slot revives it', async () => {
    const shotMethods = createShotsMethods(db);
    const { scene, sceneShots } = await seedScene(0, 1);
    const [shot] = sceneShots;
    if (!shot) throw new Error('setup');
    await shotMethods.softDelete(shot.id, { actorId });
    await shotMethods.upsert({
      sequenceId,
      sceneId: scene.id,
      shotNumber: 1,
    });
    const live = await shotMethods.listBySequence(sequenceId);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(shot.id);
    expect(live[0]?.deletedAt).toBeNull();
  });

  it('shot softDelete is idempotent, keeps its shotNumber slot, and records prevState', async () => {
    const shotMethods = createShotsMethods(db);
    const { scene, sceneShots } = await seedScene(0, 1);
    const [shot] = sceneShots;
    if (!shot) throw new Error('setup');

    const deletedAt = await shotMethods.softDelete(shot.id, { actorId });
    const repeat = await shotMethods.softDelete(shot.id, { actorId });
    expect(Math.floor(repeat.getTime() / 1000)).toBe(
      Math.floor(deletedAt.getTime() / 1000)
    );

    const [row] = await db.select().from(shots).where(eq(shots.id, shot.id));
    expect(row?.shotNumber).toBe(1);

    const [event] = await db
      .select()
      .from(sequenceEvents)
      .where(eq(sequenceEvents.kind, 'shot.deleted'));
    expect(event?.data).toEqual({
      prevState: { sceneId: scene.id, shotNumber: 1 },
    });

    const restored = await shotMethods.restore(shot.id, { actorId });
    expect(restored.deletedAt).toBeNull();
    expect(restored.shotNumber).toBe(1);
  });
});
