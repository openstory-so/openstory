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
import {
  characters,
  characterSheetVariants,
  characterVoiceVersions,
  sequenceLocations,
  locationSheetVariants,
  sequenceElements,
  sequenceMusicVariants,
  sequenceMusicPromptVersions,
  sequenceEvents,
} from '@/platform/server/db/schema';
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
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { mcpServer, serveMcpRequest } from './server';
import {
  Client as McpClient,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { McpAuthContext } from './auth';
import { serveResourceRequest } from './resources';
import { asStub } from '@/test/as-stub';
import type { User } from '@/platform/server/auth/config';
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

vi.mock('#db-client', () => ({ getDb: vi.fn() }));
let client: Client;
let db: Database;
let teamId: string;
let sequenceId: string;
let sceneId: string;
let shotId: string;
let frameId: string;
let segmentId: string;
let actorId: string;
let imageId: string;
let videoId: string;
let scopedDb: ReturnType<typeof createScopedDb>;
const queries: string[] = [];
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await mcpServer.handle(
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
    .values({ id, sequenceId, orderIndex, legacyTitle: 'Another scene' });
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
    selectedScriptVersionId: scriptId,
  });
  await db.insert(sceneScriptVersions).values({
    id: scriptId,
    sceneId,
    content: { extract: 'Selected script', dialogue: [] },
    title: 'Opening',
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
  actorId = generateId();
  await db
    .insert(user)
    .values({ id: actorId, name: 'Actor', email: `${actorId}@test.invalid` });
  scopedDb = createScopedDb(teamId, actorId);
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
    // A frame with a selected still and nothing newer reads completed.
    expect(await data('get_frame', { sequenceId, frameId })).toMatchObject({
      frame: { imageStatus: 'completed', imageError: null },
    });
    // The frame's current image attempt is its newest primary row (#1942).
    await db.insert(frameVariants).values({
      frameId,
      sequenceId,
      model: 'nano_banana_2',
      status: 'failed',
      error: 'Image failed',
    });
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
    expect(await data('get_frame', { sequenceId, frameId })).toMatchObject({
      frame: { imageStatus: 'failed', imageError: 'Image failed' },
    });
    expect(await data('list_frames', { sequenceId, shotId })).toMatchObject({
      frames: [{ imageStatus: 'failed', imageError: 'Image failed' }],
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
    // The frame's current image attempt is its newest primary row (#1942).
    await db.insert(frameVariants).values({
      frameId,
      sequenceId,
      model: 'nano_banana_2',
      status: 'generating',
      workflowRunId: 'image-run',
    });
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
    // The frame's current image attempt is its newest primary row (#1942).
    await db.insert(frameVariants).values({
      frameId,
      sequenceId,
      model: 'nano_banana_2',
      status: 'failed',
    });
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
      legacyName: 'Ada',
      legacyPersonality: 'Curious',
      legacyConsistencyTag: 'ada',
      selectedVoiceVersionId: characterId,
    });
    await db.insert(characterVoiceVersions).values({
      id: characterId,
      characterId,
      source: 'generated',
      voiceId: 'voice-ada',
      previews: [
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
      legacyName: 'Office',
      legacyDescription: 'Bright office',
      legacyConsistencyTag: 'office',
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
      // Provider-measured, so fractional despite the integer() column.
      durationSeconds: 61.5,
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
        selectedMusicVariantId: musicId,
        selectedMusicPromptVersionId: musicPromptId,
        musicModel: 'music-test',
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
    // The narrative lives on the selected script version (#1600).
    await db
      .update(sceneScriptVersions)
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
      .where(eq(sceneScriptVersions.sceneId, dbSceneId(sceneId)));
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
      legacyName: 'Other',
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
  it('resolves usage in both directions using database IDs and pages the matches', async () => {
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
    const first = z
      .object({ usages: z.array(z.unknown()), nextCursor: z.string() })
      .parse(
        await data('list_entity_usages', {
          sequenceId,
          kind: 'character',
          entityId: characterId,
          limit: 1,
        })
      );
    expect(first.usages).toHaveLength(1);
    expect(
      await call('list_entity_usages', {
        sequenceId,
        kind: 'element',
        entityId: elementId,
        cursor: first.nextCursor,
      })
    ).toMatchObject({ isError: true });
    await db
      .update(sceneScriptVersions)
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
      .where(eq(sceneScriptVersions.sceneId, dbSceneId(sceneId)));
    expect(
      await data('list_entity_usages', {
        sequenceId,
        kind: 'character',
        entityId: characterId,
      })
    ).toMatchObject({ usages: [], nextCursor: null });
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
      .set({ legacyVoiceOnly: true })
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
            dialogueKey: null,
            referenceKeys: [],
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
            dialogueKey: null,
            referenceKeys: [],
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
      input: { prompt: 'A city', image_urls: ['/r2/ref.jpg'] },
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
    expect(asset.input).toEqual({
      prompt: 'A city',
      image_urls: ['https://openstory.test/r2/ref.jpg'],
    });
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

describe('update_scene (#1459)', () => {
  const sceneScript = z.object({
    script: z.object({
      id: z.string(),
      content: z.object({
        extract: z.string(),
        dialogue: z.array(z.unknown()),
      }),
    }),
  });
  async function selectedScriptId() {
    return sceneScript.parse(await data('get_scene', { sequenceId, sceneId }))
      .script.id;
  }

  it('selects a new script version by the actor, keeps dialogue, and matches get_scene', async () => {
    const dialogue = [{ character: 'ADA', line: 'Hello.', tone: 'warm' }];
    await db
      .update(sceneScriptVersions)
      .set({ content: { extract: 'Selected script', dialogue } })
      .where(eq(sceneScriptVersions.sceneId, sceneId));
    await addShot();
    const expected = await selectedScriptId();
    const updated = await data('update_scene', {
      sequenceId,
      sceneId,
      expectedScriptVersionId: expected,
      scriptExtract: 'A rewritten scene.',
      storyBeat: 'the turn',
    });
    const parsed = z
      .object({
        changed: z.literal(true),
        storyBeat: z.string(),
        staleness: z.object({
          shots: z.array(z.object({ shotId: z.string() })),
        }),
      })
      .merge(sceneScript)
      .parse(updated);
    expect(parsed.script.id).not.toBe(expected);
    expect(parsed.script.content).toEqual({
      extract: 'A rewritten scene.',
      dialogue,
    });
    expect(parsed.storyBeat).toBe('the turn');
    expect(parsed.staleness.shots).toHaveLength(2);
    const { changed, staleness, ...scene } = z
      .record(z.string(), z.unknown())
      .parse(updated);
    expect(changed).toBe(true);
    expect(staleness).toBeDefined();
    expect(scene).toEqual(await data('get_scene', { sequenceId, sceneId }));
    const [row] = await db
      .select()
      .from(sceneScriptVersions)
      .where(eq(sceneScriptVersions.id, parsed.script.id));
    expect(row?.createdBy).toBe(actorId);
  });

  it('writes no version for unchanged input and clears a field with an empty string', async () => {
    const expected = await selectedScriptId();
    const unchanged = await data('update_scene', {
      sequenceId,
      sceneId,
      expectedScriptVersionId: expected,
      scriptExtract: 'Selected script',
      title: 'Opening',
    });
    expect(unchanged).toMatchObject({ changed: false });
    expect(await selectedScriptId()).toBe(expected);
    const cleared = await data('update_scene', {
      sequenceId,
      sceneId,
      expectedScriptVersionId: expected,
      title: '',
    });
    expect(cleared).toMatchObject({ changed: true, title: null });
  });

  it('refuses a stale selected version and writes nothing', async () => {
    const before = await db.select().from(sceneScriptVersions);
    const result = await call('update_scene', {
      sequenceId,
      sceneId,
      expectedScriptVersionId: generateId(),
      scriptExtract: 'Stale edit.',
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT' } },
    });
    expect(await db.select().from(sceneScriptVersions)).toEqual(before);
  });

  it('reports a scene without a script instead of inventing one', async () => {
    const bare = await addScene(1);
    const result = await call('update_scene', {
      sequenceId,
      sceneId: bare,
      expectedScriptVersionId: null,
      scriptExtract: 'New text.',
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'VALIDATION_ERROR' } },
    });
    const titled = await data('update_scene', {
      sequenceId,
      sceneId: bare,
      expectedScriptVersionId: null,
      title: 'Named',
    });
    expect(titled).toMatchObject({ changed: true, title: 'Named' });
  });

  it('rejects shot IDs, removed scene fields, empty edits and foreign, deleted or wrong-sequence scenes', async () => {
    const expectedScriptVersionId = await selectedScriptId();
    const base = { sequenceId, sceneId, expectedScriptVersionId };
    for (const args of [
      { ...base, sceneId: shotId, title: 'x' },
      { ...base, shotId, title: 'x' },
      { ...base, durationSeconds: 4 },
      { ...base, imageModel: 'nano_banana_2', title: 'x' },
      { ...base, videoModel: 'wan_i2v', title: 'x' },
      { ...base, continuity: { styleTag: 'noir' } },
      base,
    ])
      expect(
        (await call('update_scene', args)).isError,
        JSON.stringify(args)
      ).toBe(true);
    const otherSequence = generateId();
    await db.insert(sequences).values({
      id: otherSequence,
      teamId,
      title: 'Other',
      styleId: (await db.select().from(sequences))[0]?.styleId ?? '',
    });
    expect(
      await call('update_scene', {
        ...base,
        sequenceId: otherSequence,
        title: 'x',
      })
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'NOT_FOUND' } },
    });
    await db
      .update(scenes)
      .set({ deletedAt: new Date() })
      .where(eq(scenes.id, dbSceneId(sceneId)));
    expect(await call('update_scene', { ...base, title: 'x' })).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'NOT_FOUND' } },
    });
    scopedDb = createScopedDb(generateId(), actorId);
    expect(await call('update_scene', { ...base, title: 'x' })).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'NOT_FOUND' } },
    });
  });
});

describe('update_scene continuity (#1459)', () => {
  it('rescans @-mentions into continuity, merges sent keys and records only moved fields', async () => {
    await db.insert(characters).values({
      id: generateId(),
      sequenceId,
      characterId: 'char_001',
      legacyName: 'Ada',
      legacyConsistencyTag: 'ada',
    });
    const read = z.object({ script: z.object({ id: z.string() }) });
    const first = await data('update_scene', {
      sequenceId,
      sceneId,
      expectedScriptVersionId: read.parse(
        await data('get_scene', { sequenceId, sceneId })
      ).script.id,
      scriptExtract: 'ADA walks in.',
      continuity: { lightingSetup: 'neon' },
    });
    const continuity = z.object({
      continuity: z.object({
        characterTags: z.array(z.string()),
        lightingSetup: z.string(),
        colorPalette: z.string(),
      }),
    });
    const afterFirst = continuity.parse(first).continuity;
    expect(afterFirst.characterTags).toHaveLength(1);
    expect(afterFirst).toMatchObject({
      lightingSetup: 'neon',
      colorPalette: '',
    });
    const second = await data('update_scene', {
      sequenceId,
      sceneId,
      expectedScriptVersionId: read.parse(first).script.id,
      title: 'Opening',
      continuity: { colorPalette: 'teal' },
    });
    expect(continuity.parse(second).continuity).toEqual({
      ...afterFirst,
      colorPalette: 'teal',
    });
    const [event] = await db
      .select()
      .from(sequenceEvents)
      .where(eq(sequenceEvents.kind, 'scene.updated'))
      .orderBy(desc(sequenceEvents.id))
      .limit(1);
    expect(Object.keys(event?.data?.prevState ?? {})).toEqual(['continuity']);
  });
});

describe('structure edits (#1979)', () => {
  it('update_sequence renames with an event and writes only the sent settings', async () => {
    const updated = await data('update_sequence', {
      sequenceId,
      title: 'Renamed',
      includeMusic: false,
      targetDurationSeconds: 30,
    });
    expect(updated).toMatchObject({
      sequenceId,
      title: 'Renamed',
      includeMusic: false,
      targetDurationSeconds: 30,
      status: 'completed',
    });
    const [event] = await db
      .select()
      .from(sequenceEvents)
      .where(eq(sequenceEvents.kind, 'sequence.renamed'));
    expect(event).toMatchObject({ actorId, targetId: sequenceId });
    expect(
      await data('update_sequence', { sequenceId, targetDurationSeconds: null })
    ).toMatchObject({ title: 'Renamed', targetDurationSeconds: null });
  });

  it('refuses an empty update and another team’s sequence', async () => {
    expect(await call('update_sequence', { sequenceId })).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'VALIDATION_ERROR' } },
    });
    expect(
      await call('update_sequence', { sequenceId: generateId(), title: 'x' })
    ).toMatchObject({ isError: true });
    expect(await call('regenerate_storyboard', { sequenceId })).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'VALIDATION_ERROR' } },
    });
  });

  it('archive_sequence then unarchive_sequence restores the prior status', async () => {
    expect(await data('archive_sequence', { sequenceId })).toMatchObject({
      status: 'archived',
    });
    expect(await data('unarchive_sequence', { sequenceId })).toMatchObject({
      status: 'completed',
    });
  });

  it('create_scene appends a scene with its first shot and script', async () => {
    const created = z.object({ sceneId: z.string(), shotId: z.string() }).parse(
      await data('create_scene', {
        sequenceId,
        title: 'Finale',
        scriptExtract: 'The whale swims away.',
      })
    );
    const scene = z
      .object({
        title: z.string().nullable(),
        script: z.object({ content: z.object({ extract: z.string() }) }),
      })
      .parse(await data('get_scene', { sequenceId, sceneId: created.sceneId }));
    expect(scene.title).toBe('Finale');
    expect(scene.script.content.extract).toBe('The whale swims away.');
    const scenesPage = z
      .object({ scenes: z.array(z.object({ id: z.string() })) })
      .parse(await data('list_scenes', { sequenceId }));
    expect(scenesPage.scenes.map((row) => row.id)).toEqual([
      sceneId,
      created.sceneId,
    ]);
    expect(
      await data('get_shot', { sequenceId, shotId: created.shotId })
    ).toMatchObject({ sceneId: created.sceneId });
  });

  it('reorders, deletes and restores scenes', async () => {
    const second = await addScene(1);
    await data('reorder_scenes', { sequenceId, sceneIds: [second, sceneId] });
    const order = z
      .object({ scenes: z.array(z.object({ id: z.string() })) })
      .parse(await data('list_scenes', { sequenceId }));
    expect(order.scenes.map((row) => row.id)).toEqual([second, sceneId]);

    expect(await data('delete_scene', { sequenceId, sceneId })).toEqual({
      sceneId,
      deletedShotIds: [shotId],
    });
    expect(await call('get_shot', { sequenceId, shotId })).toMatchObject({
      isError: true,
    });
    await data('restore_scene', { sequenceId, sceneId });
    expect(await data('get_shot', { sequenceId, shotId })).toMatchObject({
      sceneId,
    });
  });

  it('creates, edits, reorders, deletes and restores shots', async () => {
    const created = z
      .object({ shotId: z.string(), shotNumber: z.number() })
      .parse(
        await data('create_shot', { sequenceId, sceneId, durationSeconds: 5 })
      );
    expect(created.shotNumber).toBe(2);
    expect(
      await data('update_shot', {
        sequenceId,
        shotId: created.shotId,
        durationSeconds: 6.5,
      })
    ).toMatchObject({ durationSeconds: 6.5 });
    // No still yet: turning the start frame on must not start a generation.
    expect(
      await call('update_shot', {
        sequenceId,
        shotId: created.shotId,
        useStartFrame: true,
      })
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'VALIDATION_ERROR' } },
    });
    expect(
      await data('update_shot', { sequenceId, shotId, useStartFrame: true })
    ).toMatchObject({ useStartFrame: true });

    await data('reorder_shots', {
      sequenceId,
      sceneId,
      shotIds: [created.shotId, shotId],
    });
    const page = z
      .object({ shots: z.array(z.object({ id: z.string() })) })
      .parse(await data('list_shots', { sequenceId }));
    expect(page.shots.map((row) => row.id)).toEqual([created.shotId, shotId]);

    await data('delete_shot', { sequenceId, shotId: created.shotId });
    expect(
      await call('get_shot', { sequenceId, shotId: created.shotId })
    ).toMatchObject({ isError: true });
    await data('restore_shot', { sequenceId, shotId: created.shotId });
    expect(
      await data('get_shot', { sequenceId, shotId: created.shotId })
    ).toMatchObject({ sceneId });
  });

  it('refuses a shot of another sequence', async () => {
    const otherSequence = generateId();
    const [fixture] = await db
      .select({ styleId: sequences.styleId })
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!fixture) throw new Error('Missing fixture sequence');
    await db.insert(sequences).values({
      id: otherSequence,
      teamId,
      title: 'Other',
      styleId: fixture.styleId,
      status: 'completed',
    });
    expect(
      await call('delete_shot', { sequenceId: otherSequence, shotId })
    ).toMatchObject({ isError: true });
    expect(
      await call('create_shot', { sequenceId: otherSequence, sceneId })
    ).toMatchObject({ isError: true });
  });
});

describe('get_export_status without an exportId (#1461)', () => {
  it('returns null with no exports, then the newest, and refuses a foreign id', async () => {
    expect(await data('get_export_status', { sequenceId })).toEqual({
      export: null,
    });
    const older = generateId();
    const newer = generateId();
    for (const [id, status] of [
      [older, 'ready'],
      [newer, 'failed'],
    ] as const) {
      await db.insert(sequenceExports).values({
        id,
        sequenceId,
        url: `/r2/openstory-videos/${id}.mp4`,
        storagePath: `${id}.mp4`,
        status,
        createdAt: new Date(Date.now() + (id === newer ? 1000 : 0)),
      });
    }
    expect(await data('get_export_status', { sequenceId })).toMatchObject({
      export: { id: newer, status: 'failed' },
    });
    expect(
      (await call('get_export_status', { sequenceId, exportId: generateId() }))
        .isError
    ).toBe(true);
  });
});

describe('production-context resources (#1462)', () => {
  async function resourceRpc(method: string, params: Record<string, unknown>) {
    const response = await serveResourceRequest(
      new Request('https://openstory.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': method,
          ...(typeof params.uri === 'string' ? { 'mcp-name': params.uri } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: {
            ...params,
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
        caller: {
          user: asStub<User>({ id: actorId, email: 'a@b.c', name: 'A' }),
          teamId,
          teamName: 'T',
        },
        origin: 'https://openstory.test',
        scoped: () => ({
          scopedDb,
          origin: 'https://openstory.test',
          userId: actorId,
          request: {},
        }),
      }
    );
    return z
      .object({
        result: z.record(z.string(), z.unknown()).optional(),
        error: z
          .object({ code: z.number(), message: z.string() })
          .passthrough()
          .optional(),
      })
      .parse(await response.json());
  }
  async function read(uri: string) {
    const { result, error } = await resourceRpc('resources/read', { uri });
    if (error) return { error };
    const contents = z
      .array(z.object({ uri: z.string(), text: z.string() }))
      .parse(result?.contents);
    return { body: JSON.parse(contents[0]?.text ?? 'null') as unknown };
  }

  it('lists templates in templates/list and concrete resources in resources/list', async () => {
    const templates = await resourceRpc('resources/templates/list', {});
    expect(
      z
        .array(z.object({ uriTemplate: z.string() }))
        .parse(templates.result?.resourceTemplates)
        .map((t) => t.uriTemplate)
    ).toEqual([
      'openstory://sequences/{sequenceId}/summary',
      'openstory://sequences/{sequenceId}/bible',
      'openstory://sequences/{sequenceId}/scenes/{sceneId}',
    ]);
    const listed = z
      .array(z.object({ uri: z.string() }))
      .parse((await resourceRpc('resources/list', {})).result?.resources)
      .map((r) => r.uri);
    expect(listed).toEqual([
      'ui://openstory/sequence-card.html',
      `openstory://sequences/${sequenceId}/summary`,
      `openstory://sequences/${sequenceId}/bible`,
    ]);
    expect(listed.some((uri) => uri.includes('{'))).toBe(false);
  });

  it('serves the same projections as get_sequence and get_scene', async () => {
    expect(
      (await read(`openstory://sequences/${sequenceId}/summary`)).body
    ).toEqual(await data('get_sequence', { sequenceId }));
    expect(
      (await read(`openstory://sequences/${sequenceId}/scenes/${sceneId}`)).body
    ).toEqual(await data('get_scene', { sequenceId, sceneId }));
  });

  it('serves the bible with explicit truncation, equal to its tool', async () => {
    const { body } = await read(`openstory://sequences/${sequenceId}/bible`);
    expect(body).toMatchObject({
      sequenceId,
      charactersTruncated: null,
      scenesTruncated: null,
    });
    expect(body).toEqual(await data('get_production_bible', { sequenceId }));
  });

  it('shrinks an over-budget bible to fit, with a real cursor to continue', async () => {
    await db.insert(characters).values(
      Array.from({ length: 30 }, (_, i) => ({
        id: generateId(),
        sequenceId,
        characterId: `char_${i}`,
        legacyName: `C${i}`,
        legacyPersonality: 'x'.repeat(8000),
      }))
    );
    const bible = z
      .object({
        characters: z.array(z.unknown()),
        charactersTruncated: z.object({
          continueWith: z.literal('list_characters'),
          cursor: z.string(),
        }),
      })
      .parse(await data('get_production_bible', { sequenceId }));
    expect(bible.characters).toHaveLength(5);
    expect(
      await data('list_characters', {
        sequenceId,
        cursor: bible.charactersTruncated.cursor,
        limit: 5,
      })
    ).toMatchObject({ characters: expect.any(Array) });
  });

  it('drops a deleted scene from the bible', async () => {
    const before = z
      .object({ totalScenes: z.number() })
      .parse((await read(`openstory://sequences/${sequenceId}/bible`)).body);
    await db
      .update(scenes)
      .set({ deletedAt: new Date() })
      .where(eq(scenes.id, dbSceneId(sceneId)));
    expect(
      (await read(`openstory://sequences/${sequenceId}/bible`)).body
    ).toMatchObject({ totalScenes: before.totalScenes - 1 });
  });

  it('rejects malformed URIs, shot ids, wrong-sequence, deleted and foreign scenes', async () => {
    const otherSequence = generateId();
    await db.insert(sequences).values({
      id: otherSequence,
      teamId,
      title: 'Other',
      styleId: (await db.select().from(sequences))[0]?.styleId ?? '',
    });
    for (const uri of [
      `openstory://sequences/${sequenceId}/summary?x=1`,
      `openstory://sequences/not-a-ulid/summary`,
      `openstory://sequences/${sequenceId}/scenes/${shotId}`,
      `openstory://sequences/${otherSequence}/scenes/${sceneId}`,
      `openstory://sequences/${sequenceId}/scenes/${sceneId}/extra`,
    ]) {
      expect((await read(uri)).error, uri).toMatchObject({
        code: -32602,
        data: { uri },
      });
    }
    await db
      .update(scenes)
      .set({ deletedAt: new Date() })
      .where(eq(scenes.id, dbSceneId(sceneId)));
    expect(
      (await read(`openstory://sequences/${sequenceId}/scenes/${sceneId}`))
        .error
    ).toMatchObject({ code: -32602 });
    scopedDb = createScopedDb(generateId(), actorId);
    for (const path of ['summary', 'bible', `scenes/${sceneId}`]) {
      expect(
        (await read(`openstory://sequences/${sequenceId}/${path}`)).error,
        path
      ).toMatchObject({ code: -32602 });
    }
  });
});

/**
 * #1463: the official MCP client (pinned to our server's SDK revision) over
 * Streamable HTTP, against the real server and migrated SQLite. Only the
 * network hop is replaced: the transport's fetch calls serveMcpRequest.
 */
describe('official MCP client transport (#1463)', () => {
  async function connect(
    scopes: readonly string[] | null,
    mode: 'auto' | 'legacy' = 'auto'
  ) {
    const auth = asStub<McpAuthContext>({
      user: asStub<User>({ id: actorId, email: 'a@b.c', name: 'A' }),
      teamId,
      teamName: 'T',
      kind: scopes ? 'oauth' : 'api_key',
      keyHint: 'osk_…test',
      clientId: 'vitest',
      scopes: scopes ?? [],
      session: null,
      oauth: null,
    });
    const transport = new StreamableHTTPClientTransport(
      new URL('https://openstory.test/mcp'),
      {
        fetch: (input, init) => {
          const request = new Request(input, init);
          return serveMcpRequest(
            request,
            auth,
            request.headers.get('mcp-method')
          );
        },
      }
    );
    const mcp = new McpClient(
      { name: 'vitest-client', version: '1' },
      { versionNegotiation: { mode } }
    );
    await mcp.connect(transport);
    return mcp;
  }
  const structured = (result: unknown) =>
    z
      .object({ structuredContent: z.record(z.string(), z.unknown()) })
      .parse(result).structuredContent;

  it('discovers the read tools and resources, and navigates sequence → shot → scene', async () => {
    const mcp = await connect(null);
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    for (const name of [
      'list_sequences',
      'get_sequence',
      'get_sequence_status',
      'list_scenes',
      'get_scene',
      'list_shots',
      'get_shot',
    ]) {
      expect(names).toContain(`openstory.${name}`);
    }
    expect(
      (await mcp.listResourceTemplates()).resourceTemplates.map(
        (t) => t.uriTemplate
      )
    ).toContain('openstory://sequences/{sequenceId}/bible');

    expect(
      structured(
        await mcp.callTool({ name: 'openstory.list_sequences', arguments: {} })
      )
    ).toMatchObject({ sequences: [{ id: sequenceId }] });
    const second = await addShot(sceneId, 2);
    const shotPage = z.object({
      shots: z.array(z.object({ id: z.string(), sceneId: z.string() })),
      nextCursor: z.string().nullable(),
    });
    const listShots = async (args: Record<string, unknown>) =>
      shotPage.parse(
        structured(
          await mcp.callTool({
            name: 'openstory.list_shots',
            arguments: { sequenceId, limit: 1, ...args },
          })
        )
      );
    const page = await listShots({});
    const [first] = page.shots;
    if (!first || !page.nextCursor) throw new Error('expected a first page');
    expect((await listShots({ cursor: page.nextCursor })).shots).toEqual([
      expect.objectContaining({ id: second }),
    ]);
    expect(
      (await listShots({ sceneId: first.sceneId, limit: 10 })).shots.map(
        (s) => s.id
      )
    ).toEqual([first.id, second]);
    expect(
      structured(
        await mcp.callTool({
          name: 'openstory.get_shot',
          arguments: { sequenceId, shotId: first.id },
        })
      )
    ).toMatchObject({ id: first.id });
    expect(
      structured(
        await mcp.callTool({
          name: 'openstory.get_scene',
          arguments: { sequenceId, sceneId: first.sceneId },
        })
      )
    ).toMatchObject({ id: first.sceneId });

    // Scene and shot ids are not interchangeable.
    expect(
      await mcp.callTool({
        name: 'openstory.get_scene',
        arguments: { sequenceId, sceneId: shotId },
      })
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'NOT_FOUND' } },
    });
    expect(
      await mcp.callTool({
        name: 'openstory.get_shot',
        arguments: { sequenceId, shotId: sceneId },
      })
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'NOT_FOUND' } },
    });

    const read = await mcp.readResource({
      uri: `openstory://sequences/${sequenceId}/summary`,
    });
    expect(read.contents[0]).toMatchObject({ mimeType: 'application/json' });
    await mcp.close();
  });

  it('serves a 2025-only client without a session (Claude’s connector)', async () => {
    const legacy = await connect(null, 'legacy');
    const { tools } = await legacy.listTools();
    expect(tools.map((tool) => tool.name)).toContain(
      'openstory.list_sequences'
    );
    expect(
      structured(
        await legacy.callTool({
          name: 'openstory.list_sequences',
          arguments: {},
        })
      )
    ).toMatchObject({ sequences: [{ id: sequenceId }] });
    await legacy.close();
  });

  it('refuses a missing scope with an actionable error', async () => {
    const readOnly = await connect(['sequences:read']);
    expect(
      await readOnly.callTool({
        name: 'openstory.update_scene',
        arguments: {
          sequenceId,
          sceneId,
          expectedScriptVersionId: generateId(),
          title: 'New',
        },
      })
    ).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'INSUFFICIENT_SCOPE',
          details: { scope: 'sequences:write' },
        },
      },
    });
    await readOnly.close();
  });
});
