/**
 * The library flag and the voice (#2017), on real SQLite with the provider
 * stubbed: taking a character out of the library when no sequence casts it
 * releases its saved voice, provider first and row second, and a link in an
 * archived sequence is not a holder.
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
import { setCharacterInLibrary } from './cast-edit';
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
// The surface `setCharacterInLibrary` and the release touch.
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

describe('setCharacterInLibrary', () => {
  it('sets and clears the flag without touching the voice while a sequence casts the character', async () => {
    const { created } = await voiced();
    await setCharacterInLibrary(scoped(), { userId }, created.id, true);
    expect((await chars().getTeamCharacter(created.id))?.inLibrary).toBe(true);

    await setCharacterInLibrary(scoped(), { userId }, created.id, false);
    expect((await chars().getTeamCharacter(created.id))?.inLibrary).toBe(false);
    expect(mockDelete).not.toHaveBeenCalled();
    expect((await chars().getVoice(created.id)).voiceId).toBe(VOICE);
  });

  it('releases the voice when the library was the last thing holding the character', async () => {
    const { sequenceId, created } = await voiced();
    await setCharacterInLibrary(scoped(), { userId }, created.id, true);
    await chars().softDelete(sequenceId, created.id, { actorId: userId });
    // The library holds it, so the remove kept the voice.
    expect(await chars().getHeldElsewhere(sequenceId, created.id)).toBe(true);
    expect(await chars().getCastInAnySequence(created.id)).toBe(false);

    // Provider first: the row still names the voice when the delete runs.
    mockDelete.mockImplementation(async () => {
      expect((await chars().getVoice(created.id)).voiceId).toBe(VOICE);
    });
    await setCharacterInLibrary(scoped(), { userId }, created.id, false);

    expect(mockDelete).toHaveBeenCalledWith('key', VOICE);
    expect((await chars().getVoice(created.id)).voiceId).toBeNull();
    // Unlisted now, with nothing left behind at the provider.
    expect(await chars().getTeamCharacter(created.id)).toBeNull();
  });

  it('keeps the flag when the provider delete fails, so the release can be retried', async () => {
    const { sequenceId, created } = await voiced();
    await setCharacterInLibrary(scoped(), { userId }, created.id, true);
    await chars().softDelete(sequenceId, created.id, { actorId: userId });
    mockDelete.mockRejectedValue(new Error('ElevenLabs 503'));

    await expect(
      setCharacterInLibrary(scoped(), { userId }, created.id, false)
    ).rejects.toThrow('ElevenLabs 503');

    expect((await chars().getTeamCharacter(created.id))?.inLibrary).toBe(true);
    expect((await chars().getVoice(created.id)).voiceId).toBe(VOICE);
  });

  it('counts an archived sequence as not casting, like the list does', async () => {
    const { sequenceId, created } = await voiced();
    await setCharacterInLibrary(scoped(), { userId }, created.id, true);
    await archive(sequenceId);
    expect(await chars().getCastInAnySequence(created.id)).toBe(false);
    expect((await chars().getTeamCharacter(created.id))?.sequences).toEqual([]);

    await setCharacterInLibrary(scoped(), { userId }, created.id, false);
    expect(mockDelete).toHaveBeenCalledWith('key', VOICE);
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

    // The library is a holder whatever the sequences do.
    await db
      .update(characters)
      .set({ inLibrary: true })
      .where(eq(characters.id, created.id));
    expect(await chars().getHeldElsewhere(a, created.id)).toBe(true);
  });
});
