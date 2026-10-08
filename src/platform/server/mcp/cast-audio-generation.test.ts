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
