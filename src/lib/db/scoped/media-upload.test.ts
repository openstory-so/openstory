/**
 * Acceptance tests for manual media inject (#1108 Phase 3): the uploaded-still
 * append (§4.3 B), the atomic prompt+image replace (§4.3 C), and the uploaded
 * video append — against in-memory libSQL with the real migrations.
 *
 * The §4.3 assertions are the product contract:
 *   B — image-only: the upload is FRESH against the current prompt, the prompt
 *       pointer/history is untouched, and the previously selected video reads
 *       STALE by manifest derivation.
 *   C — prompt+image together: BOTH are fresh (the image hash was computed
 *       against the NEW prompt text), committed in one batch; video stale.
 */

import { DEFAULT_IMAGE_MODEL, safeTextToImageModel } from '@/lib/ai/models';
import { computeVideoManifestInputHash } from '@/lib/ai/input-hash';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import {
  characters,
  framePromptVersions,
  frameVariants,
  frames,
  renderSegments,
  sequenceEvents,
  sequenceMusicVariants,
  sequences,
  shots,
  styles,
  teams,
  user,
  videoVariants,
} from '@/lib/db/schema';
import type { VideoManifest } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import {
  computeUploadedStillInputHash,
  parseUploadedStoragePath,
  resolveUploadExtension,
  USER_UPLOAD_MODEL,
} from '@/lib/shots/upload-media';
import { buildRegenerateShotSnapshot } from '@/lib/workflows/regenerate-shots-snapshot';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createFramePromptVersionsMethods } from './frame-prompt-versions';
import { createFrameVariantsMethods } from './frame-variants';
import { createSequenceMusicPromptVersionsMethods } from './sequence-music-prompt-versions';
import { createSequenceVariantsMethods } from './sequence-variants';
import { createVideoVariantsMethods } from './video-variants';

let client: Client;
let db: Database;
let sequenceId = '';
let shotId = '';
let frameId = '';
let actorId = '';
let teamId = '';
let styleId = '';

// The staleness verify runs through a real ScopedDb, so point the client
// factory at this test's libSQL instance and load the consumers dynamically
// (vi.doMock is not hoisted — a static import would bypass it).
vi.doMock('#db-client', () => ({ getDb: () => db }));
const { createScopedDb } = await import('@/lib/db/scoped');
const { computeShotStaleness } = await import('@/lib/shots/shot-staleness');

async function seed() {
  await db.delete(sequenceEvents);
  await db.delete(sequenceMusicVariants);
  await db.delete(videoVariants);
  await db.delete(frameVariants);
  await db.delete(framePromptVersions);
  await db.delete(frames);
  await db.delete(characters);
  await db.delete(shots);
  await db.delete(renderSegments);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  teamId = generateId();
  sequenceId = generateId();
  actorId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
  await db.insert(user).values({ id: actorId, name: 'U', email: 'u@e.com' });
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
  await db
    .insert(sequences)
    .values({ id: sequenceId, teamId, title: 'S', styleId: style.id });
  const [shot] = await db
    .insert(shots)
    .values({ sequenceId, shotNumber: 1, durationMs: 4000 })
    .returning();
  if (!shot) throw new Error('test setup: shot insert returned nothing');
  shotId = shot.id;
  const [frame] = await db
    .insert(frames)
    .values({ shotId, sequenceId, orderIndex: 0, role: 'first' })
    .returning();
  if (!frame) throw new Error('test setup: frame insert returned nothing');
  frameId = frame.id;
}

/** A completed, selected `user-edit` prompt version with `text`. */
async function seedSelectedPrompt(text: string) {
  const prompts = createFramePromptVersionsMethods(db);
  return await prompts.write({
    frameId,
    text,
    source: 'user-edit',
    inputHash: 'upstream-hash-1',
    analysisModel: 'test-model',
    createdBy: actorId,
  });
}

/** A completed, selected `kind:'model'` still to be replaced by the upload. */
async function seedSelectedImage(inputHash: string) {
  const images = createFrameVariantsMethods(db);
  const version = await images.appendVersion({
    frameId,
    sequenceId,
    kind: 'model',
    model: 'nano_banana_2',
    status: 'completed',
    url: '/r2/thumbnails/old.png',
    storagePath: 'old.png',
    generatedAt: new Date(),
    inputHash,
  });
  await images.select(frameId, version.id, { actorId });
  return version;
}

/**
 * A completed, selected video whose manifest references the given frame
 * version — the state a still replace must invalidate by derivation.
 */
async function seedSegmentAndVideo(frameVersionId: string) {
  // render_segments.sceneId is NOT NULL → seed a minimal scene first.
  const sceneId = generateId();
  await client.execute({
    sql: 'INSERT INTO scenes (id, sequence_id, order_index, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
    args: [sceneId, sequenceId, Date.now(), Date.now()],
  });
  await db
    .insert(renderSegments)
    .values({ id: shotId, sceneId, sequenceId })
    .onConflictDoNothing();
  await db
    .update(shots)
    .set({ renderSegmentId: shotId })
    .where(eq(shots.id, shotId));

  const manifest: VideoManifest = [
    {
      shotId,
      motionPromptVersionId: null,
      frameVersionId,
      durationMs: 4000,
    },
  ];
  const videos = createVideoVariantsMethods(db);
  const version = await videos.appendVersion({
    renderSegmentId: shotId,
    sequenceId,
    model: 'kling_25',
    manifest,
    status: 'completed',
    url: '/r2/videos/old.mp4',
    storagePath: 'old.mp4',
    generatedAt: new Date(),
    inputHash: await computeVideoManifestInputHash(manifest, 'kling_25'),
  });
  await videos.select(shotId, version.id, { actorId });
  return version;
}

async function eventKinds(): Promise<string[]> {
  const rows = await db.select().from(sequenceEvents);
  return rows.map((r) => r.kind);
}

/**
 * A scene that actually REFERENCES a character, plus that character with a
 * completed sheet. The reference sets are what `buildRegenerateShotSnapshot`
 * folds into the image hash, and omitting them is the exact shape that made
 * every reference-bearing shot read stale in #867 — so the end-to-end
 * freshness assertions below run against this, not an empty scene.
 */
const SCENE_WITH_REFS: Scene = {
  sceneId: 'scene-1',
  sceneNumber: 1,
  originalScript: { extract: 'Jack steps off the curb.', dialogue: [] },
  metadata: {
    title: 'Curbside',
    durationSeconds: 4,
    location: 'City street',
    timeOfDay: 'dawn',
    storyBeat: 'setup',
  },
  continuity: {
    characterTags: ['Jack'],
    environmentTag: 'city-street',
    elementTags: [],
    colorPalette: 'cool blues, steel grays',
    lightingSetup: 'natural dawn light',
    styleTag: 'cinematic',
  },
};

async function seedCharacterWithSheet(sheetInputHash: string) {
  const [row] = await db
    .insert(characters)
    .values({
      sequenceId,
      characterId: 'char_001',
      name: 'Jack',
      consistencyTag: 'char_001: Jack-denim-jacket',
      sheetStatus: 'completed',
      sheetImageUrl: '/r2/characters/jack.png',
      sheetInputHash,
    })
    .returning();
  if (!row) throw new Error('test setup: character insert returned nothing');
  return row;
}

/** The scoped DB + sequence shape `computeShotStaleness` verifies against. */
function stalenessArgs() {
  return {
    scopedDb: createScopedDb(teamId, actorId),
    sequence: {
      id: sequenceId,
      styleId,
      aspectRatio: '16:9' as const,
      // #1121 defers staleness while 'processing'; these tests assert real
      // verdicts, so the sequence must read as settled.
      status: 'completed' as const,
      analysisModel: 'test-model',
    },
  };
}

/** Run the real verify path for this shot's anchor frame. */
async function verifyThumbnailStaleness(scene: Scene | null) {
  const { scopedDb, sequence } = stalenessArgs();
  const [shot] = await db.select().from(shots).where(eq(shots.id, shotId));
  const [frame] = await db.select().from(frames).where(eq(frames.id, frameId));
  if (!shot || !frame) throw new Error('test setup: shot/frame missing');
  const selectedImage = await scopedDb.frameVariants.getSelected(frameId);
  const result = await computeShotStaleness({
    scopedDb,
    sequence,
    shot,
    frame,
    selectedImage,
    scene,
  });
  return result.thumbnail;
}

const uploadUrl = () => `/r2/thumbnails/teams/x/${generateId()}.png`;

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
});

describe('parseUploadedStoragePath', () => {
  const ownTeam = '01TEAM';
  it('accepts a stored URL under the team prefix and strips the bucket', () => {
    expect(
      parseUploadedStoragePath(
        '/r2/thumbnails/teams/01TEAM/sequences/s/frames/f/x.png',
        'thumbnails',
        ownTeam
      )
    ).toBe('teams/01TEAM/sequences/s/frames/f/x.png');
  });
  it('rejects the wrong bucket, wrong team, traversal, and external URLs', () => {
    expect(
      parseUploadedStoragePath(
        '/r2/videos/teams/01TEAM/x.mp4',
        'thumbnails',
        ownTeam
      )
    ).toBeNull();
    expect(
      parseUploadedStoragePath(
        '/r2/thumbnails/teams/OTHER/x.png',
        'thumbnails',
        ownTeam
      )
    ).toBeNull();
    expect(
      parseUploadedStoragePath(
        '/r2/thumbnails/teams/01TEAM/../OTHER/x.png',
        'thumbnails',
        ownTeam
      )
    ).toBeNull();
    expect(
      parseUploadedStoragePath(
        'https://evil.example/x.png',
        'thumbnails',
        ownTeam
      )
    ).toBeNull();
  });
});

describe('resolveUploadExtension', () => {
  it('accepts the surface’s own types and rejects everything else', () => {
    expect(resolveUploadExtension('still.PNG', 'image')).toBe('png');
    expect(resolveUploadExtension('my.clip.final.mp4', 'video')).toBe('mp4');
    expect(resolveUploadExtension('score.wav', 'audio')).toBe('wav');
    // Cross-surface.
    expect(resolveUploadExtension('clip.mp4', 'image')).toBeNull();
    // Script-bearing types the /r2 route would serve same-origin.
    expect(resolveUploadExtension('payload.svg', 'image')).toBeNull();
    expect(resolveUploadExtension('payload.html', 'image')).toBeNull();
    // No extension must NOT fall back to jpg (getExtensionFromUrl's default).
    expect(resolveUploadExtension('payload', 'image')).toBeNull();
  });
});

describe('music upload — append-only across uploads', () => {
  it('retires the previous upload instead of overwriting it, keeping it promotable', async () => {
    const variants = createSequenceVariantsMethods(db);
    const upload = (url: string) => ({
      sequenceId,
      model: USER_UPLOAD_MODEL,
      url,
      storagePath: url.replace('/r2/audio/', ''),
      status: 'completed' as const,
      generatedAt: new Date(),
      inputHash: null,
    });

    const first = await variants.upsertMusicPrimary(upload('/r2/audio/v1.mp3'));

    // Second upload: retire, then insert — the shape the server fn uses.
    const retired = await variants.retireMusicPrimary(
      sequenceId,
      USER_UPLOAD_MODEL
    );
    const second = await variants.upsertMusicPrimary(
      upload('/r2/audio/v2.mp3')
    );

    // A distinct row, not an in-place update of the first.
    expect(retired?.id).toBe(first.id);
    expect(second.id).not.toBe(first.id);

    // The first upload's bytes are still addressable.
    const [firstRow] = await db
      .select()
      .from(sequenceMusicVariants)
      .where(eq(sequenceMusicVariants.id, first.id));
    expect(firstRow?.url).toBe('/r2/audio/v1.mp3');

    // …and it is offered back to the user as a promotable alternate.
    const alternates = await variants.listDivergentMusic(sequenceId);
    expect(alternates.map((v) => v.id)).toContain(first.id);

    // The live slot is the newest upload.
    const primary = await variants.getMusicPrimary(
      sequenceId,
      USER_UPLOAD_MODEL
    );
    expect(primary?.id).toBe(second.id);
  });
});

describe('§4.3 B — image-only upload (appendUploadedVersion + select)', () => {
  it('selects the upload FRESH against the current prompt, leaves the prompt untouched, and stales the video by manifest derivation', async () => {
    const prompt = await seedSelectedPrompt('a red car at dawn');
    const oldImage = await seedSelectedImage('image-hash-old');
    const oldVideo = await seedSegmentAndVideo(oldImage.id);

    const images = createFrameVariantsMethods(db);
    const inputHash = await computeUploadedStillInputHash({
      shotId,
      frameId,
      scene: null,
      promptText: prompt.text,
      characters: [],
      locations: [],
      elements: [],
      aspectRatio: '16:9',
    });
    expect(inputHash).not.toBeNull();

    const url = uploadUrl();
    const uploaded = await images.appendUploadedVersion({
      frameId,
      sequenceId,
      model: USER_UPLOAD_MODEL,
      url,
      storagePath: 'teams/x/upload.png',
      inputHash,
      promptVersionId: prompt.id,
      promptText: prompt.text,
      actorId,
    });
    await images.select(frameId, uploaded.id, { actorId });

    // Upload is the selected still, kind 'upload'.
    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    expect(frame?.selectedImageVersionId).toBe(uploaded.id);
    expect(uploaded.kind).toBe('upload');
    expect(uploaded.status).toBe('completed');

    // Image FRESH: the stamped hash equals what the staleness verify
    // recomputes from current state (buildRegenerateShotSnapshot with the
    // `user-upload` model resolved exactly as the verify resolves it).
    const verify = await buildRegenerateShotSnapshot({
      shot: { id: shotId },
      scene: null,
      frameId,
      imagePrompt: prompt.text,
      characters: [],
      locations: [],
      elements: [],
      imageModel: safeTextToImageModel(USER_UPLOAD_MODEL, DEFAULT_IMAGE_MODEL),
      aspectRatio: '16:9',
    });
    expect(uploaded.inputHash).toBe(verify.snapshotInputHash);
    expect(await images.isStale(uploaded.id, verify.snapshotInputHash)).toBe(
      false
    );

    // Prompt untouched: same selection pointer, no new history rows.
    expect(frame?.selectedImagePromptVersionId).toBe(prompt.id);
    const promptRows = await db.select().from(framePromptVersions);
    expect(promptRows).toHaveLength(1);

    // Video STALE by derivation: the selected render's manifest still names
    // the previous frame version…
    const videos = createVideoVariantsMethods(db);
    const selectedVideo = await videos.getSelectedByShot(shotId);
    expect(selectedVideo?.id).toBe(oldVideo.id);
    expect(selectedVideo?.manifest[0]?.frameVersionId).toBe(oldImage.id);
    expect(selectedVideo?.manifest[0]?.frameVersionId).not.toBe(
      frame?.selectedImageVersionId
    );
    // …and its manifest hash diverges from one recomputed over current
    // pointers.
    const currentManifest: VideoManifest = [
      {
        shotId,
        motionPromptVersionId: null,
        frameVersionId: uploaded.id,
        durationMs: 4000,
      },
    ];
    expect(
      await videos.isStale(
        oldVideo.id,
        await computeVideoManifestInputHash(currentManifest, 'kling_25')
      )
    ).toBe(true);

    // Events: the append logged image.uploaded, the repoint image.selected.
    const kinds = await eventKinds();
    expect(kinds).toContain('image.uploaded');
    expect(kinds).toContain('image.selected');
  });

  it('reads FRESH through the real staleness verify, on a scene that carries references', async () => {
    // The stamp/verify agreement is the §8 risk note. Asserting it through
    // `computeShotStaleness` (not by re-deriving the snapshot here) is what
    // makes this a contract test: a divergence introduced on the verify side —
    // a different model tier, a dropped reference set — fails here.
    const character = await seedCharacterWithSheet('sheet-hash-1');
    const prompt = await seedSelectedPrompt('Jack at dawn, wide');

    const images = createFrameVariantsMethods(db);
    const inputHash = await computeUploadedStillInputHash({
      shotId,
      frameId,
      scene: SCENE_WITH_REFS,
      promptText: prompt.text,
      characters: [character],
      locations: [],
      elements: [],
      aspectRatio: '16:9',
    });
    const uploaded = await images.appendUploadedVersion({
      frameId,
      sequenceId,
      model: USER_UPLOAD_MODEL,
      url: uploadUrl(),
      storagePath: 'teams/x/upload.png',
      inputHash,
      promptVersionId: prompt.id,
      promptText: prompt.text,
      actorId,
    });
    await images.select(frameId, uploaded.id, { actorId });

    expect(await verifyThumbnailStaleness(SCENE_WITH_REFS)).toBe('fresh');

    // Counterfactual: the character's sheet moving on re-stales the upload, so
    // "fresh" above is a real comparison and not a hash that ignores its
    // reference inputs.
    await db
      .update(characters)
      .set({ sheetInputHash: 'sheet-hash-2' })
      .where(eq(characters.id, character.id));
    expect(await verifyThumbnailStaleness(SCENE_WITH_REFS)).toBe('stale');
  });

  it('stamps a null hash (untracked, never falsely stale) when the frame has no prompt', async () => {
    const inputHash = await computeUploadedStillInputHash({
      shotId,
      frameId,
      scene: null,
      promptText: null,
      characters: [],
      locations: [],
      elements: [],
      aspectRatio: '16:9',
    });
    expect(inputHash).toBeNull();

    const images = createFrameVariantsMethods(db);
    const uploaded = await images.appendUploadedVersion({
      frameId,
      sequenceId,
      model: USER_UPLOAD_MODEL,
      url: uploadUrl(),
      storagePath: 'teams/x/upload.png',
      inputHash,
      promptVersionId: null,
      promptText: null,
      actorId,
    });
    await images.select(frameId, uploaded.id, { actorId });
    expect(await images.isStale(uploaded.id, 'any-live-hash')).toBe(false);
  });
});

describe('§4.3 C — atomic prompt+image replace (replaceContent)', () => {
  it('commits both versions in one batch: prompt fresh, image fresh against the NEW text, video stale', async () => {
    const oldPrompt = await seedSelectedPrompt('a red car at dawn');
    const oldImage = await seedSelectedImage('image-hash-old');
    const oldVideo = await seedSegmentAndVideo(oldImage.id);

    // A live pending prompt claim must lose its mirror right (#1085).
    const prompts = createFramePromptVersionsMethods(db);
    const claim = await prompts.createPending({
      frameId,
      pendingInputHash: 'live-hash-x',
      createdBy: actorId,
    });

    const newText = 'a blue motorcycle at dusk';
    const images = createFrameVariantsMethods(db);
    const imageInputHash = await computeUploadedStillInputHash({
      shotId,
      frameId,
      scene: null,
      promptText: newText,
      characters: [],
      locations: [],
      elements: [],
      aspectRatio: '16:9',
    });
    const url = uploadUrl();
    const { promptVersion, imageVersion } = await images.replaceContent({
      frameId,
      sequenceId,
      actorId,
      prompt: {
        text: newText,
        inputHash: 'upstream-hash-2',
        analysisModel: 'test-model',
        createdBy: actorId,
      },
      image: {
        model: USER_UPLOAD_MODEL,
        url,
        storagePath: 'teams/x/upload2.png',
        inputHash: imageInputHash,
      },
    });

    // Both pointers moved to the new versions.
    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    expect(frame?.selectedImagePromptVersionId).toBe(promptVersion.id);
    expect(frame?.selectedImageVersionId).toBe(imageVersion.id);
    expect(frame?.imageStatus).toBe('completed');

    // Prompt fresh: the new user-edit version carries its upstream hash.
    expect(promptVersion.text).toBe(newText);
    expect(promptVersion.source).toBe('user-edit');
    expect(promptVersion.status).toBe('completed');
    expect(promptVersion.inputHash).toBe('upstream-hash-2');
    expect(promptVersion.id).not.toBe(oldPrompt.id);

    // Image FRESH against the NEW prompt text — the §4.3 C rule. Recompute
    // from post-commit state (selected prompt = newText) and compare.
    const recomputed = await computeUploadedStillInputHash({
      shotId,
      frameId,
      scene: null,
      promptText: newText,
      characters: [],
      locations: [],
      elements: [],
      aspectRatio: '16:9',
    });
    expect(imageVersion.inputHash).toBe(recomputed);
    expect(imageVersion.kind).toBe('upload');
    expect(imageVersion.promptVersionId).toBe(promptVersion.id);

    // Counterfactual: hashing against the OLD text would have read stale —
    // stamping from the new text is what keeps the upload fresh.
    const hashAgainstOldText = await computeUploadedStillInputHash({
      shotId,
      frameId,
      scene: null,
      promptText: oldPrompt.text,
      characters: [],
      locations: [],
      elements: [],
      aspectRatio: '16:9',
    });
    expect(imageVersion.inputHash).not.toBe(hashAgainstOldText);

    // Video STALE by manifest derivation.
    const videos = createVideoVariantsMethods(db);
    const selectedVideo = await videos.getSelectedByShot(shotId);
    expect(selectedVideo?.id).toBe(oldVideo.id);
    expect(selectedVideo?.manifest[0]?.frameVersionId).not.toBe(
      imageVersion.id
    );

    // The live pending claim lost its mirror right.
    const [claimRow] = await db
      .select()
      .from(framePromptVersions)
      .where(eq(framePromptVersions.id, claim.id));
    expect(claimRow?.pendingInputHash).toBeNull();

    // Events committed with the mutation — including the selection move, which
    // the activity timeline reads pointer history from.
    const kinds = await eventKinds();
    expect(kinds).toContain('prompt.edited');
    expect(kinds).toContain('image.uploaded');
    expect(kinds).toContain('image.selected');
  });

  it('reads FRESH through the real staleness verify against the NEW prompt', async () => {
    // §4.3 C end-to-end: the verify recomputes from the post-commit selected
    // prompt (the new text), so a stamp taken against the old text would fail
    // here. Scene carries references so the reference sets participate.
    const character = await seedCharacterWithSheet('sheet-hash-1');
    await seedSelectedPrompt('Jack at dawn, wide');

    const newText = 'Jack at dusk, tight on his hands';
    const images = createFrameVariantsMethods(db);
    const imageInputHash = await computeUploadedStillInputHash({
      shotId,
      frameId,
      scene: SCENE_WITH_REFS,
      promptText: newText,
      characters: [character],
      locations: [],
      elements: [],
      aspectRatio: '16:9',
    });
    await images.replaceContent({
      frameId,
      sequenceId,
      actorId,
      prompt: {
        text: newText,
        inputHash: 'upstream-hash-2',
        analysisModel: 'test-model',
        createdBy: actorId,
      },
      image: {
        model: USER_UPLOAD_MODEL,
        url: uploadUrl(),
        storagePath: 'teams/x/upload2.png',
        inputHash: imageInputHash,
      },
    });

    expect(await verifyThumbnailStaleness(SCENE_WITH_REFS)).toBe('fresh');
  });
});

describe('video upload (appendUploadedVersion + select)', () => {
  it('appends a completed primary version with the current-pointer manifest, selects it, and re-stales it when the still moves on', async () => {
    const prompt = await seedSelectedPrompt('a red car at dawn');
    const still = await seedSelectedImage('image-hash-old');
    await seedSegmentAndVideo(still.id);

    const videos = createVideoVariantsMethods(db);
    const manifest: VideoManifest = [
      {
        shotId,
        motionPromptVersionId: null,
        frameVersionId: still.id,
        durationMs: 4000,
      },
    ];
    const inputHash = await computeVideoManifestInputHash(
      manifest,
      USER_UPLOAD_MODEL
    );
    const uploaded = await videos.appendUploadedVersion({
      renderSegmentId: shotId,
      sequenceId,
      shotId,
      model: USER_UPLOAD_MODEL,
      manifest,
      url: '/r2/videos/upload.mp4',
      storagePath: 'teams/x/upload.mp4',
      inputHash,
      actorId,
    });
    await videos.select(shotId, uploaded.id, { actorId });

    const selected = await videos.getSelectedByShot(shotId);
    expect(selected?.id).toBe(uploaded.id);
    expect(selected?.status).toBe('completed');
    expect(selected?.isPrimary).toBe(true);

    // Fresh now: the stamped manifest hash matches a recompute over the same
    // current pointers.
    expect(await videos.isStale(uploaded.id, inputHash)).toBe(false);

    // Replace the still → manifest diverges → the uploaded clip reads stale.
    const images = createFrameVariantsMethods(db);
    const nextStill = await images.appendUploadedVersion({
      frameId,
      sequenceId,
      model: USER_UPLOAD_MODEL,
      url: uploadUrl(),
      storagePath: 'teams/x/next.png',
      inputHash: null,
      promptVersionId: prompt.id,
      promptText: prompt.text,
      actorId,
    });
    await images.select(frameId, nextStill.id, { actorId });
    const divergedManifest: VideoManifest = [
      {
        shotId,
        motionPromptVersionId: null,
        frameVersionId: nextStill.id,
        durationMs: 4000,
      },
    ];
    expect(
      await videos.isStale(
        uploaded.id,
        await computeVideoManifestInputHash(divergedManifest, USER_UPLOAD_MODEL)
      )
    ).toBe(true);

    const kinds = await eventKinds();
    expect(kinds).toContain('video.uploaded');
    expect(kinds).toContain('video.selected');
  });
});

describe('video cancel parity (#1108 Phase 4)', () => {
  it('markTerminal fails the live row, drops its auto-promote claim, logs video.cancelled; a racing completion is discarded', async () => {
    await seedSelectedPrompt('a red car at dawn');
    const still = await seedSelectedImage('image-hash-old');
    await seedSegmentAndVideo(still.id);

    const videos = createVideoVariantsMethods(db);
    // An in-flight render holding the segment's auto-promote claim.
    const inFlight = await videos.appendVersion({
      renderSegmentId: shotId,
      sequenceId,
      model: 'kling_25',
      manifest: [],
      status: 'generating',
      workflowRunId: 'run-cancel-1',
    });
    await db
      .update(renderSegments)
      .set({ pendingPromoteVersionId: inFlight.id })
      .where(eq(renderSegments.id, shotId));

    const cancelled = await videos.markTerminal(inFlight.id, {
      error: 'Cancelled by user',
      actorId,
    });
    // 'cancelled', NOT 'failed' (#1108): smart retry and the failure surfaces
    // match 'failed' only — a deliberate cancel must never be auto-re-billed.
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.error).toBe('Cancelled by user');
    const [segment] = await db
      .select()
      .from(renderSegments)
      .where(eq(renderSegments.id, shotId));
    expect(segment?.pendingPromoteVersionId).toBeNull();
    expect(await eventKinds()).toContain('video.cancelled');

    // Idempotent: a second cancel reports null (already terminal).
    expect(
      await videos.markTerminal(inFlight.id, {
        error: 'Cancelled by user',
        actorId,
      })
    ).toBeNull();

    // The racing completion must NOT resurrect the cancelled row.
    expect(
      await videos.completeIfLive(inFlight.id, {
        url: '/r2/videos/late.mp4',
        storagePath: 'late.mp4',
      })
    ).toBeNull();
    const [row] = await db
      .select()
      .from(videoVariants)
      .where(eq(videoVariants.id, inFlight.id));
    expect(row?.status).toBe('cancelled');
    expect(row?.url).toBeNull();

    // A cancelled row is invisible to retry-model resolution…
    expect(await videos.getLastFailedByShot(shotId)).toBeNull();
    // …and the run's onFailure sees it as ACCOUNTED FOR (non-zero), so
    // persistMotionFailure never appends a duplicate 'failed' row that would
    // resurrect a failure banner over the deliberate cancel.
    expect(
      await videos.markFailedByWorkflowRun('run-cancel-1', 'late failure')
    ).toBeGreaterThan(0);
    const [afterOnFailure] = await db
      .select()
      .from(videoVariants)
      .where(eq(videoVariants.id, inFlight.id));
    expect(afterOnFailure?.status).toBe('cancelled');
  });
});

describe('music prompt edit vs uploaded score (#1108 Phase 4)', () => {
  it('a post-completion user edit updates the prompt, reads untracked (no nag), and never flags the uploaded score', async () => {
    const variants = createSequenceVariantsMethods(db);
    // The user's uploaded score in the user-upload primary slot — inputHash
    // null is the §4.4 "untracked" contract for manual audio.
    const uploaded = await variants.upsertMusicPrimary({
      sequenceId,
      model: 'user-upload',
      url: '/r2/audio/score.mp3',
      storagePath: 'score.mp3',
      prompt: 'old prompt',
      tags: 'calm',
      status: 'completed',
      generatedAt: new Date(),
      inputHash: null,
    });
    await variants.setMusicFromVariant(uploaded.id);

    // Edit the prompt AFTER the track exists — the saveMusicPromptFn path.
    const prompts = createSequenceMusicPromptVersionsMethods(db);
    await prompts.write({
      sequenceId,
      prompt: 'a brand new mood',
      tags: 'tense',
      source: 'user-edit',
      createdBy: actorId,
    });

    const [seq] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    expect(seq?.musicPrompt).toBe('a brand new mood');
    // Null stored hash → getMusicPromptStalenessFn short-circuits to
    // 'untracked': no regenerate nag from the prompt side.
    expect(seq?.musicPromptInputHash).toBeNull();

    // The uploaded score is untouched and itself untracked — no staleness
    // derivation exists that can flag a null-hash score for regeneration.
    const score = await variants.getMusicById(uploaded.id);
    expect(score?.url).toBe('/r2/audio/score.mp3');
    expect(score?.inputHash).toBeNull();
    expect(score?.divergedAt).toBeNull();
    expect(score?.discardedAt).toBeNull();

    // The user-upload slot is only ever written by the upload path, which
    // RETIRES the previous primary before upserting (never overwrites): after
    // a second upload the first score survives as a parked alternate
    // (divergedAt set, promotable back), and the new upload owns the slot.
    const retired = await variants.retireMusicPrimary(
      sequenceId,
      'user-upload'
    );
    expect(retired?.id).toBe(uploaded.id);
    const second = await variants.upsertMusicPrimary({
      sequenceId,
      model: 'user-upload',
      url: '/r2/audio/score2.mp3',
      storagePath: 'score2.mp3',
      prompt: 'a brand new mood',
      tags: 'tense',
      status: 'completed',
      generatedAt: new Date(),
      inputHash: null,
    });
    expect(second.id).not.toBe(uploaded.id);
    const first = await variants.getMusicById(uploaded.id);
    expect(first?.url).toBe('/r2/audio/score.mp3');
    expect(first?.divergedAt).not.toBeNull();
    expect(await variants.getMusicPrimary(sequenceId, 'user-upload')).toEqual(
      second
    );
  });
});
