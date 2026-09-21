import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import type { Database } from '@/platform/server/db/client';
import { relations } from '@/platform/server/db/schema/relations';
import {
  frames,
  renderSegments,
  scenes,
  sequences,
  shots,
  styles,
  teams,
} from '@/platform/server/db/schema';
import { createFrameVariantsMethods } from '@/stills/server/db/frame-variants';
import { createVideoVariantsMethods } from '@/motion/server/db/video-variants';
import { createSequencesMethods } from './sequences';
import { createAdminMethods } from '@/platform/server/db/scoped/admin';
import { videoPosterUrl } from '@/look/cloudflare-video';

let client: Client;
let db: Database;
let sequenceId: string;
let teamId: string;

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});
afterAll(() => client.close());
beforeEach(async () => {
  // Separate teams keep FK fixtures isolated without depending on deletion order.
  const [team] = await db
    .insert(teams)
    .values({ name: 'Test', slug: crypto.randomUUID() })
    .returning();
  if (!team) throw new Error('Missing team');
  teamId = team.id;
  const [style] = await db
    .insert(styles)
    .values({
      teamId,
      name: 'Test',
      config: {
        mood: 'neutral',
        artStyle: 'cinematic',
        lighting: 'natural',
        colorPalette: [],
        cameraWork: 'static',
        referenceFilms: [],
        colorGrading: 'neutral',
      },
    })
    .returning();
  if (!style) throw new Error('Missing style');
  const [seq] = await db
    .insert(sequences)
    .values({
      teamId,
      title: 'Film',
      styleId: style.id,
      posterUrl: '/r2/provisional.png',
    })
    .returning();
  if (!seq) throw new Error('Missing sequence');
  sequenceId = seq.id;
});

async function makeShot(sceneOrder = 0, shotNumber = 1) {
  const [scene] = await db
    .insert(scenes)
    .values({ sequenceId, orderIndex: sceneOrder })
    .returning();
  if (!scene) throw new Error('Missing scene');
  const [segment] = await db
    .insert(renderSegments)
    .values({ sequenceId, sceneId: scene.id })
    .returning();
  if (!segment) throw new Error('Missing segment');
  const [shot] = await db
    .insert(shots)
    .values({
      sequenceId,
      sceneId: scene.id,
      shotNumber,
      renderSegmentId: segment.id,
    })
    .returning();
  if (!shot) throw new Error('Missing shot');
  const [frame] = await db
    .insert(frames)
    .values({ sequenceId, shotId: shot.id, orderIndex: 0, role: 'first' })
    .returning();
  if (!frame) throw new Error('Missing frame');
  return { shot, frame, segment };
}
async function poster() {
  const rows = await createSequencesMethods(db, teamId, 'unused').list();
  return rows.find((row) => row.id === sequenceId)?.posterUrl;
}
async function preview(frameId: string, url = '/r2/storyboard.png') {
  return createFrameVariantsMethods(db).recordPreview({
    frameId,
    sequenceId,
    model: 'preview',
    url,
    storagePath: url,
    promptHash: null,
    workflowRunId: crypto.randomUUID(),
  });
}
async function still(frameId: string, url = '/r2/start.png') {
  const m = createFrameVariantsMethods(db);
  const version = await m.appendVersion({
    frameId,
    sequenceId,
    model: 'test',
    status: 'completed',
    url,
    storagePath: url,
  });
  await m.select(frameId, version.id, { actorId: null });
}
async function video(
  shotId: string,
  segmentId: string,
  url = 'https://assets.openstory.so/videos/first.mp4'
) {
  const m = createVideoVariantsMethods(db);
  const version = await m.appendVersion({
    renderSegmentId: segmentId,
    manifest: [],
    sequenceId,
    model: 'test',
    status: 'completed',
    url,
    storagePath: 'videos/first.mp4',
  });
  await m.select(shotId, version.id, { actorId: null });
  return videoPosterUrl(url);
}

describe('sequence posters follow the first shot', () => {
  it('replaces provisional artwork with a storyboard and then the selected start frame', async () => {
    const { frame } = await makeShot();
    await preview(frame.id);
    expect(await poster()).toBe('/r2/storyboard.png');
    await still(frame.id);
    expect(await poster()).toBe('/r2/start.png');
    await preview(frame.id, '/r2/late-storyboard.png');
    expect(await poster()).toBe('/r2/start.png');
  });
  it('uses scene order before shot number and ignores later shots and non-anchor frames', async () => {
    const first = await makeShot(0, 4);
    const later = await makeShot(1, 1);
    await still(later.frame.id, '/r2/later.png');
    expect(await poster()).toBe('/r2/provisional.png');
    const [lastFrame] = await db
      .insert(frames)
      .values({
        sequenceId,
        shotId: first.shot.id,
        orderIndex: 1,
        role: 'last',
      })
      .returning();
    if (!lastFrame) throw new Error('Missing last frame');
    await still(lastFrame.id, '/r2/last.png');
    expect(await poster()).toBe('/r2/provisional.png');
    await still(first.frame.id);
    expect(await poster()).toBe('/r2/start.png');
  });
  it('uses a server-extracted first video frame and does not downgrade it for late images', async () => {
    const { shot, frame, segment } = await makeShot();
    await still(frame.id);
    const expected = await video(shot.id, segment.id);
    expect(expected).toContain('mode=frame,time=0s,format=jpg');
    expect(await poster()).toBe(expected);
    await still(frame.id, '/r2/rerolled.png');
    await preview(frame.id);
    expect(await poster()).toBe(expected);
  });
  it('supports video-only shots and updates the poster when the selected video changes', async () => {
    const { shot, segment } = await makeShot();
    await video(shot.id, segment.id);
    const expected = await video(
      shot.id,
      segment.id,
      'https://assets.openstory.so/videos/second.mp4'
    );
    expect(await poster()).toBe(expected);
  });
  it('ignores a later shot video and never puts a raw local clip URL in the poster', async () => {
    const first = await makeShot();
    const later = await makeShot(1);
    await video(later.shot.id, later.segment.id);
    expect(await poster()).toBe('/r2/provisional.png');
    vi.stubEnv('E2E_TEST', 'true');
    try {
      await video(first.shot.id, first.segment.id, '/r2/videos/local.mp4');
      await preview(first.frame.id);
      expect(await poster()).toBe('/r2/storyboard.png');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('resolves stored video URLs through the public CDN for server-side extraction', async () => {
    const { shot, segment } = await makeShot();
    vi.stubEnv('E2E_TEST', 'false');
    vi.stubEnv('R2_PUBLIC_STORAGE_DOMAIN', 'storage.openstory.so');
    try {
      await video(shot.id, segment.id, '/r2/videos/stored.mp4');
      expect(await poster()).toBe(
        videoPosterUrl('https://storage.openstory.so/videos/stored.mp4')
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ignores deleted shots and follows start-frame selection changes', async () => {
    const removed = await makeShot();
    const first = await makeShot(1);
    await db
      .update(shots)
      .set({ deletedAt: new Date() })
      .where(eq(shots.id, removed.shot.id));
    await still(removed.frame.id);
    expect(await poster()).toBe('/r2/provisional.png');
    await still(first.frame.id);
    await still(first.frame.id, '/r2/new-selection.png');
    expect(await poster()).toBe('/r2/new-selection.png');
  });
  it('resolves existing media for support and team lists without writing a poster', async () => {
    const { frame } = await makeShot();
    await still(frame.id);
    expect(await poster()).toBe('/r2/start.png');
    const support = await createAdminMethods(db).getAllSequences({
      search: 'Film',
    });
    expect(support.find((row) => row.id === sequenceId)).toMatchObject({
      posterUrl: '/r2/start.png',
      creatorName: null,
    });
    const [stored] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    expect(stored?.posterUrl).toBe('/r2/provisional.png');
  });
});
