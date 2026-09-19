import {
  talent,
  talentSheets,
  talentMedia,
  talentSheetVariants,
  locationLibrary,
  locationSheets,
  generatedAssets,
  audio,
  vfx,
  user,
} from '@/platform/server/db/schema';
import { listFilesPage } from '#storage';
vi.mock('#storage', () => ({ listFilesPage: vi.fn() }));
import { registerLibraryReads } from './tools/library-reads';
import {
  characters,
  characterSheetVariants,
  sequenceLocations,
  locationSheetVariants,
  sequenceElements,
  sequenceMusicVariants,
  sequenceMusicPromptVersions,
  sequenceEvents,
} from '@/platform/server/db/schema';
import { registerCastReads } from './tools/cast-reads';
import { registerProductionReads } from './tools/production-reads';
import { registerContextReads } from './tools/context-reads';
/** MCP wire tests backed by the real scoped repositories and migrated SQLite schema. */
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
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
// oxlint-disable-next-line boundaries/no-raw-db -- substitute the isolated in-memory DB at the factory boundary
import { getDb } from '#db-client';
import type { Database } from '@/platform/server/db/client';
// oxlint-disable-next-line boundaries/no-scoped-factory -- exercise real team-scoped repositories, not mocked authorization
import { createScopedDb } from '@/platform/server/db/scoped';
import { generateId } from '@/platform/id';
import { relations } from '@/platform/server/db/schema/relations';
import {
  frames,
  frameVariants,
  framePromptVersions,
  scenes,
  sceneScriptVersions,
  sequences,
  shots,
  shotPromptVersions,
  styles,
  teams,
  renderSegments,
  videoVariants,
  sequenceExports,
} from '@/platform/server/db/schema';
import { dbSceneId } from '@/shots/scene-id';
import {
  shotInspectionSchema,
  sceneDetailSchema,
} from '@/shots/inspection.schema';
import { serializeShot } from '@/shots/server/inspection';
import { registerListSequences } from './tools/list-sequences';
import { registerGetSequence } from './tools/get-sequence';
import { registerGetSequenceStatus } from './tools/get-sequence-status';
import { registerListScenes } from './tools/list-scenes';
import { registerGetScene } from './tools/get-scene';
import { registerListShots } from './tools/list-shots';
import { registerGetShot } from './tools/get-shot';

vi.mock('#db-client', () => ({ getDb: vi.fn() }));
let client: Client;
let db: Database;
let teamId: string;
let sequenceId: string;
let sceneId: string;
let shotId: string;
let frameId: string;
let segmentId: string;
let imageId: string;
let videoId: string;
let scopedDb: ReturnType<typeof createScopedDb>;
const queries: string[] = [];
const registrations = [
  registerLibraryReads,
  registerCastReads,
  registerProductionReads,
  registerContextReads,
  registerListSequences,
  registerGetSequence,
  registerGetSequenceStatus,
  registerListScenes,
  registerGetScene,
  registerListShots,
  registerGetShot,
];
const handler = createMcpHandler(
  () => {
    const server = new McpServer(
      { name: 'test', version: '1' },
      { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() }
    );
    for (const register of registrations)
      register(server, () => ({ scopedDb, origin: 'https://openstory.test' }));
    return server;
  },
  { legacy: 'reject' }
);
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await handler.fetch(
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
    })
  );
  const envelope = z
    .object({
      result: z
        .object({
          isError: z.boolean().optional(),
          structuredContent: z.record(z.string(), z.unknown()).optional(),
          content: z.array(z.object({ type: z.string(), text: z.string() })),
        })
        .optional(),
      error: z.unknown().optional(),
    })
    .parse(await response.json());
  expect(envelope.error).toBeUndefined();
  if (!envelope.result) throw new Error('Missing tool result');
  return envelope.result;
}
async function data(name: string, args: Record<string, unknown>) {
  const result = await call(name, args);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.structuredContent;
}
async function addShot(parent = sceneId, number = 2) {
  const id = generateId();
  await db.insert(shots).values({
    id,
    sequenceId,
    sceneId: dbSceneId(parent),
    shotNumber: number,
    durationMs: 4000,
  });
  return id;
}
async function addScene(orderIndex: number) {
  const id = dbSceneId(generateId());
  await db
    .insert(scenes)
    .values({ id, sequenceId, orderIndex, title: 'Another scene' });
  return id;
}
beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({
    client,
    relations,
    logger: {
      logQuery(query) {
        queries.push(query);
      },
    },
  });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  vi.mocked(getDb).mockReturnValue(db);
});
afterAll(() => {
  client.close();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  vi.stubEnv('R2_PUBLIC_STORAGE_DOMAIN', undefined);
  teamId = generateId();
  sequenceId = generateId();
  sceneId = generateId();
  shotId = generateId();
  frameId = generateId();
  segmentId = generateId();
  imageId = generateId();
  videoId = generateId();
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
    title: 'Test sequence',
    styleId,
    status: 'completed',
    generateStartFrames: true,
  });
  const scriptId = generateId();
  await db.insert(scenes).values({
    id: dbSceneId(sceneId),
    sequenceId,
    orderIndex: 0,
    title: 'Opening',
    selectedScriptVersionId: scriptId,
  });
  await db.insert(sceneScriptVersions).values({
    id: scriptId,
    sceneId,
    content: { extract: 'Selected script', dialogue: [] },
    source: 'edit',
  });
  await db.insert(renderSegments).values({
    id: segmentId,
    sequenceId,
    sceneId,
    selectedVideoVersionId: videoId,
  });
  await db.insert(shots).values({
    id: shotId,
    sequenceId,
    sceneId: dbSceneId(sceneId),
    shotNumber: 1,
    durationMs: 3000,
    renderSegmentId: segmentId,
  });
  await db.insert(frames).values({
    id: frameId,
    shotId,
    sequenceId,
    selectedImageVersionId: imageId,
    imageStatus: 'completed',
  });
  await db.insert(frameVariants).values({
    id: imageId,
    frameId,
    sequenceId,
    model: 'nano_banana_2',
    status: 'completed',
    url: '/r2/openstory-images/still.png',
  });
  await db.insert(videoVariants).values({
    id: videoId,
    sequenceId,
    renderSegmentId: segmentId,
    model: 'wan_i2v',
    manifest: [],
    status: 'completed',
    isPrimary: true,
    url: '/r2/openstory-videos/clip.mp4',
  });
  const visualId = generateId(),
    motionId = generateId();
  await db.insert(framePromptVersions).values({
    id: visualId,
    frameId,
    text: 'Visual prompt',
    source: 'user-edit',
  });
  await db.insert(shotPromptVersions).values({
    id: motionId,
    shotId,
    promptType: 'motion',
    text: 'Motion prompt',
    source: 'user-edit',
  });
  await db
    .update(frames)
    .set({ selectedImagePromptVersionId: visualId })
    .where(eq(frames.id, frameId));
  await db
    .update(shots)
    .set({ selectedMotionPromptVersionId: motionId })
    .where(eq(shots.id, shotId));
  scopedDb = createScopedDb(teamId, generateId());
  queries.length = 0;
});

describe('entity identity and team ownership', () => {
  it.each([
    'get_sequence',
    'get_sequence_status',
    'list_scenes',
    'get_scene',
    'list_shots',
    'get_shot',
  ])('%s rejects a foreign team before child reads', async (name) => {
    scopedDb = createScopedDb(generateId(), generateId());
    const args = {
      sequenceId,
      ...(name === 'get_scene' ? { sceneId } : {}),
      ...(name === 'get_shot' ? { shotId } : {}),
    };
    expect(await call(name, args)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'NOT_FOUND' } },
    });
    expect(queries).toHaveLength(1);
  });
  it('lists only the current team', async () => {
    expect(await data('list_sequences', {})).toMatchObject({
      sequences: [{ id: sequenceId }],
      nextCursor: null,
    });
    scopedDb = createScopedDb(generateId(), generateId());
    expect(await data('list_sequences', {})).toEqual({
      sequences: [],
      nextCursor: null,
    });
  });
  it('rejects wrong entity IDs, missing IDs and unknown selector fields', async () => {
    for (const [name, args] of [
      ['get_scene', { sequenceId, shotId }],
      ['get_scene', { sequenceId, sceneId: shotId }],
      ['get_scene', { sequenceId, sceneId, shotId }],
      ['get_shot', { sequenceId, sceneId }],
      ['get_shot', { sequenceId, shotId: sceneId }],
      ['get_shot', { sequenceId, shotId: 'not-a-ulid' }],
    ] as const)
      expect((await call(name, args)).isError).toBe(true);
  });
  it('rejects wrong-sequence children and scene filters, including empty scenes', async () => {
    const other = generateId();
    const [seq] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!seq) throw new Error('fixture');
    await db
      .insert(sequences)
      .values({ id: other, teamId, title: 'Other', styleId: seq.styleId });
    for (const [name, args] of [
      ['get_scene', { sceneId }],
      ['get_shot', { shotId }],
      ['list_shots', { sceneId }],
    ] as const)
      expect(await call(name, { sequenceId: other, ...args })).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'NOT_FOUND' } },
      });
  });
});

describe('scene and shot projections', () => {
  it('returns matching selected versions and prompts through scene and shot detail', async () => {
    const shot = shotInspectionSchema.parse(
      await data('get_shot', { sequenceId, shotId })
    );
    const scene = sceneDetailSchema.parse(
      await data('get_scene', { sequenceId, sceneId })
    );
    expect(scene.shots).toEqual([shot]);
    expect(scene.script?.content.extract).toBe('Selected script');
    expect(shot).toMatchObject({
      id: shotId,
      sceneId,
      durationMs: 3000,
      effectiveUseStartFrame: true,
      anchorFrame: {
        id: frameId,
        prompt: 'Visual prompt',
        selectedImage: {
          versionId: imageId,
          usable: true,
          url: 'https://openstory.test/r2/openstory-images/still.png',
        },
      },
      motion: {
        prompt: 'Motion prompt',
        selectedVideo: { versionId: videoId, usable: true },
      },
    });
    expect(queries.some((q) => /^(insert|update|delete)/i.test(q))).toBe(false);
  });
  it('keeps frameless shots visible and resolves reference-only mode without repairing data', async () => {
    const id = await addShot();
    await db
      .update(shots)
      .set({ useStartFrame: false })
      .where(eq(shots.id, id));
    queries.length = 0;
    expect(await data('get_shot', { sequenceId, shotId: id })).toMatchObject({
      id,
      anchorFrame: null,
      effectiveUseStartFrame: false,
    });
    expect(queries.some((q) => /^(insert|update|delete)/i.test(q))).toBe(false);
  });
  it('omits optional payloads from default lists and does not select prompt text', async () => {
    const result = await data('list_shots', { sequenceId });
    const page = z
      .object({ shots: z.array(shotInspectionSchema) })
      .parse(result);
    expect(page.shots[0]?.motion.prompt).toBeUndefined();
    expect(page.shots[0]?.anchorFrame?.selectedImage.url).toBeUndefined();
    expect(
      queries.some((q) =>
        q
          .slice(0, q.indexOf(' from '))
          .includes('"frame_prompt_versions"."text"')
      )
    ).toBe(false);
    expect(
      await data('list_shots', {
        sequenceId,
        includePrompts: true,
        includeAssets: true,
      })
    ).toMatchObject({ shots: [{ motion: { prompt: 'Motion prompt' } }] });
  });
  it('serializes loaded data without any database access', async () => {
    const read = await scopedDb.shots.getDetail(sequenceId, shotId);
    queries.length = 0;
    expect(
      serializeShot(
        read,
        { generateStartFrames: true },
        'https://openstory.test',
        { includeAssets: true, includePrompts: true }
      ).id
    ).toBe(shotId);
    expect(queries).toEqual([]);
  });
  it('returns the JSON data in text for clients without structured-result support', async () => {
    const result = await call('get_shot', { sequenceId, shotId });
    expect(JSON.parse(result.content[1]?.text ?? '')).toEqual(
      result.structuredContent
    );
  });
});

describe('paging and deleted children', () => {
  it('pages shots in scene/shot order, filters scenes, and binds cursors to the filter', async () => {
    const second = await addShot();
    const otherScene = await addScene(1);
    const third = await addShot(otherScene, 1);
    const shape = z.object({
      shots: z.array(shotInspectionSchema),
      nextCursor: z.string().nullable(),
    });
    const first = shape.parse(
      await data('list_shots', { sequenceId, limit: 1 })
    );
    expect(first.shots.map((s) => s.id)).toEqual([shotId]);
    const rest = shape.parse(
      await data('list_shots', {
        sequenceId,
        limit: 10,
        cursor: first.nextCursor,
      })
    );
    expect(rest.shots.map((s) => s.id)).toEqual([second, third]);
    expect(rest.nextCursor).toBeNull();
    expect(
      (
        await call('list_shots', {
          sequenceId,
          sceneId,
          cursor: first.nextCursor,
        })
      ).isError
    ).toBe(true);
    expect(
      shape
        .parse(await data('list_shots', { sequenceId, sceneId: otherScene }))
        .shots.map((s) => s.id)
    ).toEqual([third]);
    const emptyScene = await addScene(2);
    expect(
      await data('list_shots', { sequenceId, sceneId: emptyScene })
    ).toEqual({ sequenceId, shots: [], nextCursor: null });
  });
  it('pages scenes and bounds nested children with explicit truncation', async () => {
    for (let i = 2; i <= 7; i++) await addShot(sceneId, i);
    const nextScene = await addScene(1);
    const shape = z.object({
      scenes: z.array(
        z.object({
          id: z.string(),
          shots: z.array(shotInspectionSchema),
          shotsTruncated: z.boolean(),
        })
      ),
      nextCursor: z.string().nullable(),
    });
    const first = shape.parse(
      await data('list_scenes', { sequenceId, limit: 1 })
    );
    expect(first.scenes[0]?.shots).toHaveLength(5);
    expect(first.scenes[0]?.shotsTruncated).toBe(true);
    expect(
      shape
        .parse(
          await data('list_scenes', { sequenceId, cursor: first.nextCursor })
        )
        .scenes.map((s) => s.id)
    ).toEqual([nextScene]);
    expect(
      (await call('list_scenes', { sequenceId, cursor: 'bad' })).isError
    ).toBe(true);
    expect((await call('list_sequences', { cursor: 'bad' })).isError).toBe(
      true
    );
  });
  it('excludes deleted shots and children of deleted scenes from reads and counts', async () => {
    const hiddenScene = await addScene(1);
    const hiddenShot = await addShot(hiddenScene);
    // The app's own delete: a scene and its shots go in one batch (#1108).
    await scopedDb.scenes.softDeleteCascade(dbSceneId(hiddenScene), {
      actorId: null,
    });
    expect(await data('get_sequence_status', { sequenceId })).toMatchObject({
      counts: { shots: 1 },
    });
    expect(
      (await call('get_shot', { sequenceId, shotId: hiddenShot })).isError
    ).toBe(true);
    expect(
      (await call('get_scene', { sequenceId, sceneId: hiddenScene })).isError
    ).toBe(true);
    await db
      .update(shots)
      .set({ deletedAt: new Date() })
      .where(eq(shots.id, shotId));
    expect(await data('list_shots', { sequenceId })).toMatchObject({
      shots: [],
    });
    expect((await call('get_shot', { sequenceId, shotId })).isError).toBe(true);
  });
});

describe('status and result limits', () => {
  it('shares partially-ready counts across summaries and keeps selected assets after failed attempts', async () => {
    await db
      .update(frames)
      .set({ imageStatus: 'failed', imageError: 'Image failed' })
      .where(eq(frames.id, frameId));
    const failedId = generateId();
    await db.insert(videoVariants).values({
      id: failedId,
      sequenceId,
      renderSegmentId: segmentId,
      model: 'wan_i2v',
      manifest: [],
      status: 'failed',
      isPrimary: true,
      error: 'Video failed',
    });
    const status = await data('get_sequence_status', {
      sequenceId,
      includeFailures: true,
    });
    expect(status).toMatchObject({
      status: 'partially_ready',
      counts: {
        imagesReady: 1,
        imagesFailed: 1,
        videosReady: 1,
        videosFailed: 1,
      },
      failures: [{ stage: 'image' }, { stage: 'motion' }],
    });
    expect(await data('get_sequence', { sequenceId })).toMatchObject({
      status: 'partially_ready',
      counts: status?.counts,
    });
    expect(await data('list_sequences', {})).toMatchObject({
      sequences: [{ status: 'partially_ready', counts: status?.counts }],
    });
    expect(await data('get_shot', { sequenceId, shotId })).toMatchObject({
      anchorFrame: { status: 'failed', selectedImage: { usable: true } },
      motion: { status: 'failed', selectedVideo: { versionId: videoId } },
    });
  });
  it('counts shared segments once, exposes active workflows and retains processing lifecycle', async () => {
    const second = await addShot();
    await db
      .update(shots)
      .set({ renderSegmentId: segmentId })
      .where(eq(shots.id, second));
    await db
      .update(sequences)
      .set({ status: 'processing', workflowRunId: 'story-run' })
      .where(eq(sequences.id, sequenceId));
    await db
      .update(frames)
      .set({ imageStatus: 'generating', imageWorkflowRunId: 'image-run' })
      .where(eq(frames.id, frameId));
    await db
      .update(videoVariants)
      .set({ status: 'generating', workflowRunId: 'video-run' })
      .where(eq(videoVariants.id, videoId));
    await db.insert(sequenceExports).values({
      sequenceId,
      url: '',
      storagePath: '',
      status: 'processing',
      workflowRunId: 'export-run',
    });
    expect(await data('get_sequence_status', { sequenceId })).toMatchObject({
      status: 'processing',
      counts: { shots: 2, renderSegments: 1 },
      workflowRunIds: ['story-run', 'image-run', 'video-run', 'export-run'],
    });
  });
  it('does not treat an optional failed start frame as blocking a reference-only shot', async () => {
    await db
      .update(shots)
      .set({ useStartFrame: false })
      .where(eq(shots.id, shotId));
    await db
      .update(frames)
      .set({ imageStatus: 'failed' })
      .where(eq(frames.id, frameId));
    expect(await data('get_sequence_status', { sequenceId })).toMatchObject({
      status: 'completed',
      counts: { imagesFailed: 1 },
    });
  });
  it('does not count selected versions without a URL as usable', async () => {
    await db
      .update(frameVariants)
      .set({ url: null })
      .where(eq(frameVariants.id, imageId));
    await db
      .update(videoVariants)
      .set({ url: null })
      .where(eq(videoVariants.id, videoId));
    expect(await data('list_shots', { sequenceId })).toMatchObject({
      shots: [
        {
          anchorFrame: { selectedImage: { versionId: imageId, usable: false } },
          motion: { selectedVideo: { versionId: videoId, usable: false } },
        },
      ],
    });
    expect(await data('get_sequence_status', { sequenceId })).toMatchObject({
      counts: { imagesReady: 0, videosReady: 0 },
    });
  });
  it('keeps active exports visible even when there are more than 100 newer failures', async () => {
    const activeId = generateId();
    await db.insert(sequenceExports).values({
      id: activeId,
      sequenceId,
      url: '',
      storagePath: '',
      status: 'processing',
      workflowRunId: 'active-export',
    });
    for (let i = 0; i < 101; i++)
      await db.insert(sequenceExports).values({
        sequenceId,
        url: '',
        storagePath: '',
        status: 'failed',
        error: 'Export failed',
      });
    expect(
      await data('get_sequence_status', { sequenceId, includeFailures: true })
    ).toMatchObject({
      workflowRunIds: ['active-export'],
      activeExports: [{ id: activeId, workflowRunId: 'active-export' }],
      exportsTruncated: false,
      failuresTruncated: true,
    });
  });
  it('caps oversized results without silently truncating prompt text', async () => {
    await db
      .update(framePromptVersions)
      .set({ text: 'x'.repeat(300000) })
      .where(eq(framePromptVersions.frameId, frameId));
    const result = await call('get_shot', { sequenceId, shotId });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('256 KiB');
    expect(result.structuredContent).toBeUndefined();
  });
  it('does not leak internal exceptions', async () => {
    const fail = vi
      .spyOn(scopedDb.shots, 'getDetail')
      .mockRejectedValueOnce(new Error('private database password'));
    const result = await call('get_shot', { sequenceId, shotId });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private database password');
    fail.mockRestore();
  });
});

describe('complete production reads', () => {
  let characterId: string;
  let locationId: string;
  let elementId: string;
  let exportId: string;
  let eventId: string;
  let musicId: string;
  let musicPromptId: string;
  beforeEach(async () => {
    characterId = generateId();
    locationId = generateId();
    elementId = generateId();
    exportId = generateId();
    eventId = generateId();
    musicId = generateId();
    musicPromptId = generateId();
    await db.insert(characters).values({
      id: characterId,
      sequenceId,
      characterId: 'char_001',
      name: 'Ada',
      personality: 'Curious',
      consistencyTag: 'ada',
      voiceId: 'voice-ada',
      voicePreviews: [
        {
          generatedVoiceId: 'take-1',
          url: '/r2/voice.mp3',
          path: 'private-path',
        },
      ],
    });
    // Legacy sheet selection resolves via the parent ID, without writing a pointer.
    await db.insert(characterSheetVariants).values({
      id: characterId,
      characterId,
      model: 'nano_banana_2',
      status: 'completed',
      url: '/r2/ada.png',
    });
    await db.insert(sequenceLocations).values({
      id: locationId,
      sequenceId,
      locationId: 'loc_001',
      name: 'Office',
      description: 'Bright office',
      consistencyTag: 'office',
    });
    await db.insert(locationSheetVariants).values({
      id: locationId,
      parentId: locationId,
      parentType: 'sequence_location',
      model: 'nano_banana_2',
      status: 'completed',
      url: '/r2/office.png',
    });
    await db.insert(sequenceElements).values({
      id: elementId,
      sequenceId,
      token: 'BELL',
      uploadedFilename: 'bell.mp3',
      kind: 'audio',
      durationSeconds: 2,
      imageUrl: '/r2/bell.mp3',
      description: 'Bell ringing',
    });
    await db.insert(sequenceMusicVariants).values({
      id: musicId,
      sequenceId,
      model: 'music-test',
      url: '/r2/music.mp3',
      status: 'completed',
      prompt: 'Quiet piano',
    });
    await db.insert(sequenceMusicPromptVersions).values({
      id: musicPromptId,
      sequenceId,
      promptType: 'music',
      prompt: 'Quiet piano',
      source: 'user-edit',
    });
    await db
      .update(sequences)
      .set({
        script: 'Original script',
        musicUrl: '/r2/music.mp3',
        musicModel: 'music-test',
        musicPrompt: 'Quiet piano',
        generateVoices: true,
      })
      .where(eq(sequences.id, sequenceId));
    await db.insert(sequenceExports).values({
      id: exportId,
      sequenceId,
      status: 'ready',
      url: '/r2/export.mp4',
      storagePath: 'private/export',
      sourceShotsHash: 'cut-1',
      // The container reports a measured length, never a whole number.
      durationSeconds: 15.125,
    });
    await db.insert(sequenceEvents).values({
      id: eventId,
      sequenceId,
      kind: 'image.selected',
      targetType: 'frame',
      targetId: frameId,
      data: { versionId: imageId },
    });
    await db
      .update(scenes)
      .set({
        location: 'Office',
        continuity: {
          colorPalette: '',
          lightingSetup: '',
          styleTag: '',
          characterTags: ['ada'],
          environmentTag: 'office',
          elementTags: ['BELL'],
        },
      })
      .where(eq(scenes.id, dbSceneId(sceneId)));
    await db
      .update(shots)
      .set({
        audioClips: [
          {
            id: 'clip-1',
            url: '/r2/dialogue.mp3',
            token: 'Ada',
            durationSeconds: 1,
          },
        ],
      })
      .where(eq(shots.id, shotId));
    queries.length = 0;
  });

  function reads(): [string, Record<string, unknown>][] {
    return [
      ['list_characters', {}],
      ['get_character', { characterId }],
      ['list_locations', {}],
      ['get_location', { locationId }],
      ['list_elements', {}],
      ['get_element', { elementId }],
      ['get_sequence_settings', {}],
      ['get_sequence_script', {}],
      ['get_sequence_music', {}],
      ['list_frames', { shotId }],
      ['get_frame', { frameId }],
      ['list_render_segments', {}],
      ['get_render_segment', { segmentId }],
      ['list_versions', { kind: 'image', entityId: frameId }],
      ['get_version', { kind: 'image', entityId: frameId, versionId: imageId }],
      ['get_shot_audio', { shotId }],
      ['list_exports', {}],
      ['get_export_status', { exportId }],
      ['list_sequence_events', {}],
      ['get_sequence_event', { eventId }],
      ['list_shot_references', { kind: 'character', shotId }],
      ['list_entity_usages', { kind: 'character', entityId: characterId }],
      ['get_shot_staleness', { shotId }],
      ['list_shot_staleness', {}],
      ['get_reference_staleness', { kind: 'character', entityId: characterId }],
      ['get_render_segment_staleness', { segmentId }],
      ['get_music_staleness', {}],
    ];
  }
  it('every new tool executes against migrated SQLite and performs no writes', async () => {
    for (const [name, args] of reads())
      await data(name, { sequenceId, ...args });
    expect(
      queries.filter((query) =>
        /^(insert|update|delete|replace)\b/i.test(query)
      )
    ).toEqual([]);
  });
  it('every new tool rejects a foreign team', async () => {
    scopedDb = createScopedDb(generateId(), generateId());
    for (const [name, args] of reads()) {
      expect(await call(name, { sequenceId, ...args }), name).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'NOT_FOUND' } },
      });
    }
  });
  it('child lookups reject a different authorised sequence', async () => {
    const other = generateId();
    const sequence = await scopedDb.sequences.getById(sequenceId);
    if (!sequence) throw new Error('fixture');
    await db
      .insert(sequences)
      .values({ id: other, teamId, title: 'Other', styleId: sequence.styleId });
    for (const [name, args] of reads().filter(
      ([, args]) => Object.keys(args).length > 0
    )) {
      expect(
        await call(name, { sequenceId: other, ...args }),
        name
      ).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'NOT_FOUND' } },
      });
    }
  });
  it('returns voice previews, legacy selected sheets, and media kinds without private storage paths', async () => {
    const character = await data('get_character', { sequenceId, characterId });
    expect(character).toMatchObject({
      character: {
        id: characterId,
        characterId: 'char_001',
        effectiveUseVoice: true,
        selectedSheetVersionId: null,
        selectedSheet: {
          id: characterId,
          url: 'https://openstory.test/r2/ada.png',
        },
        voicePreviews: [
          {
            generatedVoiceId: 'take-1',
            url: 'https://openstory.test/r2/voice.mp3',
          },
        ],
      },
    });
    expect(JSON.stringify(character)).not.toContain('private-path');
    expect(
      await data('get_location', { sequenceId, locationId })
    ).toMatchObject({
      location: {
        selectedReference: {
          id: locationId,
          url: 'https://openstory.test/r2/office.png',
        },
      },
    });
    expect(await data('get_element', { sequenceId, elementId })).toMatchObject({
      element: {
        kind: 'audio',
        durationSeconds: 2,
        url: 'https://openstory.test/r2/bell.mp3',
      },
    });
  });
  it('pages entities and binds cursors to collection, sequence, and reference target', async () => {
    await db.insert(characters).values({
      id: generateId(),
      sequenceId,
      characterId: 'char_002',
      name: 'Other',
    });
    const pageSchema = z.object({
      characters: z.array(z.object({ id: z.string() })),
      nextCursor: z.string(),
    });
    const first = pageSchema.parse(
      await data('list_characters', { sequenceId, limit: 1 })
    );
    const second = z
      .object({
        characters: z.array(z.object({ id: z.string() })),
        nextCursor: z.null(),
      })
      .parse(
        await data('list_characters', {
          sequenceId,
          limit: 1,
          cursor: first.nextCursor,
        })
      );
    expect(second.characters[0]?.id).not.toBe(first.characters[0]?.id);
    expect(
      await call('list_locations', { sequenceId, cursor: first.nextCursor })
    ).toMatchObject({ isError: true });
    expect(
      await call('list_shot_references', {
        sequenceId,
        shotId,
        kind: 'character',
        cursor: first.nextCursor,
      })
    ).toMatchObject({ isError: true });
    expect(
      queries.some((query) => /from "characters".*limit \?/i.test(query))
    ).toBe(true);
  });
  it('uses effective style snapshots and reads original versus composed script with revision-safe windows', async () => {
    expect(await data('get_sequence_settings', { sequenceId })).toMatchObject({
      settings: {
        generateVoices: true,
        style: { source: 'library', config: { version: 2 } },
      },
    });
    const document = z.object({
      document: z.object({
        text: z.string(),
        revision: z.string(),
        nextOffset: z.number(),
      }),
    });
    const first = document.parse(
      await data('get_sequence_script', {
        sequenceId,
        mode: 'original',
        length: 4,
      })
    );
    expect(first.document.text).toBe('Orig');
    expect(
      await data('get_sequence_script', { sequenceId, mode: 'composed' })
    ).toMatchObject({
      document: { text: 'Selected script', nextOffset: null },
    });
    expect(
      await data('get_sequence_script', {
        sequenceId,
        mode: 'original',
        offset: first.document.nextOffset,
        revision: first.document.revision,
      })
    ).toMatchObject({ document: { text: 'inal script' } });
    await db
      .update(sequences)
      .set({ script: 'Changed script' })
      .where(eq(sequences.id, sequenceId));
    expect(
      await call('get_sequence_script', {
        sequenceId,
        mode: 'original',
        offset: first.document.nextOffset,
        revision: first.document.revision,
      })
    ).toMatchObject({ isError: true });
  });
  it('joins selected scene extracts in JavaScript and falls back to the original', async () => {
    const secondScene = generateId();
    const secondScript = generateId();
    await db.insert(scenes).values({
      id: dbSceneId(secondScene),
      sequenceId,
      orderIndex: 1,
      selectedScriptVersionId: secondScript,
    });
    await db.insert(sceneScriptVersions).values({
      id: secondScript,
      sceneId: secondScene,
      content: { extract: 'Second scene', dialogue: [] },
      source: 'edit',
    });
    queries.length = 0;
    expect(
      await data('get_sequence_script', { sequenceId, mode: 'composed' })
    ).toMatchObject({
      document: { text: 'Selected script\n\nSecond scene' },
    });
    expect(queries.join('\n')).not.toMatch(/group_concat/i);
    await db
      .update(scenes)
      .set({ selectedScriptVersionId: null })
      .where(eq(scenes.sequenceId, sequenceId));
    expect(
      await data('get_sequence_script', { sequenceId, mode: 'composed' })
    ).toMatchObject({
      document: { text: 'Original script' },
    });
  });
  it('makes every supported history kind inspectable, with explicit selection and parent ownership', async () => {
    const historyInputs = [
      ['image', frameId],
      ['video', segmentId],
      ['character_sheet', characterId],
      ['location_sheet', locationId],
      ['music', sequenceId],
      ['visual_prompt', frameId],
      ['motion_prompt', shotId],
      ['music_prompt', sequenceId],
      ['scene_script', sceneId],
    ];
    for (const [kind, entityId] of historyInputs) {
      const list = z
        .object({
          versions: z.array(
            z.object({ id: z.string(), selected: z.boolean() })
          ),
        })
        .parse(await data('list_versions', { sequenceId, kind, entityId }));
      expect(list.versions).toHaveLength(1);
      expect(list.versions[0]?.selected).toBe(true);
      const result = z
        .object({ document: z.object({ text: z.string() }) })
        .parse(
          await data('get_version', {
            sequenceId,
            kind,
            entityId,
            versionId: list.versions[0]?.id,
          })
        );
      const value = z
        .object({ id: z.string() })
        .parse(JSON.parse(result.document.text));
      expect(value.id).toBe(list.versions[0]?.id);
      expect(result.document.text).not.toContain('storagePath');
      expect(
        await call('get_version', {
          sequenceId,
          kind,
          entityId,
          versionId: generateId(),
        })
      ).toMatchObject({ isError: true });
    }
  });
  it('reads back the backfilled preview still whose id is 00 + the frame id', async () => {
    const versionId = `00${frameId}`;
    await db.insert(frameVariants).values({
      id: versionId,
      frameId,
      sequenceId,
      model: 'flux_2_turbo',
      status: 'completed',
      url: '/r2/preview.png',
    });
    const input = { sequenceId, kind: 'image', entityId: frameId };
    expect(await data('list_versions', input)).toMatchObject({
      versions: [{ id: versionId }, { id: imageId }],
    });
    expect(await data('get_version', { ...input, versionId })).toMatchObject({
      versionId,
      selected: false,
    });
  });

  it('paginates version metadata, windows large prompts and exposes discarded versions deliberately', async () => {
    const id = generateId();
    await db.insert(frameVariants).values({
      id,
      frameId,
      sequenceId,
      model: 'nano_banana_2',
      discardedAt: new Date(),
      url: '/r2/alternate.png',
    });
    expect(
      await data('list_versions', {
        sequenceId,
        kind: 'image',
        entityId: frameId,
      })
    ).toMatchObject({ versions: [{ id: imageId }], nextCursor: null });
    const first = z.object({ nextCursor: z.string() }).parse(
      await data('list_versions', {
        sequenceId,
        kind: 'image',
        entityId: frameId,
        includeDiscarded: true,
        limit: 1,
      })
    );
    expect(
      await call('list_versions', {
        sequenceId,
        kind: 'image',
        entityId: frameId,
        cursor: first.nextCursor,
      })
    ).toMatchObject({ isError: true });
    expect(
      await data('list_versions', {
        sequenceId,
        kind: 'image',
        entityId: frameId,
        cursor: first.nextCursor,
        includeDiscarded: true,
        limit: 1,
      })
    ).toMatchObject({ versions: [{ id }], nextCursor: null });
    const huge = 'Large visual prompt '.repeat(20000);
    const promptId = generateId();
    await db
      .insert(framePromptVersions)
      .values({ id: promptId, frameId, text: huge, source: 'user-edit' });
    expect(
      await data('list_versions', {
        sequenceId,
        kind: 'visual_prompt',
        entityId: frameId,
      })
    ).not.toHaveProperty('versions.0.text');
    const firstDoc = z
      .object({
        document: z.object({ text: z.string(), nextOffset: z.number() }),
      })
      .parse(
        await data('get_version', {
          sequenceId,
          kind: 'visual_prompt',
          entityId: frameId,
          versionId: promptId,
          length: 4000,
        })
      );
    expect(firstDoc.document.text).toHaveLength(4000);
    expect(firstDoc.document.nextOffset).toBe(4000);
  });
  it('validates location sheet parent types and excludes deleted entities and deleted parents', async () => {
    await db
      .update(locationSheetVariants)
      .set({ parentType: 'library_location' })
      .where(eq(locationSheetVariants.id, locationId));
    expect(
      await data('get_location', { sequenceId, locationId })
    ).toMatchObject({ location: { selectedReference: null } });
    expect(
      await call('get_version', {
        sequenceId,
        kind: 'location_sheet',
        entityId: locationId,
        versionId: locationId,
      })
    ).toMatchObject({ isError: true });
    await db
      .update(characters)
      .set({ deletedAt: new Date() })
      .where(eq(characters.id, characterId));
    expect(await data('list_characters', { sequenceId })).toMatchObject({
      characters: [],
    });
    expect(
      await call('get_character', { sequenceId, characterId })
    ).toMatchObject({ isError: true });
    await db
      .update(scenes)
      .set({ deletedAt: new Date() })
      .where(eq(scenes.id, dbSceneId(sceneId)));
    for (const [name, args] of [
      ['get_frame', { frameId }],
      ['get_render_segment', { segmentId }],
      ['list_versions', { kind: 'image', entityId: frameId }],
    ] satisfies [string, Record<string, unknown>][]) {
      expect(await call(name, { sequenceId, ...args })).toMatchObject({
        isError: true,
      });
    }
    expect(await data('list_render_segments', { sequenceId })).toMatchObject({
      segments: [],
    });
  });
  it.each([
    { defaultStartFrame: true, override: null, attached: true },
    { defaultStartFrame: false, override: null, attached: false },
    { defaultStartFrame: true, override: false, attached: false },
    { defaultStartFrame: false, override: true, attached: true },
    { defaultStartFrame: true, override: true, attached: true },
    { defaultStartFrame: false, override: false, attached: false },
  ])(
    'resolves element usage per shot with default $defaultStartFrame and override $override',
    async ({ defaultStartFrame, override, attached }) => {
      // The scene names BELL, while the selected motion prompt does not. A
      // start-frame shot retains scene references; a reference-only shot drops them.
      await db
        .update(sequences)
        .set({ generateStartFrames: defaultStartFrame })
        .where(eq(sequences.id, sequenceId));
      await db
        .update(shots)
        .set({ useStartFrame: override })
        .where(eq(shots.id, shotId));
      expect(
        await data('list_shot_references', {
          sequenceId,
          shotId,
          kind: 'element',
        })
      ).toMatchObject({
        references: attached ? [{ id: elementId, name: 'BELL' }] : [],
      });
      expect(
        await data('list_entity_usages', {
          sequenceId,
          entityId: elementId,
          kind: 'element',
        })
      ).toMatchObject({
        usages: attached ? [{ shotId, sceneId }] : [],
      });
    }
  );
  it('resolves usage in both directions using database IDs and returns continuations after empty candidate pages', async () => {
    expect(
      await data('list_shot_references', {
        sequenceId,
        shotId,
        kind: 'character',
      })
    ).toMatchObject({ references: [{ id: characterId, name: 'Ada' }] });
    expect(
      await data('list_shot_references', {
        sequenceId,
        shotId,
        kind: 'location',
      })
    ).toMatchObject({ references: [{ id: locationId }] });
    expect(
      await data('list_entity_usages', {
        sequenceId,
        kind: 'character',
        entityId: characterId,
      })
    ).toMatchObject({ usages: [{ shotId, sceneId }] });
    const laterShot = await addShot();
    await db
      .update(scenes)
      .set({
        continuity: {
          colorPalette: '',
          lightingSetup: '',
          styleTag: '',
          characterTags: [],
          elementTags: [],
          environmentTag: '',
        },
      })
      .where(eq(scenes.id, dbSceneId(sceneId)));
    const empty = z
      .object({
        usages: z.array(z.unknown()),
        nextCursor: z.string(),
        examined: z.number(),
      })
      .parse(
        await data('list_entity_usages', {
          sequenceId,
          kind: 'character',
          entityId: characterId,
          limit: 1,
        })
      );
    expect(empty.usages).toEqual([]);
    expect(empty.examined).toBe(1);
    expect(
      await data('list_entity_usages', {
        sequenceId,
        kind: 'character',
        entityId: characterId,
        limit: 1,
        cursor: empty.nextCursor,
      })
    ).toMatchObject({ usages: [], nextCursor: null });
    expect(
      await call('list_entity_usages', {
        sequenceId,
        kind: 'element',
        entityId: elementId,
        cursor: empty.nextCursor,
      })
    ).toMatchObject({ isError: true });
    expect(laterShot).not.toBe(shotId);
  });
  it('returns missing-frame and voice-only staleness without repairs, and detects selected video input changes', async () => {
    const noFrame = await addShot();
    queries.length = 0;
    expect(
      await data('get_shot_staleness', { sequenceId, shotId: noFrame })
    ).toMatchObject({ frameId: null, thumbnail: 'untracked' });
    expect(
      queries.some((query) => /^(insert|update|delete)\b/i.test(query))
    ).toBe(false);
    await db
      .update(characters)
      .set({ voiceOnly: true })
      .where(eq(characters.id, characterId));
    expect(
      await data('get_reference_staleness', {
        sequenceId,
        kind: 'character',
        entityId: characterId,
      })
    ).toEqual({ status: 'untracked', applicable: false });
    await db
      .update(videoVariants)
      .set({
        manifest: [
          {
            shotId,
            motionPromptVersionId: 'old-motion',
            frameVersionId: imageId,
            usesStartFrame: true,
            durationMs: 3000,
            audioClipIds: [],
            audioSourceKey: null,
          },
        ],
      })
      .where(eq(videoVariants.id, videoId));
    expect(
      await data('get_render_segment_staleness', { sequenceId, segmentId })
    ).toEqual({ status: 'stale' });
  });
  it('keeps a segment fresh after its shot is regrouped into a new segment', async () => {
    const [shot] = await db.select().from(shots).where(eq(shots.id, shotId));
    if (!shot) throw new Error('Missing shot');
    await db
      .update(videoVariants)
      .set({
        manifest: [
          {
            shotId,
            motionPromptVersionId: shot.selectedMotionPromptVersionId,
            frameVersionId: imageId,
            usesStartFrame: true,
            durationMs: 3000,
            audioClipIds: [],
            audioSourceKey: null,
          },
        ],
      })
      .where(eq(videoVariants.id, videoId));
    const staleness = () =>
      data('get_render_segment_staleness', { sequenceId, segmentId });
    expect(await staleness()).toEqual({ status: 'fresh' });
    const regroupedId = generateId();
    await db
      .insert(renderSegments)
      .values({ id: regroupedId, sequenceId, sceneId });
    await db
      .update(shots)
      .set({ renderSegmentId: regroupedId })
      .where(eq(shots.id, shotId));
    expect(await staleness()).toEqual({ status: 'fresh' });
  });
  it('exposes working audio, export source identity and historical activity data without mutations', async () => {
    expect(
      await data('get_export_status', { sequenceId, exportId })
    ).toMatchObject({
      export: {
        status: 'ready',
        sourceShotsHash: 'cut-1',
        durationSeconds: 15.125,
        url: 'https://openstory.test/r2/export.mp4',
      },
    });
    expect(await data('list_exports', { sequenceId })).toMatchObject({
      exports: [{ id: exportId, durationSeconds: 15.125 }],
    });
    const audio = z
      .object({ document: z.object({ text: z.string() }) })
      .parse(await data('get_shot_audio', { sequenceId, shotId }));
    expect(JSON.parse(audio.document.text)).toEqual([
      {
        id: 'clip-1',
        url: 'https://openstory.test/r2/dialogue.mp3',
        token: 'Ada',
        durationSeconds: 1,
      },
    ]);
    const event = z
      .object({ document: z.object({ text: z.string() }) })
      .parse(await data('get_sequence_event', { sequenceId, eventId }));
    expect(JSON.parse(event.document.text)).toEqual({ versionId: imageId });
    expect(
      queries.some((query) => /^(insert|update|delete)\b/i.test(query))
    ).toBe(false);
  });
});

describe('Studio, Gallery and library reads', () => {
  let talentId: string;
  let libraryLocationId: string;
  let sheetId: string;
  let mediaId: string;
  let talentVersionId: string;
  let locationSheetId: string;
  let locationVersionId: string;
  let assetId: string;
  let audioId: string;
  let vfxId: string;
  let galleryStyleId: string;
  let foreignTeamId: string;
  const listResult = z.object({
    items: z.array(z.object({ id: z.string() })),
    nextCursor: z.string().nullable(),
  });
  async function document(name: string, args: Record<string, unknown>) {
    const result = z
      .object({
        document: z.object({
          text: z.string(),
          nextOffset: z.number().nullable(),
          revision: z.string(),
        }),
      })
      .parse(await data(name, { ...args, length: 16000 }));
    expect(result.document.nextOffset).toBeNull();
    return z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(result.document.text));
  }
  beforeEach(async () => {
    talentId = generateId();
    libraryLocationId = generateId();
    sheetId = generateId();
    mediaId = generateId();
    talentVersionId = generateId();
    locationSheetId = generateId();
    locationVersionId = generateId();
    assetId = generateId();
    audioId = generateId();
    vfxId = generateId();
    galleryStyleId = generateId();
    foreignTeamId = generateId();
    await db
      .insert(teams)
      .values({ id: foreignTeamId, name: 'Foreign', slug: foreignTeamId });
    await db.insert(talent).values({
      id: talentId,
      teamId,
      name: 'Actor',
      voiceId: 'voice-1',
      imagePath: 'private',
      imageUrl: '/r2/actor.jpg',
    });
    await db.insert(locationLibrary).values({
      id: libraryLocationId,
      teamId,
      name: 'Office',
      referenceImagePath: 'private',
      referenceImageUrl: '/r2/office.jpg',
    });
    await db.insert(talentSheets).values({
      id: sheetId,
      talentId,
      name: 'Formal',
      imageUrl: '/r2/formal.jpg',
      imagePath: 'private',
      isDefault: true,
    });
    await db.insert(talentMedia).values({
      id: mediaId,
      talentId,
      type: 'recording',
      url: '/r2/voice.mp3',
      path: 'private',
    });
    await db.insert(talentSheetVariants).values({
      id: talentVersionId,
      talentSheetId: sheetId,
      model: 'test',
      url: '/r2/alternate.jpg',
      discardedAt: new Date(),
      divergedAt: new Date(),
      storagePath: 'private',
    });
    await db.insert(locationSheets).values({
      id: locationSheetId,
      locationId: libraryLocationId,
      name: 'Night',
      imageUrl: '/r2/night.jpg',
    });
    await db.insert(locationSheetVariants).values({
      id: locationVersionId,
      parentId: libraryLocationId,
      parentType: 'library_location',
      model: 'test',
      url: '/r2/location.jpg',
    });
    const userId = generateId();
    await db
      .insert(user)
      .values({ id: userId, name: 'User', email: `${userId}@test.invalid` });
    await db.insert(generatedAssets).values({
      id: assetId,
      teamId,
      userId,
      source: 'studio',
      provider: 'fal',
      activity: 'image',
      modelName: 'Test',
      endpointId: 'test/image',
      input: { prompt: 'A city', aspectRatio: '16:9' },
      outputs: [{ url: '/r2/city.jpg', contentType: 'image/jpeg' }],
      status: 'completed',
      isFavorite: true,
      costMicros: 500,
    });
    await db
      .insert(audio)
      .values({ id: audioId, teamId, name: 'Music', fileUrl: '/r2/music.mp3' });
    await db.insert(vfx).values({ id: vfxId, teamId, name: 'Rain' });
    const sequenceStyle = await scopedDb.sequences.getById(sequenceId);
    if (!sequenceStyle?.styleId) throw new Error('Missing fixture style');
    const sourceStyle = await scopedDb.styles.getById(sequenceStyle.styleId);
    if (!sourceStyle) throw new Error('Missing fixture style');
    await db.insert(styles).values({
      id: galleryStyleId,
      teamId: foreignTeamId,
      name: 'Cinematic Noir',
      config: sourceStyle.config,
      isPublic: true,
      previewUrl: '/r2/styles/noir/thumbnail.webp',
    });
    vi.mocked(listFilesPage).mockResolvedValue({
      files: [
        {
          name: 'sound.mp3',
          url: '/r2/sound.mp3',
          size: 30,
          contentType: 'audio/mpeg',
          uploadedAt: new Date().toISOString(),
        },
      ],
      nextCursor: null,
    });
    queries.length = 0;
  });
  const resourceCases = () => [
    { kind: 'talent_sheet', parentId: talentId, id: sheetId },
    { kind: 'talent_media', parentId: talentId, id: mediaId },
    { kind: 'talent_sheet_version', parentId: sheetId, id: talentVersionId },
    {
      kind: 'location_sheet',
      parentId: libraryLocationId,
      id: locationSheetId,
    },
    {
      kind: 'location_sheet_version',
      parentId: libraryLocationId,
      id: locationVersionId,
    },
    { kind: 'audio', id: audioId },
    { kind: 'vfx', id: vfxId },
  ];
  it('reads every new surface and child kind without writes or private storage fields', async () => {
    for (const [name, args] of [
      ['list_talent', {}],
      ['get_talent', { id: talentId }],
      ['list_library_locations', {}],
      ['get_library_location', { id: libraryLocationId }],
      ['list_styles', {}],
      ['get_style', { id: galleryStyleId }],
      ['list_gallery_samples', {}],
      ['list_generated_assets', {}],
      ['get_generated_asset', { id: assetId }],
      ['list_studio_uploads', {}],
    ] as const)
      expect(await data(name, args)).toBeDefined();
    for (const args of resourceCases()) {
      const { id, ...listArgs } = args;
      const list = listResult.parse(
        await data('list_library_resources', listArgs)
      );
      expect(list.items.map((item) => item.id)).toContain(id);
      const detail = await document('get_library_resource', args);
      expect(detail.id).toBe(id);
      for (const key of [
        'path',
        'imagePath',
        'storagePath',
        'teamId',
        'createdBy',
      ])
        expect(detail).not.toHaveProperty(key);
    }
    const actor = await document('get_talent', { id: talentId });
    expect(actor.voiceId).toBe('voice-1');
    expect(actor.imageUrl).toBe('https://openstory.test/r2/actor.jpg');
    const asset = await document('get_generated_asset', { id: assetId });
    expect(asset.input).toEqual({ prompt: 'A city', aspectRatio: '16:9' });
    expect(asset.outputs).toEqual([
      { url: 'https://openstory.test/r2/city.jpg', contentType: 'image/jpeg' },
    ]);
    expect(asset.costMicros).toBe(500);
    expect(asset).not.toHaveProperty('userId');
    expect(queries.some((q) => /^(insert|update|delete)/i.test(q))).toBe(false);
  });
  it('rejects private foreign parents and every descendant, while allowing public library records', async () => {
    scopedDb = createScopedDb(foreignTeamId, generateId());
    for (const [name, id] of [
      ['get_talent', talentId],
      ['get_library_location', libraryLocationId],
      ['get_generated_asset', assetId],
    ] as const)
      expect((await call(name, { id })).isError).toBe(true);
    for (const args of resourceCases()) {
      expect((await call('get_library_resource', args)).isError).toBe(true);
      const { id: _id, ...listArgs } = args;
      if (listArgs.parentId)
        expect((await call('list_library_resources', listArgs)).isError).toBe(
          true
        );
      else
        expect(
          listResult.parse(await data('list_library_resources', listArgs)).items
        ).toEqual([]);
    }
    await db
      .update(talent)
      .set({ isPublic: true })
      .where(eq(talent.id, talentId));
    await db
      .update(locationLibrary)
      .set({ isPublic: true })
      .where(eq(locationLibrary.id, libraryLocationId));
    expect((await document('get_talent', { id: talentId })).name).toBe('Actor');
    for (const args of resourceCases().filter((args) => args.parentId))
      expect(await document('get_library_resource', args)).toHaveProperty(
        'id',
        args.id
      );
  });
  it('does not expose private or sequence-bound styles through Gallery or direct IDs', async () => {
    const ownStyleId = (await scopedDb.sequences.getById(sequenceId))?.styleId;
    if (!ownStyleId) throw new Error('Missing style');
    scopedDb = createScopedDb(foreignTeamId, generateId());
    expect((await call('get_style', { id: ownStyleId })).isError).toBe(true);
    expect(
      listResult.parse(await data('list_styles', {})).items.map((x) => x.id)
    ).not.toContain(ownStyleId);
    await db
      .update(styles)
      .set({ isPublic: true, sequenceId })
      .where(eq(styles.id, ownStyleId));
    expect((await call('get_style', { id: ownStyleId })).isError).toBe(true);
    const gallery = z
      .object({
        samples: z.array(
          z.object({
            styleId: z.string(),
            video: z.object({ url: z.string() }),
          })
        ),
      })
      .parse(await data('list_gallery_samples', {}));
    expect(gallery.samples.map((x) => x.styleId)).not.toContain(ownStyleId);
    expect(
      gallery.samples.find((x) => x.styleId === galleryStyleId)?.video.url
    ).toBe('https://openstory.test/r2/styles/noir/canonical.mp4');
  });
  it('binds cursors to collection, team and parent and keeps large fields out of lists', async () => {
    await db
      .insert(talent)
      .values({ teamId, name: 'Second', description: 'x'.repeat(50000) });
    const first = listResult.parse(await data('list_talent', { limit: 1 }));
    expect(first.nextCursor).not.toBeNull();
    const second = listResult.parse(
      await data('list_talent', { limit: 1, cursor: first.nextCursor })
    );
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect(
      (await call('list_library_locations', { cursor: first.nextCursor }))
        .isError
    ).toBe(true);
    scopedDb = createScopedDb(foreignTeamId, generateId());
    expect(
      (await call('list_talent', { cursor: first.nextCursor })).isError
    ).toBe(true);
    scopedDb = createScopedDb(teamId, generateId());
    await db.insert(talentSheets).values({ talentId, name: 'Second sheet' });
    const sheets = listResult.parse(
      await data('list_library_resources', {
        kind: 'talent_sheet',
        parentId: talentId,
        limit: 1,
      })
    );
    expect(
      (
        await call('list_library_resources', {
          kind: 'talent_sheet',
          parentId: generateId(),
          cursor: sheets.nextCursor,
        })
      ).isError
    ).toBe(true);
    // Lists read the library's own full rows; the wire shape stays narrow.
    const items = z.object({
      items: z.array(z.record(z.string(), z.unknown())),
    });
    for (const tool of ['list_talent', 'list_generated_assets'])
      for (const item of items.parse(await data(tool, {})).items) {
        expect(item).not.toHaveProperty('description');
        expect(item).not.toHaveProperty('input');
      }
  });
  it('binds asset cursors to all filters and windows long input without truncation', async () => {
    const asset = await scopedDb.generatedAssets.getById(assetId);
    if (!asset) throw new Error('seeded asset missing');
    await db.insert(generatedAssets).values({
      ...asset,
      id: generateId(),
      input: { prompt: 'x'.repeat(40000) },
    });
    const page = listResult.parse(
      await data('list_generated_assets', { limit: 1, source: 'studio' })
    );
    for (const filter of [
      { source: 'catalog' },
      { source: 'studio', activity: 'video' },
      { source: 'studio', favoritesOnly: true },
      { source: 'studio', endpointId: 'other' },
    ])
      expect(
        (
          await call('list_generated_assets', {
            ...filter,
            cursor: page.nextCursor,
          })
        ).isError
      ).toBe(true);
    const id = page.items[0]?.id;
    const first = z
      .object({
        document: z.object({
          text: z.string(),
          nextOffset: z.number(),
          revision: z.string(),
        }),
      })
      .parse(await data('get_generated_asset', { id, length: 1000 }));
    expect(first.document.text.length).toBe(1000);
    await db
      .update(generatedAssets)
      .set({ input: { prompt: 'changed' } })
      .where(eq(generatedAssets.id, id ?? ''));
    expect(
      (
        await call('get_generated_asset', {
          id,
          offset: first.document.nextOffset,
          revision: first.document.revision,
        })
      ).isError
    ).toBe(true);
  });
  it('requires parentId for child library kinds and rejects it for audio and VFX', async () => {
    for (const kind of [
      'talent_sheet',
      'talent_media',
      'talent_sheet_version',
      'location_sheet',
      'location_sheet_version',
    ] as const) {
      for (const [name, args] of [
        ['list_library_resources', { kind }],
        ['get_library_resource', { kind, id: sheetId }],
      ] as const) {
        const result = await call(name, args);
        expect(result.isError, JSON.stringify(result)).toBe(true);
        expect(result.content[0]?.text).toMatch(/parentId/i);
        expect(result.content[0]?.text).not.toMatch(/not found/i);
      }
    }
    expect(
      (
        await call('list_library_resources', {
          kind: 'audio',
          parentId: talentId,
        })
      ).isError
    ).toBe(true);
  });
  it('rejects wrong child parents and location variant parent types', async () => {
    const otherTalent = generateId();
    await db.insert(talent).values({ id: otherTalent, teamId, name: 'Other' });
    expect(
      (
        await call('get_library_resource', {
          kind: 'talent_sheet',
          parentId: otherTalent,
          id: sheetId,
        })
      ).isError
    ).toBe(true);
    await db
      .update(locationSheetVariants)
      .set({ parentType: 'sequence_location' })
      .where(eq(locationSheetVariants.id, locationVersionId));
    expect(
      (
        await call('get_library_resource', {
          kind: 'location_sheet_version',
          parentId: libraryLocationId,
          id: locationVersionId,
        })
      ).isError
    ).toBe(true);
  });
  it('continues past filtered upload pages and binds storage cursors to team', async () => {
    vi.mocked(listFilesPage).mockResolvedValueOnce({
      files: [
        {
          name: 'note.txt',
          url: '/r2/note.txt',
          size: 1,
          contentType: 'text/plain',
          uploadedAt: new Date().toISOString(),
        },
      ],
      nextCursor: 'r2-next',
    });
    const first = z
      .object({ uploads: z.array(z.unknown()), nextCursor: z.string() })
      .parse(await data('list_studio_uploads', { limit: 1 }));
    expect(first.uploads).toEqual([]);
    await data('list_studio_uploads', { limit: 1, cursor: first.nextCursor });
    expect(listFilesPage).toHaveBeenLastCalledWith('talent', `${teamId}/temp`, {
      limit: 1,
      cursor: 'r2-next',
    });
    scopedDb = createScopedDb(foreignTeamId, generateId());
    expect(
      (await call('list_studio_uploads', { cursor: first.nextCursor })).isError
    ).toBe(true);
  });
});
