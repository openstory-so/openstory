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
