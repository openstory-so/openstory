/**
 * Behavioural tests for the scoped `video_variants` layer (#990) against a real
 * migrated in-memory D1 (libsql), mirroring the `is-stale.test.ts` harness.
 *
 * Pins the append-only version store + selection-as-pointer contract: append
 * (with generating-retry idempotency), list-by-group ordering / discard
 * filtering, `select` (segment pointer + `video.selected` event, atomic),
 * discard/undiscard, and staleness.
 *
 * Since #1067 phase 2d the pointer is also the READ path — the whole video
 * surface is projected through `getSelectedByShotIds`, so its exclusions
 * (no segment / no pointer / discarded) are pinned here too: each one is a
 * video silently appearing or vanishing in the UI if it drifts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/lib/db/id';
import type { Database } from '@/lib/db/client';
import {
  dbSceneId,
  renderSegments,
  scenes,
  sequenceEvents,
  sequences,
  shots,
  styles,
  teams,
  user,
  videoVariants,
  type NewVideoVariant,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import {
  createVideoVariantsMethods,
  getPrimaryVideoByShotIds,
} from './video-variants';

let client: Client;
let db: Database;
let methods: ReturnType<typeof createVideoVariantsMethods>;

const ACTOR = 'user-1';
let sequenceId = '';
let sceneId = '';
let shotId = '';
let segmentId = '';

async function seed() {
  await db.delete(videoVariants);
  await db.delete(sequenceEvents);
  await db.delete(shots);
  await db.delete(renderSegments);
  await db.delete(scenes);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  const teamId = generateId();
  sequenceId = generateId();
  sceneId = generateId();
  shotId = generateId();
  segmentId = generateId();

  await db.insert(user).values([{ id: ACTOR, name: 'U', email: 'u@e.com' }]);
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
  await db
    .insert(renderSegments)
    .values([{ id: segmentId, sceneId, sequenceId }]);
  await db.insert(shots).values([
    {
      id: shotId,
      sequenceId,
      sceneId,
      shotNumber: 1,
      renderSegmentId: segmentId,
    },
  ]);
}

/**
 * A second sequence in the same team, with its own scene / segment / shot. Used
 * to prove the sequence-scoped reads don't leak across sequences.
 */
async function seedSecondSequence() {
  const [team] = await db.select().from(teams);
  const [style] = await db.select().from(styles);
  if (!team || !style) throw new Error('seed: seed() must run first');

  const otherSequenceId = generateId();
  const otherSceneId = generateId();
  const otherSegmentId = generateId();
  const otherShotId = generateId();

  await db.insert(sequences).values([
    {
      id: otherSequenceId,
      teamId: team.id,
      title: 'Other',
      styleId: style.id,
    },
  ]);
  await db.insert(scenes).values([
    {
      id: dbSceneId(otherSceneId),
      sequenceId: otherSequenceId,
      orderIndex: 0,
    },
  ]);
  await db.insert(renderSegments).values([
    {
      id: otherSegmentId,
      sceneId: otherSceneId,
      sequenceId: otherSequenceId,
    },
  ]);
  await db.insert(shots).values([
    {
      id: otherShotId,
      sequenceId: otherSequenceId,
      sceneId: otherSceneId,
      shotNumber: 1,
      renderSegmentId: otherSegmentId,
    },
  ]);
  return {
    sequenceId: otherSequenceId,
    shotId: otherShotId,
    segmentId: otherSegmentId,
  };
}

function versionInput(
  overrides: Partial<NewVideoVariant> = {}
): NewVideoVariant {
  return {
    renderSegmentId: segmentId,
    sequenceId,
    model: 'veo3_1',
    manifest: [
      {
        shotId,
        motionPromptVersionId: null,
        frameVersionId: null,
        durationMs: 3000,
      },
    ],
    status: 'completed',
    url: 'https://r2/v.mp4',
    storagePath: 'team/seq/v.mp4',
    inputHash: 'hash-1',
    ...overrides,
  };
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  methods = createVideoVariantsMethods(db);
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
});

describe('appendVersion', () => {
  it('appends a row and getById round-trips it', async () => {
    const v = await methods.appendVersion(versionInput());
    expect(v.id).toBeTruthy();
    expect(await methods.getById(v.id)).toMatchObject({
      id: v.id,
      renderSegmentId: segmentId,
      model: 'veo3_1',
    });
  });

  it('is idempotent for an in-flight (generating + run id) append', async () => {
    const a = await methods.appendVersion(
      versionInput({ status: 'generating', workflowRunId: 'run-1', url: null })
    );
    const b = await methods.appendVersion(
      versionInput({ status: 'generating', workflowRunId: 'run-1', url: null })
    );
    expect(b.id).toBe(a.id);
  });

  it('a fresh run id appends a distinct generating row', async () => {
    const a = await methods.appendVersion(
      versionInput({ status: 'generating', workflowRunId: 'run-1', url: null })
    );
    const b = await methods.appendVersion(
      versionInput({ status: 'generating', workflowRunId: 'run-2', url: null })
    );
    expect(b.id).not.toBe(a.id);
  });
});

describe('listByGroup', () => {
  it('returns a group oldest-first and excludes discarded by default', async () => {
    // Explicit ascending ids: rapid generateId() calls aren't guaranteed
    // monotonic within a millisecond, but the scoped layer orders by id (ULID ≈
    // creation time), which holds for real seconds-apart appends.
    const a = await methods.appendVersion(versionInput({ id: 'v-001' }));
    const b = await methods.appendVersion(versionInput({ id: 'v-002' }));
    await methods.discard(b.id, { actorId: ACTOR });

    const group = { renderSegmentId: segmentId, model: 'veo3_1' };
    const visible = await methods.listByGroup(group);
    expect(visible.map((v) => v.id)).toEqual([a.id]);

    const all = await methods.listByGroup(group, { includeDiscarded: true });
    expect(all.map((v) => v.id)).toEqual([a.id, b.id]);
  });
});

describe('listBySequence / listModelsForSequence', () => {
  it('lists non-discarded versions and distinct models', async () => {
    await methods.appendVersion(versionInput({ model: 'veo3_1' }));
    await methods.appendVersion(versionInput({ model: 'kling_v3_pro' }));
    const discarded = await methods.appendVersion(versionInput());
    await methods.discard(discarded.id, { actorId: ACTOR });

    expect(await methods.listBySequence(sequenceId)).toHaveLength(2);
    expect((await methods.listModelsForSequence(sequenceId)).sort()).toEqual([
      'kling_v3_pro',
      'veo3_1',
    ]);
  });
});

describe('listBySegment (#1070)', () => {
  it('lists non-discarded versions for one segment, oldest-first', async () => {
    const a = await methods.appendVersion(versionInput({ model: 'veo3_1' }));
    const b = await methods.appendVersion(
      versionInput({ model: 'kling_v3_pro' })
    );
    const discarded = await methods.appendVersion(versionInput());
    await methods.discard(discarded.id, { actorId: ACTOR });

    const listed = await methods.listBySegment(segmentId);
    expect(listed.map((v) => v.id)).toEqual([a.id, b.id]);
  });
});

// The batched read the whole video surface is projected through (#1067 phase
// 2d). Its exclusions must match `getSelectedByShot` exactly, or a read path
// would silently show a video the single-shot path hides.
describe('getSelectedByShotIds (#1067)', () => {
  it('returns empty for an empty id list without querying', async () => {
    expect(await methods.getSelectedByShotIds([])).toEqual(new Map());
  });

  it('omits a shot whose segment has no selection pointer', async () => {
    await methods.appendVersion(versionInput());
    // Version exists, but nothing was selected — the mirror-era bug was
    // treating "has a version" as "has a video".
    expect(await methods.getSelectedByShotIds([shotId])).toEqual(new Map());
    expect(await methods.getSelectedByShot(shotId)).toBeNull();
  });

  it('omits a shot whose selected version was discarded', async () => {
    const v = await methods.appendVersion(versionInput());
    await methods.select(shotId, v.id, { actorId: ACTOR });
    await methods.discard(v.id, { actorId: ACTOR });

    expect(await methods.getSelectedByShotIds([shotId])).toEqual(new Map());
    expect(await methods.getSelectedByShot(shotId)).toBeNull();
  });

  it('omits a shot with no render segment at all', async () => {
    await db
      .update(shots)
      .set({ renderSegmentId: null })
      .where(eq(shots.id, shotId));
    expect(await methods.getSelectedByShotIds([shotId])).toEqual(new Map());
  });

  it('agrees with the single-shot getter for a live selection', async () => {
    const v = await methods.appendVersion(versionInput());
    await methods.select(shotId, v.id, { actorId: ACTOR });

    const single = await methods.getSelectedByShot(shotId);
    expect(single?.id).toBe(v.id);
    expect(await methods.getSelectedByShotIds([shotId])).toEqual(
      new Map([[shotId, single]])
    );
  });
});

// `renderSegments.clearSelectionByShot` is gone — a new still leaves the render
// selected and the manifest-staleness system flags it instead (#1067 phase 2d).

describe('select', () => {
  it('repoints the segment and logs the event, writing nothing to the shot', async () => {
    const v = await methods.appendVersion(versionInput());
    await methods.select(shotId, v.id, { actorId: ACTOR });

    // Nothing is copied onto the shot any more (#1067 phase 2d) — the pointer
    // below is the only record, and reads project the status through it.
    expect((await methods.getPrimaryByShot(shotId))?.status).toBe('completed');
    expect((await methods.getPrimaryByShot(shotId))?.error).toBeNull();

    const [segment] = await db
      .select()
      .from(renderSegments)
      .where(eq(renderSegments.id, segmentId));
    expect(segment?.selectedVideoVersionId).toBe(v.id);

    // What a read path resolves through that pointer.
    const selected = await methods.getSelectedByShot(shotId);
    expect(selected?.url).toBe('https://r2/v.mp4');
    expect(selected?.model).toBe('veo3_1');
    expect(await methods.getSelectedByShotIds([shotId])).toEqual(
      new Map([[shotId, selected]])
    );

    const [event] = await db
      .select()
      .from(sequenceEvents)
      .where(
        and(
          eq(sequenceEvents.kind, 'video.selected'),
          eq(sequenceEvents.targetId, shotId)
        )
      );
    expect(event).toBeTruthy();
  });

  it('rejects selecting an unfinished version', async () => {
    const v = await methods.appendVersion(
      versionInput({ status: 'generating', url: null })
    );
    await expect(
      methods.select(shotId, v.id, { actorId: ACTOR })
    ).rejects.toThrow(/not 'completed'/);
  });

  it("rejects selecting a version from another shot's segment", async () => {
    const v = await methods.appendVersion(versionInput());
    // A second shot in no/another segment must not select segment 1's version.
    const otherShotId = generateId();
    await db.insert(shots).values([
      {
        id: otherShotId,
        sequenceId,
        sceneId,
        shotNumber: 2,
        renderSegmentId: null,
      },
    ]);
    await expect(
      methods.select(otherShotId, v.id, { actorId: ACTOR })
    ).rejects.toThrow(/belongs to segment/);
  });
});

describe('listSelectedModelsBySequence (#1066)', () => {
  it("maps each shot to its SELECTED version's model, not the latest", async () => {
    const first = await methods.appendVersion(
      versionInput({ id: 'v-001', model: 'veo3_1' })
    );
    // A later render in a different model that was never selected must NOT
    // become the shot's model — resolution follows the pointer, not recency.
    await methods.appendVersion(
      versionInput({ id: 'v-002', model: 'kling_v3_pro' })
    );
    await methods.select(shotId, first.id, { actorId: ACTOR });

    expect([
      ...(await methods.listSelectedModelsBySequence(sequenceId)),
    ]).toEqual([[shotId, 'veo3_1']]);
  });

  it('omits a shot whose segment has no selection', async () => {
    await methods.appendVersion(versionInput());
    expect(await methods.listSelectedModelsBySequence(sequenceId)).toEqual(
      new Map()
    );
  });

  it('omits a shot with no render segment at all', async () => {
    await db.insert(shots).values([
      {
        id: generateId(),
        sequenceId,
        sceneId,
        shotNumber: 2,
        renderSegmentId: null,
      },
    ]);
    const v = await methods.appendVersion(versionInput());
    await methods.select(shotId, v.id, { actorId: ACTOR });

    const selected = await methods.listSelectedModelsBySequence(sequenceId);
    expect(selected.size).toBe(1);
    expect(selected.get(shotId)).toBe('veo3_1');
  });

  it('never returns a shot from another sequence', async () => {
    // This read decides which model a user is BILLED for — a missing sequence
    // filter would leak another team's shots into the map.
    const v = await methods.appendVersion(versionInput());
    await methods.select(shotId, v.id, { actorId: ACTOR });

    const other = await seedSecondSequence();
    const otherVersion = await methods.appendVersion(
      versionInput({
        renderSegmentId: other.segmentId,
        sequenceId: other.sequenceId,
        model: 'kling_v3_pro',
        manifest: [
          {
            shotId: other.shotId,
            motionPromptVersionId: null,
            frameVersionId: null,
            durationMs: 3000,
          },
        ],
      })
    );
    await methods.select(other.shotId, otherVersion.id, { actorId: ACTOR });

    const selected = await methods.listSelectedModelsBySequence(sequenceId);
    expect(selected.size).toBe(1);
    expect(selected.has(other.shotId)).toBe(false);
  });

  it('omits a selected version that has been discarded', async () => {
    const v = await methods.appendVersion(versionInput());
    await methods.select(shotId, v.id, { actorId: ACTOR });
    await methods.discard(v.id, { actorId: ACTOR });

    expect(await methods.listSelectedModelsBySequence(sequenceId)).toEqual(
      new Map()
    );
    expect(await methods.getSelectedByShot(shotId)).toBeNull();
  });
});

describe('listLastFailedModelsBySequence (#1066)', () => {
  it('maps each shot to its NEWEST failed version model', async () => {
    await methods.appendVersion(
      versionInput({ model: 'kling_v3_pro', status: 'failed', url: null })
    );
    await methods.appendVersion(
      versionInput({ model: 'seedance_v2', status: 'failed', url: null })
    );

    expect(
      (await methods.listLastFailedModelsBySequence(sequenceId)).get(shotId)
    ).toBe('seedance_v2');
  });

  it('ignores completed versions', async () => {
    await methods.appendVersion(versionInput());
    expect(await methods.listLastFailedModelsBySequence(sequenceId)).toEqual(
      new Map()
    );
  });

  it('never returns a shot from another sequence', async () => {
    const other = await seedSecondSequence();
    await methods.appendVersion(
      versionInput({
        renderSegmentId: other.segmentId,
        sequenceId: other.sequenceId,
        model: 'kling_v3_pro',
        status: 'failed',
        url: null,
        manifest: [
          {
            shotId: other.shotId,
            motionPromptVersionId: null,
            frameVersionId: null,
            durationMs: 3000,
          },
        ],
      })
    );
    expect(await methods.listLastFailedModelsBySequence(sequenceId)).toEqual(
      new Map()
    );
  });
});

describe('discard / undiscard', () => {
  it('soft-hides and restores a version with matching events', async () => {
    const v = await methods.appendVersion(versionInput());

    await methods.discard(v.id, { actorId: ACTOR });
    expect((await methods.getById(v.id))?.discardedAt).toBeTruthy();

    await methods.undiscard(v.id, { actorId: ACTOR });
    expect((await methods.getById(v.id))?.discardedAt).toBeNull();

    const events = await db
      .select()
      .from(sequenceEvents)
      .where(eq(sequenceEvents.targetId, v.id));
    expect(events.map((e) => e.kind).sort()).toEqual([
      'video.discarded',
      'video.undiscarded',
    ]);
  });
});

// Both batch getters bind one param per shot id, so they chunk at 90 to stay
// under D1's 100-bound-parameter ceiling (#1019). These tests run on libsql,
// which has NO param cap — so they cannot reproduce the overflow itself. What
// they pin is that the chunking loop reduces correctly across the boundary: a
// loop that drops the trailing partial batch, or overwrites the accumulator
// per chunk, silently loses videos for every shot past the first 90.
describe('batch getters chunk past D1s parameter ceiling (#1019)', () => {
  const OVER_ONE_CHUNK = 95;

  it('returns every shot when the id list spans more than one chunk', async () => {
    // All shots share the seeded segment — legitimate (a multi-shot segment is
    // one render), and it makes one selected version cover every shot.
    const extraShotIds = Array.from({ length: OVER_ONE_CHUNK - 1 }, () =>
      generateId()
    );
    await db.insert(shots).values(
      extraShotIds.map((id, i) => ({
        id,
        sequenceId,
        sceneId,
        shotNumber: i + 2,
        renderSegmentId: segmentId,
      }))
    );
    const allShotIds = [shotId, ...extraShotIds];
    expect(allShotIds.length).toBeGreaterThan(90);
    // The last id sits in the trailing partial batch — the one a loop that
    // stops early, or reassigns instead of accumulating, would lose.
    const pastBoundaryId = extraShotIds.at(-1);
    if (!pastBoundaryId) throw new Error('test setup: no shots past chunk 1');

    const version = await methods.appendVersion(versionInput());
    await methods.select(shotId, version.id, { actorId: ACTOR });

    const selected = await methods.getSelectedByShotIds(allShotIds);
    expect(selected.size).toBe(OVER_ONE_CHUNK);
    // Spot-check the far side of the boundary, not just the count.
    expect(selected.get(pastBoundaryId)?.id).toBe(version.id);

    const primary = await getPrimaryVideoByShotIds(db, allShotIds);
    expect(primary.size).toBe(OVER_ONE_CHUNK);
    expect(primary.get(pastBoundaryId)?.id).toBe(version.id);
  });
});

describe('isStale', () => {
  it('compares the stored input hash; null stored is never stale', async () => {
    const hashed = await methods.appendVersion(
      versionInput({ inputHash: 'h1' })
    );
    expect(await methods.isStale(hashed.id, 'h1')).toBe(false);
    expect(await methods.isStale(hashed.id, 'h2')).toBe(true);

    const legacy = await methods.appendVersion(
      versionInput({ inputHash: null })
    );
    expect(await methods.isStale(legacy.id, 'anything')).toBe(false);
  });

  it('treats a null live hash as unknown-not-stale (#1380)', async () => {
    const hashed = await methods.appendVersion(
      versionInput({ inputHash: 'h1' })
    );
    expect(await methods.isStale(hashed.id, null)).toBe(false);
  });
});
