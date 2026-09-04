/**
 * Acceptance tests for the frame prompt-versions helper (image / visual prompt
 * history). Exercised against an in-memory libSQL database with the real
 * migrations applied — the same harness as shot-prompt-versions.test.ts.
 *
 * Covers the write dedupe / force-regen contract (including the regression
 * where a user-edit whose hash collides with an existing row silently dropped
 * the edit), the restore (`select`) repoint + atomic `prompt.selected` event,
 * and the cross-frame ownership guard.
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import {
  framePromptVersions,
  frames,
  sequenceEvents,
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFramePromptVersionsMethods } from './frame-prompt-versions';

let client: Client;
let db: Database;
let teamId = '';
let sequenceId = '';
let shotId = '';
let frameId = '';

async function seed() {
  await db.delete(sequenceEvents);
  await db.delete(framePromptVersions);
  await db.delete(frames);
  await db.delete(shots);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  teamId = generateId();
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

const HAIKU = 'anthropic/claude-haiku-4.5';

describe('framePromptVersions.write', () => {
  it('mirrors the version onto the frame (text, hash, selected pointer)', async () => {
    const m = createFramePromptVersionsMethods(db);

    const version = await m.write({
      frameId,
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    const selected =
      await createFramePromptVersionsMethods(db).getSelected(frameId);
    expect(selected?.text).toBe('AI prompt v1');
    expect(selected?.inputHash).toBe('hash-1');
    expect(frame.selectedImagePromptVersionId).toBe(version.id);
  });

  it('AI write is idempotent on (frame, input_hash) — a retry returns the existing row', async () => {
    const m = createFramePromptVersionsMethods(db);
    const first = await m.write({
      frameId,
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    const retried = await m.write({
      frameId,
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    expect(retried.id).toBe(first.id);
    expect(await m.listByFrame(frameId)).toHaveLength(1);
  });

  it('force-regen at the same hash appends a distinct row that keeps tracking live context', async () => {
    const m = createFramePromptVersionsMethods(db);
    const first = await m.write({
      frameId,
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    const forced = await m.write({
      frameId,
      text: 'Fresh completion against same inputs',
      source: 'regenerated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    expect(forced.id).not.toBe(first.id);
    // Keeps the real hash: the row itself is what staleness compares against.
    expect(forced.inputHash).toBe('hash-1');
    expect(forced.text).toBe('Fresh completion against same inputs');

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    const selected =
      await createFramePromptVersionsMethods(db).getSelected(frameId);
    expect(selected?.text).toBe('Fresh completion against same inputs');
    // Cached hash still tracks the live upstream so staleness doesn't fire.
    expect(selected?.inputHash).toBe('hash-1');
    expect(frame.selectedImagePromptVersionId).toBe(forced.id);
  });

  it('user-edit whose hash collides with an existing row STILL records the edit (regression)', async () => {
    // The bug: a user-edit carries the live upstream hash captured at edit
    // time. When the text was edited but upstream context is unchanged, that
    // hash matched the existing AI row, so a dedupe keyed on hash alone
    // returned the OLD row and the edit vanished from history. Dedupe matches
    // text too, so new text always appends.
    const m = createFramePromptVersionsMethods(db);
    const ai = await m.write({
      frameId,
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });

    const edit = await m.write({
      frameId,
      text: 'Hand-edited prompt',
      source: 'user-edit',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });

    // A distinct row was appended, carrying the new text.
    expect(edit.id).not.toBe(ai.id);
    expect(edit.source).toBe('user-edit');
    expect(edit.text).toBe('Hand-edited prompt');
    // Keeps the hash captured at edit time, so staleness stays live.
    expect(edit.inputHash).toBe('hash-1');

    const history = await m.listByFrame(frameId);
    expect(history).toHaveLength(2);

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    const selected =
      await createFramePromptVersionsMethods(db).getSelected(frameId);
    // The pointer references the row whose text is mirrored — no divergence.
    expect(selected?.text).toBe('Hand-edited prompt');
    expect(frame.selectedImagePromptVersionId).toBe(edit.id);
    // Cached hash still tracks the live upstream context.
    expect(selected?.inputHash).toBe('hash-1');
  });

  it('idempotent retry of the same text at the same hash de-dupes (no spurious null-hash row)', async () => {
    const m = createFramePromptVersionsMethods(db);
    await m.write({
      frameId,
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    await m.write({
      frameId,
      text: 'AI prompt v1',
      source: 'regenerated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    expect(await m.listByFrame(frameId)).toHaveLength(1);
  });

  it('user-edit with null hash clears the cached hash', async () => {
    const m = createFramePromptVersionsMethods(db);
    await m.write({
      frameId,
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    await m.write({
      frameId,
      text: 'Hand-typed prompt',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });
    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    const selected =
      await createFramePromptVersionsMethods(db).getSelected(frameId);
    expect(selected?.text).toBe('Hand-typed prompt');
    expect(selected?.inputHash).toBeNull();
  });

  it('softened rewrite at the same hash appends a distinct row and keeps tracking live context', async () => {
    const m = createFramePromptVersionsMethods(db);
    const first = await m.write({
      frameId,
      text: 'A graphic fight in the alley',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    const softened = await m.write({
      frameId,
      text: 'Two figures confront each other in the alley',
      source: 'softened',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    expect(softened.id).not.toBe(first.id);
    expect(softened.source).toBe('softened');
    expect(softened.inputHash).toBe('hash-1');

    const selected =
      await createFramePromptVersionsMethods(db).getSelected(frameId);
    expect(selected?.text).toBe('Two figures confront each other in the alley');
    expect(selected?.id).toBe(softened.id);
  });
});

describe('framePromptVersions.select (restore)', () => {
  it('repoints the frame and appends a prompt.selected event with prevVersionId in one batch', async () => {
    const m = createFramePromptVersionsMethods(db);
    const v1 = await m.write({
      frameId,
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    const v2 = await m.write({
      frameId,
      text: 'AI prompt v2',
      source: 'regenerated',
      inputHash: 'hash-2',
      analysisModel: HAIKU,
    });
    // Frame now points at v2; restore v1.
    const actorId = generateId();
    await db.insert(user).values({ id: actorId, name: 'U', email: 'u@e.com' });

    const restored = await m.select(frameId, v1.id, { actorId });
    expect(restored.id).toBe(v1.id);

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    const selected =
      await createFramePromptVersionsMethods(db).getSelected(frameId);
    expect(selected?.text).toBe('AI prompt v1');
    expect(frame.selectedImagePromptVersionId).toBe(v1.id);

    const events = await db
      .select()
      .from(sequenceEvents)
      .where(eq(sequenceEvents.kind, 'prompt.selected'));
    expect(events).toHaveLength(1);
    const [evt] = events;
    if (!evt) throw new Error('event missing');
    expect(evt.targetId).toBe(frameId);
    expect(evt.actorId).toBe(actorId);
    expect(evt.data).toMatchObject({ versionId: v1.id, prevVersionId: v2.id });
  });

  it('throws for a version that belongs to another frame (cross-frame guard)', async () => {
    const m = createFramePromptVersionsMethods(db);
    const [sibling] = await db
      .insert(frames)
      .values({ shotId, sequenceId, orderIndex: 1, role: 'last' })
      .returning();
    if (!sibling) throw new Error('test setup: sibling frame missing');
    const siblingVersion = await m.write({
      frameId: sibling.id,
      text: 'belongs to sibling',
      source: 'ai-generated',
      inputHash: 'hash-s',
      analysisModel: HAIKU,
    });

    await expect(
      m.select(frameId, siblingVersion.id, { actorId: null })
    ).rejects.toThrow(/not found for frame/);
  });
});

describe('framePromptVersions.getByIdForFrame', () => {
  it('refuses to return a sibling frame version (cross-frame guard)', async () => {
    const m = createFramePromptVersionsMethods(db);
    const [sibling] = await db
      .insert(frames)
      .values({ shotId, sequenceId, orderIndex: 1, role: 'last' })
      .returning();
    if (!sibling) throw new Error('test setup: sibling frame missing');
    const own = await m.write({
      frameId,
      text: 'belongs to frame A',
      source: 'ai-generated',
      inputHash: 'hash-A',
      analysisModel: HAIKU,
    });

    expect(await m.getByIdForFrame(own.id, sibling.id)).toBeNull();
    expect((await m.getByIdForFrame(own.id, frameId))?.id).toBe(own.id);
  });
});

describe('framePromptVersions.completePendingAiVersion', () => {
  it('completes the claim in place and mirrors onto the frame', async () => {
    const m = createFramePromptVersionsMethods(db);
    const claim = await m.createPending({
      frameId,
      pendingInputHash: 'live-hash',
    });
    await m.markGenerating(claim.id, 'run-1');

    const completed = await m.completePendingAiVersion({
      versionId: claim.id,
      frameId,
      text: 'Regenerated prompt',
      inputHash: 'live-hash',
      analysisModel: HAIKU,
    });

    expect(completed?.id).toBe(claim.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.text).toBe('Regenerated prompt');
    expect(completed?.inputHash).toBe('live-hash');

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    const selected =
      await createFramePromptVersionsMethods(db).getSelected(frameId);
    expect(selected?.text).toBe('Regenerated prompt');
    expect(selected?.inputHash).toBe('live-hash');
    expect(frame.selectedImagePromptVersionId).toBe(claim.id);
  });

  it('a post-click user edit keeps the mirror — the run completes to history only', async () => {
    // The invariant the PR is named for: the system cannot lose an edit.
    const m = createFramePromptVersionsMethods(db);
    const claim = await m.createPending({
      frameId,
      pendingInputHash: 'live-hash',
    });
    await m.markGenerating(claim.id, 'run-1');

    // User edits AFTER the claim was enqueued: a newer completed row lands.
    const edit = await m.write({
      frameId,
      text: 'Post-click hand edit',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });

    const completed = await m.completePendingAiVersion({
      versionId: claim.id,
      frameId,
      text: 'Older run output',
      inputHash: 'other-hash',
      analysisModel: HAIKU,
    });

    // The claim itself completed into history…
    expect(completed?.id).toBe(claim.id);
    expect(completed?.status).toBe('completed');

    // …but the frame still shows the user's edit.
    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    const selected =
      await createFramePromptVersionsMethods(db).getSelected(frameId);
    expect(selected?.text).toBe('Post-click hand edit');
    expect(frame.selectedImagePromptVersionId).toBe(edit.id);
  });

  it('returns null for a claim cancelled mid-flight and never mirrors', async () => {
    const m = createFramePromptVersionsMethods(db);
    await m.write({
      frameId,
      text: 'Original',
      source: 'ai-generated',
      inputHash: 'hash-0',
      analysisModel: HAIKU,
    });
    const claim = await m.createPending({
      frameId,
      pendingInputHash: 'live-hash',
    });
    await m.markGenerating(claim.id, 'run-1');
    await m.markTerminal(claim.id, 'cancelled');

    const completed = await m.completePendingAiVersion({
      versionId: claim.id,
      frameId,
      text: 'Should be discarded',
      inputHash: 'live-hash',
      analysisModel: HAIKU,
    });

    expect(completed).toBeNull();
    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    const selected =
      await createFramePromptVersionsMethods(db).getSelected(frameId);
    expect(selected?.text).toBe('Original');
    const [row] = await db
      .select()
      .from(framePromptVersions)
      .where(eq(framePromptVersions.id, claim.id));
    expect(row?.status).toBe('cancelled');
  });

  it('identical text at a colliding hash retires the claim in favour of the existing row', async () => {
    const m = createFramePromptVersionsMethods(db);
    const existing = await m.write({
      frameId,
      text: 'Same output',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    const claim = await m.createPending({
      frameId,
      pendingInputHash: 'hash-1',
    });
    await m.markGenerating(claim.id, 'run-1');

    const completed = await m.completePendingAiVersion({
      versionId: claim.id,
      frameId,
      text: 'Same output',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });

    // The existing row wins; the placeholder retires as 'cancelled'.
    expect(completed?.id).toBe(existing.id);
    const [placeholder] = await db
      .select()
      .from(framePromptVersions)
      .where(eq(framePromptVersions.id, claim.id));
    expect(placeholder?.status).toBe('cancelled');
    // No unique-index violation, and the mirror points at the surviving row.
    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    expect(frame.selectedImagePromptVersionId).toBe(existing.id);
  });

  it('new text at a colliding hash completes as its own row keeping the real hash', async () => {
    const m = createFramePromptVersionsMethods(db);
    await m.write({
      frameId,
      text: 'Old output',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    const claim = await m.createPending({
      frameId,
      pendingInputHash: 'hash-1',
    });
    await m.markGenerating(claim.id, 'run-1');

    const completed = await m.completePendingAiVersion({
      versionId: claim.id,
      frameId,
      text: 'Fresh different output',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });

    expect(completed?.id).toBe(claim.id);
    expect(completed?.inputHash).toBe('hash-1');
    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    const selected =
      await createFramePromptVersionsMethods(db).getSelected(frameId);
    expect(selected?.text).toBe('Fresh different output');
    expect(selected?.inputHash).toBe('hash-1');
  });

  it('throws for a claim that belongs to another frame (ownership guard)', async () => {
    const m = createFramePromptVersionsMethods(db);
    const [sibling] = await db
      .insert(frames)
      .values({ shotId, sequenceId, orderIndex: 1, role: 'last' })
      .returning();
    if (!sibling) throw new Error('test setup: sibling frame missing');
    const claim = await m.createPending({
      frameId: sibling.id,
      pendingInputHash: 'live-hash',
    });

    await expect(
      m.completePendingAiVersion({
        versionId: claim.id,
        frameId,
        text: 'Wrong frame',
        inputHash: 'live-hash',
        analysisModel: HAIKU,
      })
    ).rejects.toThrow(/not found for frame/);
  });

  it('restore demotes live claims so completion never remirrors', async () => {
    const m = createFramePromptVersionsMethods(db);
    const original = await m.write({
      frameId,
      text: 'Original prompt',
      source: 'ai-generated',
      inputHash: 'hash-0',
      analysisModel: HAIKU,
    });
    const claim = await m.createPending({
      frameId,
      pendingInputHash: 'live-hash',
    });
    await m.markGenerating(claim.id, 'run-1');

    // User restores the original while the claim is still generating.
    await m.select(frameId, original.id, { actorId: null });

    const [demoted] = await db
      .select()
      .from(framePromptVersions)
      .where(eq(framePromptVersions.id, claim.id));
    expect(demoted?.pendingInputHash).toBeNull();
    expect(await m.getLivePending(frameId, 'live-hash')).toBeNull();

    const completed = await m.completePendingAiVersion({
      versionId: claim.id,
      frameId,
      text: 'Would clobber restore',
      inputHash: 'live-hash',
      analysisModel: HAIKU,
    });
    expect(completed?.status).toBe('completed');

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    const selected =
      await createFramePromptVersionsMethods(db).getSelected(frameId);
    expect(selected?.text).toBe('Original prompt');
    expect(frame.selectedImagePromptVersionId).toBe(original.id);
  });

  it('write demotes live claims (edit frees the unique slot + blocks remirror)', async () => {
    const m = createFramePromptVersionsMethods(db);
    const claim = await m.createPending({
      frameId,
      pendingInputHash: 'live-hash',
    });
    await m.markGenerating(claim.id, 'run-1');

    await m.write({
      frameId,
      text: 'User edit while regenerating',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });

    const [demoted] = await db
      .select()
      .from(framePromptVersions)
      .where(eq(framePromptVersions.id, claim.id));
    expect(demoted?.pendingInputHash).toBeNull();
    // Live unique slot freed — a fresh enqueue for a new hash can proceed.
    expect(await m.getLivePending(frameId, 'live-hash')).toBeNull();
  });
});

describe('framePromptVersions.getLatestWithInputHash', () => {
  it('skips null-hash user-edits and returns the most recent hashed row', async () => {
    const m = createFramePromptVersionsMethods(db);
    const ai = await m.write({
      frameId,
      text: 'AI prompt',
      source: 'ai-generated',
      inputHash: 'ai-hash',
      analysisModel: HAIKU,
    });
    await m.write({
      frameId,
      text: 'Hand-typed',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });
    expect((await m.getLatest(frameId))?.inputHash).toBeNull();
    const hashed = await m.getLatestWithInputHash(frameId);
    expect(hashed?.id).toBe(ai.id);
    expect(hashed?.inputHash).toBe('ai-hash');
  });
});
