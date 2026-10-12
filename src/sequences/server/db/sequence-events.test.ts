/**
 * Acceptance tests for the sequence-events helper (append-only activity log).
 * In-memory libSQL with the real migrations. Covers record persistence,
 * buildEventInsert composing into a caller's batch (atomic with its mutation),
 * and the timeline / by-target read ordering (newest-first, ULID order).
 */

import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import {
  frames,
  sequenceEvents,
  sequences,
  shots,
  styles,
  teams,
  user,
} from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSequencesMethods } from './sequences';
import {
  SETTINGS_CHANGED_LABELS,
  buildEventInsert,
  buildEventInsertOnce,
  createSequenceEventsMethods,
} from './sequence-events';

let client: Client;
let db: Database;
let sequenceId = '';
let shotId = '';
let teamId = '';
let userId = '';

async function seed() {
  await db.delete(sequenceEvents);
  await db.delete(frames);
  await db.delete(shots);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  teamId = generateId();
  userId = generateId();
  sequenceId = generateId();
  await db.insert(user).values({
    id: userId,
    name: 'Ada',
    email: `${userId}@example.com`,
  });
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

describe('sequenceEvents.record', () => {
  it('persists a standalone event with its data payload', async () => {
    const m = createSequenceEventsMethods(db);
    const row = await m.record({
      sequenceId,
      actorId: null,
      kind: 'shot.added',
      targetType: 'shot',
      targetId: shotId,
      summary: 'Added a shot',
      data: { orderIndex: 0 },
    });
    expect(row.kind).toBe('shot.added');
    expect(row.summary).toBe('Added a shot');
    expect(row.data).toMatchObject({ orderIndex: 0 });
  });
});

describe('buildEventInsert', () => {
  it('composes into a caller batch so the mutation and its event are atomic', async () => {
    const m = createSequenceEventsMethods(db);
    await db.batch([
      db.update(shots).set({ shotNumber: 5 }).where(eq(shots.id, shotId)),
      buildEventInsert(db, {
        sequenceId,
        actorId: null,
        kind: 'shots.reordered',
        targetType: 'shot',
        targetId: shotId,
        data: { to: 5 },
      }),
    ]);

    const [shot] = await db.select().from(shots).where(eq(shots.id, shotId));
    if (!shot) throw new Error('test setup: refresh failed');
    expect(shot.shotNumber).toBe(5);
    const events = await m.listByTarget('shot', shotId);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('shots.reordered');
  });
});

describe('sequenceEvents reads', () => {
  it('listBySequence returns the timeline newest-first', async () => {
    const m = createSequenceEventsMethods(db);
    await m.record({
      sequenceId,
      actorId: null,
      kind: 'a.first',
      targetType: 'sequence',
      targetId: sequenceId,
    });
    await m.record({
      sequenceId,
      actorId: null,
      kind: 'b.second',
      targetType: 'sequence',
      targetId: sequenceId,
    });
    const timeline = await m.listBySequence(sequenceId);
    expect(timeline.map((e) => e.kind)).toEqual(['b.second', 'a.first']);
    expect(await m.listBySequence(sequenceId, { limit: 1 })).toHaveLength(1);
  });

  it('listByTarget filters by (targetType, targetId)', async () => {
    const m = createSequenceEventsMethods(db);
    await m.record({
      sequenceId,
      actorId: null,
      kind: 'shot.added',
      targetType: 'shot',
      targetId: shotId,
    });
    await m.record({
      sequenceId,
      actorId: null,
      kind: 'sequence.touched',
      targetType: 'sequence',
      targetId: sequenceId,
    });
    const shotEvents = await m.listByTarget('shot', shotId);
    expect(shotEvents).toHaveLength(1);
    expect(shotEvents[0]?.targetType).toBe('shot');
  });
});

describe('listHistory', () => {
  it('pages newest-first and drops the link when the shot is deleted', async () => {
    const m = createSequenceEventsMethods(db);
    await m.record({
      sequenceId,
      actorId: null,
      kind: 'a.first',
      targetType: 'sequence',
      targetId: sequenceId,
      summary: 'First',
    });
    await m.record({
      sequenceId,
      actorId: userId,
      kind: 'b.second',
      targetType: 'shot',
      targetId: shotId,
      summary: 'Second',
    });
    await m.record({
      sequenceId,
      actorId: null,
      kind: 'c.third',
      targetType: 'sequence',
      targetId: sequenceId,
      summary: 'Third',
    });

    const first = await m.listHistory(sequenceId, { limit: 2 });
    expect(first.events.map((event) => event.summary)).toEqual([
      'Third',
      'Second',
    ]);
    expect(first.events[1]?.actorName).toBe('Ada');
    expect(first.events[0]?.actorName).toBe('OpenStory');
    expect(first.events[1]?.targetLabel).toBe('Shot 1');
    expect(first.events[1]?.link).toMatchObject({ search: { shot: shotId } });
    expect(first.nextCursor).toBe(first.events[1]?.id);

    const older = await m.listHistory(sequenceId, {
      before: first.nextCursor ?? undefined,
      limit: 2,
    });
    expect(older.events.map((event) => event.summary)).toEqual(['First']);
    expect(older.nextCursor).toBeNull();

    await db
      .update(shots)
      .set({ deletedAt: new Date() })
      .where(eq(shots.id, shotId));
    const afterDelete = await m.listHistory(sequenceId, { limit: 2 });
    expect(afterDelete.events[1]?.targetLabel).toBe('Shot 1');
    expect(afterDelete.events[1]?.link).toBeNull();
  });
});

describe('buildEventInsertOnce', () => {
  it('keeps the first row when the same id is inserted again', async () => {
    const id = generateId();
    const input = {
      id,
      sequenceId,
      actorId: null,
      kind: 'preview.generated',
      targetType: 'sequence' as const,
      targetId: sequenceId,
      summary: 'Once',
    };
    await buildEventInsertOnce(db, input);
    await buildEventInsertOnce(db, { ...input, summary: 'Twice' });
    const rows = await db
      .select()
      .from(sequenceEvents)
      .where(eq(sequenceEvents.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe('Once');
  });
});

describe('sequence settings history', () => {
  it('writes a sentence only when the stored value changes', async () => {
    const sequences = createSequencesMethods(db, teamId, userId);
    await sequences.update({ id: sequenceId, aspectRatio: '9:16' });
    await sequences.update({ id: sequenceId, aspectRatio: '9:16' });
    await sequences.update({ id: sequenceId, imageModel: 'gpt_image_2' });

    const events =
      await createSequenceEventsMethods(db).listBySequence(sequenceId);
    expect(events.map((event) => event.summary)).toEqual([
      'Changed the image model to GPT Image 2.5',
      'Changed aspect ratio to 9:16',
    ]);
    expect(events[0]?.data).toMatchObject({ fields: ['imageModel'] });
    expect(SETTINGS_CHANGED_LABELS.imageModel).toBeUndefined();
  });
});
