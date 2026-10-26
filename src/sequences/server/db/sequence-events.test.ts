/**
 * Acceptance tests for the sequence-events helper (append-only activity log).
 * In-memory libSQL with the real migrations. Covers record persistence,
 * buildEventInsert composing into a caller's batch (atomic with its mutation),
 * and the timeline / by-target read ordering (newest-first, ULID order).
 */

import type { Database } from '@/platform/server/db/client';
import { createTestDb } from '@/platform/server/db/test-d1';
import { generateId } from '@/platform/id';
import { dbSceneId } from '@/shots/scene-id';
import {
  characterBibleVersions,
  characters,
  frameVariants,
  frames,
  renderSegments,
  scenes,
  sequenceCast,
  sequenceEvents,
  sequenceExports,
  sequences,
  shots,
  styles,
  teams,
  user,
  videoVariants,
} from '@/platform/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSequenceExportsMethods } from './sequence-exports';
import { createSequencesMethods } from './sequences';
import { videoPosterUrl } from '@/look/cloudflare-video';
import {
  SETTINGS_CHANGED_LABELS,
  buildEventInsert,
  buildEventInsertIfPresent,
  buildEventInsertOnce,
  createSequenceEventsMethods,
} from './sequence-events';

let closeDb: () => Promise<void>;
let db: Database;
let sequenceId = '';
let shotId = '';
let teamId = '';
let userId = '';

async function seed() {
  await db.delete(sequenceEvents);
  await db.delete(frameVariants);
  await db.delete(frames);
  await db.delete(videoVariants);
  await db.delete(renderSegments);
  await db.delete(shots);
  await db.delete(scenes);
  await db.delete(sequenceExports);
  await db.delete(sequenceCast);
  await db.delete(characterBibleVersions);
  await db.delete(characters);
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
  ({ db, close: closeDb } = await createTestDb());
});

afterAll(async () => {
  await closeDb();
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

  it('links a scene, a cast character, a still, and a clip', async () => {
    const sceneId = dbSceneId(generateId());
    const clipShotId = generateId();
    const frameId = generateId();
    const stillId = generateId();
    const segmentId = generateId();
    const clipId = generateId();
    const characterId = generateId();
    const bibleId = generateId();
    await db.insert(scenes).values({ id: sceneId, sequenceId, orderIndex: 2 });
    await db.insert(shots).values({
      id: clipShotId,
      sequenceId,
      shotNumber: 4,
    });
    await db.insert(frames).values({ id: frameId, shotId, sequenceId });
    await db.insert(frameVariants).values({
      id: stillId,
      frameId,
      sequenceId,
      model: 'nano',
      url: '/r2/still.png',
    });
    await db.insert(renderSegments).values({
      id: segmentId,
      sceneId,
      sequenceId,
    });
    await db.insert(videoVariants).values({
      id: clipId,
      renderSegmentId: segmentId,
      sequenceId,
      model: 'wan',
      url: '/r2/clip.mp4',
      manifest: [
        {
          shotId: clipShotId,
          motionPromptVersionId: null,
          frameVersionId: stillId,
          usesStartFrame: true,
          durationMs: 1000,
          audioClipIds: [],
          audioSourceKey: null,
          dialogueKey: null,
          referenceKeys: [],
        },
      ],
    });
    await db.insert(characters).values({
      id: characterId,
      teamId,
      legacyName: 'Maya',
      selectedBibleVersionId: bibleId,
    });
    await db.insert(characterBibleVersions).values({
      id: bibleId,
      characterId,
      name: 'Maya',
      voiceOnly: false,
      isPerson: false,
      source: 'edit',
    });
    await db.insert(sequenceCast).values({
      sequenceId,
      characterId,
      scriptCharacterId: 'char_001',
    });

    const m = createSequenceEventsMethods(db);
    await m.record({
      sequenceId,
      actorId: null,
      kind: 'scene.added',
      targetType: 'scene',
      targetId: sceneId,
      summary: 'Scene',
    });
    await m.record({
      sequenceId,
      actorId: null,
      kind: 'character.added',
      targetType: 'character',
      targetId: characterId,
      summary: 'Cast',
    });
    await m.record({
      sequenceId,
      actorId: null,
      kind: 'image.generated',
      targetType: 'variant',
      targetId: stillId,
      summary: 'Still',
    });
    await m.record({
      sequenceId,
      actorId: null,
      kind: 'video.cancelled',
      targetType: 'variant',
      targetId: clipId,
      summary: 'Clip',
    });
    await m.record({
      sequenceId,
      actorId: null,
      kind: 'video.discarded',
      targetType: 'variant',
      targetId: generateId(),
      summary: 'Missing clip',
    });

    const page = await m.listHistory(sequenceId, { limit: 10 });
    const bySummary = new Map(
      page.events.map((event) => [event.summary, event])
    );
    expect(bySummary.get('Scene')).toMatchObject({
      targetLabel: 'Scene 3',
      link: { search: { scenes: sceneId } },
    });
    expect(bySummary.get('Cast')).toMatchObject({
      targetLabel: 'Maya',
      link: { params: { characterId } },
    });
    expect(bySummary.get('Still')).toMatchObject({
      targetLabel: 'Shot 1',
      link: { search: { shot: shotId } },
      preview: { url: '/r2/still.png', model: 'nano' },
      previousPreview: null,
    });
    expect(bySummary.get('Clip')).toMatchObject({
      targetLabel: 'Shot 4',
      link: { search: { shot: clipShotId } },
      preview: { url: '/r2/still.png', model: 'wan' },
      previousPreview: null,
    });
    expect(JSON.stringify(page.events)).not.toContain('/r2/clip.mp4');
    expect(bySummary.get('Missing clip')).toMatchObject({
      targetLabel: 'Clip',
      link: null,
    });

    await db
      .update(sequenceCast)
      .set({ removedAt: new Date() })
      .where(eq(sequenceCast.characterId, characterId));
    const uncast = await m.listHistory(sequenceId, { limit: 10 });
    expect(
      uncast.events.find((event) => event.summary === 'Cast')
    ).toMatchObject({ targetLabel: 'Maya', link: null });
  });

  it('previews a selected clip from its start frame and skips a clip with none', async () => {
    const sceneId = dbSceneId(generateId());
    const segmentId = generateId();
    const frameId = generateId();
    const prevStillId = generateId();
    const nextStillId = generateId();
    const prevClipId = generateId();
    const nextClipId = generateId();
    const bareClipId = generateId();
    await db.insert(scenes).values({ id: sceneId, sequenceId, orderIndex: 0 });
    await db.insert(frames).values({ id: frameId, shotId, sequenceId });
    await db.insert(frameVariants).values([
      {
        id: prevStillId,
        frameId,
        sequenceId,
        model: 'nano',
        url: '/r2/prev.png',
      },
      {
        id: nextStillId,
        frameId,
        sequenceId,
        model: 'nano',
        url: '/r2/next.png',
      },
    ]);
    await db.insert(renderSegments).values({
      id: segmentId,
      sceneId,
      sequenceId,
    });
    const manifest = (frameVersionId: string | null) => [
      {
        shotId,
        motionPromptVersionId: null,
        frameVersionId,
        usesStartFrame: frameVersionId != null,
        durationMs: 1000,
        audioClipIds: [] as string[],
        audioSourceKey: null,
        dialogueKey: null,
        referenceKeys: [] as string[],
      },
    ];
    await db.insert(videoVariants).values([
      {
        id: prevClipId,
        renderSegmentId: segmentId,
        sequenceId,
        model: 'wan',
        url: '/r2/prev.mp4',
        manifest: manifest(prevStillId),
      },
      {
        id: nextClipId,
        renderSegmentId: segmentId,
        sequenceId,
        model: 'minimax_h3_max',
        url: 'https://assets.openstory.so/videos/next.mp4',
        manifest: manifest(nextStillId),
      },
      {
        id: bareClipId,
        renderSegmentId: segmentId,
        sequenceId,
        model: 'wan',
        url: '/r2/bare.mp4',
        manifest: manifest(null),
      },
    ]);
    const m = createSequenceEventsMethods(db);
    await m.record({
      sequenceId,
      actorId: userId,
      kind: 'video.selected',
      targetType: 'shot',
      targetId: shotId,
      summary: 'Selected minimax_h3_max video',
      data: {
        versionId: nextClipId,
        prevVersionId: prevClipId,
        model: 'minimax_h3_max',
      },
    });
    await m.record({
      sequenceId,
      actorId: null,
      kind: 'video.rendered',
      targetType: 'shot',
      targetId: shotId,
      summary: 'Rendered wan video',
      data: { versionId: bareClipId, model: 'wan' },
    });

    const page = await m.listHistory(sequenceId, { limit: 10 });
    expect(
      page.events.find((event) => event.kind === 'video.selected')
    ).toMatchObject({
      summary: 'Selected MiniMax H3 Max video',
      preview: {
        url: videoPosterUrl('https://assets.openstory.so/videos/next.mp4', 192),
        model: 'minimax_h3_max',
      },
      previousPreview: { url: '/r2/prev.png', model: 'wan' },
    });
    expect(
      page.events.find((event) => event.kind === 'video.rendered')
    ).toMatchObject({ preview: null, previousPreview: null });
    expect(JSON.stringify(page.events)).not.toContain('/r2/prev.mp4');
    expect(JSON.stringify(page.events)).not.toContain('/r2/bare.mp4');
  });

  it('limits history to a shot, or to a scene and the shots in it', async () => {
    const sceneId = dbSceneId(generateId());
    const otherSceneId = dbSceneId(generateId());
    const otherShotId = generateId();
    const frameId = generateId();
    const stillId = generateId();
    const segmentId = generateId();
    const clipId = generateId();
    await db.insert(scenes).values([
      { id: sceneId, sequenceId, orderIndex: 0 },
      { id: otherSceneId, sequenceId, orderIndex: 1 },
    ]);
    await db.update(shots).set({ sceneId }).where(eq(shots.id, shotId));
    await db.insert(shots).values({
      id: otherShotId,
      sequenceId,
      sceneId: otherSceneId,
      shotNumber: 2,
    });
    await db.insert(frames).values({ id: frameId, shotId, sequenceId });
    await db.insert(frameVariants).values({
      id: stillId,
      frameId,
      sequenceId,
      model: 'nano',
      url: '/r2/still.png',
    });
    await db.insert(renderSegments).values({
      id: segmentId,
      sceneId,
      sequenceId,
    });
    await db.insert(videoVariants).values({
      id: clipId,
      renderSegmentId: segmentId,
      sequenceId,
      model: 'wan',
      url: '/r2/clip.mp4',
      manifest: [
        {
          shotId,
          motionPromptVersionId: null,
          frameVersionId: null,
          usesStartFrame: true,
          durationMs: 1000,
          audioClipIds: [],
          audioSourceKey: null,
          dialogueKey: null,
          referenceKeys: [],
        },
      ],
    });
    const m = createSequenceEventsMethods(db);
    const note = (
      summary: string,
      targetType: 'shot' | 'scene' | 'variant' | 'sequence',
      targetId: string
    ) =>
      m.record({
        sequenceId,
        actorId: null,
        kind: 'note',
        targetType,
        targetId,
        summary,
      });
    await note('This shot', 'shot', shotId);
    await note('This still', 'variant', stillId);
    await note('This clip', 'variant', clipId);
    await note('This scene', 'scene', sceneId);
    await note('Other shot', 'shot', otherShotId);
    await note('Settings', 'sequence', sequenceId);

    const shotPage = await m.listHistory(sequenceId, {
      scope: { shotId },
      limit: 20,
    });
    expect(shotPage.events.map((event) => event.summary).sort()).toEqual([
      'This clip',
      'This shot',
      'This still',
    ]);

    // 50 scenes is the most the server fn accepts. The list is one bound
    // value per use, so the statement stays under D1's 100 parameters.
    const scenePage = await m.listHistory(sequenceId, {
      scope: {
        sceneIds: [sceneId, ...Array.from({ length: 49 }, () => generateId())],
      },
      limit: 20,
    });
    expect(scenePage.events.map((event) => event.summary).sort()).toEqual([
      'This clip',
      'This scene',
      'This shot',
      'This still',
    ]);
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

describe('buildEventInsertIfPresent', () => {
  it('writes nothing when the source row is absent', async () => {
    const id = generateId();
    const input = {
      id,
      sequenceId,
      actorId: null,
      kind: 'sheet.started',
      targetType: 'sequence' as const,
      targetId: sequenceId,
      summary: 'Started a sheet',
    };
    await db.batch([
      buildEventInsertIfPresent(
        db,
        input,
        sequences,
        eq(sequences.id, 'missing')
      ),
    ]);
    const missed = await db
      .select()
      .from(sequenceEvents)
      .where(eq(sequenceEvents.id, id));
    expect(missed).toHaveLength(0);

    await db.batch([
      buildEventInsertIfPresent(
        db,
        input,
        sequences,
        eq(sequences.id, sequenceId)
      ),
    ]);
    const hit = await db
      .select()
      .from(sequenceEvents)
      .where(eq(sequenceEvents.id, id));
    expect(hit).toHaveLength(1);
    expect(hit[0]?.summary).toBe('Started a sheet');
  });
});

describe('export.finished', () => {
  it('records one finished line when ready is called twice', async () => {
    const exports = createSequenceExportsMethods(db);
    const exportId = generateId();
    await db.insert(sequenceExports).values({
      id: exportId,
      sequenceId,
      url: '/r2/cut.mp4',
      storagePath: 'cut.mp4',
      status: 'processing',
    });
    await exports.markReady(exportId, { durationSeconds: 3 });
    await exports.markReady(exportId, { durationSeconds: 3 });
    const rows = await db
      .select()
      .from(sequenceEvents)
      .where(
        and(
          eq(sequenceEvents.kind, 'export.finished'),
          eq(sequenceEvents.sequenceId, sequenceId)
        )
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe('Finished the export');
    // Same target as export.started and export.failed: the sequence.
    expect(rows[0]?.targetId).toBe(sequenceId);
    expect(rows[0]?.data).toEqual({ exportId });
  });
});

describe('storyboard.started', () => {
  const started = () =>
    db
      .select()
      .from(sequenceEvents)
      .where(eq(sequenceEvents.kind, 'storyboard.started'));

  it('is written with the claim, and not when the claim is lost', async () => {
    const methods = createSequencesMethods(db, teamId, userId);
    const lost = await methods.claimWorkflowSlot({
      id: sequenceId,
      expectedRunId: 'someone-else',
      claimId: 'run-lost',
      activity: { summary: 'Started the storyboard' },
    });
    expect(lost).toBe(false);
    expect(await started()).toHaveLength(0);

    const won = await methods.claimWorkflowSlot({
      id: sequenceId,
      expectedRunId: null,
      claimId: 'run-won',
      activity: { summary: 'Started the storyboard' },
    });
    expect(won).toBe(true);
    const rows = await started();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorId).toBe(userId);
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
    expect(events[0]?.data).toMatchObject({
      fields: ['imageModel'],
      changes: [
        { field: 'imageModel', from: 'nano_banana_2', to: 'gpt_image_2' },
      ],
    });
    expect(SETTINGS_CHANGED_LABELS.imageModel).toBeUndefined();

    const page = await createSequenceEventsMethods(db).listHistory(sequenceId);
    expect(page.events[0]?.changes).toEqual([
      { label: 'Image', from: 'Nano Banana 2', to: 'GPT Image 2.5' },
    ]);
    expect(page.events[1]?.changes).toEqual([
      { label: 'Aspect ratio', from: '16:9', to: '9:16' },
    ]);
  });
});
