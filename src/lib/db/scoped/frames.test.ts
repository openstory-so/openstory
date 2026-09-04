/**
 * Acceptance tests for the frames helper. In-memory libSQL with the real
 * migrations. Covers upsert idempotency (workflow-replay safety), isStale
 * null-hash semantics, resolveCurrent, and that the generic `update` path does
 * not move the selection pointer / mirror columns (drift prevention — those
 * live on `frameVariants.select` / `framePromptVersions`).
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
  user,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createFramesMethods } from './frames';

let client: Client;
let db: Database;
let sequenceId = '';
let shotId = '';

async function seed() {
  await db.delete(frameVariants);
  await db.delete(frames);
  await db.delete(shots);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  const teamId = generateId();
  sequenceId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
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
  const [shot] = await db
    .insert(shots)
    .values({ sequenceId, shotNumber: 1 })
    .returning();
  if (!shot) throw new Error('test setup: shot insert returned nothing');
  shotId = shot.id;
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

describe('frames.upsert', () => {
  it('is idempotent on (shotId, orderIndex) — a replay updates in place', async () => {
    const m = createFramesMethods(db);
    const first = await m.upsert({
      shotId,
      sequenceId,
      orderIndex: 0,
      role: 'first',
    });
    const replay = await m.upsert({
      shotId,
      sequenceId,
      orderIndex: 0,
      role: 'first',
    });
    expect(replay.id).toBe(first.id);
    expect(await m.listByShot(shotId)).toHaveLength(1);
  });
});

describe('frames.update', () => {
  it('updates non-mirror fields without disturbing the selection pointer', async () => {
    const m = createFramesMethods(db);
    const frame = await m.create({
      shotId,
      sequenceId,
      orderIndex: 0,
      role: 'first',
    });
    // Seed the pointer + the frame-owned lifecycle as the select path would.
    await db
      .update(frames)
      .set({
        selectedImageVersionId: 'ver-1',
        imageStatus: 'completed',
      })
      .where(eq(frames.id, frame.id));

    await m.update(frame.id, { orderIndex: 2, role: 'key' });

    const [refreshed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frame.id));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.orderIndex).toBe(2);
    expect(refreshed.role).toBe('key');
    // Selection-owned columns untouched.
    expect(refreshed.selectedImageVersionId).toBe('ver-1');
    expect(refreshed.imageStatus).toBe('completed');
  });

  it('throws on a missing frame by default, returns undefined when opted out', async () => {
    const m = createFramesMethods(db);
    await expect(m.update(generateId(), { orderIndex: 1 })).rejects.toThrow(
      /not found/
    );
    expect(
      await m.update(generateId(), { orderIndex: 1 }, { throwOnMissing: false })
    ).toBeUndefined();
  });
});

describe('frames.resolveCurrent', () => {
  it('returns the frame with a null selectedVersion when unselected', async () => {
    const m = createFramesMethods(db);
    const frame = await m.create({
      shotId,
      sequenceId,
      orderIndex: 0,
      role: 'first',
    });
    const resolved = await m.resolveCurrent(frame.id);
    expect(resolved?.frame.id).toBe(frame.id);
    expect(resolved?.selectedVersion).toBeNull();
  });

  it('returns null for a missing frame', async () => {
    const m = createFramesMethods(db);
    expect(await m.resolveCurrent(generateId())).toBeNull();
  });

  it('resolves the pointed-at version', async () => {
    const m = createFramesMethods(db);
    const frame = await m.create({
      shotId,
      sequenceId,
      orderIndex: 0,
      role: 'first',
    });
    const [version] = await db
      .insert(frameVariants)
      .values({
        frameId: frame.id,
        sequenceId,
        kind: 'model',
        model: 'm1',
        status: 'completed',
      })
      .returning();
    if (!version)
      throw new Error('test setup: version insert returned nothing');
    await db
      .update(frames)
      .set({ selectedImageVersionId: version.id })
      .where(eq(frames.id, frame.id));

    const resolved = await m.resolveCurrent(frame.id);
    expect(resolved?.selectedVersion?.id).toBe(version.id);
  });
});

describe('frames.isStale', () => {
  it('throws when the frame does not exist', () => {
    const m = createFramesMethods(db);
    expect(m.isStale(generateId(), 'h')).rejects.toThrow(/not found/);
  });

  it('null stored hash → not stale; match → not stale; differ → stale', async () => {
    const m = createFramesMethods(db);
    const a = await m.create({ shotId, sequenceId, orderIndex: 0 });
    // No selected version at all → no opinion, so not stale.
    expect(await m.isStale(a.id, 'anything')).toBe(false);

    // The hash lives on the SELECTED version now (#1067), not the frame.
    const versionId = generateId();
    await db.insert(frameVariants).values({
      id: versionId,
      frameId: a.id,
      sequenceId,
      kind: 'model',
      model: 'm1',
      status: 'completed',
      inputHash: 'h-match',
    });
    await db
      .update(frames)
      .set({ selectedImageVersionId: versionId })
      .where(eq(frames.id, a.id));
    expect(await m.isStale(a.id, 'h-match')).toBe(false);
    expect(await m.isStale(a.id, 'h-new')).toBe(true);
  });
});

describe('frames.setPendingPromoteVersionId (#1101)', () => {
  it('refuses to claim auto-promote for a preview version', async () => {
    const m = createFramesMethods(db);
    const frame = await m.create({
      shotId,
      sequenceId,
      orderIndex: 0,
      role: 'first',
    });
    const [preview] = await db
      .insert(frameVariants)
      .values({
        frameId: frame.id,
        sequenceId,
        kind: 'preview',
        model: 'flux_2_turbo',
        url: 'https://fal.media/preview.png',
        status: 'completed',
      })
      .returning();
    if (!preview)
      throw new Error('test setup: preview insert returned nothing');

    // Promotion is unattended: without this guard a mis-pointed claim would
    // surface as a workflow failure minutes later instead of at the mistake.
    await expect(
      m.setPendingPromoteVersionId(frame.id, preview.id)
    ).rejects.toThrow(/preview/);

    const [refreshed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frame.id));
    expect(refreshed?.pendingPromoteVersionId).toBeNull();
  });

  it('still claims for a model version, and clears on null', async () => {
    const m = createFramesMethods(db);
    const frame = await m.create({
      shotId,
      sequenceId,
      orderIndex: 0,
      role: 'first',
    });
    const [version] = await db
      .insert(frameVariants)
      .values({
        frameId: frame.id,
        sequenceId,
        kind: 'model',
        model: 'nano_banana_2',
        status: 'generating',
      })
      .returning();
    if (!version)
      throw new Error('test setup: version insert returned nothing');

    await m.setPendingPromoteVersionId(frame.id, version.id);
    const [claimed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frame.id));
    expect(claimed?.pendingPromoteVersionId).toBe(version.id);

    await m.setPendingPromoteVersionId(frame.id, null);
    const [cleared] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frame.id));
    expect(cleared?.pendingPromoteVersionId).toBeNull();
  });
});

describe('frames.getByIds (#1322)', () => {
  it("chunks the id list under D1's 100-param ceiling and returns every row", async () => {
    // libsql has no bound-param cap, so a single IN(…) would pass here and
    // throw `too many SQL variables` on D1 — assert the fan-out directly.
    const m = createFramesMethods(db);
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      const id = generateId();
      ids.push(id);
      await db
        .insert(frames)
        .values({ id, shotId, sequenceId, orderIndex: i, role: 'first' });
    }
    const select = vi.spyOn(db, 'select');
    const rows = await m.getByIds(ids);
    expect(rows).toHaveLength(200);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(ids));
    expect(select).toHaveBeenCalledTimes(3);
    select.mockRestore();
  });
});
