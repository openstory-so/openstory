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
import { clearVersionRows } from '@/platform/server/test/clear-version-rows';

import { charactersToBible } from '@/cast/server/bibles-from-scoped';
import { hashVisualPromptInput } from '@/shots/input-hash';
import type { StyleConfig } from '@/platform/server/db/schema';
import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import { newSeedVoiceId } from '@/cast/seed-voice';
import {
  characterBibleVersions,
  characterLookVersions,
  characterLooks,
  characterSheetVariants,
  characterVoiceVersions,
  characters,
  locationBibleVersions,
  sequenceCast,
  sequenceCastLooks,
  sequenceElements,
  sequenceEvents,
  sequenceLocations,
  sequenceStyleVersions,
  sequences,
  styles,
  talent,
  teams,
  user,
} from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCharacterLooksMethods } from './character-looks';
import { createCharacterSheetVariantsMethods } from './character-sheet-variants';
import { createCharactersMethods } from './characters';
import { createSequenceElementsMethods } from './sequence-elements';
import { createSequenceLocationsMethods } from './sequence-locations';
import { createSequencesMethods } from '@/sequences/server/db/sequences';

/** A hard delete of characters that hold no saved voice. */
const NO_VOICES = { releasedVoiceIds: [] };

let client: Client;
let db: Database;
let sequenceId = '';
let teamId = '';
let actorId = '';

async function seed() {
  await clearVersionRows(db);
  await db.delete(sequenceEvents);
  await db.delete(characterVoiceVersions);
  await db.delete(characters);
  await db.delete(sequenceElements);
  await db.delete(sequenceLocations);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  teamId = generateId();
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
  const cast = await createCharactersMethods(db, teamId).listWithSheets(
    sequenceId
  );
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
    const methods = createCharactersMethods(db, teamId);
    const created = await methods.create(
      {
        sequenceId,
        characterId: 'voice_001',
        name: 'Maya',
        voiceDescription: 'Warm Australian alto',
      },
      { source: 'analysis', createdBy: null }
    );
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
    const methods = createCharactersMethods(db, teamId);
    const created = await methods.create(
      {
        sequenceId,
        characterId: 'voice_unusable',
        name: 'Maya',
      },
      { source: 'analysis', createdBy: null }
    );
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
    const methods = createCharactersMethods(db, teamId);
    const created = await methods.create(
      {
        sequenceId,
        characterId: 'voice_husk',
        name: 'Maya',
      },
      { source: 'analysis', createdBy: null }
    );
    const before = await methods.listVoiceVersions(created.id);
    const { version: husk } = await methods.createPendingVoiceClaim(
      created.id,
      actorId
    );
    expect(husk.status).toBe('generating');
    expect(husk.source).toBe('generated');
    expect(husk.voiceId).toBeNull();
    const live = await methods.getById(sequenceId, created.id);
    expect(live?.pendingPromoteVoiceVersionId).toBe(husk.id);
    expect(await methods.listVoiceVersions(created.id)).toHaveLength(
      before.length + 1
    );
    expect(await methods.listLiveVoiceClaims(created.id)).toEqual([
      expect.objectContaining({ id: husk.id, status: 'generating' }),
    ]);
  });

  it('returns the existing live husk instead of inserting a second (#1715)', async () => {
    const methods = createCharactersMethods(db, teamId);
    const created = await methods.create(
      {
        sequenceId,
        characterId: 'voice_husk_unique',
        name: 'Maya',
      },
      { source: 'analysis', createdBy: null }
    );
    const first = await methods.createPendingVoiceClaim(created.id, actorId);
    const second = await methods.createPendingVoiceClaim(created.id, actorId);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.version.id).toBe(first.version.id);
    expect(await methods.listLiveVoiceClaims(created.id)).toHaveLength(1);
  });

  it('does not touch the live voice while a husk is inserted or completed (#1715)', async () => {
    const methods = createCharactersMethods(db, teamId);
    const created = await methods.create(
      {
        sequenceId,
        characterId: 'voice_husk_keep_live',
        name: 'Maya',
      },
      { source: 'analysis', createdBy: null }
    );
    const saved = await methods.updateVoice(
      created.id,
      { voiceId: 'voice-old', voiceDescription: 'Original' },
      'generated',
      actorId
    );
    const { version: husk } = await methods.createPendingVoiceClaim(
      created.id,
      actorId
    );
    const afterInsert = await methods.getById(sequenceId, created.id);
    expect(afterInsert?.voiceId).toBe('voice-old');
    expect(afterInsert?.selectedVoiceVersionId).toBe(
      saved.selectedVoiceVersionId
    );
    expect(afterInsert?.pendingPromoteVoiceVersionId).toBe(husk.id);
    await methods.completeVoiceClaimIfLive(husk.id, { voiceId: 'voice-new' });
    const afterComplete = await methods.getById(sequenceId, created.id);
    expect(afterComplete?.voiceId).toBe('voice-old');
    expect(afterComplete?.selectedVoiceVersionId).toBe(
      saved.selectedVoiceVersionId
    );
    const promoted = await methods.promoteVoiceClaimIfPending(
      created.id,
      husk.id
    );
    expect(promoted?.voiceId).toBe('voice-new');
    expect(promoted?.selectedVoiceVersionId).toBe(husk.id);
  });

  it('completes a live husk in place without appending history (#1715)', async () => {
    const methods = createCharactersMethods(db, teamId);
    const created = await methods.create(
      {
        sequenceId,
        characterId: 'voice_husk_complete',
        name: 'Maya',
      },
      { source: 'analysis', createdBy: null }
    );
    const { version: husk } = await methods.createPendingVoiceClaim(
      created.id,
      actorId
    );
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
    const methods = createCharactersMethods(db, teamId);
    const created = await methods.create(
      {
        sequenceId,
        characterId: 'voice_husk_fail',
        name: 'Maya',
      },
      { source: 'analysis', createdBy: null }
    );
    const { version: husk } = await methods.createPendingVoiceClaim(
      created.id,
      actorId
    );
    const failed = await methods.markVoiceClaimTerminal(
      husk.id,
      'failed',
      'Voice Design returned no previews'
    );
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('Voice Design returned no previews');
    const after = await methods.getById(sequenceId, created.id);
    expect(after?.pendingPromoteVoiceVersionId).toBeNull();
    expect(
      await methods.completeVoiceClaimIfLive(husk.id, { voiceId: 'voice-x' })
    ).toBeNull();
  });

  it('clears pending-promote when selecting a different completed voice (#1715)', async () => {
    const methods = createCharactersMethods(db, teamId);
    const created = await methods.create(
      {
        sequenceId,
        characterId: 'voice_husk_demote',
        name: 'Maya',
      },
      { source: 'analysis', createdBy: null }
    );
    const saved = await methods.updateVoice(
      created.id,
      { voiceId: 'voice-a', voiceDescription: 'Original' },
      'generated',
      actorId
    );
    const { version: husk } = await methods.createPendingVoiceClaim(
      created.id,
      actorId
    );
    expect(
      (await methods.getById(sequenceId, created.id))
        ?.pendingPromoteVoiceVersionId
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

  it('promotes a completed husk only while pending-promote still names it (#1715)', async () => {
    const methods = createCharactersMethods(db, teamId);
    const created = await methods.create(
      {
        sequenceId,
        characterId: 'voice_husk_promote',
        name: 'Maya',
      },
      { source: 'analysis', createdBy: null }
    );
    await methods.updateVoice(
      created.id,
      { voiceId: 'voice-old', voiceDescription: 'Original' },
      'generated',
      actorId
    );
    const { version: husk } = await methods.createPendingVoiceClaim(
      created.id,
      actorId
    );
    await methods.completeVoiceClaimIfLive(husk.id, {
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
    const promoted = await methods.promoteVoiceClaimIfPending(
      created.id,
      husk.id
    );
    expect(promoted?.voiceId).toBe('voice-new');
    expect(promoted?.selectedVoiceVersionId).toBe(husk.id);
    expect(promoted?.pendingPromoteVoiceVersionId).toBeNull();
  });

  it('does not promote when the pointer moved mid-run (#1715)', async () => {
    const methods = createCharactersMethods(db, teamId);
    const created = await methods.create(
      {
        sequenceId,
        characterId: 'voice_husk_promote_demote',
        name: 'Maya',
      },
      { source: 'analysis', createdBy: null }
    );
    await methods.updateVoice(
      created.id,
      { voiceId: 'voice-old', voiceDescription: 'Original' },
      'generated',
      actorId
    );
    const { version: husk } = await methods.createPendingVoiceClaim(
      created.id,
      actorId
    );
    await methods.completeVoiceClaimIfLive(husk.id, {
      voiceId: 'voice-new',
    });
    await methods.updateVoice(
      created.id,
      { voiceId: 'voice-lib' },
      'library',
      actorId
    );
    expect(
      (await methods.getById(sequenceId, created.id))
        ?.pendingPromoteVoiceVersionId
    ).toBeNull();
    expect(
      await methods.promoteVoiceClaimIfPending(created.id, husk.id)
    ).toBeNull();
    const live = await methods.getById(sequenceId, created.id);
    expect(live?.voiceId).toBe('voice-lib');
    expect(live?.pendingPromoteVoiceVersionId).toBeNull();
  });

  it('does not promote a generating husk or a completed empty husk (#1715)', async () => {
    const methods = createCharactersMethods(db, teamId);
    const created = await methods.create(
      {
        sequenceId,
        characterId: 'voice_husk_promote_empty',
        name: 'Maya',
      },
      { source: 'analysis', createdBy: null }
    );
    const { version: husk } = await methods.createPendingVoiceClaim(
      created.id,
      actorId
    );
    expect(
      await methods.promoteVoiceClaimIfPending(created.id, husk.id)
    ).toBeNull();
    await methods.completeVoiceClaimIfLive(husk.id, { voiceId: null });
    expect(
      await methods.promoteVoiceClaimIfPending(created.id, husk.id)
    ).toBeNull();
  });

  it('clears pending-promote on a library updateVoice (#1715)', async () => {
    const methods = createCharactersMethods(db, teamId);
    const created = await methods.create(
      {
        sequenceId,
        characterId: 'voice_husk_library_demote',
        name: 'Maya',
      },
      { source: 'analysis', createdBy: null }
    );
    await methods.updateVoice(
      created.id,
      { voiceId: 'voice-a' },
      'generated',
      actorId
    );
    const { version: husk } = await methods.createPendingVoiceClaim(
      created.id,
      actorId
    );
    await methods.updateVoice(
      created.id,
      { voiceId: 'voice-lib' },
      'library',
      actorId
    );
    const live = await methods.getById(sequenceId, created.id);
    expect(live?.pendingPromoteVoiceVersionId).toBeNull();
    expect(live?.voiceId).toBe('voice-lib');
    expect(
      await methods.promoteVoiceClaimIfPending(created.id, husk.id)
    ).toBeNull();
  });

  it('refuses to select a generating voice husk (#1715)', async () => {
    const methods = createCharactersMethods(db, teamId);
    const created = await methods.create(
      {
        sequenceId,
        characterId: 'voice_husk_select',
        name: 'Maya',
      },
      { source: 'analysis', createdBy: null }
    );
    const { version: husk } = await methods.createPendingVoiceClaim(
      created.id,
      actorId
    );
    await expect(
      methods.selectVoiceVersion(created.id, husk.id)
    ).rejects.toThrow(/not finished/i);
  });

  it('refuses to select a completed husk with no voiceId (#1715)', async () => {
    const methods = createCharactersMethods(db, teamId);
    const created = await methods.create(
      {
        sequenceId,
        characterId: 'voice_husk_empty_select',
        name: 'Maya',
      },
      { source: 'analysis', createdBy: null }
    );
    const { version: husk } = await methods.createPendingVoiceClaim(
      created.id,
      actorId
    );
    await methods.completeVoiceClaimIfLive(husk.id, { voiceId: null });
    await expect(
      methods.selectVoiceVersion(created.id, husk.id)
    ).rejects.toThrow(/no saved take/i);
  });

  it('refuses a released voice version, across every character holding the id', async () => {
    const methods = createCharactersMethods(db, teamId);
    const maya = await methods.create(
      {
        sequenceId,
        characterId: 'voice_002',
        name: 'Maya',
      },
      { source: 'analysis', createdBy: null }
    );
    const otto = await methods.create(
      {
        sequenceId,
        characterId: 'voice_003',
        name: 'Otto',
      },
      { source: 'analysis', createdBy: null }
    );
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
    const unchanged = await methods.getById(sequenceId, maya.id);
    expect(unchanged?.voiceId).toBe('kept');

    // Another character's version is not this character's to select.
    const ottos = ottoVersions[0];
    if (!ottos) throw new Error('otto voice version missing');
    await expect(methods.selectVoiceVersion(maya.id, ottos.id)).rejects.toThrow(
      /not found for character/
    );
  });

  it('create labels a talent-copied voice library, and appends nothing on the re-upsert', async () => {
    const methods = createCharactersMethods(db, teamId);
    const cast = await methods.create(
      {
        sequenceId,
        characterId: 'voice_004',
        name: 'Nora',
        voiceId: 'talent-voice',
        voiceDescription: 'Gravelly',
      },
      { source: 'analysis', createdBy: null }
    );
    const [original] = await methods.listVoiceVersions(cast.id);
    expect(original?.source).toBe('library');
    expect(original?.voiceId).toBe('talent-voice');

    // The References stage re-upserts the same row; history must not grow and
    // the `coalesce` keeps the voice the row already holds.
    const again = await methods.create(
      {
        sequenceId,
        characterId: 'voice_004',
        name: 'Nora',
        voiceId: 'other-voice',
        sheetStatus: 'generating',
      },
      { source: 'analysis', createdBy: null }
    );
    expect(again.voiceId).toBe('talent-voice');
    expect(await methods.listVoiceVersions(cast.id)).toHaveLength(1);
  });

  it('a re-cast fills a voice id the selected version lacks, as a library version (#1788)', async () => {
    const methods = createCharactersMethods(db, teamId);
    const created = await methods.create(
      {
        sequenceId,
        characterId: 'voice_fill',
        name: 'Lia',
        voiceDescription: 'Bright',
      },
      { source: 'analysis', createdBy: null }
    );
    expect(created.voiceDescription).toBe('Bright');
    const recast = await methods.create(
      {
        sequenceId,
        characterId: 'voice_fill',
        name: 'Lia',
        voiceId: 'talent-voice',
        voiceDescription: 'Husky',
      },
      { source: 'analysis', createdBy: null }
    );
    // The id is new, the description the character already had wins.
    expect(recast.voiceId).toBe('talent-voice');
    expect(recast.voiceDescription).toBe('Bright');
    const versions = await methods.listVoiceVersions(created.id);
    expect(versions.map((v) => v.source)).toEqual(['library', 'analysis']);
    expect(recast.selectedVoiceVersionId).toBe(versions[0]?.id);
  });

  it('counts voice references through the selected version, soft-deleted included (#1788)', async () => {
    const methods = createCharactersMethods(db, teamId);
    const shared = 'shared-voice';
    const live = await methods.create(
      { sequenceId, characterId: 'ref_live', name: 'A', voiceId: shared },
      { source: 'analysis', createdBy: null }
    );
    const deleted = await methods.create(
      { sequenceId, characterId: 'ref_deleted', name: 'B', voiceId: shared },
      { source: 'analysis', createdBy: null }
    );
    await methods.softDelete(sequenceId, deleted.id, { actorId });
    // A completed version holding the id, but no longer selected: not a
    // reference — only the selected row is the character's voice.
    const moved = await methods.create(
      { sequenceId, characterId: 'ref_moved', name: 'C', voiceId: shared },
      { source: 'analysis', createdBy: null }
    );
    await methods.updateVoice(moved.id, { voiceId: 'other' }, 'library', null);
    const [seq] = await db
      .select({ teamId: sequences.teamId })
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!seq) throw new Error('test setup: sequence missing');
    await db
      .insert(talent)
      .values({ teamId: seq.teamId, name: 'T', voiceId: shared });

    expect(live.voiceId).toBe(shared);
    expect(await methods.getVoiceReferenceCount(shared)).toBe(3);
    expect(await methods.getVoiceReferenceCount('other')).toBe(1);
    expect(await methods.getVoiceReferenceCount('nobody')).toBe(0);
  });

  it('update refuses a voice field, and a bible description edit records one', async () => {
    const methods = createCharactersMethods(db, teamId);
    const created = await methods.create(
      {
        sequenceId,
        characterId: 'voice_005',
        name: 'Pia',
      },
      { source: 'analysis', createdBy: null }
    );
    await expect(
      // @ts-expect-error -- the point: a voice write needs updateVoice's source
      methods.update(created.id, { voiceId: 'nope' })
    ).rejects.toThrow(/updateVoice/);
    expect(await methods.listVoiceVersions(created.id)).toHaveLength(0);

    await methods.updateBible(
      sequenceId,
      created.id,
      { voiceDescription: 'Clipped, dry' },
      { source: 'edit', actorId }
    );
    const versions = await methods.listVoiceVersions(created.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.source).toBe('user-edit');
    expect(versions[0]?.description).toBe('Clipped, dry');

    // Re-posting the same description is not a new take.
    await methods.updateBible(
      sequenceId,
      created.id,
      { voiceDescription: 'Clipped, dry', age: '40s' },
      { source: 'edit', actorId }
    );
    expect(await methods.listVoiceVersions(created.id)).toHaveLength(1);
  });

  it('updateBible writes the fields and an atomic character.updated event carrying prevState', async () => {
    const m = createCharactersMethods(db, teamId);
    const created = await m.create(
      {
        sequenceId,
        characterId: 'char_001',
        name: 'Alice',
        physicalDescription: 'tall, brown hair',
        sheetStatus: 'completed',
      },
      { source: 'analysis', createdBy: null }
    );

    const updated = await m.updateBible(
      sequenceId,
      created.id,
      { physicalDescription: 'short, red hair', age: '40s' },
      { source: 'edit', actorId }
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
    const m = createCharactersMethods(db, teamId);
    const created = await m.create(
      {
        sequenceId,
        characterId: 'char_001',
        name: 'Alice',
        physicalDescription: 'tall, brown hair',
        sheetStatus: 'completed',
      },
      { source: 'analysis', createdBy: null }
    );
    // The sheet lives on the version row (#1419), keyed to the character's id.
    await db.insert(characterSheetVariants).values({
      id: created.id,
      characterId: created.id,
      model: 'prior',
      url: 'https://r2/alice.png',
      status: 'completed',
      inputHash: 'sheet-hash-v1',
    });

    const deletedAt = await m.softDelete(sequenceId, created.id, { actorId });
    expect(deletedAt).toBeInstanceOf(Date);
    // Idempotent — repeat returns the stored timestamp (second precision:
    // integer timestamp columns round-trip without millis), no second event.
    const repeat = await m.softDelete(sequenceId, created.id, { actorId });
    expect(Math.floor(repeat.getTime() / 1000)).toBe(
      Math.floor(deletedAt.getTime() / 1000)
    );

    expect(await m.list(sequenceId)).toHaveLength(0);
    expect(await m.listWithTalent(sequenceId)).toHaveLength(0);
    expect(await m.listWithSheets(sequenceId)).toHaveLength(0);
    expect(await m.getNeedingSheets(sequenceId)).toHaveLength(0);
    // Id-addressed reads still reach it (restore, admin).
    expect((await m.getById(sequenceId, created.id))?.deletedAt).toBeInstanceOf(
      Date
    );

    const restored = await m.restore(sequenceId, created.id, { actorId });
    expect(restored.deletedAt).toBeNull();
    // Lossless: bible fields AND the sheet's prior hash survived the round
    // trip — restore comes back with its old hashes (may honestly read stale
    // if upstream moved while deleted).
    expect(restored.physicalDescription).toBe('tall, brown hair');
    // Read back resolved: `restore` returns the raw row, which no longer
    // carries the sheet (#1419).
    expect((await m.getById(sequenceId, created.id))?.sheetInputHash).toBe(
      'sheet-hash-v1'
    );
    expect(await m.list(sequenceId)).toHaveLength(1);

    const kinds = await eventKinds();
    expect(kinds.filter((k) => k === 'character.deleted')).toHaveLength(1);
    expect(kinds).toContain('character.restored');
  });

  it('derived staleness: a bible edit moves the visual-prompt hash, a consistencyTag edit does NOT (#867)', async () => {
    const m = createCharactersMethods(db, teamId);
    const created = await m.create(
      {
        sequenceId,
        characterId: 'char_001',
        name: 'Alice',
        physicalDescription: 'tall, brown hair',
        consistencyTag: 'char_001: alice-red-coat',
        sheetStatus: 'completed',
      },
      { source: 'analysis', createdBy: null }
    );
    const before = await liveVisualPromptHash();

    // consistencyTag is deliberately projected OUT of the prompt hash — it is
    // an identity token, and folding it in re-staled every prompt on a recast.
    await m.updateBible(
      sequenceId,
      created.id,
      { consistencyTag: 'char_001: alice-blue-coat' },
      { source: 'edit', actorId }
    );
    expect(await liveVisualPromptHash()).toBe(before);

    // A projected field does move it, so prompts read stale by derivation.
    await m.updateBible(
      sequenceId,
      created.id,
      { physicalDescription: 'short, red hair' },
      { source: 'edit', actorId }
    );
    expect(await liveVisualPromptHash()).not.toBe(before);

    // …and the write path stamped no hash of its own — staleness stays derived.
    const row = await m.getById(sequenceId, created.id);
    expect(row?.sheetInputHash).toBeNull();
  });

  it('derived staleness: soft-removing a character moves the visual-prompt hash; restore puts it back', async () => {
    const m = createCharactersMethods(db, teamId);
    const created = await m.create(
      {
        sequenceId,
        characterId: 'char_001',
        name: 'Alice',
        physicalDescription: 'tall, brown hair',
        sheetStatus: 'completed',
      },
      { source: 'analysis', createdBy: null }
    );
    const withCast = await liveVisualPromptHash();

    await m.softDelete(sequenceId, created.id, { actorId });
    const withoutCast = await liveVisualPromptHash();
    expect(withoutCast).not.toBe(withCast);

    // Restore is lossless all the way through the hash: prompts that were
    // fresh before the removal are fresh again, not permanently re-staled.
    await m.restore(sequenceId, created.id, { actorId });
    expect(await liveVisualPromptHash()).toBe(withCast);
  });

  it('bible edit and soft-remove move the DERIVED live prompt hash; restore moves it back', async () => {
    const m = createCharactersMethods(db, teamId);
    const created = await m.create(
      {
        sequenceId,
        characterId: 'char_001',
        name: 'Alice',
        physicalDescription: 'tall, brown hair',
        sheetStatus: 'completed',
      },
      { source: 'analysis', createdBy: null }
    );

    const stamped = await liveVisualPromptHash();
    await m.updateBible(
      sequenceId,
      created.id,
      { physicalDescription: 'short, red hair' },
      { source: 'edit', actorId }
    );
    const afterEdit = await liveVisualPromptHash();
    expect(afterEdit).not.toBe(stamped);

    await m.softDelete(sequenceId, created.id, { actorId });
    const afterDelete = await liveVisualPromptHash();
    expect(afterDelete).not.toBe(afterEdit);

    // Restore returns the exact prior live hash — nothing was rewritten.
    await m.restore(sequenceId, created.id, { actorId });
    expect(await liveVisualPromptHash()).toBe(afterEdit);
  });

  it('a re-analysis upsert on the same characterId revives a soft-deleted character', async () => {
    const m = createCharactersMethods(db, teamId);
    const created = await m.create(
      {
        sequenceId,
        characterId: 'char_001',
        name: 'Alice',
        sheetStatus: 'pending',
      },
      { source: 'analysis', createdBy: null }
    );
    await m.softDelete(sequenceId, created.id, { actorId });
    expect(await m.list(sequenceId)).toHaveLength(0);

    // Storyboard re-extracts the character → same (sequenceId, characterId).
    await m.create(
      {
        sequenceId,
        characterId: 'char_001',
        name: 'Alice',
        sheetStatus: 'pending',
      },
      { source: 'analysis', createdBy: null }
    );
    const rows = await m.list(sequenceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deletedAt).toBeNull();
  });
});

describe('sequence locations bible CRUD + soft-remove', () => {
  it('updateBible writes the fields and an atomic location.updated event carrying prevState', async () => {
    const m = createSequenceLocationsMethods(db);
    const created = await m.create(
      {
        sequenceId,
        locationId: 'loc_001',
        name: 'Beach',
        description: 'white sand',
        referenceStatus: 'completed',
      },
      { source: 'analysis', createdBy: null }
    );

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
    const created = await m.create(
      {
        sequenceId,
        locationId: 'loc_001',
        name: 'Beach',
        referenceStatus: 'completed',
      },
      { source: 'analysis', createdBy: null }
    );

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
    const created = await m.create(
      {
        sequenceId,
        locationId: 'loc_001',
        name: 'Beach',
        referenceStatus: 'pending',
      },
      { source: 'analysis', createdBy: null }
    );
    await m.softDelete(created.id, { actorId });

    await m.createBulk(
      [
        {
          sequenceId,
          locationId: 'loc_001',
          name: 'Beach',
          referenceStatus: 'pending',
        },
      ],
      { source: 'analysis', createdBy: null }
    );
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

describe('bible history (#1600)', () => {
  const characterVersions = async (characterId: string) =>
    await db
      .select()
      .from(characterBibleVersions)
      .where(eq(characterBibleVersions.characterId, characterId));
  const locationVersions = async (locationId: string) =>
    await db
      .select()
      .from(locationBibleVersions)
      .where(eq(locationBibleVersions.locationId, locationId));
  const analysis = { source: 'analysis', createdBy: null } as const;

  it('a create appends the first version and points at it', async () => {
    const m = createCharactersMethods(db, teamId);
    const created = await m.create(
      {
        sequenceId,
        characterId: 'char_001',
        name: 'Ada',
        standardClothing: 'coat',
      },
      analysis
    );
    const [first] = await characterVersions(created.id);
    expect(first).toMatchObject({
      name: 'Ada',
      voiceOnly: false,
      isPerson: true,
      source: 'analysis',
    });
    expect(created.selectedBibleVersionId).toBe(first?.id);
    // The clothing is its default look's (#2015), not the bible's.
    expect(created).toMatchObject({
      standardClothing: 'coat',
      looks: [{ id: created.id, isDefault: true, clothing: 'coat' }],
    });
  });

  it('a re-analysis appends only when a field moved, keeping what it left out', async () => {
    const m = createCharactersMethods(db, teamId);
    const input = {
      sequenceId,
      characterId: 'char_001',
      name: 'Ada',
      standardClothing: 'coat',
      personality: 'wry',
    };
    const created = await m.create(input, analysis);
    await m.create(input, analysis);
    expect(await characterVersions(created.id)).toHaveLength(1);

    const moved = await m.create(
      { sequenceId, characterId: 'char_001', name: 'Ada', age: '40s' },
      analysis
    );
    expect(await characterVersions(created.id)).toHaveLength(2);
    expect(moved).toMatchObject({
      age: '40s',
      standardClothing: 'coat',
      personality: 'wry',
    });
  });

  it('an edit appends a version by its author; a no-op edit appends none', async () => {
    const m = createCharactersMethods(db, teamId);
    const created = await m.create(
      { sequenceId, characterId: 'char_001', name: 'Ada' },
      analysis
    );
    const edited = await m.updateBible(
      sequenceId,
      created.id,
      { age: '40s' },
      { actorId, source: 'edit' }
    );
    expect(edited.age).toBe('40s');
    const versions = await characterVersions(created.id);
    expect(versions).toHaveLength(2);
    expect(
      versions.find((v) => v.id === edited.selectedBibleVersionId)
    ).toMatchObject({ source: 'edit', createdBy: actorId });

    await m.updateBible(
      sequenceId,
      created.id,
      { age: '40s' },
      { actorId, source: 'edit' }
    );
    expect(await characterVersions(created.id)).toHaveLength(2);
  });

  it('a clothing edit appends a look version, not a bible version (#2015)', async () => {
    const m = createCharactersMethods(db, teamId);
    const looks = createCharacterLooksMethods(db, teamId);
    const created = await m.create(
      { sequenceId, characterId: 'char_001', name: 'Ada' },
      analysis
    );
    const edited = await m.updateBible(
      sequenceId,
      created.id,
      { standardClothing: 'dress' },
      { actorId, source: 'edit' }
    );
    expect(edited.standardClothing).toBe('dress');
    expect(await characterVersions(created.id)).toHaveLength(1);
    const versions = await looks.listVersions(created.lookId);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({
      clothing: 'dress',
      source: 'edit',
      createdBy: actorId,
    });

    await m.updateBible(
      sequenceId,
      created.id,
      { standardClothing: 'dress' },
      { actorId, source: 'edit' }
    );
    expect(await looks.listVersions(created.lookId)).toHaveLength(2);

    // A re-analysis that moves the clothing appends one too.
    await m.create(
      {
        sequenceId,
        characterId: 'char_001',
        name: 'Ada',
        standardClothing: 'gown',
      },
      analysis
    );
    expect((await looks.listVersions(created.lookId))[0]).toMatchObject({
      clothing: 'gown',
      source: 'analysis',
    });
  });

  it('locations: create, bulk re-analysis and edits append the same way', async () => {
    const m = createSequenceLocationsMethods(db);
    const created = await m.create(
      { sequenceId, locationId: 'loc_001', name: 'Diner', description: 'old' },
      analysis
    );
    await m.createBulk(
      [
        {
          sequenceId,
          locationId: 'loc_001',
          name: 'Diner',
          description: 'old',
        },
      ],
      analysis
    );
    expect(await locationVersions(created.id)).toHaveLength(1);

    const edited = await m.updateBible(
      created.id,
      { architecturalStyle: 'modern' },
      { actorId }
    );
    expect(edited).toMatchObject({
      description: 'old',
      architecturalStyle: 'modern',
    });
    const versions = await locationVersions(created.id);
    expect(versions).toHaveLength(2);
    expect(
      versions.find((v) => v.id === edited.selectedBibleVersionId)
    ).toMatchObject({ source: 'edit', createdBy: actorId });
  });
});

describe('hard deletes clear the #1600 version rows they RESTRICT', () => {
  it('characters, locations and the sequence delete with their versions', async () => {
    const chars = createCharactersMethods(db, teamId);
    const locs = createSequenceLocationsMethods(db);
    const opts = { source: 'analysis' as const, createdBy: null };
    const [a, b] = await Promise.all(
      ['Ann', 'Bo'].map((name, i) =>
        chars.create({ sequenceId, characterId: `char_${i}`, name }, opts)
      )
    );
    const [x, y] = await locs.createBulk(
      ['Beach', 'Diner'].map((name, i) => ({
        sequenceId,
        locationId: `loc_${i}`,
        name,
        referenceStatus: 'pending' as const,
      })),
      opts
    );
    if (!a || !b || !x || !y) throw new Error('test setup: create failed');

    expect(await chars.delete(a.id, NO_VOICES)).toBe(true);
    expect(await locs.delete(x.id)).toBe(true);

    const [sequence] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!sequence) throw new Error('test setup: no sequence');
    await db.insert(sequenceStyleVersions).values({
      id: sequenceId,
      sequenceId,
      styleId: sequence.styleId,
      config: STYLE_CONFIG,
      source: 'backfill',
    });
    await createSequencesMethods(db, sequence.teamId, actorId).delete(
      sequenceId,
      NO_VOICES
    );

    expect(await db.select().from(characterBibleVersions)).toEqual([]);
    expect(await db.select().from(sequenceCast)).toEqual([]);
    expect(await db.select().from(characters)).toEqual([]);
    expect(await db.select().from(locationBibleVersions)).toEqual([]);
    expect(await db.select().from(sequenceStyleVersions)).toEqual([]);
    expect(await db.select().from(sequences)).toEqual([]);
  });
});

describe('team characters (#2017)', () => {
  const analysis = { source: 'analysis', createdBy: null } as const;
  const chars = () => createCharactersMethods(db, teamId);
  const looks = () => createCharacterLooksMethods(db, teamId);
  const linksOf = async (characterId: string) =>
    await db
      .select()
      .from(sequenceCast)
      .where(eq(sequenceCast.characterId, characterId));
  const versionsOf = async (characterId: string) =>
    await db
      .select()
      .from(characterBibleVersions)
      .where(eq(characterBibleVersions.characterId, characterId));
  const newTalent = async () => {
    const [row] = await db
      .insert(talent)
      .values({ teamId, name: 'Talent' })
      .returning();
    if (!row) throw new Error('test setup: talent insert returned nothing');
    return row.id;
  };
  /** A second sequence of the same team, on the first one's style. */
  const secondSequence = async () => {
    const [first] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!first) throw new Error('test setup: no sequence');
    const id = generateId();
    await db
      .insert(sequences)
      .values({ id, teamId, title: 'S2', styleId: first.styleId });
    return id;
  };
  it('a recast is one bible version, by its author, naming the talent', async () => {
    const created = await chars().create(
      { sequenceId, characterId: 'char_001', name: 'Ada' },
      analysis
    );
    const talentId = await newTalent();
    const recast = await chars().updateBible(
      sequenceId,
      created.id,
      { age: '30s' },
      { actorId, source: 'recast', talentId }
    );

    const versions = await versionsOf(created.id);
    expect(versions).toHaveLength(2);
    expect(
      versions.find((v) => v.id === recast.selectedBibleVersionId)
    ).toMatchObject({
      source: 'recast',
      createdBy: actorId,
      talentId,
      age: '30s',
    });
    expect(recast.talentId).toBe(talentId);
    expect(await linksOf(created.id)).toMatchObject([
      { bibleVersionId: recast.selectedBibleVersionId },
    ]);

    // An edit keeps the cast on the version it appends.
    const edited = await chars().updateBible(
      sequenceId,
      created.id,
      { age: '40s' },
      { actorId, source: 'edit' }
    );
    expect(edited.talentId).toBe(talentId);
    // The same talent again appends nothing.
    await chars().updateBible(
      sequenceId,
      created.id,
      {},
      { actorId, source: 'recast', talentId }
    );
    expect(await versionsOf(created.id)).toHaveLength(3);
  });

  it('deleting a sequence keeps a library character and one another sequence casts', async () => {
    const [oneOff, inLibrary, shared] = await Promise.all(
      ['One', 'Lib', 'Shared'].map((name, i) =>
        chars().create({ sequenceId, characterId: `char_${i}`, name }, analysis)
      )
    );
    if (!oneOff || !inLibrary || !shared) throw new Error('test setup');
    await db
      .update(characters)
      .set({ inLibrary: true })
      .where(eq(characters.id, inLibrary.id));
    const other = await secondSequence();
    await db.insert(sequenceCast).values({
      sequenceId: other,
      characterId: shared.id,
      scriptCharacterId: 'char_x',
      bibleVersionId: shared.selectedBibleVersionId,
    });
    await createSequencesMethods(db, teamId, actorId).delete(
      sequenceId,
      NO_VOICES
    );

    const left = await db.select({ id: characters.id }).from(characters);
    expect(left.map((row) => row.id).sort()).toEqual(
      [inLibrary.id, shared.id].sort()
    );
    expect(await versionsOf(oneOff.id)).toEqual([]);
    expect(await versionsOf(inLibrary.id)).toHaveLength(1);
    // The library character has no link left; the shared one keeps the
    // other sequence's.
    expect(await linksOf(inLibrary.id)).toEqual([]);
    expect(await linksOf(shared.id)).toMatchObject([{ sequenceId: other }]);
    expect(
      await db
        .select()
        .from(characterLooks)
        .where(eq(characterLooks.id, oneOff.id))
    ).toEqual([]);
  });

  /** A character with a sheet on its default look and two voice versions. */
  const withSheetAndVoices = async (scriptId: string) => {
    const created = await chars().create(
      { sequenceId, characterId: scriptId, name: scriptId },
      analysis
    );
    await db.insert(characterSheetVariants).values({
      characterId: created.id,
      lookId: created.lookId,
      model: 'm',
      url: '/r2/sheet.png',
      status: 'completed',
    });
    await chars().updateVoice(
      created.id,
      { voiceId: 'voice-a' },
      'library',
      null
    );
    await chars().updateVoice(
      created.id,
      { voiceId: 'voice-b' },
      'library',
      null
    );
    return created;
  };
  const rowsOf = async (characterId: string) => ({
    sheets: (
      await db
        .select()
        .from(characterSheetVariants)
        .where(eq(characterSheetVariants.characterId, characterId))
    ).length,
    voices: (
      await db
        .select()
        .from(characterVoiceVersions)
        .where(eq(characterVoiceVersions.characterId, characterId))
    ).length,
    looks: (
      await db
        .select()
        .from(characterLooks)
        .where(eq(characterLooks.characterId, characterId))
    ).length,
    versions: (await versionsOf(characterId)).length,
    links: (await linksOf(characterId)).length,
  });
  const NOTHING = { sheets: 0, voices: 0, looks: 0, versions: 0, links: 0 };

  it('deleting a character is refused until every voice it alone holds is released, then removes every row of it', async () => {
    const created = await withSheetAndVoices('char_001');
    const kept = await withSheetAndVoices('char_002');
    const before = await rowsOf(created.id);
    expect(before).toEqual({
      sheets: 1,
      voices: 2,
      looks: 1,
      versions: 1,
      links: 1,
    });

    // Both characters have 'voice-a' in their history and 'voice-b'
    // selected. The other character's SELECTED voice-b is a live reference,
    // so only voice-a would be stranded.
    expect(await chars().getVoiceIdsToRelease(created.id)).toEqual(['voice-a']);
    await expect(chars().delete(created.id, NO_VOICES)).rejects.toThrow(
      /would be stranded/
    );
    expect(await rowsOf(created.id)).toEqual(before);

    // The caller ran voice-a through releaseVoiceIfUnreferenced and says so.
    expect(
      await chars().delete(created.id, { releasedVoiceIds: ['voice-a'] })
    ).toBe(true);
    expect(await rowsOf(created.id)).toEqual(NOTHING);
    expect(
      await db.select().from(characters).where(eq(characters.id, created.id))
    ).toEqual([]);
    // Nothing of another character went with it.
    expect(await rowsOf(kept.id)).toEqual(before);
  });

  it('an unselected voice version that still holds a slot stops the delete', async () => {
    const created = await withSheetAndVoices('char_001');
    // What releaseCharacterVoice writes: the live pointer is dropped.
    await chars().updateVoice(created.id, { voiceId: null }, 'removed', null);
    // Neither id is selected any more, and neither is released.
    expect((await chars().getVoiceIdsToRelease(created.id)).sort()).toEqual([
      'voice-a',
      'voice-b',
    ]);
    await expect(chars().delete(created.id, NO_VOICES)).rejects.toThrow(
      /2 saved voice\(s\) would be stranded/
    );

    // A released id is no longer owed.
    await chars().markVoiceReleased('voice-a');
    expect(await chars().getVoiceIdsToRelease(created.id)).toEqual(['voice-b']);
    await expect(
      chars().delete(created.id, { releasedVoiceIds: ['voice-a'] })
    ).rejects.toThrow(/1 saved voice\(s\) would be stranded/);
    expect(
      await chars().delete(created.id, { releasedVoiceIds: ['voice-b'] })
    ).toBe(true);
  });

  it('a Seed voice and a voice a talent still holds do not stop the delete', async () => {
    const created = await chars().create(
      { sequenceId, characterId: 'char_001', name: 'Ada' },
      analysis
    );
    // A Seed voice holds no provider slot.
    await chars().updateVoice(
      created.id,
      { voiceId: newSeedVoiceId() },
      'generated',
      null
    );
    // A voice copied from a talent: the talent still points at it.
    await db.insert(talent).values({ teamId, name: 'T', voiceId: 'voice-t' });
    await chars().updateVoice(
      created.id,
      { voiceId: 'voice-t' },
      'library',
      null
    );

    expect(await chars().getVoiceIdsToRelease(created.id)).toEqual([]);
    expect(await chars().delete(created.id, NO_VOICES)).toBe(true);
    expect(await rowsOf(created.id)).toEqual(NOTHING);
  });

  it("deleting a sequence is refused until its characters' voices are released, then removes sheets and voices too", async () => {
    const created = await withSheetAndVoices('char_001');
    const sequencesDb = createSequencesMethods(db, teamId, actorId);
    const owed = await sequencesDb.getVoiceIdsToReleaseOnDelete(sequenceId);
    expect(owed.sort()).toEqual(['voice-a', 'voice-b']);
    await expect(sequencesDb.delete(sequenceId, NO_VOICES)).rejects.toThrow(
      /would be stranded/
    );
    expect(await db.select().from(sequences)).toHaveLength(1);
    expect((await rowsOf(created.id)).links).toBe(1);

    await sequencesDb.delete(sequenceId, { releasedVoiceIds: owed });
    expect(await db.select().from(sequences)).toEqual([]);
    expect(await db.select().from(characters)).toEqual([]);
    expect(await rowsOf(created.id)).toEqual(NOTHING);
    expect(await db.select().from(characterSheetVariants)).toEqual([]);
    expect(await db.select().from(characterVoiceVersions)).toEqual([]);
  });

  it('a library character and one another sequence casts keep their voices when a sequence is deleted', async () => {
    const inLibrary = await withSheetAndVoices('char_001');
    const shared = await withSheetAndVoices('char_002');
    await db
      .update(characters)
      .set({ inLibrary: true })
      .where(eq(characters.id, inLibrary.id));
    const other = await secondSequence();
    await db.insert(sequenceCast).values({
      sequenceId: other,
      characterId: shared.id,
      scriptCharacterId: 'char_x',
      bibleVersionId: shared.selectedBibleVersionId,
    });
    const sequencesDb = createSequencesMethods(db, teamId, actorId);
    // Neither is deleted, so no voice is in the way.
    expect(await sequencesDb.getVoiceIdsToReleaseOnDelete(sequenceId)).toEqual(
      []
    );
    await sequencesDb.delete(sequenceId, NO_VOICES);

    const kept = { sheets: 1, voices: 2, looks: 1, versions: 1 };
    expect(await rowsOf(inLibrary.id)).toEqual({ ...kept, links: 0 });
    expect(await rowsOf(shared.id)).toEqual({ ...kept, links: 1 });
    const [voiced] = await db
      .select({ selected: characters.selectedVoiceVersionId })
      .from(characters)
      .where(eq(characters.id, shared.id));
    expect(voiced?.selected).not.toBeNull();
  });

  it('another team cannot delete a sequence or what it casts', async () => {
    const created = await withSheetAndVoices('char_001');
    const before = await rowsOf(created.id);
    const otherTeam = generateId();
    await db.insert(teams).values({ id: otherTeam, name: 'O', slug: 'o' });
    const theirs = createSequencesMethods(db, otherTeam, actorId);

    expect(await theirs.getVoiceIdsToReleaseOnDelete(sequenceId)).toEqual([]);
    await theirs.delete(sequenceId, NO_VOICES);
    expect(await db.select().from(sequences)).toHaveLength(1);
    expect(await rowsOf(created.id)).toEqual(before);
    expect(await chars().getById(sequenceId, created.id)).toMatchObject({
      name: 'char_001',
    });
  });

  it('one character in two sequences reads, edits, claims and deletes through each link', async () => {
    const created = await chars().create(
      {
        sequenceId,
        characterId: 'char_001',
        name: 'Ada',
        standardClothing: 'coat',
      },
      analysis
    );
    const lookVersionId = created.looks[0]?.lookVersionId;
    if (!lookVersionId) throw new Error('test setup: no default look');
    // The second link, as an attach will write it (#2050).
    const other = await secondSequence();
    const [link] = await db
      .insert(sequenceCast)
      .values({
        sequenceId: other,
        characterId: created.id,
        scriptCharacterId: 'char_ada',
        bibleVersionId: created.selectedBibleVersionId,
      })
      .returning();
    if (!link) throw new Error('test setup: link insert returned nothing');
    await db.insert(sequenceCastLooks).values({
      castId: link.id,
      lookId: created.lookId,
      lookVersionId,
      sheetStatus: 'pending',
    });

    // List and get: each sequence sees the character through its own link.
    expect(await chars().list(sequenceId)).toMatchObject([
      { id: created.id, sequenceId, characterId: 'char_001' },
    ]);
    expect(await chars().list(other)).toMatchObject([
      {
        id: created.id,
        sequenceId: other,
        characterId: 'char_ada',
        castId: link.id,
      },
    ]);
    expect(await chars().getByIds(other, [created.id])).toHaveLength(1);
    expect(await chars().listWithTalent(other)).toHaveLength(1);
    expect(await looks().listByCharacter(other, created.id)).toHaveLength(1);

    // Edit from the second: its pins and the current pointers move, the
    // first sequence stays where it was.
    const second = await chars().updateBible(
      other,
      created.id,
      { age: '40s', standardClothing: 'gown' },
      { actorId, source: 'edit' }
    );
    expect(second).toMatchObject({ age: '40s', standardClothing: 'gown' });
    const first = await chars().getById(sequenceId, created.id);
    expect(first).toMatchObject({
      age: null,
      standardClothing: 'coat',
      selectedBibleVersionId: created.selectedBibleVersionId,
    });
    if (!first) throw new Error('unreachable');
    const [current] = await db
      .select({ bible: characters.selectedBibleVersionId })
      .from(characters)
      .where(eq(characters.id, created.id));
    expect(current?.bible).toBe(second.selectedBibleVersionId);

    // A look added from one sequence is not in the other.
    await looks().create(
      other,
      created.id,
      { name: 'Gala', clothing: 'gown', styling: null },
      { source: 'edit', actorId }
    );
    expect(await looks().listByCharacter(sequenceId, created.id)).toHaveLength(
      1
    );
    expect(await looks().listByCharacter(other, created.id)).toHaveLength(2);

    // Sheet claims: one per sequence, each guarded by that sequence's pins.
    const snapshotOf = (character: typeof second) => ({
      lookVersionId: character.looks[0]?.lookVersionId ?? '',
      bibleVersionId: character.selectedBibleVersionId,
      talentId: character.talentId,
    });
    const claim = { markGenerating: true };
    const claimA = await looks().claimSheet(
      sequenceId,
      created.lookId,
      snapshotOf(first),
      claim
    );
    expect(claimA.held).toBe(true);
    // The first sequence's snapshot does not hold in the second.
    expect(
      (
        await looks().claimSheet(
          other,
          created.lookId,
          snapshotOf(first),
          claim
        )
      ).held
    ).toBe(false);
    const claimB = await looks().claimSheet(
      other,
      created.lookId,
      snapshotOf(second),
      claim
    );
    expect(claimB.held).toBe(true);
    expect(await looks().getById(sequenceId, created.lookId)).toMatchObject({
      pendingPromoteSheetVersionId: claimA.versionId,
    });
    expect(await looks().getById(other, created.lookId)).toMatchObject({
      pendingPromoteSheetVersionId: claimB.versionId,
    });

    // The second sequence's sheet lands on its own pointer only.
    await createCharacterSheetVariantsMethods(db, teamId).promoteIfPending({
      sequenceId: other,
      characterId: created.id,
      lookId: created.lookId,
      lookVersionId: snapshotOf(second).lookVersionId,
      versionId: claimB.versionId,
      claimed: true,
      url: 'https://x.test/b.png',
      storagePath: 'b.png',
      inputHash: null,
      bibleVersionId: second.selectedBibleVersionId,
      model: 'test-model',
      workflowRunId: 'run-b',
    });
    expect(await chars().getById(other, created.id)).toMatchObject({
      sheetImageUrl: 'https://x.test/b.png',
      sheetStatus: 'completed',
    });
    expect(await chars().getById(sequenceId, created.id)).toMatchObject({
      sheetImageUrl: null,
      sheetStatus: 'generating',
    });

    // Remove from the first: the second still casts it.
    expect(await chars().getHeldElsewhere(sequenceId, created.id)).toBe(true);
    await chars().softDelete(sequenceId, created.id, { actorId });
    expect(await chars().list(sequenceId)).toEqual([]);
    expect(await chars().list(other)).toHaveLength(1);
    expect(await chars().getHeldElsewhere(other, created.id)).toBe(false);
    await chars().restore(sequenceId, created.id, { actorId });
    expect(await chars().list(sequenceId)).toHaveLength(1);

    // Delete the first sequence: the character stays for the second.
    const sequencesDb = createSequencesMethods(db, teamId, actorId);
    await sequencesDb.delete(sequenceId, NO_VOICES);
    expect(await linksOf(created.id)).toMatchObject([{ sequenceId: other }]);
    expect(await chars().getById(other, created.id)).toMatchObject({
      age: '40s',
      sheetImageUrl: 'https://x.test/b.png',
    });
    // Delete the second: nothing holds the character, so it goes.
    await sequencesDb.delete(other, NO_VOICES);
    expect(await db.select().from(characters)).toEqual([]);
    expect(await linksOf(created.id)).toEqual([]);
  });

  it('attaches a library character to a second sequence: one link, every look pinned, no copy (#2050)', async () => {
    const created = await chars().create(
      {
        sequenceId,
        characterId: 'char_001',
        name: 'Ada Lovelace',
        standardClothing: 'coat',
      },
      analysis
    );
    const gala = await looks().create(
      sequenceId,
      created.id,
      { name: 'Gala', clothing: 'gown', styling: null },
      { source: 'edit', actorId }
    );
    const other = await secondSequence();

    // Not in the library: refused, and nothing written.
    await expect(
      chars().attach(other, created.id, { actorId })
    ).rejects.toThrow('not in the library');
    expect(await linksOf(created.id)).toHaveLength(1);

    await chars().setInLibrary(created.id, true);
    const attached = await chars().attach(other, created.id, { actorId });
    expect(attached).toMatchObject({
      id: created.id,
      sequenceId: other,
      characterId: 'char_ada_lovelace',
      selectedBibleVersionId: created.selectedBibleVersionId,
      standardClothing: 'coat',
      sheetStatus: 'pending',
    });
    // The whole character once, with two links.
    expect(await db.select().from(characters)).toHaveLength(1);
    expect(await linksOf(created.id)).toHaveLength(2);
    // Every live look came across, pinned at its current version, sheet-less.
    const otherLooks = await looks().listByCharacter(other, created.id);
    expect(otherLooks.map((look) => [look.id, look.lookVersionId])).toEqual([
      [created.lookId, created.looks[0]?.lookVersionId],
      [gala.id, gala.lookVersionId],
    ]);
    expect(
      otherLooks.every((look) => look.selectedSheetVersionId === null)
    ).toBe(true);
    expect(await eventKinds()).toContain('character.created');

    // Idempotent: the same link comes back.
    expect(await chars().attach(other, created.id, { actorId })).toMatchObject({
      castId: attached.castId,
    });
    // Removed from the second, attached again: the link is restored.
    await chars().softDelete(other, created.id, { actorId });
    expect(
      (await chars().attach(other, created.id, { actorId })).deletedAt
    ).toBeNull();

    // A second library character with the same name is refused: the script
    // names a character in capitals, and ADA LOVELACE would be two people.
    const twin = await chars().create(
      { sequenceId, characterId: 'char_002', name: 'ada lovelace' },
      analysis
    );
    await chars().setInLibrary(twin.id, true);
    await expect(chars().attach(other, twin.id, { actorId })).rejects.toThrow(
      'already a name'
    );
    // Another team's character is not found.
    await expect(
      createCharactersMethods(db, generateId()).attach(other, created.id, {
        actorId,
      })
    ).rejects.toThrow('not found');
  });

  it('analysis links a shared character: looks by id or name, a new look added, nothing rewritten or removed (#2050)', async () => {
    const created = await chars().create(
      {
        sequenceId,
        characterId: 'char_001',
        name: 'Ada',
        standardClothing: 'coat',
      },
      analysis
    );
    await chars().setInLibrary(created.id, true);
    const other = await secondSequence();
    const attached = await chars().attach(other, created.id, { actorId });
    // A look added in the first sequence after the attach: the second has no
    // cast look for it, and the snapshot there does not know it.
    const gala = await looks().create(
      sequenceId,
      created.id,
      { name: 'Gala gown', clothing: 'gown', styling: null },
      { source: 'edit', actorId }
    );
    await chars().softDelete(other, created.id, { actorId });

    const ids = await looks().linkFromAnalysis(other, created.id, [
      {
        lookId: created.lookId,
        name: 'Default',
        clothing: 'MODEL',
        styling: 'x',
      },
      {
        lookId: 'char_ada:gala_gown',
        name: 'gala gown',
        clothing: 'y',
        styling: '',
      },
      {
        lookId: 'char_ada:rain',
        name: 'Rain',
        clothing: 'mac',
        styling: 'wet',
      },
    ]);
    expect(ids[created.lookId]).toBe(created.lookId);
    expect(ids['char_ada:gala_gown']).toBe(gala.id);
    const rainId = ids['char_ada:rain'];
    if (!rainId) throw new Error('expected the new look');

    // The link came back; the second sequence now has all three looks.
    expect((await chars().getById(other, created.id))?.deletedAt).toBeNull();
    const otherLooks = await looks().listByCharacter(other, created.id);
    expect(otherLooks.map((l) => [l.id, l.name, l.clothing])).toEqual([
      [created.lookId, 'Default', 'coat'],
      [gala.id, 'Gala gown', 'gown'],
      [rainId, 'Rain', 'mac'],
    ]);
    expect(otherLooks.find((l) => l.id === gala.id)?.lookVersionId).toBe(
      gala.lookVersionId
    );
    // Nothing of hers was written: one bible version, one version per look.
    expect(await versionsOf(created.id)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(characterLookVersions)
        .where(eq(characterLookVersions.lookId, created.lookId))
    ).toHaveLength(1);
    // The first sequence does not wear the new look.
    expect(await looks().listByCharacter(sequenceId, created.id)).toHaveLength(
      2
    );
    expect(attached.castId).toBe(
      (await chars().getById(other, created.id))?.castId
    );
  });

  it('lists the team characters by the latest sequence casting them, then by how many', async () => {
    const [old, busy, removed] = await Promise.all(
      ['Old', 'Busy', 'Removed'].map((name, i) =>
        chars().create({ sequenceId, characterId: `char_${i}`, name }, analysis)
      )
    );
    if (!old || !busy || !removed) throw new Error('test setup');
    const other = await secondSequence();
    const cast = async (into: string, character: typeof busy) => {
      const [link] = await db
        .insert(sequenceCast)
        .values({
          sequenceId: into,
          characterId: character.id,
          scriptCharacterId: character.characterId,
          bibleVersionId: character.selectedBibleVersionId,
        })
        .returning();
      if (!link) throw new Error('test setup: link insert returned nothing');
      await db.insert(sequenceCastLooks).values({
        castId: link.id,
        lookId: character.lookId,
        lookVersionId: character.looks[0]?.lookVersionId ?? '',
        sheetStatus: 'pending',
      });
    };
    await cast(other, busy);
    const touch = async (id: string, at: string) =>
      await db
        .update(sequences)
        .set({ updatedAt: new Date(at) })
        .where(eq(sequences.id, id));
    await touch(sequenceId, '2026-01-01T00:00:00Z');
    await touch(other, '2026-02-01T00:00:00Z');
    await chars().softDelete(sequenceId, removed.id, { actorId });
    // A sheet on the second sequence's link only.
    await createCharacterSheetVariantsMethods(db, teamId).applyConvergent({
      sequenceId: other,
      lookId: busy.lookId,
      url: 'https://x.test/busy.png',
      storagePath: 'busy.png',
      inputHash: null,
      model: 'test-model',
    });
    // `softDelete` and the sheet write do not touch the sequences' own rows.
    await touch(sequenceId, '2026-01-01T00:00:00Z');
    await touch(other, '2026-02-01T00:00:00Z');

    // Removed from its only sequence and not in the library: left out.
    expect(await chars().listTeam({ inLibrary: false })).toEqual([
      {
        id: busy.id,
        name: 'Busy',
        physicalDescription: null,
        voiceOnly: false,
        inLibrary: false,
        lastUsedAt: new Date('2026-02-01T00:00:00Z'),
        sequences: [
          { id: other, title: 'S2', sheetImageUrl: 'https://x.test/busy.png' },
          { id: sequenceId, title: 'S', sheetImageUrl: null },
        ],
      },
      expect.objectContaining({
        id: old.id,
        lastUsedAt: new Date('2026-01-01T00:00:00Z'),
        sequences: [{ id: sequenceId, title: 'S', sheetImageUrl: null }],
      }),
    ]);

    // The flag is the character's own: no copy, no talent, no link moves.
    await chars().setInLibrary(removed.id, true);
    await chars().setInLibrary(old.id, true);
    expect(await db.select().from(talent)).toEqual([]);
    expect(await db.select().from(characters)).toHaveLength(3);
    expect(await linksOf(old.id)).toHaveLength(1);
    expect(
      (await chars().listTeam({ inLibrary: true })).map((row) => row.name)
    ).toEqual(['Old', 'Removed']);
    expect(await chars().getTeamCharacter(removed.id)).toMatchObject({
      inLibrary: true,
      lastUsedAt: null,
      sequences: [],
    });
    await chars().setInLibrary(removed.id, false);
    expect(await chars().getTeamCharacter(removed.id)).toBeNull();

    // An archived sequence does not count as casting.
    await db
      .update(sequences)
      .set({ status: 'archived' })
      .where(eq(sequences.id, other));
    expect(
      (await chars().getTeamCharacter(busy.id))?.sequences.map((row) => row.id)
    ).toEqual([sequenceId]);

    // Another team sees none of it, and cannot set the flag.
    const otherTeam = generateId();
    await db.insert(teams).values({ id: otherTeam, name: 'O', slug: 'o' });
    const theirs = createCharactersMethods(db, otherTeam);
    expect(await theirs.listTeam({ inLibrary: false })).toEqual([]);
    await expect(theirs.setInLibrary(busy.id, true)).rejects.toThrow(
      /not found/
    );
  });

  it('another team cannot read, edit or delete a character or its looks', async () => {
    const created = await chars().create(
      { sequenceId, characterId: 'char_001', name: 'Ada' },
      analysis
    );
    const otherTeam = generateId();
    await db.insert(teams).values({ id: otherTeam, name: 'O', slug: 'o' });
    const theirs = createCharactersMethods(db, otherTeam);
    const theirLooks = createCharacterLooksMethods(db, otherTeam);

    expect(await theirs.getById(sequenceId, created.id)).toBeNull();
    expect(await theirs.list(sequenceId)).toEqual([]);
    expect(await theirLooks.getById(sequenceId, created.lookId)).toBeNull();
    expect(await theirLooks.listVersions(created.lookId)).toEqual([]);
    await expect(
      theirLooks.update(
        sequenceId,
        created.lookId,
        { clothing: 'coat' },
        { source: 'edit', actorId }
      )
    ).rejects.toThrow(/not found/);

    expect(await theirs.delete(created.id, NO_VOICES)).toBe(false);
    expect(await linksOf(created.id)).toHaveLength(1);
    expect(await versionsOf(created.id)).toHaveLength(1);
    expect(await looks().listByCharacter(sequenceId, created.id)).toHaveLength(
      1
    );
    expect(await chars().getById(sequenceId, created.id)).toMatchObject({
      name: 'Ada',
    });

    expect(await chars().delete(created.id, NO_VOICES)).toBe(true);
    expect(await linksOf(created.id)).toEqual([]);
  });
});
