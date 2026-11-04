/**
 * Deleting an organization character and its voice (#2065), on real SQLite with the
 * provider stubbed: refused while any sequence casts it, otherwise the saved
 * voice is released, provider first and row second. A link in an archived
 * sequence is not a holder of the voice (#2017).
 */
import { createTestDb } from '@/platform/server/db/test-d1';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { eq } from 'drizzle-orm';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  characters,
  sequenceCast,
  sequences,
  styles,
  organization,
  user,
} from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { asStub } from '@/test/as-stub';
import {
  createOrganizationCharacter,
  createOrganizationCharacterLook,
  deleteOrganizationCharacter,
  restoreOrganizationCharacter,
  removeOrganizationCharacterLook,
  updateOrganizationCharacter,
  updateOrganizationCharacterLook,
} from './cast-edit';
import { createCharacterLooksMethods } from './db/character-looks';
import { createCharactersMethods } from './db/characters';

const { mockDelete, mockGetVoice } = vi.hoisted(() => ({
  mockDelete: vi.fn(),
  mockGetVoice: vi.fn(),
}));

// Hoisted: the characters module's own imports reach the release path.
vi.mock('@/cast/server/voice/elevenlabs-voice', async (importActual) => ({
  ...(await importActual<
    typeof import('@/cast/server/voice/elevenlabs-voice')
  >()),
  deleteElevenLabsVoice: mockDelete,
  getElevenLabsVoice: mockGetVoice,
}));
vi.mock('@/models/server/elevenlabs-config', () => ({
  getElevenLabsApiKey: () => 'key',
  isElevenLabsConfigured: () => true,
}));

// One per test: a voice id is counted across every organization's rows.
let VOICE = '';
let closeDb: () => Promise<void>;
let db: Database;
let organizationId = '';
let userId = '';
let styleId = '';

const chars = () => createCharactersMethods(db, organizationId);
// The surface `deleteOrganizationCharacter` and the release touch.
const scoped = () =>
  asStub<ScopedDb>({
    characters: chars(),
    characterLooks: createCharacterLooksMethods(db, organizationId),
  });

async function newSequence(title: string) {
  const id = generateId();
  await db.insert(sequences).values({ id, organizationId, title, styleId });
  return id;
}

/** A character with a saved voice, cast in a new sequence. */
async function voiced() {
  const sequenceId = await newSequence('A');
  const created = await chars().create(
    {
      sequenceId,
      characterId: 'char_001',
      name: 'Ada',
      rendering: 'Photoreal live action',
    },
    { source: 'analysis', createdBy: null }
  );
  await chars().updateVoice(
    created.id,
    { voiceId: VOICE },
    'generated',
    null,
    null
  );
  return { sequenceId, created };
}

const archive = async (sequenceId: string) =>
  await db
    .update(sequences)
    .set({ status: 'archived' })
    .where(eq(sequences.id, sequenceId));

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockDelete.mockResolvedValue(undefined);
  VOICE = `voice-${generateId()}`;
  organizationId = generateId();
  userId = generateId();
  mockGetVoice.mockResolvedValue({
    voiceId: VOICE,
    name: 'Designed',
    category: 'generated',
    previewUrl: null,
    isPremade: false,
  });
  await db
    .insert(organization)
    .values({ id: organizationId, name: 'T', slug: organizationId });
  await db
    .insert(user)
    .values({ id: userId, name: 'U', email: `${userId}@x.test` });
  const [style] = await db
    .insert(styles)
    .values({
      organizationId,
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
  styleId = style.id;
});

describe('deleteOrganizationCharacter', () => {
  it('is refused while a live sequence casts the character', async () => {
    const { created } = await voiced();

    await expect(
      deleteOrganizationCharacter(scoped(), { userId }, created.id)
    ).rejects.toThrow('Remove it from its sequences first.');

    expect(mockDelete).not.toHaveBeenCalled();
    expect((await chars().getVoice(created.id)).voiceId).toBe(VOICE);
    expect(await chars().getOrganizationCharacter(created.id)).not.toBeNull();
  });

  it('is refused while only an archived sequence casts the character', async () => {
    const { sequenceId, created } = await voiced();
    await archive(sequenceId);
    // Not cast as the list counts it, but the link is still there.
    expect(await chars().getCastInAnySequence(created.id)).toBe(false);
    expect(await chars().getCastInAnySequenceOrArchive(created.id)).toBe(true);

    await expect(
      deleteOrganizationCharacter(scoped(), { userId }, created.id)
    ).rejects.toThrow('Remove it from its sequences first.');

    expect(mockDelete).not.toHaveBeenCalled();
    expect(await chars().getOrganizationCharacter(created.id)).not.toBeNull();
  });

  it('soft-deletes the character and releases its voice when nothing casts it; restore brings it back without the voice', async () => {
    const { sequenceId, created } = await voiced();
    await chars().softDelete(sequenceId, created.id, { actorId: userId });
    // Still listed, with no sequence.
    expect((await chars().listOrganization()).map((c) => c.id)).toEqual([
      created.id,
    ]);

    // Provider first: the row still names the voice when the delete runs.
    mockDelete.mockImplementation(async () => {
      expect((await chars().getVoice(created.id)).voiceId).toBe(VOICE);
    });
    await deleteOrganizationCharacter(scoped(), { userId }, created.id);

    expect(mockDelete).toHaveBeenCalledWith('key', VOICE);
    // Off the list and not attachable; every row of it is still there.
    expect(await chars().getOrganizationCharacter(created.id)).toBeNull();
    expect(await chars().listOrganization()).toEqual([]);
    await expect(
      chars().attach(await newSequence('B'), created.id, { actorId: userId })
    ).rejects.toThrow('Character not found');
    expect(
      await db.select().from(characters).where(eq(characters.id, created.id))
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(sequenceCast)
        .where(eq(sequenceCast.characterId, created.id))
    ).toHaveLength(1);

    await restoreOrganizationCharacter(scoped(), created.id);
    expect(await chars().getOrganizationCharacter(created.id)).toMatchObject({
      id: created.id,
      sequences: [],
    });
    expect((await chars().getVoice(created.id)).voiceId).toBeNull();
    // Only a deleted character restores.
    await expect(
      restoreOrganizationCharacter(scoped(), created.id)
    ).rejects.toThrow('Character not found');
  });

  it('restoring it in the sequence that removed it brings it back to the organization', async () => {
    const { sequenceId, created } = await voiced();
    await chars().softDelete(sequenceId, created.id, { actorId: userId });
    mockDelete.mockResolvedValue(undefined);
    await deleteOrganizationCharacter(scoped(), { userId }, created.id);

    await chars().restore(sequenceId, created.id, { actorId: userId });

    expect((await chars().listOrganization()).map((c) => c.id)).toEqual([
      created.id,
    ]);
  });

  it('a re-analysis that revives it in the sequence that removed it brings it back to the organization', async () => {
    const { sequenceId, created } = await voiced();
    await chars().softDelete(sequenceId, created.id, { actorId: userId });
    mockDelete.mockResolvedValue(undefined);
    await deleteOrganizationCharacter(scoped(), { userId }, created.id);

    // The script still names her: analysis takes her script id again.
    const revived = await chars().create(
      {
        sequenceId,
        characterId: 'char_001',
        name: 'Ada',
        rendering: 'Photoreal live action',
      },
      { source: 'analysis', createdBy: null }
    );

    expect(revived.id).toBe(created.id);
    expect((await chars().listOrganization()).map((c) => c.id)).toEqual([
      created.id,
    ]);
  });

  it('a sequence that casts it after the check still stops the delete', async () => {
    const { created } = await voiced();
    // The check passes as if the link were made just after it; the guarded
    // write refuses on its own, before the voice is touched.
    const db = scoped();
    const raced = {
      ...db,
      characters: {
        ...db.characters,
        getCastInAnySequenceOrArchive: async () => false,
      },
    };

    await expect(
      deleteOrganizationCharacter(raced, { userId }, created.id)
    ).rejects.toThrow('Remove it from its sequences first.');

    expect(mockDelete).not.toHaveBeenCalled();
    expect((await chars().getVoice(created.id)).voiceId).toBe(VOICE);
    expect(await chars().getOrganizationCharacter(created.id)).not.toBeNull();
  });

  it('leaves the character when the provider delete fails, so it can be retried', async () => {
    const { sequenceId, created } = await voiced();
    await chars().softDelete(sequenceId, created.id, { actorId: userId });
    mockDelete.mockRejectedValue(new Error('ElevenLabs 503'));

    await expect(
      deleteOrganizationCharacter(scoped(), { userId }, created.id)
    ).rejects.toThrow('ElevenLabs 503');

    expect(await chars().getOrganizationCharacter(created.id)).not.toBeNull();
    expect((await chars().getVoice(created.id)).voiceId).toBe(VOICE);
  });
});

describe('a character made with no sequence (#2065)', () => {
  it('is created, edited and given looks from the Characters page, then cast by an attach', async () => {
    const actor = { userId };
    const made = await createOrganizationCharacter(scoped(), actor, {
      rendering: 'Photoreal live action',
      name: 'Ada Lovelace',
      physicalDescription: 'grey eyes',
    });
    // The tag a hand-added character of that name gets in a sequence.
    expect(made).toMatchObject({
      name: 'Ada Lovelace',
      consistencyTag: 'char_ada_lovelace: ada_lovelace',
      standardClothing: null,
    });
    expect(await chars().listOrganization()).toMatchObject([
      { id: made.id, sequences: [] },
    ]);

    await updateOrganizationCharacter(scoped(), actor, made.id, {
      personality: 'exact',
      standardClothing: 'coat',
    });
    const gala = await createOrganizationCharacterLook(
      scoped(),
      actor,
      made.id,
      {
        name: ' Gala ',
        clothing: 'gown',
        styling: '',
      }
    );
    await updateOrganizationCharacterLook(
      scoped(),
      actor,
      made.id,
      gala.lookId,
      {
        styling: 'hair up',
      }
    );
    expect(await chars().getCurrent(made.id)).toMatchObject({
      personality: 'exact',
      looks: [
        { name: 'Default', clothing: 'coat' },
        { name: 'Gala', clothing: 'gown', styling: 'hair up' },
      ],
    });

    // A look of another character is not found; a removed one is not edited.
    const other = await createOrganizationCharacter(scoped(), actor, {
      name: 'Bob',
      rendering: 'Photoreal live action',
    });
    await expect(
      updateOrganizationCharacterLook(scoped(), actor, other.id, gala.lookId, {
        name: 'x',
      })
    ).rejects.toThrow('Look not found');
    await removeOrganizationCharacterLook(
      scoped(),
      actor,
      made.id,
      gala.lookId
    );
    await expect(
      updateOrganizationCharacterLook(scoped(), actor, made.id, gala.lookId, {
        name: 'x',
      })
    ).rejects.toThrow('Restore the look first');

    // Picked for a sequence: cast at her current version, sheet-less.
    const sequenceId = await newSequence('A');
    expect(
      await chars().attach(sequenceId, made.id, { actorId: userId })
    ).toMatchObject({
      name: 'Ada Lovelace',
      characterId: 'char_ada_lovelace',
      personality: 'exact',
      standardClothing: 'coat',
      sheetStatus: 'pending',
    });
    expect(
      (await chars().getOrganizationCharacter(made.id))?.sequences
    ).toHaveLength(1);
  });
});
