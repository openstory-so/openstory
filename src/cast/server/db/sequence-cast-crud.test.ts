/**
 * Acceptance tests for cast/location bible CRUD + soft-remove (#1108 Phase 2)
 * — in-memory libSQL with the real migrations.
 *
 * The product contract under test:
 *   - updateBible commits the field write and a `*.updated` event (with
 *     prevState for undo/audit) atomically; staleness is untouched here (it
 *     derives from hashes elsewhere).
 *   - softDelete hides the row from every default list (cast facet, bible
 *     reads, sheet sweeps) but keeps it reachable by id; scene continuity is
 *     NOT rewritten. restore brings it back losslessly.
 *   - a re-analysis upsert on the same (sequenceId, characterId/locationId)
 *     revives a soft-deleted row.
 */

import { charactersToBible } from '@/cast/server/bibles-from-scoped';
import { hashVisualPromptInput } from '@/shots/input-hash';
import type { StyleConfig } from '@/platform/server/db/schema';
import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import {
  characterSheetVariants,
  characterVoiceVersions,
  characters,
  sequenceElements,
  sequenceEvents,
  sequenceLocations,
  sequences,
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
import { createCharactersMethods } from './characters';
import { createSequenceElementsMethods } from './sequence-elements';
import { createSequenceLocationsMethods } from './sequence-locations';

let client: Client;
let db: Database;
let sequenceId = '';
let actorId = '';

async function seed() {
  await db.delete(sequenceEvents);
  await db.delete(characterVoiceVersions);
  await db.delete(characters);
  await db.delete(sequenceElements);
  await db.delete(sequenceLocations);
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

async function eventKinds(): Promise<string[]> {
  const rows = await db.select().from(sequenceEvents);
  return rows.map((r) => r.kind);
}

const STYLE_CONFIG: StyleConfig = {
  version: 2,
  look: {
    mood: 'neutral',
    artStyle: 'cinematic',
    lighting: 'natural',
    colorPalette: ['#000', '#fff'],
    colorGrading: 'neutral',
  },
  motion: { camera: 'static' },
  references: [],
};

const HASH_SCENE = {
  sceneId: 'scene-1',
  sceneNumber: 1,
  originalScript: { extract: 'Alice walks in.', dialogue: [] },
  continuity: {
    characterTags: ['Alice'],
    environmentTag: 'room',
    elementTags: [],
    colorPalette: 'muted',
    lightingSetup: 'soft',
    styleTag: 'cinematic',
  },
};

/**
 * The live visual-prompt hash over the sequence's CURRENT (non-deleted) cast —
 * the same projection `computeShotStaleness` compares against. Used to assert
 * the DERIVED consequences of Phase 2 writes: a bible edit or a soft-remove
 * must move this, and nothing in the write paths may stamp a hash itself.
 */
async function liveVisualPromptHash(): Promise<string> {
  const cast = await createCharactersMethods(db).listWithSheets(sequenceId);
  return await hashVisualPromptInput({
    scene: HASH_SCENE,
    styleConfig: STYLE_CONFIG,
    characterBible: charactersToBible(cast),
    locationBible: [],
    elementBible: [],
    aspectRatio: '16:9',
    analysisModel: 'test-model',
  });
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

describe('characters bible CRUD + soft-remove', () => {
  it('appends and can restore selected voice configurations', async () => {
    const methods = createCharactersMethods(db);
    const created = await methods.create({
      sequenceId,
      characterId: 'voice_001',
      name: 'Maya',
      voiceDescription: 'Warm Australian alto',
    });
    // The voice the cast arrived with is history's first row, selected (#1657).
    expect(created.selectedVoiceVersionId).toBeTruthy();
    const [original] = await methods.listVoiceVersions(created.id);
    expect(original?.source).toBe('analysis');
    expect(original?.description).toBe('Warm Australian alto');

    const a = await methods.updateVoice(
      created.id,
      { voiceId: 'voice-a', voicePreviews: [], useVoice: true },
      'generated',
      actorId
    );
    expect((await methods.listVoiceVersions(created.id))[0]?.createdBy).toBe(
      actorId
    );
    const b = await methods.updateVoice(
      created.id,
      { voiceId: 'voice-b' },
      'library',
      null
    );

    const versions = await methods.listVoiceVersions(created.id);
    expect(versions).toHaveLength(3);
    expect(versions.map((version) => version.source)).toEqual([
      'library',
      'generated',
      'analysis',
    ]);
    // Every write moves the pointer with the row it appended.
    expect(a.selectedVoiceVersionId).toBe(
      versions.find((version) => version.voiceId === 'voice-a')?.id
    );
    expect(b.selectedVoiceVersionId).toBe(
      versions.find((version) => version.voiceId === 'voice-b')?.id
    );

    const first = versions.find((version) => version.voiceId === 'voice-a');
    if (!first) throw new Error('first voice version missing');

    // Select restores the whole mirror, not just the id.
    const restored = await methods.selectVoiceVersion(created.id, first.id);
    expect(restored.voiceId).toBe('voice-a');
    expect(restored.useVoice).toBe(true);
    expect(restored.voicePreviews).toEqual([]);
    expect(restored.selectedVoiceVersionId).toBe(first.id);
  });

  it('stamps a take unusable without appending voice history (#1709)', async () => {
    const methods = createCharactersMethods(db);
    const created = await methods.create({
      sequenceId,
      characterId: 'voice_unusable',
      name: 'Maya',
    });
    const saved = await methods.updateVoice(
      created.id,
      {
        voiceId: 'voice-a',
        voicePreviews: [
          {
            generatedVoiceId: 'take-1',
            url: '/r2/a.mp3',
            path: 'a.mp3',
            takeNumber: 1,
          },
          {
            generatedVoiceId: 'take-2',
            url: '/r2/b.mp3',
            path: 'b.mp3',
            takeNumber: 2,
          },
        ],
      },
      'generated',
      actorId
    );
    const before = await methods.listVoiceVersions(created.id);
    const stamped = await methods.stampPreviewUnusable(
      created.id,
      'take-2',
      'expired'
    );
    expect(stamped.voicePreviews).toEqual([
      expect.objectContaining({ generatedVoiceId: 'take-1' }),
      expect.objectContaining({
        generatedVoiceId: 'take-2',
        unusable: 'expired',
      }),
    ]);
    expect(await methods.listVoiceVersions(created.id)).toHaveLength(
      before.length
    );
    expect(stamped.selectedVoiceVersionId).toBe(saved.selectedVoiceVersionId);
  });

  it('creates a generating voice husk and points pending-promote at it (#1715)', async () => {
    const methods = createCharactersMethods(db);
    const created = await methods.create({
      sequenceId,
      characterId: 'voice_husk',
      name: 'Maya',
    });
    const before = await methods.listVoiceVersions(created.id);
    const husk = await methods.createPendingVoiceClaim(created.id, actorId);
    expect(husk.status).toBe('generating');
    expect(husk.source).toBe('generated');
    expect(husk.voiceId).toBeNull();
    const live = await methods.getById(created.id);
    expect(live?.pendingPromoteVoiceVersionId).toBe(husk.id);
    expect(await methods.listVoiceVersions(created.id)).toHaveLength(
      before.length + 1
    );
    expect(await methods.listLiveVoiceClaims(created.id)).toEqual([
      expect.objectContaining({ id: husk.id, status: 'generating' }),
    ]);
  });

  it('refuses a second live voice husk for the same character (#1715)', async () => {
    const methods = createCharactersMethods(db);
    const created = await methods.create({
      sequenceId,
      characterId: 'voice_husk_unique',
      name: 'Maya',
    });
    await methods.createPendingVoiceClaim(created.id, actorId);
    await expect(
      methods.createPendingVoiceClaim(created.id, actorId)
    ).rejects.toThrow();
  });

  it('completes a live husk in place without appending history (#1715)', async () => {
    const methods = createCharactersMethods(db);
    const created = await methods.create({
      sequenceId,
      characterId: 'voice_husk_complete',
      name: 'Maya',
    });
    const husk = await methods.createPendingVoiceClaim(created.id, actorId);
    const completed = await methods.completeVoiceClaimIfLive(husk.id, {
      voiceId: 'voice-new',
      description: 'Warm alto',
      previews: [
        {
          generatedVoiceId: 'take-1',
          url: '/r2/a.mp3',
          path: 'a.mp3',
          takeNumber: 1,
        },
      ],
    });
    expect(completed?.id).toBe(husk.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.voiceId).toBe('voice-new');
    expect(await methods.listVoiceVersions(created.id)).toHaveLength(1);
    expect(await methods.listLiveVoiceClaims(created.id)).toEqual([]);
    expect(
      await methods.completeVoiceClaimIfLive(husk.id, { voiceId: 'other' })
    ).toBeNull();
  });

  it('does not complete a husk that already failed (#1715)', async () => {
    const methods = createCharactersMethods(db);
    const created = await methods.create({
      sequenceId,
      characterId: 'voice_husk_fail',
      name: 'Maya',
    });
    const husk = await methods.createPendingVoiceClaim(created.id, actorId);
    const failed = await methods.markVoiceClaimTerminal(
      husk.id,
      'failed',
      'Voice Design returned no previews'
    );
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('Voice Design returned no previews');
    const after = await methods.getById(created.id);
    expect(after?.pendingPromoteVoiceVersionId).toBeNull();
    expect(
      await methods.completeVoiceClaimIfLive(husk.id, { voiceId: 'voice-x' })
    ).toBeNull();
  });

  it('clears pending-promote when selecting a different completed voice (#1715)', async () => {
    const methods = createCharactersMethods(db);
    const created = await methods.create({
      sequenceId,
      characterId: 'voice_husk_demote',
      name: 'Maya',
    });
    const saved = await methods.updateVoice(
      created.id,
      { voiceId: 'voice-a', voiceDescription: 'Original' },
      'generated',
      actorId
    );
    const husk = await methods.createPendingVoiceClaim(created.id, actorId);
    expect(
      (await methods.getById(created.id))?.pendingPromoteVoiceVersionId
    ).toBe(husk.id);
    if (!saved.selectedVoiceVersionId) {
      throw new Error('expected a selected voice version');
    }
    const restored = await methods.selectVoiceVersion(
      created.id,
      saved.selectedVoiceVersionId
    );
    expect(restored.pendingPromoteVoiceVersionId).toBeNull();
    expect(restored.voiceId).toBe('voice-a');
  });

  it('refuses to select a generating voice husk (#1715)', async () => {
    const methods = createCharactersMethods(db);
    const created = await methods.create({
      sequenceId,
      characterId: 'voice_husk_select',
      name: 'Maya',
    });
    const husk = await methods.createPendingVoiceClaim(created.id, actorId);
    await expect(
      methods.selectVoiceVersion(created.id, husk.id)
    ).rejects.toThrow(/not finished/i);
  });

  it('refuses a released voice version, across every character holding the id', async () => {
    const methods = createCharactersMethods(db);
    const maya = await methods.create({
      sequenceId,
      characterId: 'voice_002',
      name: 'Maya',
    });
    const otto = await methods.create({
      sequenceId,
      characterId: 'voice_003',
      name: 'Otto',
    });
    await methods.updateVoice(
      maya.id,
      { voiceId: 'shared' },
      'generated',
      null
    );
    await methods.updateVoice(otto.id, { voiceId: 'shared' }, 'library', null);
    await methods.updateVoice(maya.id, { voiceId: 'kept' }, 'library', null);

    // The id is deleted at ElevenLabs once, for everyone (#1657).
    await methods.markVoiceReleased('shared');
    const mayaVersions = await methods.listVoiceVersions(maya.id);
    const ottoVersions = await methods.listVoiceVersions(otto.id);
    expect(
      [...mayaVersions, ...ottoVersions]
        .filter((version) => version.voiceId === 'shared')
        .every((version) => version.releasedAt)
    ).toBe(true);
    expect(
      mayaVersions.find((version) => version.voiceId === 'kept')?.releasedAt
    ).toBeNull();

    const released = mayaVersions.find(
      (version) => version.voiceId === 'shared'
    );
    if (!released) throw new Error('released voice version missing');
    await expect(
      methods.selectVoiceVersion(maya.id, released.id)
    ).rejects.toThrow(/deleted when it stopped being used/);
    // The refusal changed nothing.
    const unchanged = await methods.getById(maya.id);
    expect(unchanged?.voiceId).toBe('kept');

    // Another character's version is not this character's to select.
    const ottos = ottoVersions[0];
    if (!ottos) throw new Error('otto voice version missing');
    await expect(methods.selectVoiceVersion(maya.id, ottos.id)).rejects.toThrow(
      /not found for character/
    );
  });

  it('create labels a talent-copied voice library, and appends nothing on the re-upsert', async () => {
    const methods = createCharactersMethods(db);
    const cast = await methods.create({
      sequenceId,
      characterId: 'voice_004',
      name: 'Nora',
      voiceId: 'talent-voice',
      voiceDescription: 'Gravelly',
    });
    const [original] = await methods.listVoiceVersions(cast.id);
    expect(original?.source).toBe('library');
    expect(original?.voiceId).toBe('talent-voice');

    // The References stage re-upserts the same row; history must not grow and
    // the `coalesce` keeps the voice the row already holds.
    const again = await methods.create({
      sequenceId,
      characterId: 'voice_004',
      name: 'Nora',
      voiceId: 'other-voice',
      sheetStatus: 'generating',
    });
    expect(again.voiceId).toBe('talent-voice');
    expect(await methods.listVoiceVersions(cast.id)).toHaveLength(1);
  });

  it('update refuses a voice field, and a bible description edit records one', async () => {
    const methods = createCharactersMethods(db);
    const created = await methods.create({
      sequenceId,
      characterId: 'voice_005',
      name: 'Pia',
    });
    await expect(
      // @ts-expect-error -- the point: a voice write needs updateVoice's source
      methods.update(created.id, { voiceId: 'nope' })
    ).rejects.toThrow(/updateVoice/);
    expect(await methods.listVoiceVersions(created.id)).toHaveLength(0);

    await methods.updateBible(
      created.id,
      { voiceDescription: 'Clipped, dry' },
      { actorId }
    );
    const versions = await methods.listVoiceVersions(created.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.source).toBe('user-edit');
    expect(versions[0]?.description).toBe('Clipped, dry');

    // Re-posting the same description is not a new take.
    await methods.updateBible(
      created.id,
      { voiceDescription: 'Clipped, dry', age: '40s' },
      { actorId }
    );
    expect(await methods.listVoiceVersions(created.id)).toHaveLength(1);
  });

  it('updateBible writes the fields and an atomic character.updated event carrying prevState', async () => {
    const m = createCharactersMethods(db);
    const created = await m.create({
      sequenceId,
      characterId: 'char_001',
      name: 'Alice',
      physicalDescription: 'tall, brown hair',
      sheetStatus: 'completed',
    });

    const updated = await m.updateBible(
      created.id,
      { physicalDescription: 'short, red hair', age: '40s' },
      { actorId }
    );
    expect(updated.physicalDescription).toBe('short, red hair');
    expect(updated.age).toBe('40s');
    expect(updated.name).toBe('Alice');

    const [event] = await db
      .select()
      .from(sequenceEvents)
      .where(eq(sequenceEvents.kind, 'character.updated'));
    expect(event?.targetId).toBe(created.id);
    expect(event?.data).toEqual({
      prevState: { physicalDescription: 'tall, brown hair', age: null },
    });
  });

  it('softDelete hides the row from every default list but keeps it by id; restore is lossless', async () => {
    const m = createCharactersMethods(db);
    const created = await m.create({
      sequenceId,
      characterId: 'char_001',
      name: 'Alice',
      physicalDescription: 'tall, brown hair',
      sheetStatus: 'completed',
    });
    // The sheet lives on the version row (#1419), keyed to the character's id.
    await db.insert(characterSheetVariants).values({
      id: created.id,
      characterId: created.id,
      model: 'prior',
      url: 'https://r2/alice.png',
      status: 'completed',
      inputHash: 'sheet-hash-v1',
    });

    const deletedAt = await m.softDelete(created.id, { actorId });
    expect(deletedAt).toBeInstanceOf(Date);
    // Idempotent — repeat returns the stored timestamp (second precision:
    // integer timestamp columns round-trip without millis), no second event.
    const repeat = await m.softDelete(created.id, { actorId });
    expect(Math.floor(repeat.getTime() / 1000)).toBe(
      Math.floor(deletedAt.getTime() / 1000)
    );

    expect(await m.list(sequenceId)).toHaveLength(0);
    expect(await m.listWithTalent(sequenceId)).toHaveLength(0);
    expect(await m.listWithSheets(sequenceId)).toHaveLength(0);
    expect(await m.getNeedingSheets(sequenceId)).toHaveLength(0);
    // Id-addressed reads still reach it (restore, admin).
    expect((await m.getById(created.id))?.deletedAt).toBeInstanceOf(Date);

    const restored = await m.restore(created.id, { actorId });
    expect(restored.deletedAt).toBeNull();
    // Lossless: bible fields AND the sheet's prior hash survived the round
    // trip — restore comes back with its old hashes (may honestly read stale
    // if upstream moved while deleted).
    expect(restored.physicalDescription).toBe('tall, brown hair');
    // Read back resolved: `restore` returns the raw row, which no longer
    // carries the sheet (#1419).
    expect((await m.getById(created.id))?.sheetInputHash).toBe('sheet-hash-v1');
    expect(await m.list(sequenceId)).toHaveLength(1);

    const kinds = await eventKinds();
    expect(kinds.filter((k) => k === 'character.deleted')).toHaveLength(1);
    expect(kinds).toContain('character.restored');
  });

  it('derived staleness: a bible edit moves the visual-prompt hash, a consistencyTag edit does NOT (#867)', async () => {
    const m = createCharactersMethods(db);
    const created = await m.create({
      sequenceId,
      characterId: 'char_001',
      name: 'Alice',
      physicalDescription: 'tall, brown hair',
      consistencyTag: 'char_001: alice-red-coat',
      sheetStatus: 'completed',
    });
    const before = await liveVisualPromptHash();

    // consistencyTag is deliberately projected OUT of the prompt hash — it is
    // an identity token, and folding it in re-staled every prompt on a recast.
    await m.updateBible(
      created.id,
      { consistencyTag: 'char_001: alice-blue-coat' },
      { actorId }
    );
    expect(await liveVisualPromptHash()).toBe(before);

    // A projected field does move it, so prompts read stale by derivation.
    await m.updateBible(
      created.id,
      { physicalDescription: 'short, red hair' },
      { actorId }
    );
    expect(await liveVisualPromptHash()).not.toBe(before);

    // …and the write path stamped no hash of its own — staleness stays derived.
    const row = await m.getById(created.id);
    expect(row?.sheetInputHash).toBeNull();
  });

  it('derived staleness: soft-removing a character moves the visual-prompt hash; restore puts it back', async () => {
    const m = createCharactersMethods(db);
    const created = await m.create({
      sequenceId,
      characterId: 'char_001',
      name: 'Alice',
      physicalDescription: 'tall, brown hair',
      sheetStatus: 'completed',
    });
    const withCast = await liveVisualPromptHash();

    await m.softDelete(created.id, { actorId });
    const withoutCast = await liveVisualPromptHash();
    expect(withoutCast).not.toBe(withCast);

    // Restore is lossless all the way through the hash: prompts that were
    // fresh before the removal are fresh again, not permanently re-staled.
    await m.restore(created.id, { actorId });
    expect(await liveVisualPromptHash()).toBe(withCast);
  });

  it('bible edit and soft-remove move the DERIVED live prompt hash; restore moves it back', async () => {
    const m = createCharactersMethods(db);
    const created = await m.create({
      sequenceId,
      characterId: 'char_001',
      name: 'Alice',
      physicalDescription: 'tall, brown hair',
      sheetStatus: 'completed',
    });

    const stamped = await liveVisualPromptHash();
    await m.updateBible(
      created.id,
      { physicalDescription: 'short, red hair' },
      { actorId }
    );
    const afterEdit = await liveVisualPromptHash();
    expect(afterEdit).not.toBe(stamped);

    await m.softDelete(created.id, { actorId });
    const afterDelete = await liveVisualPromptHash();
    expect(afterDelete).not.toBe(afterEdit);

    // Restore returns the exact prior live hash — nothing was rewritten.
    await m.restore(created.id, { actorId });
    expect(await liveVisualPromptHash()).toBe(afterEdit);
  });

  it('a re-analysis upsert on the same characterId revives a soft-deleted character', async () => {
    const m = createCharactersMethods(db);
    const created = await m.create({
      sequenceId,
      characterId: 'char_001',
      name: 'Alice',
      sheetStatus: 'pending',
    });
    await m.softDelete(created.id, { actorId });
    expect(await m.list(sequenceId)).toHaveLength(0);

    // Storyboard re-extracts the character → same (sequenceId, characterId).
    await m.create({
      sequenceId,
      characterId: 'char_001',
      name: 'Alice',
      sheetStatus: 'pending',
    });
    const rows = await m.list(sequenceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deletedAt).toBeNull();
  });
});

describe('sequence locations bible CRUD + soft-remove', () => {
  it('updateBible writes the fields and an atomic location.updated event carrying prevState', async () => {
    const m = createSequenceLocationsMethods(db);
    const created = await m.create({
      sequenceId,
      locationId: 'loc_001',
      name: 'Beach',
      description: 'white sand',
      referenceStatus: 'completed',
    });

    const updated = await m.updateBible(
      created.id,
      { description: 'black volcanic sand', ambiance: 'stormy' },
      { actorId }
    );
    expect(updated.description).toBe('black volcanic sand');
    expect(updated.ambiance).toBe('stormy');

    const [event] = await db
      .select()
      .from(sequenceEvents)
      .where(eq(sequenceEvents.kind, 'location.updated'));
    expect(event?.targetId).toBe(created.id);
    expect(event?.data).toEqual({
      prevState: { description: 'white sand', ambiance: null },
    });
  });

  it('softDelete hides the row from default lists and the team library; restore brings it back', async () => {
    const m = createSequenceLocationsMethods(db);
    const [seq] = await db.select().from(sequences);
    if (!seq) throw new Error('test setup: sequence missing');
    const created = await m.create({
      sequenceId,
      locationId: 'loc_001',
      name: 'Beach',
      referenceStatus: 'completed',
    });

    await m.softDelete(created.id, { actorId });
    expect(await m.list(sequenceId)).toHaveLength(0);
    expect(await m.listWithReferences(sequenceId)).toHaveLength(0);
    expect(await m.getNeedingReferences(sequenceId)).toHaveLength(0);
    expect(await m.getTeamLibrary(seq.teamId)).toHaveLength(0);
    expect((await m.getById(created.id))?.deletedAt).toBeInstanceOf(Date);

    const restored = await m.restore(created.id, { actorId });
    expect(restored.deletedAt).toBeNull();
    expect(await m.list(sequenceId)).toHaveLength(1);
    expect(await m.getTeamLibrary(seq.teamId)).toHaveLength(1);

    const kinds = await eventKinds();
    expect(kinds).toContain('location.deleted');
    expect(kinds).toContain('location.restored');
  });

  it('createBulk upsert revives a soft-deleted location', async () => {
    const m = createSequenceLocationsMethods(db);
    const created = await m.create({
      sequenceId,
      locationId: 'loc_001',
      name: 'Beach',
      referenceStatus: 'pending',
    });
    await m.softDelete(created.id, { actorId });

    await m.createBulk([
      {
        sequenceId,
        locationId: 'loc_001',
        name: 'Beach',
        referenceStatus: 'pending',
      },
    ]);
    const rows = await m.list(sequenceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deletedAt).toBeNull();
  });
});

describe('sequence elements soft-remove (#1108 item 6)', () => {
  it('softDelete hides the element from list + shot counts but keeps the row; restore brings it back', async () => {
    const m = createSequenceElementsMethods(db);
    const created = await m.create({
      id: generateId(),
      sequenceId,
      uploadedFilename: 'logo.png',
      token: 'logo',
      imageUrl: '/r2/elements/t/logo.png',
      imagePath: 't/logo.png',
      visionStatus: 'completed',
    });

    const deletedAt = await m.softDelete(created.id, { actorId });
    expect(deletedAt).toBeInstanceOf(Date);
    expect(await m.list(sequenceId)).toHaveLength(0);
    expect(await m.getShotCountsByElement(sequenceId)).toEqual({});
    // Row + bytes retained; id-addressed read still reaches it.
    expect((await m.getById(created.id))?.deletedAt).toBeInstanceOf(Date);

    // Token uniqueness still counts the deleted row — a new upload cannot
    // steal 'logo' while a restore could bring it back.
    expect(await m.isTokenTaken(sequenceId, 'logo')).toBe(true);

    const restored = await m.restore(created.id, { actorId });
    expect(restored.deletedAt).toBeNull();
    expect(await m.list(sequenceId)).toHaveLength(1);

    const kinds = (await db.select().from(sequenceEvents)).map((r) => r.kind);
    expect(kinds).toContain('element.deleted');
    expect(kinds).toContain('element.restored');
  });
});
