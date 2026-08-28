/**
 * Acceptance tests for the prompt-variants helpers.
 *
 * These exercise issue #620's acceptance criteria end-to-end against an
 * in-memory libSQL database with the real migrations applied:
 *   - Editing a prompt produces a `'user-edit'` row; the prior text is
 *     recoverable by reading the variant chain.
 *   - Regenerating a prompt produces a `'regenerated'` row with a populated
 *     `input_hash`.
 *   - The selection pointer (`shots.selectedMotionPromptVersionId`) is moved
 *     onto the written row by the helper sequentially after the variant insert
 *     (not transactionally — see the helper docstring for the durability
 *     story). #1067 dropped the `shots.motionPrompt` /
 *     `motionPromptInputHash` mirrors, so the prompt text and hash are read
 *     back off the selected version row.
 *
 * The VISUAL (image) prompt path moved to `frame_prompt_versions` in #989
 * (keyed by the anchor frame id, resolved from the shot — frame ids ≠ shot ids)
 * and is covered by `frame-prompt-versions.test.ts`; the shot helper now owns
 * only the MOTION prompt, so these tests exercise it via `promptType: 'motion'`.
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import {
  shotPromptVersions,
  shots,
  sequenceMusicPromptVersions,
  sequences,
  styles,
  teams,
  user,
} from '@/lib/db/schema';
import type { ShotPromptVersion } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createShotPromptVersionsMethods } from './shot-prompt-versions';
import { createSequenceMusicPromptVersionsMethods } from './sequence-music-prompt-versions';

let client: Client;
let db: Database;
let teamId = '';
let sequenceId = '';
let shotId = '';

async function seed() {
  await db.delete(shotPromptVersions);
  await db.delete(sequenceMusicPromptVersions);
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
  await db.insert(sequences).values({
    id: sequenceId,
    teamId,
    title: 'S',
    styleId: style.id,
  });
  const [shot] = await db
    .insert(shots)
    .values({ sequenceId, shotNumber: 1 })
    .returning();
  if (!shot) throw new Error('test setup: shot insert returned nothing');
  shotId = shot.id;
}

/**
 * The motion prompt version the shot points at — the row that holds what the
 * dropped `shots.motionPrompt`/`motionPromptInputHash` mirrors used to cache.
 * Null when the pointer is unset or orphaned.
 */
async function selectedMotionVersion(
  id: string = shotId
): Promise<ShotPromptVersion | null> {
  const [shot] = await db.select().from(shots).where(eq(shots.id, id));
  if (!shot) throw new Error('test setup: refresh failed');
  if (!shot.selectedMotionPromptVersionId) return null;
  const [version] = await db
    .select()
    .from(shotPromptVersions)
    .where(eq(shotPromptVersions.id, shot.selectedMotionPromptVersionId));
  return version ?? null;
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

describe('shot_prompt_variants helper', () => {
  it('user-edit with null inputHash appends a row and selects it with a null hash', async () => {
    const methods = createShotPromptVersionsMethods(db);

    // A user-edit recorded without an upstream hash (e.g., context was
    // uncomputable at write time) writes null to the row the shot then
    // points at.
    const variant = await methods.write({
      shotId,
      promptType: 'motion',
      text: 'User edited prompt',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });

    expect(variant.source).toBe('user-edit');
    expect(variant.text).toBe('User edited prompt');
    expect(variant.inputHash).toBeNull();

    const selected = await selectedMotionVersion();
    expect(selected?.id).toBe(variant.id);
    expect(selected?.text).toBe('User edited prompt');
    expect(selected?.inputHash).toBeNull();
  });

  it('user-edit with a real inputHash stamps the row the shot selects', async () => {
    const methods = createShotPromptVersionsMethods(db);

    const variant = await methods.write({
      shotId,
      promptType: 'motion',
      text: 'User edited prompt',
      source: 'user-edit',
      inputHash: 'hash-at-edit-time',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    expect(variant.source).toBe('user-edit');
    expect(variant.inputHash).toBe('hash-at-edit-time');

    const selected = await selectedMotionVersion();
    expect(selected?.id).toBe(variant.id);
    expect(selected?.text).toBe('User edited prompt');
    expect(selected?.inputHash).toBe('hash-at-edit-time');
  });

  it('regenerated prompt populates input_hash on the row the shot selects', async () => {
    const methods = createShotPromptVersionsMethods(db);

    const variant = await methods.write({
      shotId,
      promptType: 'motion',
      text: 'AI prompt v2',
      source: 'regenerated',
      inputHash: 'context-hash-abc',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    expect(variant.source).toBe('regenerated');
    expect(variant.inputHash).toBe('context-hash-abc');

    // The selection pointer must move to the written version — the render
    // manifest snapshots this, and leaving it null reintroduced the #990
    // null-reference bug.
    const selected = await selectedMotionVersion();
    expect(selected?.id).toBe(variant.id);
    expect(selected?.text).toBe('AI prompt v2');
    expect(selected?.inputHash).toBe('context-hash-abc');
  });

  it('preserves prior AI text in the variant chain after a user edit (recoverable history)', async () => {
    const methods = createShotPromptVersionsMethods(db);

    await methods.write({
      shotId,
      promptType: 'motion',
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    await methods.write({
      shotId,
      promptType: 'motion',
      text: 'User edited prompt',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });

    const history = await methods.listByShot(shotId, 'motion');
    expect(history).toHaveLength(2);
    // Newest first.
    const [latest, prior] = history;
    if (!latest || !prior) throw new Error('test setup: history missing rows');
    expect(latest.source).toBe('user-edit');
    expect(prior.source).toBe('ai-generated');
    expect(prior.text).toBe('AI prompt v1');
    expect(prior.inputHash).toBe('context-hash-1');
  });

  it('ai-generated → regenerated → user-edit chain reflects the workflow source-discrimination flow', async () => {
    // Mirrors the scene-prompt workflow's decision: source = previous ?
    // 'regenerated' : 'ai-generated'. A regression that swaps the two would
    // mislabel every regeneration as a first generation (or vice versa) and
    // corrupt prompt history.
    const methods = createShotPromptVersionsMethods(db);

    const previousBeforeFirst = await methods.getLatest(shotId, 'motion');
    expect(previousBeforeFirst).toBeNull();
    const firstSource = previousBeforeFirst ? 'regenerated' : 'ai-generated';

    await methods.write({
      shotId,
      promptType: 'motion',
      text: 'AI prompt v1',
      source: firstSource,
      inputHash: 'hash-v1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const previousBeforeSecond = await methods.getLatest(shotId, 'motion');
    expect(previousBeforeSecond?.source).toBe('ai-generated');
    const secondSource = previousBeforeSecond ? 'regenerated' : 'ai-generated';

    await methods.write({
      shotId,
      promptType: 'motion',
      text: 'AI prompt v2',
      source: secondSource,
      inputHash: 'hash-v2',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    await methods.write({
      shotId,
      promptType: 'motion',
      text: 'User polished it',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });

    const history = await methods.listByShot(shotId, 'motion');
    expect(history.map((r) => r.source)).toEqual([
      'user-edit',
      'regenerated',
      'ai-generated',
    ]);

    // Selection follows the latest write (the user-edit), whose hash is null
    // since the text is no longer derived from upstream.
    const selected = await selectedMotionVersion();
    expect(selected?.text).toBe('User polished it');
    expect(selected?.inputHash).toBeNull();
  });

  it('AI write is idempotent on (shot, type, input_hash) — a retry returns the existing row', async () => {
    const methods = createShotPromptVersionsMethods(db);

    const first = await methods.write({
      shotId,
      promptType: 'motion',
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const retried = await methods.write({
      shotId,
      promptType: 'motion',
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    expect(retried.id).toBe(first.id);

    const history = await methods.listByShot(shotId, 'motion');
    expect(history).toHaveLength(1);
  });

  it('force-regen at the same input_hash appends a distinct history row with the new text and selects it', async () => {
    // Mirrors the user-driven "Regenerate Prompt" path: the LLM is invoked
    // again against unchanged upstream inputs, so the new completion's hash
    // collides with the existing row. The helper must still record the new
    // text in history (otherwise the user's regenerated prompt would be
    // silently lost) and repoint the shot at it. Staleness then falls back to
    // the latest hashed row, since the forced row's own hash is null.
    const methods = createShotPromptVersionsMethods(db);

    const first = await methods.write({
      shotId,
      promptType: 'motion',
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const forced = await methods.write({
      shotId,
      promptType: 'motion',
      text: 'Fresh LLM completion against same inputs',
      source: 'regenerated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    // A distinct row was inserted (not the existing one returned verbatim).
    expect(forced.id).not.toBe(first.id);
    // Keeps the real hash: the row itself is what staleness compares against.
    expect(forced.inputHash).toBe('context-hash-1');
    expect(forced.source).toBe('regenerated');
    expect(forced.text).toBe('Fresh LLM completion against same inputs');

    const history = await methods.listByShot(shotId, 'motion');
    expect(history).toHaveLength(2);
    const [latest, prior] = history;
    if (!latest || !prior) throw new Error('test setup: history missing rows');
    expect(latest.text).toBe('Fresh LLM completion against same inputs');
    expect(prior.text).toBe('AI prompt v1');

    // Selection points at the freshly-forced row (not the deduped original),
    // even though that row carries a null input_hash.
    const selected = await selectedMotionVersion();
    expect(selected?.id).toBe(forced.id);
    expect(selected?.text).toBe('Fresh LLM completion against same inputs');
  });

  it('idempotent retry of the same text at the same hash still de-dupes (does not fall through to the null-hash branch)', async () => {
    // Regression guard for the force-regen branch: it must only fire when
    // `existing.text !== input.text`. A genuine workflow step retry submits
    // the same text + same hash and should still collapse to one row.
    const methods = createShotPromptVersionsMethods(db);

    await methods.write({
      shotId,
      promptType: 'motion',
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    await methods.write({
      shotId,
      promptType: 'motion',
      text: 'AI prompt v1',
      source: 'regenerated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const history = await methods.listByShot(shotId, 'motion');
    expect(history).toHaveLength(1);
  });

  it('a different input_hash produces a new row for the same shot+type', async () => {
    const methods = createShotPromptVersionsMethods(db);

    await methods.write({
      shotId,
      promptType: 'motion',
      text: 'AI v1',
      source: 'ai-generated',
      inputHash: 'hash-a',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    await methods.write({
      shotId,
      promptType: 'motion',
      text: 'AI v2',
      source: 'regenerated',
      inputHash: 'hash-b',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const history = await methods.listByShot(shotId, 'motion');
    expect(history).toHaveLength(2);
  });

  it('getByIdForShot refuses to return a sibling shot variant (cross-shot guard)', async () => {
    // Restore handlers rely on this guard to refuse a `variantId` that
    // belongs to a different shot in the same sequence — without it, a
    // user could restore shot A's prompt onto shot B by passing the wrong
    // variantId. The shot-access middleware only checks the parent shot.
    const methods = createShotPromptVersionsMethods(db);

    const [siblingShot] = await db
      .insert(shots)
      .values({ sequenceId, shotNumber: 2 })
      .returning();
    if (!siblingShot)
      throw new Error('test setup: sibling shot insert returned nothing');

    const ownVariant = await methods.write({
      shotId,
      promptType: 'motion',
      text: 'belongs to shot A',
      source: 'ai-generated',
      inputHash: 'hash-A',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    // Lookup with the sibling shot's id must not succeed.
    const wrongShot = await methods.getByIdForShot(
      ownVariant.id,
      siblingShot.id
    );
    expect(wrongShot).toBeNull();

    // Sanity: the same lookup with the owning shot's id does return it.
    const rightShot = await methods.getByIdForShot(ownVariant.id, shotId);
    expect(rightShot?.id).toBe(ownVariant.id);
  });

  it('restored row carries the source variant input_hash so staleness keeps tracking the original upstream context', async () => {
    const methods = createShotPromptVersionsMethods(db);

    // Original AI-generated prompt with a stored hash.
    const original = await methods.write({
      shotId,
      promptType: 'motion',
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    // User then edits the prompt, but the upstream context wasn't
    // computable at edit time — both the row and the cached column go
    // null. The restore-from-AI flow below must still re-populate the
    // cached hash from the source row.
    await methods.write({
      shotId,
      promptType: 'motion',
      text: 'User edited prompt',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });

    // Restoring the original AI prompt must re-populate the cached hash so
    // the staleness check resumes detecting upstream drift. A regression
    // that drops the hash here silently disables staleness forever.
    const restored = await methods.write({
      shotId,
      promptType: 'motion',
      text: original.text,
      components: original.components,
      parameters: original.parameters,
      source: 'restored',
      inputHash: original.inputHash,
      analysisModel: original.analysisModel,
    });
    expect(restored.inputHash).toBe('context-hash-1');
    // Restore must append a NEW history row, not silently return the source
    // AI row when its hash is still unique on the shot. The previous unique
    // index keyed on (shot, type, input_hash) collapsed restore-of-existing-
    // hash into onConflictDoNothing, dropping the audit row.
    expect(restored.id).not.toBe(original.id);
    expect(restored.source).toBe('restored');

    const history = await methods.listByShot(shotId, 'motion');
    expect(history).toHaveLength(3);
    expect(history.map((r) => r.source)).toEqual([
      'restored',
      'user-edit',
      'ai-generated',
    ]);

    // The shot points at the restored row, which carries the original's hash —
    // so staleness resumes tracking the upstream context that produced it.
    const selected = await selectedMotionVersion();
    expect(selected?.id).toBe(restored.id);
    expect(selected?.text).toBe('AI prompt v1');
    expect(selected?.inputHash).toBe('context-hash-1');
  });

  it('softened row with select:false (variant-only rescue) lands in history and leaves the selection alone (#1373)', async () => {
    const methods = createShotPromptVersionsMethods(db);
    const original = await methods.write({
      shotId,
      promptType: 'motion',
      text: 'User prompt',
      source: 'user-edit',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const softened = await methods.write({
      shotId,
      promptType: 'motion',
      text: 'Softened prompt',
      source: 'softened',
      inputHash: original.inputHash,
      analysisModel: original.analysisModel,
      select: false,
    });
    expect(softened.id).not.toBe(original.id);
    expect(softened.inputHash).toBe('context-hash-1');

    const history = await methods.listByShot(shotId, 'motion');
    expect(history.map((r) => r.source)).toEqual(['softened', 'user-edit']);
    // An alternate model's rescue never moves the primary shot's prompt.
    expect((await selectedMotionVersion())?.id).toBe(original.id);

    // The default (primary render) selects the rewrite, as the image path does.
    const selected = await methods.write({
      shotId,
      promptType: 'motion',
      text: 'Softened prompt for the primary',
      source: 'softened',
      inputHash: original.inputHash,
      analysisModel: original.analysisModel,
    });
    expect((await selectedMotionVersion())?.id).toBe(selected.id);
  });

  it('restoring an AI prompt that is currently live still appends a restored row (audit trail)', async () => {
    // Without the partial-index `source != 'restored'` exclusion, this case
    // hit onConflictDoNothing and silently returned the original AI row.
    const methods = createShotPromptVersionsMethods(db);

    const original = await methods.write({
      shotId,
      promptType: 'motion',
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const restored = await methods.write({
      shotId,
      promptType: 'motion',
      text: original.text,
      components: original.components,
      parameters: original.parameters,
      source: 'restored',
      inputHash: original.inputHash,
      analysisModel: original.analysisModel,
    });

    expect(restored.id).not.toBe(original.id);
    expect(restored.source).toBe('restored');
    expect(restored.inputHash).toBe('context-hash-1');

    const history = await methods.listByShot(shotId, 'motion');
    expect(history).toHaveLength(2);
  });

  it('restored row from a user-edit source carries null hash (no staleness opinion to forward)', async () => {
    const methods = createShotPromptVersionsMethods(db);

    const userEdit = await methods.write({
      shotId,
      promptType: 'motion',
      text: 'Hand-written prompt',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });

    // Restoring a user-edit must not synthesize a hash out of nothing —
    // the source had none, so the restored row keeps null.
    const restored = await methods.write({
      shotId,
      promptType: 'motion',
      text: userEdit.text,
      components: userEdit.components,
      parameters: userEdit.parameters,
      source: 'restored',
      inputHash: userEdit.inputHash,
      analysisModel: userEdit.analysisModel,
    });
    expect(restored.inputHash).toBeNull();
    expect(restored.analysisModel).toBeNull();
  });

  it('getLatestWithInputHash skips null-hash user-edits and returns the most recent hashed row', async () => {
    const methods = createShotPromptVersionsMethods(db);

    // 1) An AI prompt with a real hash.
    const ai = await methods.write({
      shotId,
      promptType: 'motion',
      text: 'AI prompt',
      source: 'ai-generated',
      inputHash: 'ai-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    // 2) A later user-edit with no upstream context (null hash).
    await methods.write({
      shotId,
      promptType: 'motion',
      text: 'Hand-typed prompt',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });

    // getLatest returns the most recent row regardless of hash.
    const latest = await methods.getLatest(shotId, 'motion');
    expect(latest?.inputHash).toBeNull();

    // getLatestWithInputHash skips the user-edit and returns the AI row.
    const latestHashed = await methods.getLatestWithInputHash(shotId, 'motion');
    expect(latestHashed?.id).toBe(ai.id);
    expect(latestHashed?.inputHash).toBe('ai-hash-1');
  });

  it('getSelectedMotion returns the version the shot points at', async () => {
    const methods = createShotPromptVersionsMethods(db);
    const written = await methods.write({
      shotId,
      promptType: 'motion',
      text: 'Selected motion prompt',
      source: 'ai-generated',
      inputHash: 'sel-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const selected = await methods.getSelectedMotion(shotId);
    expect(selected?.id).toBe(written.id);
    expect(selected?.text).toBe('Selected motion prompt');
  });

  it('getSelectedMotion returns null (does not throw) when the pointer is orphaned', async () => {
    const methods = createShotPromptVersionsMethods(db);
    // Pointer set to a version id that has no row (deleted/broken FK).
    await db
      .update(shots)
      .set({ selectedMotionPromptVersionId: generateId() })
      .where(eq(shots.id, shotId));

    expect(await methods.getSelectedMotion(shotId)).toBeNull();
  });

  it('select repoints the shot at an existing version', async () => {
    const methods = createShotPromptVersionsMethods(db);
    const v1 = await methods.write({
      shotId,
      promptType: 'motion',
      text: 'Motion v1',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    await methods.write({
      shotId,
      promptType: 'motion',
      text: 'Motion v2',
      source: 'regenerated',
      inputHash: 'hash-2',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    // The shot currently points at v2; restore v1.
    const restored = await methods.select(shotId, v1.id, { actorId: null });
    expect(restored.id).toBe(v1.id);

    const selected = await selectedMotionVersion();
    expect(selected?.id).toBe(v1.id);
    expect(selected?.text).toBe('Motion v1');
  });

  it('select refuses a version id that belongs to another shot', async () => {
    const methods = createShotPromptVersionsMethods(db);
    const [otherShot] = await db
      .insert(shots)
      .values({ sequenceId, shotNumber: 2 })
      .returning();
    if (!otherShot) throw new Error('test setup: other shot insert failed');
    const foreign = await methods.write({
      shotId: otherShot.id,
      promptType: 'motion',
      text: 'Foreign motion prompt',
      source: 'ai-generated',
      inputHash: 'foreign-hash',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    await expect(
      methods.select(shotId, foreign.id, { actorId: null })
    ).rejects.toThrow(/not found/);
  });
});

describe('shotPromptVersions.completePendingAiVersion', () => {
  it('completes the claim in place and selects it', async () => {
    const m = createShotPromptVersionsMethods(db);
    const claim = await m.createPending({
      shotId,
      pendingInputHash: 'live-hash',
    });
    await m.markGenerating(claim.id, 'run-1');

    const completed = await m.completePendingAiVersion({
      versionId: claim.id,
      shotId,
      text: 'Regenerated motion prompt',
      inputHash: 'live-hash',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    expect(completed?.id).toBe(claim.id);
    expect(completed?.status).toBe('completed');

    const selected = await selectedMotionVersion();
    expect(selected?.id).toBe(claim.id);
    expect(selected?.text).toBe('Regenerated motion prompt');
  });

  it('a post-click user edit keeps the selection — the run completes to history only', async () => {
    const m = createShotPromptVersionsMethods(db);
    const claim = await m.createPending({
      shotId,
      pendingInputHash: 'live-hash',
    });
    await m.markGenerating(claim.id, 'run-1');

    const edit = await m.write({
      shotId,
      promptType: 'motion',
      text: 'Post-click hand edit',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });

    const completed = await m.completePendingAiVersion({
      versionId: claim.id,
      shotId,
      text: 'Older run output',
      inputHash: 'other-hash',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    expect(completed?.id).toBe(claim.id);
    expect(completed?.status).toBe('completed');

    // The edit — not the completed run — is what the shot points at.
    const selected = await selectedMotionVersion();
    expect(selected?.id).toBe(edit.id);
    expect(selected?.text).toBe('Post-click hand edit');
  });

  it('returns null for a claim cancelled mid-flight and never repoints', async () => {
    const m = createShotPromptVersionsMethods(db);
    const original = await m.write({
      shotId,
      promptType: 'motion',
      text: 'Original',
      source: 'ai-generated',
      inputHash: 'hash-0',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    const claim = await m.createPending({
      shotId,
      pendingInputHash: 'live-hash',
    });
    await m.markGenerating(claim.id, 'run-1');
    await m.markTerminal(claim.id, 'cancelled');

    const completed = await m.completePendingAiVersion({
      versionId: claim.id,
      shotId,
      text: 'Should be discarded',
      inputHash: 'live-hash',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    expect(completed).toBeNull();
    const selected = await selectedMotionVersion();
    expect(selected?.id).toBe(original.id);
    expect(selected?.text).toBe('Original');
  });

  it('identical text at a colliding hash retires the claim and RETURNS the surviving row', async () => {
    // The returned id is load-bearing (#1067): update-stale-shots threads it
    // out of the motion-prompt child as `finalVersionId` and re-reads it by
    // explicit id to render from. If this returned the retired placeholder,
    // the video chain would resolve a 'cancelled' row and stand down.
    const m = createShotPromptVersionsMethods(db);
    const existing = await m.write({
      shotId,
      promptType: 'motion',
      text: 'Same output',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    const claim = await m.createPending({
      shotId,
      pendingInputHash: 'hash-1',
    });
    await m.markGenerating(claim.id, 'run-1');

    const completed = await m.completePendingAiVersion({
      versionId: claim.id,
      shotId,
      text: 'Same output',
      inputHash: 'hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    // The existing row wins; the placeholder retires as 'cancelled'.
    expect(completed?.id).toBe(existing.id);
    expect(completed?.status).toBe('completed');
    const [placeholder] = await db
      .select()
      .from(shotPromptVersions)
      .where(eq(shotPromptVersions.id, claim.id));
    expect(placeholder?.status).toBe('cancelled');
    // No unique-index violation, and the shot points at the surviving row.
    const selected = await selectedMotionVersion();
    expect(selected?.id).toBe(existing.id);
  });

  it('new text at a colliding hash completes as its own row', async () => {
    const m = createShotPromptVersionsMethods(db);
    const existing = await m.write({
      shotId,
      promptType: 'motion',
      text: 'Old output',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    const claim = await m.createPending({
      shotId,
      pendingInputHash: 'hash-1',
    });
    await m.markGenerating(claim.id, 'run-1');

    const completed = await m.completePendingAiVersion({
      versionId: claim.id,
      shotId,
      text: 'New output',
      inputHash: 'hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    // Same inputs, different text — the claim keeps its real hash and wins the
    // selection. This is exactly the case a hash comparison against the
    // selection pointer could not distinguish from the retire path above.
    expect(completed?.id).toBe(claim.id);
    expect(completed?.id).not.toBe(existing.id);
    expect(completed?.text).toBe('New output');
    const selected = await selectedMotionVersion();
    expect(selected?.id).toBe(claim.id);
  });

  it('restore demotes live claims so completion never repoints', async () => {
    const m = createShotPromptVersionsMethods(db);
    const original = await m.write({
      shotId,
      promptType: 'motion',
      text: 'Original motion',
      source: 'ai-generated',
      inputHash: 'hash-0',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    const claim = await m.createPending({
      shotId,
      pendingInputHash: 'live-hash',
    });
    await m.markGenerating(claim.id, 'run-1');

    await m.select(shotId, original.id, { actorId: null });

    const [demoted] = await db
      .select()
      .from(shotPromptVersions)
      .where(eq(shotPromptVersions.id, claim.id));
    expect(demoted?.pendingInputHash).toBeNull();

    await m.completePendingAiVersion({
      versionId: claim.id,
      shotId,
      text: 'Would clobber restore',
      inputHash: 'live-hash',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const selected = await selectedMotionVersion();
    expect(selected?.id).toBe(original.id);
    expect(selected?.text).toBe('Original motion');
  });
});

describe('sequence_music_prompt_variants helper', () => {
  it('user-edit clears musicPromptInputHash and overwrites the cached prompt/tags', async () => {
    const methods = createSequenceMusicPromptVersionsMethods(db);

    await db
      .update(sequences)
      .set({
        musicPrompt: 'AI music v1',
        musicTags: 'epic,cinematic',
        musicPromptInputHash: 'music-hash-1',
      })
      .where(eq(sequences.id, sequenceId));

    const variant = await methods.write({
      sequenceId,
      prompt: 'User edited music prompt',
      tags: 'rock,fast',
      source: 'user-edit',
    });

    expect(variant.source).toBe('user-edit');

    const [refreshed] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.musicPrompt).toBe('User edited music prompt');
    expect(refreshed.musicTags).toBe('rock,fast');
    expect(refreshed.musicPromptInputHash).toBeNull();
  });

  it('ai-generated → regenerated chain on music variants mirrors the music-prompt workflow flow', async () => {
    const methods = createSequenceMusicPromptVersionsMethods(db);

    const previousBeforeFirst = await methods.getLatest(sequenceId);
    expect(previousBeforeFirst).toBeNull();
    const firstSource = previousBeforeFirst ? 'regenerated' : 'ai-generated';

    await methods.write({
      sequenceId,
      prompt: 'AI music v1',
      tags: 'epic',
      source: firstSource,
      inputHash: 'music-hash-v1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const previousBeforeSecond = await methods.getLatest(sequenceId);
    expect(previousBeforeSecond?.source).toBe('ai-generated');
    const secondSource = previousBeforeSecond ? 'regenerated' : 'ai-generated';

    await methods.write({
      sequenceId,
      prompt: 'AI music v2',
      tags: 'epic,driving',
      source: secondSource,
      inputHash: 'music-hash-v2',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const history = await methods.listBySequence(sequenceId);
    expect(history.map((r) => r.source)).toEqual([
      'regenerated',
      'ai-generated',
    ]);

    const [refreshed] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.musicPrompt).toBe('AI music v2');
    expect(refreshed.musicPromptInputHash).toBe('music-hash-v2');
  });

  it('AI music write is idempotent on (sequence, input_hash) — a retry returns the existing row', async () => {
    const methods = createSequenceMusicPromptVersionsMethods(db);

    const first = await methods.write({
      sequenceId,
      prompt: 'AI music',
      tags: 'epic',
      source: 'ai-generated',
      inputHash: 'music-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const retried = await methods.write({
      sequenceId,
      prompt: 'AI music',
      tags: 'epic',
      source: 'ai-generated',
      inputHash: 'music-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    expect(retried.id).toBe(first.id);

    const history = await methods.listBySequence(sequenceId);
    expect(history).toHaveLength(1);
  });

  it('regenerated music prompt populates the input hash on the sequence row', async () => {
    const methods = createSequenceMusicPromptVersionsMethods(db);

    await methods.write({
      sequenceId,
      prompt: 'AI music v2',
      tags: 'epic',
      source: 'regenerated',
      inputHash: 'music-context-hash',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const [refreshed] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.musicPrompt).toBe('AI music v2');
    expect(refreshed.musicPromptInputHash).toBe('music-context-hash');
  });

  it('getByIdForSequence refuses to return a sibling sequence variant (cross-sequence guard)', async () => {
    const methods = createSequenceMusicPromptVersionsMethods(db);

    // Reuse the seeded style so we can satisfy the not-null styleId on
    // sequences without duplicating the style fixture here.
    const [seededSequence] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!seededSequence)
      throw new Error('test setup: seeded sequence not found');
    const otherSequenceId = generateId();
    await db.insert(sequences).values({
      id: otherSequenceId,
      teamId,
      title: 'Other',
      styleId: seededSequence.styleId,
    });

    const ownVariant = await methods.write({
      sequenceId,
      prompt: 'belongs to sequence A',
      tags: 'epic',
      source: 'ai-generated',
      inputHash: 'music-hash-A',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const wrongSequence = await methods.getByIdForSequence(
      ownVariant.id,
      otherSequenceId
    );
    expect(wrongSequence).toBeNull();

    const rightSequence = await methods.getByIdForSequence(
      ownVariant.id,
      sequenceId
    );
    expect(rightSequence?.id).toBe(ownVariant.id);
  });

  it('restored music row carries the source variant input_hash so sequence staleness keeps tracking upstream context', async () => {
    const methods = createSequenceMusicPromptVersionsMethods(db);

    const original = await methods.write({
      sequenceId,
      prompt: 'AI music v1',
      tags: 'epic',
      source: 'ai-generated',
      inputHash: 'music-hash-v1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    await methods.write({
      sequenceId,
      prompt: 'User edit',
      tags: 'rock',
      source: 'user-edit',
    });

    const restored = await methods.write({
      sequenceId,
      prompt: original.prompt,
      tags: original.tags,
      source: 'restored',
      inputHash: original.inputHash,
      analysisModel: original.analysisModel,
    });
    expect(restored.inputHash).toBe('music-hash-v1');
    // Restore must append a new audit row even when the source AI hash is
    // still unique on the sequence.
    expect(restored.id).not.toBe(original.id);
    expect(restored.source).toBe('restored');

    const history = await methods.listBySequence(sequenceId);
    expect(history).toHaveLength(3);
    expect(history.map((r) => r.source)).toEqual([
      'restored',
      'user-edit',
      'ai-generated',
    ]);

    const [refreshed] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.musicPrompt).toBe('AI music v1');
    expect(refreshed.musicPromptInputHash).toBe('music-hash-v1');
  });
});
