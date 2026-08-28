/**
 * Acceptance tests for the frame-variants helper (flat, append-only image
 * versions + pointer selection). In-memory libSQL with the real migrations.
 *
 * Covers the core of the redesign: `select` repoints the frame's primary still
 * by mirroring a version's image fields and appending an `image.selected` event
 * atomically (one `db.batch`), the completed-only selection guard, the
 * cross-frame ownership guard, discard/undiscard, listByGroup source matching,
 * and isStale null-hash semantics.
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import {
  framePromptVersions,
  frameVariants,
  frames,
  sequenceEvents,
  sequences,
  shots,
  styles,
  teams,
  user,
} from '@/lib/db/schema';
import type { NewFrameVariant } from '@/lib/db/schema';
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
import { createFramePromptVersionsMethods } from './frame-prompt-versions';
import { createFrameVariantsMethods } from './frame-variants';

let client: Client;
let db: Database;
let sequenceId = '';
let shotId = '';
let frameId = '';

async function seed() {
  await db.delete(sequenceEvents);
  await db.delete(frameVariants);
  await db.delete(framePromptVersions);
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
  const [frame] = await db
    .insert(frames)
    .values({ shotId, sequenceId, orderIndex: 0, role: 'first' })
    .returning();
  if (!frame) throw new Error('test setup: frame insert returned nothing');
  frameId = frame.id;
}

/**
 * A second sequence in the same team, with its own shot + anchor frame. Used to
 * prove the sequence-scoped reads don't leak across sequences.
 */
async function seedSecondSequence() {
  const [team] = await db.select().from(teams);
  const [style] = await db.select().from(styles);
  if (!team || !style) throw new Error('test setup: seed() must run first');

  const otherSequenceId = generateId();
  await db.insert(sequences).values({
    id: otherSequenceId,
    teamId: team.id,
    title: 'Other',
    styleId: style.id,
  });
  const [shot] = await db
    .insert(shots)
    .values({ sequenceId: otherSequenceId, shotNumber: 1 })
    .returning();
  if (!shot) throw new Error('test setup: shot insert returned nothing');
  const [frame] = await db
    .insert(frames)
    .values({
      shotId: shot.id,
      sequenceId: otherSequenceId,
      orderIndex: 0,
      role: 'first',
    })
    .returning();
  if (!frame) throw new Error('test setup: frame insert returned nothing');
  return {
    sequenceId: otherSequenceId,
    shotId: shot.id,
    frameId: frame.id,
  };
}

function variantInput(
  overrides: Partial<NewFrameVariant> = {}
): NewFrameVariant {
  return {
    frameId,
    sequenceId,
    kind: 'model',
    model: 'nano_banana_2',
    status: 'completed',
    url: 'https://cdn/img.png',
    storagePath: 'r2/img.png',
    generatedAt: new Date('2026-06-26T00:00:00Z'),
    inputHash: 'hash-1',
    ...overrides,
  };
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

describe('frameVariants.appendVersion', () => {
  it('appends accumulating rows even for matching inputs (re-roll)', async () => {
    const m = createFrameVariantsMethods(db);
    const a = await m.appendVersion(variantInput());
    const b = await m.appendVersion(variantInput());
    expect(a.id).not.toBe(b.id);
    expect(await m.listByFrame(frameId)).toHaveLength(2);
  });

  it('is idempotent for an in-flight append of the same workflow run (CF step retry)', async () => {
    const m = createFrameVariantsMethods(db);
    const input = variantInput({
      status: 'generating',
      url: null,
      storagePath: null,
      generatedAt: null,
      workflowRunId: 'run-1',
    });
    const a = await m.appendVersion(input);
    // A retried step re-appends with the same run id — must reuse, not duplicate.
    const b = await m.appendVersion(input);
    expect(b.id).toBe(a.id);
    expect(await m.listByFrame(frameId)).toHaveLength(1);
  });

  it('still appends a fresh in-flight row for a different workflow run (re-roll)', async () => {
    const m = createFrameVariantsMethods(db);
    const a = await m.appendVersion(
      variantInput({ status: 'generating', url: null, workflowRunId: 'run-1' })
    );
    const b = await m.appendVersion(
      variantInput({ status: 'generating', url: null, workflowRunId: 'run-2' })
    );
    expect(b.id).not.toBe(a.id);
    expect(await m.listByFrame(frameId)).toHaveLength(2);
  });

  it('does not reuse a completed row of the same run when appending in-flight', async () => {
    const m = createFrameVariantsMethods(db);
    // A prior version of this run already completed; a new in-flight append for
    // the same run id must still create a fresh row (idempotency is scoped to
    // still-generating rows, so a finished version is never resurrected).
    const done = await m.appendVersion(
      variantInput({ status: 'completed', workflowRunId: 'run-1' })
    );
    const next = await m.appendVersion(
      variantInput({ status: 'generating', url: null, workflowRunId: 'run-1' })
    );
    expect(next.id).not.toBe(done.id);
    expect(await m.listByFrame(frameId)).toHaveLength(2);
  });
});

describe('frameVariants.select', () => {
  it('mirrors the version onto the frame and appends an atomic image.selected event', async () => {
    const m = createFrameVariantsMethods(db);
    const v1 = await m.appendVersion(variantInput({ model: 'm1' }));
    const v2 = await m.appendVersion(
      variantInput({
        model: 'm2',
        url: 'https://cdn/v2.png',
        storagePath: 'r2/v2.png',
        inputHash: 'hash-2',
      })
    );
    const actorId = generateId();
    await db.insert(user).values({ id: actorId, name: 'U', email: 'u@e.com' });

    // Select v1 first so v2 select has a non-null prev pointer.
    await m.select(frameId, v1.id, { actorId: null });
    await m.select(frameId, v2.id, { actorId });

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    // #1067: selecting moves the POINTER (plus the primary-render status);
    // the url/path/model/hash are read off the version, never copied down.
    expect(frame.selectedImageVersionId).toBe(v2.id);
    expect(frame.imageStatus).toBe('completed');
    const selected = await m.getSelected(frameId);
    expect(selected?.url).toBe('https://cdn/v2.png');
    expect(selected?.storagePath).toBe('r2/v2.png');
    expect(selected?.model).toBe('m2');
    expect(selected?.inputHash).toBe('hash-2');

    const events = await db
      .select()
      .from(sequenceEvents)
      .where(eq(sequenceEvents.kind, 'image.selected'));
    expect(events).toHaveLength(2);
    const latest = events.find((e) => e.actorId === actorId);
    if (!latest) throw new Error('expected actor event');
    expect(latest.targetId).toBe(frameId);
    expect(latest.data).toMatchObject({
      versionId: v2.id,
      model: 'm2',
      prevVersionId: v1.id,
    });
  });

  it('restores the linked visual prompt when selecting a stamped version (#1070)', async () => {
    const m = createFrameVariantsMethods(db);

    const [oldPrompt] = await db
      .insert(framePromptVersions)
      .values({
        frameId,
        text: 'Wide shot of the moon base',
        source: 'ai-generated',
        inputHash: 'prompt-hash-old',
        analysisModel: 'claude',
      })
      .returning();
    const [newPrompt] = await db
      .insert(framePromptVersions)
      .values({
        frameId,
        text: 'Close-up of the lunar rover',
        source: 'user-edit',
        inputHash: 'prompt-hash-new',
        analysisModel: null,
      })
      .returning();
    if (!oldPrompt || !newPrompt) {
      throw new Error('test setup: prompt insert failed');
    }

    // Live frame currently points at the newer prompt.
    await db
      .update(frames)
      .set({ selectedImagePromptVersionId: newPrompt.id })
      .where(eq(frames.id, frameId));

    // An older still that was generated from the old prompt.
    const olderStill = await m.appendVersion(
      variantInput({
        url: 'https://cdn/old.png',
        storagePath: 'r2/old.png',
        inputHash: 'image-hash-old',
        promptVersionId: oldPrompt.id,
      })
    );
    const newerStill = await m.appendVersion(
      variantInput({
        url: 'https://cdn/new.png',
        storagePath: 'r2/new.png',
        inputHash: 'image-hash-new',
        promptVersionId: newPrompt.id,
      })
    );

    await m.select(frameId, newerStill.id, { actorId: null });
    await m.select(frameId, olderStill.id, { actorId: null });

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    expect(frame.selectedImageVersionId).toBe(olderStill.id);
    expect((await m.getSelected(frameId))?.url).toBe('https://cdn/old.png');
    expect(frame.selectedImagePromptVersionId).toBe(oldPrompt.id);
    const restoredPrompt =
      await createFramePromptVersionsMethods(db).getSelected(frameId);
    expect(restoredPrompt?.text).toBe('Wide shot of the moon base');
    expect(restoredPrompt?.inputHash).toBe('prompt-hash-old');

    const promptEvents = await db
      .select()
      .from(sequenceEvents)
      .where(eq(sequenceEvents.kind, 'prompt.selected'));
    expect(promptEvents.length).toBeGreaterThanOrEqual(1);
    const restored = promptEvents.find(
      (e) =>
        e.data &&
        typeof e.data === 'object' &&
        'fromImageVersionId' in e.data &&
        e.data.fromImageVersionId === olderStill.id
    );
    expect(restored).toBeDefined();
  });

  it('clears pendingPromoteVersionId when selecting a different version (#1070)', async () => {
    const m = createFrameVariantsMethods(db);
    const current = await m.appendVersion(
      variantInput({ url: 'https://cdn/current.png' })
    );
    const other = await m.appendVersion(
      variantInput({ url: 'https://cdn/other.png' })
    );
    await m.select(frameId, current.id, { actorId: null });
    await db
      .update(frames)
      .set({ pendingPromoteVersionId: 'in-flight-ver' })
      .where(eq(frames.id, frameId));

    await m.select(frameId, other.id, { actorId: null });

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    expect(frame?.pendingPromoteVersionId).toBeNull();
    expect(frame?.selectedImageVersionId).toBe(other.id);
  });

  it('keeps pendingPromoteVersionId when re-selecting the current version', async () => {
    const m = createFrameVariantsMethods(db);
    const current = await m.appendVersion(variantInput());
    await m.select(frameId, current.id, { actorId: null });
    await db
      .update(frames)
      .set({ pendingPromoteVersionId: 'in-flight-ver' })
      .where(eq(frames.id, frameId));

    await m.select(frameId, current.id, { actorId: null });

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    expect(frame?.pendingPromoteVersionId).toBe('in-flight-ver');
  });

  it('selects without touching the prompt when promptVersionId is null (legacy)', async () => {
    const m = createFrameVariantsMethods(db);
    const [kept] = await db
      .insert(framePromptVersions)
      .values({
        frameId,
        text: 'Keep me',
        source: 'ai-generated',
        inputHash: 'keep-hash',
        analysisModel: 'claude',
      })
      .returning();
    if (!kept) throw new Error('test setup: prompt insert failed');
    await db
      .update(frames)
      .set({ selectedImagePromptVersionId: kept.id })
      .where(eq(frames.id, frameId));

    const v = await m.appendVersion(
      variantInput({ promptVersionId: null, inputHash: 'img' })
    );
    await m.select(frameId, v.id, { actorId: null });

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    expect(frame.selectedImagePromptVersionId).toBe(kept.id);
    const stillSelected =
      await createFramePromptVersionsMethods(db).getSelected(frameId);
    expect(stillSelected?.text).toBe('Keep me');
    expect(stillSelected?.inputHash).toBe('keep-hash');
    expect(
      await db
        .select()
        .from(sequenceEvents)
        .where(eq(sequenceEvents.kind, 'prompt.selected'))
    ).toHaveLength(0);
  });

  it('refuses to select a non-completed version (would blank the frame)', async () => {
    const m = createFrameVariantsMethods(db);
    const pending = await m.appendVersion(
      variantInput({ status: 'pending', url: null })
    );
    await expect(
      m.select(frameId, pending.id, { actorId: null })
    ).rejects.toThrow(/not 'completed'/);

    // The frame's pointer was never touched.
    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    expect(frame.selectedImageVersionId).toBeNull();
    // And no event leaked out of the rejected batch.
    expect(
      await db
        .select()
        .from(sequenceEvents)
        .where(eq(sequenceEvents.sequenceId, sequenceId))
    ).toHaveLength(0);
  });

  it('throws for a version that belongs to another frame (cross-frame guard)', async () => {
    const m = createFrameVariantsMethods(db);
    const [sibling] = await db
      .insert(frames)
      .values({ shotId, sequenceId, orderIndex: 1, role: 'last' })
      .returning();
    if (!sibling) throw new Error('test setup: sibling frame missing');
    const siblingVersion = await m.appendVersion(
      variantInput({ frameId: sibling.id })
    );
    await expect(
      m.select(frameId, siblingVersion.id, { actorId: null })
    ).rejects.toThrow(/not found for frame/);
  });
});

describe('frameVariants.selectIfPendingPromoteIs (#1070)', () => {
  it('promotes and consumes the claim when the pending pointer still names the version', async () => {
    const m = createFrameVariantsMethods(db);
    const v = await m.appendVersion(variantInput({ url: 'https://cdn/a.png' }));
    await db
      .update(frames)
      .set({ pendingPromoteVersionId: v.id })
      .where(eq(frames.id, frameId));

    const promoted = await m.selectIfPendingPromoteIs(frameId, v.id, {
      actorId: null,
    });

    expect(promoted?.id).toBe(v.id);
    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    expect(frame?.selectedImageVersionId).toBe(v.id);
    expect(frame?.pendingPromoteVersionId).toBeNull();
  });

  it('does not select when a newer kickoff moved the pending pointer', async () => {
    const m = createFrameVariantsMethods(db);
    const mine = await m.appendVersion(
      variantInput({ url: 'https://cdn/mine.png' })
    );
    const newer = await m.appendVersion(
      variantInput({ url: 'https://cdn/newer.png' })
    );
    await db
      .update(frames)
      .set({ pendingPromoteVersionId: newer.id })
      .where(eq(frames.id, frameId));

    const promoted = await m.selectIfPendingPromoteIs(frameId, mine.id, {
      actorId: null,
    });

    expect(promoted).toBeNull();
    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    expect(frame?.selectedImageVersionId).toBeNull();
    // The other run's claim survives — only a matching claim is consumed.
    expect(frame?.pendingPromoteVersionId).toBe(newer.id);
  });

  it('does not select when no promote claim is held at all', async () => {
    const m = createFrameVariantsMethods(db);
    const v = await m.appendVersion(variantInput());

    expect(
      await m.selectIfPendingPromoteIs(frameId, v.id, { actorId: null })
    ).toBeNull();
  });
});

describe('frameVariants.discard / undiscard', () => {
  it('soft-hides then restores a version, with matching events, in atomic batches', async () => {
    const m = createFrameVariantsMethods(db);
    const v = await m.appendVersion(variantInput());

    const discardedAt = await m.discard(v.id, { actorId: null });
    expect(discardedAt).toBeInstanceOf(Date);
    expect(await m.listByFrame(frameId)).toHaveLength(0);
    expect(
      await m.listByFrame(frameId, { includeDiscarded: true })
    ).toHaveLength(1);

    await m.undiscard(v.id, { actorId: null });
    expect(await m.listByFrame(frameId)).toHaveLength(1);

    const kinds = (
      await db
        .select()
        .from(sequenceEvents)
        .where(eq(sequenceEvents.targetId, v.id))
    ).map((e) => e.kind);
    expect(kinds).toContain('image.discarded');
    expect(kinds).toContain('image.undiscarded');
  });
});

describe('frameVariants.listByGroup', () => {
  it('matches null sourceVariantId explicitly so model groups do not collide with framing picks', async () => {
    const m = createFrameVariantsMethods(db);
    const modelVersion = await m.appendVersion(
      variantInput({ kind: 'model', model: 'm1' })
    );
    await m.appendVersion(
      variantInput({
        kind: 'framing',
        model: 'm1',
        sourceVariantId: modelVersion.id,
      })
    );

    const modelGroup = await m.listByGroup({
      frameId,
      kind: 'model',
      model: 'm1',
    });
    expect(modelGroup).toHaveLength(1);
    expect(modelGroup[0]?.id).toBe(modelVersion.id);

    const framingGroup = await m.listByGroup({
      frameId,
      kind: 'framing',
      model: 'm1',
      sourceVariantId: modelVersion.id,
    });
    expect(framingGroup).toHaveLength(1);
    expect(framingGroup[0]?.kind).toBe('framing');
  });
});

describe('frameVariants.listSelectedModelsBySequence (#1066)', () => {
  it("maps each shot to its SELECTED version's model, not the latest", async () => {
    const m = createFrameVariantsMethods(db);
    const selected = await m.appendVersion(
      variantInput({ model: 'flux_2_max' })
    );
    // A newer version in another model that was never selected must NOT win —
    // resolution follows the pointer, not recency.
    await m.appendVersion(variantInput({ model: 'gpt_image_2' }));
    await m.select(frameId, selected.id, { actorId: null });

    expect([...(await m.listSelectedModelsBySequence(sequenceId))]).toEqual([
      [shotId, 'flux_2_max'],
    ]);
  });

  it('keys by shot id, not frame id (frame ids ≠ shot ids)', async () => {
    const m = createFrameVariantsMethods(db);
    const v = await m.appendVersion(variantInput());
    await m.select(frameId, v.id, { actorId: null });

    const models = await m.listSelectedModelsBySequence(sequenceId);
    expect(models.has(shotId)).toBe(true);
    expect(models.has(frameId)).toBe(false);
  });

  it('omits a frame with no selection', async () => {
    const m = createFrameVariantsMethods(db);
    await m.appendVersion(variantInput());
    expect(await m.listSelectedModelsBySequence(sequenceId)).toEqual(new Map());
  });

  it('ignores a non-anchor frame so it cannot collide on the shot key', async () => {
    const m = createFrameVariantsMethods(db);
    const [lastFrame] = await db
      .insert(frames)
      .values({ shotId, sequenceId, orderIndex: 1, role: 'last' })
      .returning();
    if (!lastFrame)
      throw new Error('test setup: frame insert returned nothing');

    const anchorVersion = await m.appendVersion(
      variantInput({ model: 'flux_2_max' })
    );
    const lastVersion = await m.appendVersion(
      variantInput({ frameId: lastFrame.id, model: 'gpt_image_2' })
    );
    await m.select(frameId, anchorVersion.id, { actorId: null });
    await m.select(lastFrame.id, lastVersion.id, { actorId: null });

    const models = await m.listSelectedModelsBySequence(sequenceId);
    expect(models.size).toBe(1);
    expect(models.get(shotId)).toBe('flux_2_max');
  });

  it('never returns a shot from another sequence', async () => {
    // This read decides which model a user is BILLED for — a missing sequence
    // filter would leak another team's shots into the map.
    const m = createFrameVariantsMethods(db);
    const v = await m.appendVersion(variantInput());
    await m.select(frameId, v.id, { actorId: null });

    const other = await seedSecondSequence();
    const otherVersion = await m.appendVersion(
      variantInput({
        frameId: other.frameId,
        sequenceId: other.sequenceId,
        model: 'gpt_image_2',
      })
    );
    await m.select(other.frameId, otherVersion.id, { actorId: null });

    const models = await m.listSelectedModelsBySequence(sequenceId);
    expect(models.size).toBe(1);
    expect(models.has(other.shotId)).toBe(false);
  });

  it('omits a selected version that has been discarded', async () => {
    // A discarded version is hidden from the variant strip, so resolving the
    // shot's model from it would show a model the user can no longer see.
    const m = createFrameVariantsMethods(db);
    const v = await m.appendVersion(variantInput());
    await m.select(frameId, v.id, { actorId: null });
    await m.discard(v.id, { actorId: null });

    expect(await m.listSelectedModelsBySequence(sequenceId)).toEqual(new Map());
    expect(await m.getSelected(frameId)).toBeNull();
  });

  it("returns an upscale's model — it is the model that rendered it", async () => {
    // The upscale runs on the model that generated the grid (#1066), so its
    // `kind:'framing'` row carries the shot's real look model and resolution
    // reads it directly. Pinning the upscale to one model instead would make
    // this row silently redefine the shot's model.
    const m = createFrameVariantsMethods(db);
    const upscaled = await m.appendVersion(
      variantInput({ kind: 'framing', model: 'flux_2_max' })
    );
    await m.select(frameId, upscaled.id, { actorId: null });

    expect((await m.listSelectedModelsBySequence(sequenceId)).get(shotId)).toBe(
      'flux_2_max'
    );
  });
});

describe('frameVariants.listLastFailedModelsBySequence (#1066)', () => {
  it('maps each shot to its NEWEST failed version model', async () => {
    const m = createFrameVariantsMethods(db);
    await m.appendVersion(
      variantInput({ model: 'phota', status: 'failed', url: null })
    );
    await m.appendVersion(
      variantInput({ model: 'flux_2_max', status: 'failed', url: null })
    );

    expect(
      (await m.listLastFailedModelsBySequence(sequenceId)).get(shotId)
    ).toBe('flux_2_max');
  });

  it('ignores completed versions', async () => {
    const m = createFrameVariantsMethods(db);
    await m.appendVersion(variantInput({ model: 'gpt_image_2' }));
    expect(await m.listLastFailedModelsBySequence(sequenceId)).toEqual(
      new Map()
    );
  });

  it('never returns a shot from another sequence', async () => {
    const m = createFrameVariantsMethods(db);
    const other = await seedSecondSequence();
    await m.appendVersion(
      variantInput({
        frameId: other.frameId,
        sequenceId: other.sequenceId,
        model: 'flux_2_max',
        status: 'failed',
        url: null,
      })
    );
    expect(await m.listLastFailedModelsBySequence(sequenceId)).toEqual(
      new Map()
    );
  });
});

describe('frameVariants.isStale', () => {
  it('throws when the version does not exist', () => {
    const m = createFrameVariantsMethods(db);
    expect(m.isStale(generateId(), 'h')).rejects.toThrow(/not found/);
  });

  it('null stored hash → not stale; match → not stale; differ → stale', async () => {
    const m = createFrameVariantsMethods(db);
    const noHash = await m.appendVersion(variantInput({ inputHash: null }));
    expect(await m.isStale(noHash.id, 'anything')).toBe(false);

    const hashed = await m.appendVersion(
      variantInput({ inputHash: 'h-match' })
    );
    expect(await m.isStale(hashed.id, 'h-match')).toBe(false);
    expect(await m.isStale(hashed.id, 'h-new')).toBe(true);
  });
});

describe('frameVariants pending claims (#1085)', () => {
  it('createPendingClaim + listLiveClaims only surface claim rows', async () => {
    const m = createFrameVariantsMethods(db);
    // Ordinary append without claim fields is not a "claim".
    await m.appendVersion(
      variantInput({
        status: 'generating',
        url: null,
        workflowRunId: 'run-plain',
      })
    );
    const direct = await m.createPendingClaim({
      frameId,
      sequenceId,
      model: 'nano_banana_2',
      pendingInputHash: 'img-hash',
      workflowRunId: 'run-claim',
    });
    const chained = await m.createPendingClaim({
      frameId,
      sequenceId,
      model: 'nano_banana_2',
      dependsOnVersionId: 'fpv-dep',
      workflowRunId: 'run-chain',
    });

    const live = await m.listLiveClaims(frameId);
    expect(live.map((r) => r.id).sort()).toEqual(
      [direct.id, chained.id].sort()
    );
  });

  it('claimForGeneration returns null after markTerminal (cancel wins)', async () => {
    const m = createFrameVariantsMethods(db);
    const claim = await m.createPendingClaim({
      frameId,
      sequenceId,
      model: 'nano_banana_2',
      pendingInputHash: 'img-hash',
    });
    await m.markTerminal(claim.id, 'cancelled', 'Cancelled by user');

    const claimed = await m.claimForGeneration(claim.id, {
      workflowRunId: 'run-1',
      model: 'nano_banana_2',
      pendingInputHash: 'img-hash',
    });
    expect(claimed).toBeNull();
    const [row] = await db
      .select()
      .from(frameVariants)
      .where(eq(frameVariants.id, claim.id));
    expect(row?.status).toBe('cancelled');
  });

  it('completeIfLive returns null when cancelled mid-flight (no resurrection)', async () => {
    const m = createFrameVariantsMethods(db);
    const claim = await m.createPendingClaim({
      frameId,
      sequenceId,
      model: 'nano_banana_2',
      pendingInputHash: 'img-hash',
    });
    await m.claimForGeneration(claim.id, {
      workflowRunId: 'run-1',
      model: 'nano_banana_2',
    });
    await m.markTerminal(claim.id, 'cancelled', 'Cancelled by user');

    const completed = await m.completeIfLive(claim.id, {
      url: 'https://cdn/should-not-land.png',
      storagePath: 'r2/nope.png',
    });
    expect(completed).toBeNull();
    const [row] = await db
      .select()
      .from(frameVariants)
      .where(eq(frameVariants.id, claim.id));
    expect(row?.status).toBe('cancelled');
    expect(row?.url).toBeNull();
  });

  it('completeIfLive completes a live claim in place', async () => {
    const m = createFrameVariantsMethods(db);
    const claim = await m.createPendingClaim({
      frameId,
      sequenceId,
      model: 'nano_banana_2',
      pendingInputHash: 'img-hash',
    });
    await m.claimForGeneration(claim.id, {
      workflowRunId: 'run-1',
      model: 'nano_banana_2',
      pendingInputHash: 'img-hash',
    });

    const completed = await m.completeIfLive(claim.id, {
      url: 'https://cdn/img.png',
      storagePath: 'r2/img.png',
      inputHash: 'img-hash',
    });
    expect(completed?.id).toBe(claim.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.url).toBe('https://cdn/img.png');
  });

  it('cancelByDependency cancels only live dependents of that prompt version', async () => {
    const m = createFrameVariantsMethods(db);
    const dep = await m.createPendingClaim({
      frameId,
      sequenceId,
      model: 'nano_banana_2',
      dependsOnVersionId: 'fpv-1',
    });
    const other = await m.createPendingClaim({
      frameId,
      sequenceId,
      model: 'nano_banana_2',
      dependsOnVersionId: 'fpv-other',
    });
    const direct = await m.createPendingClaim({
      frameId,
      sequenceId,
      model: 'nano_banana_2',
      pendingInputHash: 'img-hash',
    });

    const cascaded = await m.cancelByDependency(
      'fpv-1',
      'Upstream visual prompt was cancelled'
    );
    expect(cascaded.map((r) => r.id)).toEqual([dep.id]);
    expect(cascaded[0]?.status).toBe('cancelled');

    const [otherRow] = await db
      .select()
      .from(frameVariants)
      .where(eq(frameVariants.id, other.id));
    const [directRow] = await db
      .select()
      .from(frameVariants)
      .where(eq(frameVariants.id, direct.id));
    expect(otherRow?.status).toBe('pending');
    expect(directRow?.status).toBe('pending');
  });

  it('claimForGeneration unique-hash collision stands down (null) instead of throwing', async () => {
    const m = createFrameVariantsMethods(db);
    // Direct claim already holds the live hash slot.
    const holder = await m.createPendingClaim({
      frameId,
      sequenceId,
      model: 'nano_banana_2',
      pendingInputHash: 'shared-hash',
      workflowRunId: 'run-holder',
    });
    // Chained claim starts with null hash (excluded from unique index).
    const chained = await m.createPendingClaim({
      frameId,
      sequenceId,
      model: 'nano_banana_2',
      dependsOnVersionId: 'fpv-1',
      workflowRunId: 'run-chain',
    });

    // Stamping the shared hash onto the chained row hits the partial unique index.
    const claimed = await m.claimForGeneration(chained.id, {
      workflowRunId: 'run-chain',
      model: 'nano_banana_2',
      pendingInputHash: 'shared-hash',
    });
    expect(claimed).toBeNull();

    // Holder still owns the slot; chained stayed pending (update rolled back).
    const [holderRow] = await db
      .select()
      .from(frameVariants)
      .where(eq(frameVariants.id, holder.id));
    const [chainedRow] = await db
      .select()
      .from(frameVariants)
      .where(eq(frameVariants.id, chained.id));
    expect(holderRow?.status).toBe('pending');
    expect(holderRow?.pendingInputHash).toBe('shared-hash');
    expect(chainedRow?.status).toBe('pending');
    expect(chainedRow?.pendingInputHash).toBeNull();
  });
});

describe("frameVariants kind: 'preview' (#1101)", () => {
  it('records a preview keyed by scene text, with no prompt version and no storage path', async () => {
    const m = createFrameVariantsMethods(db);

    const preview = await m.recordPreview({
      frameId,
      sequenceId,
      model: 'flux_2_turbo',
      url: 'https://fal.media/preview.png',
      promptHash: 'scene-text-hash',
      workflowRunId: 'run-preview-1',
    });

    expect(preview.kind).toBe('preview');
    expect(preview.status).toBe('completed');
    expect(preview.url).toBe('https://fal.media/preview.png');
    expect(preview.promptHash).toBe('scene-text-hash');
    // A preview renders the raw scene text, never a prompt version — and it
    // deliberately skips the R2 upload, so there is no storage path.
    expect(preview.promptVersionId).toBeNull();
    expect(preview.storagePath).toBeNull();
  });

  it('is idempotent per workflow run, so a step retry appends no second row', async () => {
    const m = createFrameVariantsMethods(db);

    const first = await m.recordPreview({
      frameId,
      sequenceId,
      model: 'flux_2_turbo',
      url: 'https://fal.media/preview.png',
      promptHash: null,
      workflowRunId: 'run-preview-1',
    });
    const replay = await m.recordPreview({
      frameId,
      sequenceId,
      model: 'flux_2_turbo',
      url: 'https://fal.media/preview.png',
      promptHash: null,
      workflowRunId: 'run-preview-1',
    });

    expect(replay.id).toBe(first.id);
    const rows = await db
      .select()
      .from(frameVariants)
      .where(eq(frameVariants.frameId, frameId));
    expect(rows).toHaveLength(1);
  });

  it("can never become the frame's still — select rejects it", async () => {
    const m = createFrameVariantsMethods(db);
    const preview = await m.recordPreview({
      frameId,
      sequenceId,
      model: 'flux_2_turbo',
      url: 'https://fal.media/preview.png',
      promptHash: null,
      workflowRunId: 'run-preview-1',
    });

    await expect(
      m.select(frameId, preview.id, { actorId: null })
    ).rejects.toThrow(/preview/);

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    expect(frame?.selectedImageVersionId).toBeNull();
  });

  it('projects the newest non-discarded preview, per frame', async () => {
    const m = createFrameVariantsMethods(db);
    const other = await seedSecondSequence();

    await m.recordPreview({
      frameId,
      sequenceId,
      model: 'flux_2_turbo',
      url: 'https://fal.media/old.png',
      promptHash: null,
      workflowRunId: 'run-1',
    });
    const newest = await m.recordPreview({
      frameId,
      sequenceId,
      model: 'flux_2_turbo',
      url: 'https://fal.media/new.png',
      promptHash: null,
      workflowRunId: 'run-2',
    });
    await m.recordPreview({
      frameId: other.frameId,
      sequenceId: other.sequenceId,
      model: 'flux_2_turbo',
      url: 'https://fal.media/other.png',
      promptHash: null,
      workflowRunId: 'run-3',
    });

    expect((await m.getLatestPreview(frameId))?.id).toBe(newest.id);
    const byFrame = await m.listLatestPreviewsByFrameIds([
      frameId,
      other.frameId,
    ]);
    expect(byFrame.get(frameId)?.url).toBe('https://fal.media/new.png');
    expect(byFrame.get(other.frameId)?.url).toBe('https://fal.media/other.png');

    await m.discard(newest.id, { actorId: null });
    expect((await m.getLatestPreview(frameId))?.url).toBe(
      'https://fal.media/old.png'
    );
  });

  it("stays out of the model list and the still's variant reads", async () => {
    const m = createFrameVariantsMethods(db);
    await m.appendVersion(variantInput({ model: 'nano_banana_2' }));
    await m.recordPreview({
      frameId,
      sequenceId,
      model: 'flux_2_turbo',
      url: 'https://fal.media/preview.png',
      promptHash: null,
      workflowRunId: 'run-preview-1',
    });

    // This is what lets `getSequenceImageModelsFn` drop its `hidden`-model
    // filter: the preview model is excluded by classification, not by a
    // property of the model.
    expect(await m.listModelsForSequence(sequenceId)).toEqual([
      'nano_banana_2',
    ]);
    const modelVersions = await m.listModelVersionsBySequence(sequenceId);
    expect(modelVersions.map((v) => v.model)).toEqual(['nano_banana_2']);
  });

  it('keeps an image-less husk out of the model dropdown (#1133)', async () => {
    const m = createFrameVariantsMethods(db);
    await m.appendVersion(variantInput({ model: 'nano_banana_2' }));
    // The shape the #1101 reclassify could not move because a frame selects it:
    // kind 'model', completed, but it never produced an image. 58 of these are
    // live in production and leak `flux_2_turbo` into 15 sequences' dropdown.
    await db.insert(frameVariants).values({
      id: 'husk-selected',
      frameId,
      sequenceId,
      kind: 'model',
      model: 'flux_2_turbo',
      status: 'completed',
      url: null,
      storagePath: null,
    });

    expect(await m.listModelsForSequence(sequenceId)).toEqual([
      'nano_banana_2',
    ]);
  });

  it('still lists in-flight and all-failed models (#1133)', async () => {
    const m = createFrameVariantsMethods(db);
    // Neither has a url, so the blunt `url IS NOT NULL` filter would hide both:
    // an in-flight render would drop out of the model bar until its image
    // landed, and a model whose attempts all failed would hide the failure.
    await db.insert(frameVariants).values([
      {
        id: 'inflight-row',
        frameId,
        sequenceId,
        kind: 'model',
        model: 'gpt_image_2',
        status: 'generating',
        url: null,
      },
      {
        id: 'allfailed-row',
        frameId,
        sequenceId,
        kind: 'model',
        model: 'flux_2_dev',
        status: 'failed',
        url: null,
      },
    ]);

    expect((await m.listModelsForSequence(sequenceId)).sort()).toEqual([
      'flux_2_dev',
      'gpt_image_2',
    ]);
  });

  it('orders by createdAt, so a non-ULID legacy id cannot win (#1132)', async () => {
    const m = createFrameVariantsMethods(db);
    const real = await m.recordPreview({
      frameId,
      sequenceId,
      model: 'flux_2_turbo',
      url: 'https://fal.media/real.png',
      promptHash: null,
      workflowRunId: 'run-ordering-1',
    });

    // A QStash-era row: 26-char hex id that sorts above EVERY ULID, but is
    // genuinely older. Ordering by id alone hands it the "newest" slot.
    await db.insert(frameVariants).values({
      id: 'ffdabf476d92ad8114fb89c8be',
      frameId,
      sequenceId,
      kind: 'preview',
      model: 'flux_2_turbo',
      status: 'completed',
      url: 'https://fal.media/stale-2026-03.png',
      createdAt: new Date(real.createdAt.getTime() - 60_000),
    });

    expect((await m.getLatestPreview(frameId))?.url).toBe(
      'https://fal.media/real.png'
    );
    const byFrame = await m.listLatestPreviewsByFrameIds([frameId]);
    expect(byFrame.get(frameId)?.url).toBe('https://fal.media/real.png');
  });
});

describe('frameVariants.getSelectedByFrameIds (#1322)', () => {
  it("chunks the id list under D1's 100-param ceiling and returns every selection", async () => {
    // The scenes page loads this for every frame of a sequence; a >100-frame
    // sequence threw `too many SQL variables` on D1. libsql has no cap, so the
    // spy is what pins the fan-out.
    const m = createFrameVariantsMethods(db);
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      const id = generateId();
      ids.push(id);
      await db
        .insert(frames)
        .values({ id, shotId, sequenceId, orderIndex: i + 1, role: 'first' });
      const [v] = await db
        .insert(frameVariants)
        .values({ frameId: id, sequenceId, model: 'm', status: 'completed' })
        .returning();
      if (!v) throw new Error('test setup: variant insert returned nothing');
      await db
        .update(frames)
        .set({ selectedImageVersionId: v.id })
        .where(eq(frames.id, id));
    }
    const select = vi.spyOn(db, 'select');
    const byFrame = await m.getSelectedByFrameIds(ids);
    expect(byFrame.size).toBe(200);
    for (const id of ids) expect(byFrame.get(id)?.frameId).toBe(id);
    expect(select).toHaveBeenCalledTimes(3);
    select.mockRestore();
  });
});
