/**
 * The export service behind REST and MCP (#1461) on migrated SQLite: ready
 * reuse by cut hash, in-flight coalescing, stale reconciliation and launch
 * failure. Only the workflow trigger is mocked.
 */

import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
// oxlint-disable-next-line boundaries/no-raw-db -- substitute the isolated in-memory DB at the factory boundary
import { getDb } from '#db-client';
import type { Database } from '@/platform/server/db/client';
import { relations } from '@/platform/server/db/schema/relations';
import {
  renderSegments,
  scenes,
  sequenceExports,
  sequences,
  shots,
  styles,
  teams,
  videoVariants,
} from '@/platform/server/db/schema';
import { generateId } from '@/platform/id';
// oxlint-disable-next-line boundaries/no-scoped-factory -- exercise the real team-scoped export rows
import { createScopedDb } from '@/platform/server/db/scoped';
import { dbSceneId } from '@/shots/scene-id';

vi.mock('#db-client', () => ({ getDb: vi.fn() }));
const triggerWorkflow = vi.fn();
vi.doMock('@/platform/server/workflow/client', () => ({ triggerWorkflow }));

const { previewExport, resolveExportCut, startExport } =
  await import('./export');

let client: Client;
let db: Database;
let teamId: string;
let sequenceId: string;
let videoId: string;

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  vi.mocked(getDb).mockReturnValue(db);
});
afterAll(() => client.close());

beforeEach(async () => {
  vi.clearAllMocks();
  teamId = generateId();
  sequenceId = generateId();
  const styleId = generateId();
  const sceneId = dbSceneId(generateId());
  const segmentId = generateId();
  videoId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: teamId });
  await db.insert(styles).values({
    id: styleId,
    teamId,
    name: 's',
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
  await db
    .insert(sequences)
    .values({ id: sequenceId, teamId, title: 'S', styleId });
  await db.insert(scenes).values({ id: sceneId, sequenceId, orderIndex: 0 });
  await db.insert(renderSegments).values({
    id: segmentId,
    sequenceId,
    sceneId,
    selectedVideoVersionId: videoId,
  });
  await db.insert(shots).values({
    id: generateId(),
    sequenceId,
    sceneId,
    shotNumber: 1,
    renderSegmentId: segmentId,
  });
  await db.insert(videoVariants).values({
    id: videoId,
    sequenceId,
    renderSegmentId: segmentId,
    model: 'wan_i2v',
    manifest: [],
    status: 'completed',
    isPrimary: true,
    url: '/r2/openstory-videos/clip-a.mp4',
  });
  triggerWorkflow.mockResolvedValue('export-run');
});

const scoped = () => createScopedDb(teamId, generateId());
const start = async () =>
  startExport(scoped(), {
    userId: generateId(),
    teamId,
    sequenceId,
    cut: await resolveExportCut(scoped(), sequenceId),
  });

describe('export service', () => {
  it('renders once, coalesces a second start, then reuses the ready MP4 of the same cut', async () => {
    const cut = await resolveExportCut(scoped(), sequenceId);
    expect(await previewExport(scoped(), sequenceId, cut)).toEqual({
      action: 'render',
      exportId: null,
    });
    const first = await start();
    expect(first.workflowRunId).toBe('export-run');
    expect(first.action).toBe('render');
    const joined = await start();
    expect(joined.row.id).toBe(first.row.id);
    expect(joined.workflowRunId).toBeNull();
    expect(joined.action).toBe('join_in_flight');
    await db
      .update(sequenceExports)
      .set({ status: 'ready' })
      .where(eq(sequenceExports.id, first.row.id));
    expect(await previewExport(scoped(), sequenceId, cut)).toEqual({
      action: 'reuse_ready',
      exportId: first.row.id,
    });
    const reused = await start();
    expect(reused.row.id).toBe(first.row.id);
    expect(reused.workflowRunId).toBeNull();
    expect(reused.action).toBe('reuse_ready');
    expect(triggerWorkflow).toHaveBeenCalledTimes(1);
  });

  it('refuseOtherCut joins a render of the same cut but refuses one of another cut', async () => {
    const first = await start();
    const sameCut = await startExport(scoped(), {
      userId: generateId(),
      teamId,
      sequenceId,
      cut: await resolveExportCut(scoped(), sequenceId),
      refuseOtherCut: true,
    });
    expect(sameCut).toMatchObject({
      row: { id: first.row.id },
      action: 'join_in_flight',
    });
    await db
      .update(videoVariants)
      .set({ url: '/r2/openstory-videos/clip-b.mp4' })
      .where(eq(videoVariants.id, videoId));
    await expect(
      startExport(scoped(), {
        userId: generateId(),
        teamId,
        sequenceId,
        cut: await resolveExportCut(scoped(), sequenceId),
        refuseOtherCut: true,
      })
    ).rejects.toMatchObject({ code: 'EXPORT_BUSY' });
    expect(triggerWorkflow).toHaveBeenCalledTimes(1);
  });

  it('a changed cut renders anew, and a stale processing row is failed first', async () => {
    const first = await start();
    await db
      .update(sequenceExports)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(sequenceExports.id, first.row.id));
    await db
      .update(videoVariants)
      .set({ url: '/r2/openstory-videos/clip-b.mp4' })
      .where(eq(videoVariants.id, videoId));
    const second = await start();
    expect(second.row.id).not.toBe(first.row.id);
    const [stale] = await db
      .select()
      .from(sequenceExports)
      .where(eq(sequenceExports.id, first.row.id));
    expect(stale?.status).toBe('failed');
  });

  it('a launch failure frees the slot with a safe error instead of a stuck row', async () => {
    triggerWorkflow.mockRejectedValueOnce(new Error('binding down'));
    await expect(start()).rejects.toThrow('binding down');
    const [row] = await db
      .select()
      .from(sequenceExports)
      .where(eq(sequenceExports.sequenceId, sequenceId));
    expect(row).toMatchObject({
      status: 'failed',
      error: 'The render could not be started. Try again.',
    });
    expect((await start()).workflowRunId).toBe('export-run');
  });

  it('refuses a cut with unrendered shots and a foreign sequence', async () => {
    await db
      .update(videoVariants)
      .set({ url: null })
      .where(eq(videoVariants.id, videoId));
    await expect(resolveExportCut(scoped(), sequenceId)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      resolveExportCut(createScopedDb(generateId(), generateId()), sequenceId)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
