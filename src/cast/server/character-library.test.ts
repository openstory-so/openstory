/**
 * Deleting a team character and its voice (#2065), on real SQLite with the
 * provider stubbed: refused while any sequence casts it, otherwise the saved
 * voice is released, provider first and row second. A link in an archived
 * sequence is not a holder of the voice (#2017).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  characters,
  sequenceCast,
  sequenceCastLooks,
  sequences,
  styles,
  teams,
  user,
} from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { asStub } from '@/test/as-stub';
import { deleteTeamCharacter, restoreTeamCharacter } from './cast-edit';
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

// One per test: a voice id is counted across every team's rows.
let VOICE = '';
let client: Client;
let db: Database;
let teamId = '';
let userId = '';
let styleId = '';

const chars = () => createCharactersMethods(db, teamId);
// The surface `deleteTeamCharacter` and the release touch.
const scoped = () => asStub<ScopedDb>({ characters: chars() });

async function newSequence(title: string) {
  const id = generateId();
  await db.insert(sequences).values({ id, teamId, title, styleId });
  return id;
}

/** A character with a saved voice, cast in a new sequence. */
async function voiced() {
  const sequenceId = await newSequence('A');
  const created = await chars().create(
    { sequenceId, characterId: 'char_001', name: 'Ada' },
    { source: 'analysis', createdBy: null }
  );
  await chars().updateVoice(
    sequenceId,
    created.id,
    { voiceId: VOICE },
    'generated',
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
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockDelete.mockResolvedValue(undefined);
  VOICE = `voice-${generateId()}`;
  teamId = generateId();
  userId = generateId();
  mockGetVoice.mockResolvedValue({
    voiceId: VOICE,
    name: 'Designed',
    category: 'generated',
    previewUrl: null,
    isPremade: false,
  });
  await db.insert(teams).values({ id: teamId, name: 'T', slug: teamId });
  await db
    .insert(user)
    .values({ id: userId, name: 'U', email: `${userId}@x.test` });
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
  styleId = style.id;
});

describe('deleteTeamCharacter', () => {
  it('is refused while a live sequence casts the character', async () => {
    const { created } = await voiced();

    await expect(
      deleteTeamCharacter(scoped(), { userId }, created.id)
    ).rejects.toThrow('Remove it from its sequences first.');

    expect(mockDelete).not.toHaveBeenCalled();
    expect((await chars().getVoice(created.id)).voiceId).toBe(VOICE);
    expect(await chars().getTeamCharacter(created.id)).not.toBeNull();
  });

  it('is refused while only an archived sequence casts the character', async () => {
    const { sequenceId, created } = await voiced();
    await archive(sequenceId);
    // Not cast as the list counts it, but the link is still there.
    expect(await chars().getCastInAnySequence(created.id)).toBe(false);
    expect(await chars().getCastInAnySequenceOrArchive(created.id)).toBe(true);

    await expect(
      deleteTeamCharacter(scoped(), { userId }, created.id)
    ).rejects.toThrow('Remove it from its sequences first.');

    expect(mockDelete).not.toHaveBeenCalled();
    expect(await chars().getTeamCharacter(created.id)).not.toBeNull();
  });

  it('soft-deletes the character and releases its voice when nothing casts it; restore brings it back without the voice', async () => {
    const { sequenceId, created } = await voiced();
    await chars().softDelete(sequenceId, created.id, { actorId: userId });
    // Still listed, with no sequence.
    expect((await chars().listTeam()).map((c) => c.id)).toEqual([created.id]);

    // Provider first: the row still names the voice when the delete runs.
    mockDelete.mockImplementation(async () => {
      expect((await chars().getVoice(created.id)).voiceId).toBe(VOICE);
    });
    await deleteTeamCharacter(scoped(), { userId }, created.id);

    expect(mockDelete).toHaveBeenCalledWith('key', VOICE);
    // Off the list and not attachable; every row of it is still there.
    expect(await chars().getTeamCharacter(created.id)).toBeNull();
    expect(await chars().listTeam()).toEqual([]);
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

    await restoreTeamCharacter(scoped(), created.id);
    expect(await chars().getTeamCharacter(created.id)).toMatchObject({
      id: created.id,
      sequences: [],
    });
    expect((await chars().getVoice(created.id)).voiceId).toBeNull();
    // Only a deleted character restores.
    await expect(restoreTeamCharacter(scoped(), created.id)).rejects.toThrow(
      'Character not found'
    );
  });

  it('restoring it in the sequence that removed it brings it back to the team', async () => {
    const { sequenceId, created } = await voiced();
    await chars().softDelete(sequenceId, created.id, { actorId: userId });
    mockDelete.mockResolvedValue(undefined);
    await deleteTeamCharacter(scoped(), { userId }, created.id);

    await chars().restore(sequenceId, created.id, { actorId: userId });

    expect((await chars().listTeam()).map((c) => c.id)).toEqual([created.id]);
  });

  it('a re-analysis that revives it in the sequence that removed it brings it back to the team', async () => {
    const { sequenceId, created } = await voiced();
    await chars().softDelete(sequenceId, created.id, { actorId: userId });
    mockDelete.mockResolvedValue(undefined);
    await deleteTeamCharacter(scoped(), { userId }, created.id);

    // The script still names her: analysis takes her script id again.
    const revived = await chars().create(
      { sequenceId, characterId: 'char_001', name: 'Ada' },
      { source: 'analysis', createdBy: null }
    );

    expect(revived.id).toBe(created.id);
    expect((await chars().listTeam()).map((c) => c.id)).toEqual([created.id]);
  });

  it('a sequence that casts it after the check still stops the delete', async () => {
    const { created } = await voiced();
    // Still cast: the guarded write refuses on its own.
    expect(await chars().softDeleteForTeam(created.id)).toBe(false);
    expect(await chars().getTeamCharacter(created.id)).not.toBeNull();
  });

  it('leaves the character when the provider delete fails, so it can be retried', async () => {
    const { sequenceId, created } = await voiced();
    await chars().softDelete(sequenceId, created.id, { actorId: userId });
    mockDelete.mockRejectedValue(new Error('ElevenLabs 503'));

    await expect(
      deleteTeamCharacter(scoped(), { userId }, created.id)
    ).rejects.toThrow('ElevenLabs 503');

    expect(await chars().getTeamCharacter(created.id)).not.toBeNull();
    expect((await chars().getVoice(created.id)).voiceId).toBe(VOICE);
  });
});

describe('getHeldElsewhere', () => {
  it('is false once every other sequence casting the character is archived', async () => {
    const { sequenceId: a, created } = await voiced();
    const b = await newSequence('B');
    const [link] = await db
      .insert(sequenceCast)
      .values({
        sequenceId: b,
        characterId: created.id,
        scriptCharacterId: 'char_ada',
        bibleVersionId: created.selectedBibleVersionId,
      })
      .returning();
    if (!link) throw new Error('test setup: link insert returned nothing');
    await db.insert(sequenceCastLooks).values({
      castId: link.id,
      lookId: created.lookId,
      lookVersionId: created.looks[0]?.lookVersionId ?? '',
      sheetStatus: 'pending',
    });
    expect(await chars().getHeldElsewhere(a, created.id)).toBe(true);
    expect(await chars().getHeldElsewhere(b, created.id)).toBe(true);

    // Archive B: A is the only holder, so letting go from A releases.
    await archive(b);
    expect(await chars().getHeldElsewhere(a, created.id)).toBe(false);
    expect(await chars().getHeldElsewhere(b, created.id)).toBe(true);

    // Both archived: nothing holds it from either side.
    await archive(a);
    expect(await chars().getHeldElsewhere(b, created.id)).toBe(false);
    expect(await chars().getCastInAnySequence(created.id)).toBe(false);
  });
});
