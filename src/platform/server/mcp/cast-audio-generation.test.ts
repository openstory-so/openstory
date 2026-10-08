/**
 * MCP cast, music, dialogue and pending-artifact generation tools against the
 * real scoped repositories and the migrated SQLite schema. Workflow triggers
 * and realtime are mocked; nothing reaches a provider.
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
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createMCPServer } from '@tanstack/ai-mcp/server';
// oxlint-disable-next-line boundaries/no-raw-db -- substitute the isolated in-memory DB at the factory boundary
import { getDb } from '#db-client';
import type { Database } from '@/platform/server/db/client';
// oxlint-disable-next-line boundaries/no-scoped-factory -- exercise real team-scoped repositories, not mocked authorization
import { createScopedDb } from '@/platform/server/db/scoped';
import type { NewCharacter } from '@/platform/server/db/schema';
import { generateId } from '@/platform/id';
import { relations } from '@/platform/server/db/schema/relations';
import {
  characterBibleVersions,
  frames,
  frameVariants,
  locationLibrary,
  scenes,
  sequenceLocations,
  sequenceMusicVariants,
  sequences,
  shots,
  styles,
  talent,
  teams,
  user,
} from '@/platform/server/db/schema';
import { dbSceneId } from '@/shots/scene-id';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import {
  selectCharacterSheetVersion,
  updateCharacter,
  updateCharacterLook,
  updateTeamCharacter,
  updateTeamCharacterLook,
} from '@/cast/server/cast-edit';
import { personLockOf, personLocksOf } from '@/cast/server/person-lock';
import { PORTRAIT_RIGHTS_V1 } from '@/platform/compliance/attestations';
import { sha256Hex } from '@/platform/compliance/hash';
import { USER_UPLOAD_MODEL } from '@/shots/user-upload-model';

vi.mock('#db-client', () => ({ getDb: vi.fn() }));
vi.mock('@/platform/server/workflow/client', () => ({
  triggerWorkflow: vi.fn(async () => 'run-1'),
}));
vi.mock('@/platform/realtime', () => ({
  getGenerationChannel: () => ({ emit: vi.fn(async () => undefined) }),
}));

const { castAudioGenerationTools } =
  await import('./tools/cast-audio-generation');
const server = createMCPServer({
  name: 'test',
  version: '0',
  tools: castAudioGenerationTools,
  sessions: 'reject',
});

let client: Client;
let db: Database;
let teamId: string;
let sequenceId: string;
let shotId: string;
let frameId: string;
let actorId: string;
let scopedDb: ReturnType<typeof createScopedDb>;
/** A character as analysis writes it: bible version, cast link, default look. */
const castCharacter = (character: NewCharacter) =>
  createScopedDb(teamId, actorId).characters.create(character, {
    source: 'analysis',
    createdBy: null,
  });

async function call(name: string, args: Record<string, unknown>) {
  const response = await server.handle(
    new Request('https://openstory.test/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': `openstory.${name}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: `openstory.${name}`,
          arguments: args,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': {
              name: 'vitest',
              version: '1',
            },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
    {
      context: {
        scoped: () => ({
          scopedDb,
          origin: 'https://openstory.test',
          userId: actorId,
          request: {},
        }),
      },
    }
  );
  const envelope = z
    .object({
      result: z.object({
        isError: z.boolean().optional(),
        structuredContent: z.record(z.string(), z.unknown()).optional(),
      }),
    })
    .parse(await response.json());
  return envelope.result;
}

async function data(name: string, args: Record<string, unknown>) {
  const result = await call(name, args);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.structuredContent;
}

const refused = (code: string) => ({
  isError: true,
  structuredContent: { error: { code } },
});

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  vi.mocked(getDb).mockReturnValue(db);
});
afterAll(() => client.close());

beforeEach(async () => {
  vi.mocked(triggerWorkflow).mockClear();
  teamId = generateId();
  sequenceId = generateId();
  shotId = generateId();
  frameId = generateId();
  actorId = generateId();
  const sceneId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: teamId });
  const styleId = generateId();
  await db.insert(styles).values({
    id: styleId,
    teamId,
    name: 'Noir',
    config: {
      mood: 'neutral',
      artStyle: 'cinematic',
      lighting: 'natural',
      colorPalette: ['#000'],
      cameraWork: 'static',
      referenceFilms: [],
      colorGrading: 'neutral',
    },
  });
  await db.insert(sequences).values({
    id: sequenceId,
    teamId,
    styleId,
    title: 'Test sequence',
    status: 'completed',
  });
  await db
    .insert(scenes)
    .values({ id: dbSceneId(sceneId), sequenceId, orderIndex: 0 });
  await db.insert(shots).values({
    id: shotId,
    sequenceId,
    sceneId: dbSceneId(sceneId),
    shotNumber: 1,
    durationMs: 3000,
  });
  await db.insert(frames).values({ id: frameId, shotId, sequenceId });
  await db
    .insert(user)
    .values({ id: actorId, name: 'Actor', email: `${actorId}@test.invalid` });
  scopedDb = createScopedDb(teamId, actorId);
});

describe('music', () => {
  it('refuses to generate without a music prompt, before any run', async () => {
    expect(await call('generate_music', { sequenceId })).toMatchObject(
      refused('VALIDATION_ERROR')
    );
    expect(triggerWorkflow).not.toHaveBeenCalled();
  });

  it('saves the sent prompt, claims a track and starts the run', async () => {
    expect(
      await data('generate_music', {
        sequenceId,
        prompt: 'Warm strings',
        tags: 'orchestral',
      })
    ).toMatchObject({ started: true });
    expect(triggerWorkflow).toHaveBeenCalledWith(
      '/music',
      expect.objectContaining({ prompt: 'Warm strings', tags: 'orchestral' })
    );
    const tracks = await db
      .select()
      .from(sequenceMusicVariants)
      .where(eq(sequenceMusicVariants.sequenceId, sequenceId));
    expect(tracks).toHaveLength(1);
  });

  it('rejects a foreign sequence', async () => {
    scopedDb = createScopedDb(generateId(), actorId);
    expect(await call('rewrite_music_prompt', { sequenceId })).toMatchObject(
      refused('NOT_FOUND')
    );
  });
});

describe('shot dialogue and pending artifacts', () => {
  it('refuses to record a shot with no voiced lines', async () => {
    expect(
      await call('regenerate_shot_dialogue', {
        sequenceId,
        shotId,
        scope: 'shot',
      })
    ).toMatchObject(refused('VALIDATION_ERROR'));
    expect(triggerWorkflow).not.toHaveBeenCalled();
  });

  it('lists no claims and cancels nothing for an unknown claim', async () => {
    expect(
      await data('list_shot_dialogue_claims', { sequenceId, shotId })
    ).toEqual({ claims: [] });
    expect(
      await data('cancel_shot_dialogue', {
        sequenceId,
        shotId,
        claimId: generateId(),
      })
    ).toEqual({ cancelled: false });
  });

  it('cancels a generating still once', async () => {
    const versionId = generateId();
    await db.insert(frameVariants).values({
      id: versionId,
      frameId,
      sequenceId,
      model: 'nano_banana_2',
      status: 'generating',
    });
    const args = { sequenceId, shotId, versionId, artifact: 'image' };
    expect(await data('cancel_pending_shot_artifact', args)).toEqual({
      cancelled: true,
    });
    expect(await data('cancel_pending_shot_artifact', args)).toEqual({
      cancelled: false,
    });
  });

  it('does not find a still of another shot', async () => {
    expect(
      await call('cancel_pending_shot_artifact', {
        sequenceId,
        shotId,
        versionId: generateId(),
        artifact: 'image',
      })
    ).toMatchObject(refused('NOT_FOUND'));
  });
});

describe('cast', () => {
  it('cancels no voice when none is generating', async () => {
    const characterId = generateId();
    await castCharacter({
      id: characterId,
      sequenceId,
      characterId: 'char_001',
      name: 'Ada',
    });
    expect(
      await data('cancel_character_voice', { sequenceId, characterId })
    ).toEqual({ cancelled: false });
  });

  it('refuses to recast a voice-only character', async () => {
    const characterId = generateId();
    await castCharacter({
      id: characterId,
      sequenceId,
      characterId: 'char_001',
      name: 'Narrator',
      voiceOnly: true,
    });
    expect(
      await call('recast_character', {
        sequenceId,
        characterId,
        talentId: generateId(),
      })
    ).toMatchObject(refused('VALIDATION_ERROR'));
  });

  it('refuses a library location with no reference image', async () => {
    const locationId = generateId();
    const libraryLocationId = generateId();
    await db.insert(sequenceLocations).values({
      id: locationId,
      sequenceId,
      locationId: 'loc_001',
      legacyName: 'Office',
    });
    await db
      .insert(locationLibrary)
      .values({ id: libraryLocationId, teamId, name: 'Office' });
    expect(
      await call('recast_location', {
        sequenceId,
        locationId,
        libraryLocationId,
      })
    ).toMatchObject(refused('VALIDATION_ERROR'));
    expect(triggerWorkflow).not.toHaveBeenCalled();
  });

  it('does not find a character of another sequence', async () => {
    expect(
      await call('regenerate_character_sheet', {
        sequenceId,
        characterId: generateId(),
      })
    ).toMatchObject(refused('NOT_FOUND'));
  });
});

describe('recast across a range and the move preview (#2017)', () => {
  const sequence = async (title: string) => {
    const id = generateId();
    const [seq] = await db
      .select({ styleId: sequences.styleId })
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!seq) throw new Error('seed sequence missing');
    await db.insert(sequences).values({
      id,
      teamId,
      styleId: seq.styleId,
      title,
      status: 'completed',
    });
    return id;
  };
  const castInThree = async () => {
    const created = await castCharacter({
      id: generateId(),
      sequenceId,
      characterId: 'char_001',
      name: 'Ada',
      age: '30s',
    });
    const b = await sequence('B');
    const c = await sequence('C');
    await scopedDb.characters.attach(b, created.id, { actorId });
    await scopedDb.characters.attach(c, created.id, { actorId });
    const [talentRow] = await db
      .insert(talent)
      .values({ teamId, name: 'Jude', description: 'tall' })
      .returning();
    if (!talentRow) throw new Error('talent insert returned nothing');
    return { created, b, c, talentId: talentRow.id };
  };

  it('moves the named sequences to the recast version and names the ones left behind', async () => {
    const { created, b, c, talentId } = await castInThree();
    const result = z
      .object({
        movedSequences: z.array(
          z.object({ sequenceId: z.string(), moved: z.boolean() })
        ),
        sequencesLeftBehind: z.array(
          z.object({ sequenceId: z.string(), title: z.string() })
        ),
      })
      .parse(
        await data('recast_character', {
          sequenceId,
          characterId: created.id,
          talentId,
          applyToSequenceIds: [b],
        })
      );
    expect(result.movedSequences).toEqual([{ sequenceId: b, moved: true }]);
    expect(result.sequencesLeftBehind).toEqual([{ sequenceId: c, title: 'C' }]);
    // B pins the recast version; C still pins the one before it.
    const inB = await scopedDb.characters.getById(b, created.id);
    const inC = await scopedDb.characters.getById(c, created.id);
    expect(inB?.talentId).toBe(talentId);
    expect(inB?.selectedBibleVersionId).toBe(inB?.currentBibleVersionId);
    expect(inC?.talentId).toBeNull();
    expect(inC?.selectedBibleVersionId).not.toBe(inC?.currentBibleVersionId);
    expect(triggerWorkflow).toHaveBeenCalledTimes(1);

    // The preview: C is behind, naming the talent and the bible fields that
    // moved; B is current.
    const { previewVersionMove } = await import('@/cast/server/version-moves');
    const rows = await previewVersionMove(scopedDb, created.id, {});
    const rowC = rows.find((row) => row.sequenceId === c);
    const rowB = rows.find((row) => row.sequenceId === b);
    expect(rowB).toMatchObject({ behind: false, moved: [], shotCount: 0 });
    expect(rowC?.behind).toBe(true);
    expect(rowC?.moved).toContain('talent');
    expect(rowC?.shotCount).toBe(0);
    // The default look's sheet inputs moved (the talent): one sheet to redraw.
    expect(rowC?.sheetCount).toBe(1);
  });

  it("refuses the whole recast before writing when a named sequence is another team's or does not cast the character", async () => {
    const { created, b, talentId } = await castInThree();
    const foreign = generateId();
    expect(
      await call('recast_character', {
        sequenceId,
        characterId: created.id,
        talentId,
        applyToSequenceIds: [b, foreign],
      })
    ).toMatchObject(refused('NOT_FOUND'));
    expect(triggerWorkflow).not.toHaveBeenCalled();
    const inA = await scopedDb.characters.getById(sequenceId, created.id);
    expect(inA?.talentId).toBeNull();
  });
});

describe('moves and copies on the real scoped db (#2017)', () => {
  const sequence = async (title: string, team = teamId) => {
    const id = generateId();
    const [seq] = await db
      .select({ styleId: sequences.styleId })
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!seq) throw new Error('seed sequence missing');
    await db.insert(sequences).values({
      id,
      teamId: team,
      styleId: seq.styleId,
      title,
      status: 'completed',
    });
    return id;
  };

  it("[B, foreign, C]: another team's sequence refuses the whole move; B and C stay behind", async () => {
    const { moveCastsToCurrent } = await import('@/cast/server/version-moves');
    const created = await castCharacter({
      id: generateId(),
      sequenceId,
      characterId: 'char_001',
      name: 'Ada',
      age: '30s',
    });
    const b = await sequence('B');
    const c = await sequence('C');
    await scopedDb.characters.attach(b, created.id, { actorId });
    await scopedDb.characters.attach(c, created.id, { actorId });
    const otherTeam = generateId();
    await db
      .insert(teams)
      .values({ id: otherTeam, name: 'O', slug: otherTeam });
    const foreign = await sequence('F', otherTeam);
    // A new bible version from A: B and C are behind.
    await scopedDb.characters.updateBible(
      sequenceId,
      created.id,
      { age: '40s' },
      { actorId, source: 'edit' }
    );
    await expect(
      moveCastsToCurrent(scopedDb, { userId: actorId }, created.id, [
        b,
        foreign,
        c,
      ])
    ).rejects.toThrow('Sequence not found');
    for (const id of [b, c]) {
      const inSeq = await scopedDb.characters.getById(id, created.id);
      expect(inSeq?.age).toBe('30s');
    }
    // The same ids without the foreign one move in one batch.
    expect(
      await moveCastsToCurrent(scopedDb, { userId: actorId }, created.id, [
        b,
        c,
      ])
    ).toEqual([
      { sequenceId: b, moved: true },
      { sequenceId: c, moved: true },
    ]);
    expect((await scopedDb.characters.getById(c, created.id))?.age).toBe('40s');
  });

  it('a one-off copy is refused for a character nothing else holds', async () => {
    const created = await castCharacter({
      id: generateId(),
      sequenceId,
      characterId: 'char_001',
      name: 'Ada',
    });
    await expect(
      scopedDb.characters.copyForSequence(sequenceId, created.id, { actorId })
    ).rejects.toThrow('only in this sequence');
  });
});

describe('a character that must be a person is stored as one, on every path (#2065)', () => {
  const actor = () => ({ userId: actorId });
  const sequence = async (title: string) => {
    const id = generateId();
    const [seq] = await db
      .select({ styleId: sequences.styleId })
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!seq) throw new Error('seed sequence missing');
    await db.insert(sequences).values({
      id,
      teamId,
      styleId: seq.styleId,
      title,
      status: 'completed',
    });
    return id;
  };
  /** Cast in A (the seed sequence) and B, both pinning one bible version. */
  const castInTwo = async (isPerson: boolean) => {
    const created = await castCharacter({
      id: generateId(),
      sequenceId,
      characterId: 'char_001',
      name: 'Xan',
      age: '30s',
      isPerson,
    });
    const b = await sequence('B');
    await scopedDb.characters.attach(b, created.id, { actorId });
    return { id: created.id, b };
  };
  /**
   * An uploaded photo the ledger saw a real person in, selected as the
   * default look's sheet in `inSequence`. The sheet only: the upload path's
   * own bible write is the caller's to make or leave out.
   */
  const uploadRealPhoto = async (inSequence: string, characterId: string) => {
    const url = `/r2/characters/${teamId}/uploads/${generateId()}.png`;
    const { version } = await scopedDb.characterSheetVariants.applyConvergent({
      sequenceId: inSequence,
      lookId: characterId,
      url,
      storagePath: url.slice('/r2/'.length),
      inputHash: null,
      model: USER_UPLOAD_MODEL,
    });
    await scopedDb.compliance.attestations.record({
      subjectType: 'uploaded_image',
      subjectId: await sha256Hex(url),
      statementVersion: PORTRAIT_RIGHTS_V1.version,
      statementSha256: 'x'.repeat(64),
      depictsRealPerson: true,
    });
    return version.id;
  };
  /** What the upload path writes when the ledger says a real person. */
  const markPerson = (inSequence: string, characterId: string) =>
    scopedDb.characters.updateBible(
      inSequence,
      characterId,
      { isPerson: true },
      { actorId, source: 'edit' }
    );
  const isPersonIn = async (inSequence: string, characterId: string) =>
    (await scopedDb.characters.getById(inSequence, characterId))?.isPerson;
  const isPersonNow = async (characterId: string) =>
    (await scopedDb.characters.getCurrent(characterId))?.isPerson;

  it('C1: an edit from a sequence that pins an older not-a-person version writes a person', async () => {
    const { id, b } = await castInTwo(false);
    await uploadRealPhoto(b, id);
    await markPerson(b, id);
    expect(await isPersonIn(sequenceId, id)).toBe(false);

    // A edits the age: the new current version is built from A's pin.
    const edited = await updateCharacter(scopedDb, actor(), sequenceId, id, {
      age: '40s',
    });
    expect(edited).toMatchObject({ age: '40s', isPerson: true });
    expect(await isPersonNow(id)).toBe(true);
    // Still refused outright.
    await expect(
      updateCharacter(scopedDb, actor(), sequenceId, id, { isPerson: false })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // A row stored wrong repairs itself on its next save, from no sequence
    // too.
    await db
      .update(characterBibleVersions)
      .set({ isPerson: false })
      .where(eq(characterBibleVersions.characterId, id));
    await updateTeamCharacter(scopedDb, actor(), id, { movement: 'Glides' });
    expect(await isPersonNow(id)).toBe(true);
  });

  it('C2: the features move of a default look’s styling edit does not carry a stale not-a-person forward', async () => {
    const { id, b } = await castInTwo(false);
    // Before #2065: the features still sit on her bible version.
    await db
      .update(characterBibleVersions)
      .set({ legacyDistinguishingFeatures: 'scar' })
      .where(eq(characterBibleVersions.characterId, id));
    await uploadRealPhoto(b, id);
    await markPerson(b, id);

    // A, still pinning the not-a-person version, edits the styling: the
    // move copies A's pinned version forward and makes it current.
    await updateCharacterLook(scopedDb, actor(), sequenceId, id, id, {
      styling: 'hair down',
    });
    expect(await scopedDb.characters.getCurrent(id)).toMatchObject({
      isPerson: true,
      legacyDistinguishingFeatures: null,
    });
    expect(await isPersonIn(sequenceId, id)).toBe(true);
  });

  it('C2: the same from the Characters page, for a row stored wrong', async () => {
    const { id, b } = await castInTwo(true);
    await uploadRealPhoto(b, id);
    await db
      .update(characterBibleVersions)
      .set({ isPerson: false, legacyDistinguishingFeatures: 'scar' })
      .where(eq(characterBibleVersions.characterId, id));
    await updateTeamCharacterLook(scopedDb, actor(), id, id, {
      styling: 'hair down',
    });
    expect(await scopedDb.characters.getCurrent(id)).toMatchObject({
      isPerson: true,
      legacyDistinguishingFeatures: null,
    });
  });

  it('C3: Update this sequence never lands a real-person sheet on a not-a-person version', async () => {
    const { moveSequenceToCurrent, moveCastsToCurrent } =
      await import('@/cast/server/version-moves');
    const { id, b } = await castInTwo(true);
    // Nothing locks her yet: A makes her not a person. B is now behind.
    await updateCharacter(scopedDb, actor(), sequenceId, id, {
      isPerson: false,
    });
    expect(await isPersonNow(id)).toBe(false);
    // B's sheet becomes a real person's photo. B already pins a person, so
    // the upload writes no bible version.
    await uploadRealPhoto(b, id);

    expect(await moveSequenceToCurrent(scopedDb, actor(), b, id)).toEqual({
      moved: true,
    });
    const inB = await scopedDb.characters.getById(b, id);
    expect(inB?.isPerson).toBe(true);
    expect(inB?.selectedBibleVersionId).toBe(inB?.currentBibleVersionId);

    // "Move sequences" is the same gate.
    const c = await sequence('C');
    await scopedDb.characters.attach(c, id, { actorId });
    await db
      .update(characterBibleVersions)
      .set({ isPerson: false })
      .where(eq(characterBibleVersions.characterId, id));
    await moveCastsToCurrent(scopedDb, actor(), id, [c]);
    expect(await isPersonIn(c, id)).toBe(true);
  });

  it('C3: a recast with a talent that is not a person, applied to a sequence wearing a real photo, stays a person', async () => {
    const { id, b } = await castInTwo(false);
    await uploadRealPhoto(b, id);
    await markPerson(b, id);
    const [creature] = await db
      .insert(talent)
      .values({ teamId, name: 'Rex', description: 'a dragon', isHuman: false })
      .returning();
    if (!creature) throw new Error('talent insert returned nothing');

    // A (pinning the not-a-person version) recasts, and applies it to B.
    await data('recast_character', {
      sequenceId,
      characterId: id,
      talentId: creature.id,
      applyToSequenceIds: [b],
    });
    const inB = await scopedDb.characters.getById(b, id);
    expect(inB).toMatchObject({ talentId: creature.id, isPerson: true });
    // One recast version, pinned by both: A is not left behind by a repair.
    const inA = await scopedDb.characters.getById(sequenceId, id);
    expect(inA?.selectedBibleVersionId).toBe(inB?.selectedBibleVersionId);
    expect(inA?.selectedBibleVersionId).toBe(inA?.currentBibleVersionId);
  });

  it('C4: selecting an uploaded photo of a real person again makes the character a person', async () => {
    const created = await castCharacter({
      id: generateId(),
      sequenceId,
      characterId: 'char_001',
      name: 'Xan',
      isPerson: false,
    });
    const { id } = created;
    const photo = await uploadRealPhoto(sequenceId, id);
    await markPerson(sequenceId, id);
    // Regenerated: a drawn sheet is selected, and the lock lifts.
    await scopedDb.characterSheetVariants.applyConvergent({
      sequenceId,
      lookId: id,
      url: '/r2/drawn.png',
      storagePath: 'drawn.png',
      inputHash: null,
      model: 'nano_banana_2',
    });
    await updateCharacter(scopedDb, actor(), sequenceId, id, {
      isPerson: false,
    });
    expect(await isPersonIn(sequenceId, id)).toBe(false);

    await selectCharacterSheetVersion(scopedDb, actor(), sequenceId, id, photo);
    expect(await isPersonIn(sequenceId, id)).toBe(true);
    expect(await isPersonNow(id)).toBe(true);
  });

  it('C6: a talent that went private still locks, in the list and in the edit alike', async () => {
    const otherTeam = generateId();
    await db
      .insert(teams)
      .values({ id: otherTeam, name: 'O', slug: otherTeam });
    // Cast while it was public; private now, so the team-scoped talent read
    // no longer returns it.
    const [actress] = await db
      .insert(talent)
      .values({
        teamId: otherTeam,
        name: 'Ada Vale',
        isHuman: true,
        isPublic: false,
      })
      .returning();
    if (!actress) throw new Error('talent insert returned nothing');
    const created = await castCharacter({
      id: generateId(),
      sequenceId,
      characterId: 'char_001',
      name: 'Xan',
      talentId: actress.id,
    });
    expect(await scopedDb.talent.getById(actress.id)).toBeUndefined();
    const lock = { reason: 'talent', talentName: 'Ada Vale' };
    const list = await scopedDb.characters.listWithTalent(sequenceId);
    expect(await personLocksOf(scopedDb, list)).toEqual([lock]);
    expect(await personLockOf(scopedDb, created)).toEqual(lock);
    await expect(
      updateCharacter(scopedDb, actor(), sequenceId, created.id, {
        isPerson: false,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
