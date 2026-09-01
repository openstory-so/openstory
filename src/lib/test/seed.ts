/**
 * Test-only data seeding helpers.
 *
 * These run INSIDE the Worker (via the guarded /api/test/* routes),
 * so all DB writes go through the single safe Miniflare instance
 * started by @cloudflare/vite-plugin during E2E tests.
 *
 * Do NOT import this from e2e/ fixtures directly — call the HTTP endpoints instead.
 */

import { generateId } from '@/lib/db/id';
import {
  characterSheetVariants,
  characters,
  credits,
  frameVariants,
  frames,
  shots,
  locationLibrary,
  locationSheets,
  renderSegments,
  scenes,
  sequences,
  session,
  styles,
  talent,
  talentMedia,
  talentSheets,
  teamMembers,
  teams,
  user,
  verification,
  videoVariants,
} from '@/lib/db/schema';
import { getDb } from '#db-client';
import { and, asc, desc, eq, isNull, like, sql } from 'drizzle-orm';

export type CreatedTestUser = {
  id: string;
  email: string;
  name: string;
  teamId: string;
};

export type CreatedTestStyle = {
  id: string;
  teamId: string;
};

export type CreatedTestSequence = {
  id: string;
  teamId: string;
  styleId: string;
  title: string;
};

export type CreatedTestShot = {
  id: string;
  sequenceId: string;
  orderIndex: number;
};

export type CreatedTestTalent = {
  id: string;
  teamId: string;
  name: string;
  defaultSheetId: string;
};

/**
 * Create a test user + team + membership + credits.
 * Mirrors the previous direct logic from e2e/fixtures/auth.fixture.ts
 */
export async function createTestUser(
  opts: { name?: string } = {}
): Promise<CreatedTestUser> {
  const db = getDb();
  const now = new Date();

  const userId = generateId();
  const teamId = generateId();
  const name = opts.name ?? 'E2E Test User';

  const email = `test-${userId.slice(-8).toLowerCase()}@e2e.test`;
  const teamSlug = `test-team-${teamId.slice(-8).toLowerCase()}`;

  await db.insert(user).values({
    id: userId,
    name,
    email,
    emailVerified: true,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(teams).values({
    id: teamId,
    name: 'E2E Test Team',
    slug: teamSlug,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(teamMembers).values({
    teamId,
    userId,
    role: 'owner',
    joinedAt: now,
  });

  await db.insert(credits).values({
    teamId,
    balance: 100_000_000, // generous for tests
    updatedAt: now,
  });

  return { id: userId, email, name, teamId };
}

/**
 * Create a verification record (OTP) for a test user.
 *
 * This is a low-level primitive. Callers (e.g. the /api/test/verify route)
 * are responsible for passing the exact `identifier` that Better Auth will
 * look up (e.g. `sign-in-otp-${userEmail}`) and the value in the format it
 * expects (usually `${otp}:0`).
 */
export async function createOtpVerification(
  identifier: string,
  value: string
): Promise<void> {
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes

  // Delete any existing verification for this identifier first
  await db.delete(verification).where(eq(verification.identifier, identifier));

  await db.insert(verification).values({
    id: generateId(),
    identifier,
    value,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Clean up a test user and related records.
 */
export async function cleanupTestUser(
  userId: string,
  teamId: string
): Promise<void> {
  const db = getDb();

  await db.delete(session).where(eq(session.userId, userId));
  await db.delete(teamMembers).where(eq(teamMembers.userId, userId));
  await db.delete(teams).where(eq(teams.id, teamId));
  await db.delete(user).where(eq(user.id, userId));
  // Credits will cascade or be cleaned via team if we add FKs later
}

/**
 * Create a minimal test style for a team.
 */
export async function createTestStyle(
  teamId: string
): Promise<CreatedTestStyle> {
  const db = getDb();
  const now = new Date();
  const styleId = generateId();

  const styleConfig = {
    artStyle: 'Cinematic',
    colorPalette: ['#000000', '#FFFFFF'],
    lighting: 'Natural',
    cameraWork: 'Standard',
    mood: 'Dramatic',
    referenceFilms: ['Test Film'],
    colorGrading: 'Natural',
  };

  await db.insert(styles).values({
    id: styleId,
    teamId,
    name: 'E2E Test Style',
    config: styleConfig,
    createdAt: now,
    updatedAt: now,
  });

  return { id: styleId, teamId };
}

/**
 * Create a basic completed test sequence (no shots).
 */
export async function createTestSequence(
  teamId: string,
  userId: string,
  title = 'E2E Test Sequence'
): Promise<CreatedTestSequence> {
  const db = getDb();
  const now = new Date();
  const sequenceId = generateId();
  const style = await createTestStyle(teamId);

  await db.insert(sequences).values({
    id: sequenceId,
    teamId,
    title,
    status: 'completed',
    styleId: style.id,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });

  return { id: sequenceId, teamId, styleId: style.id, title };
}

/**
 * Create a single shot for a sequence (useful for variant tests).
 */
export async function createTestShot(
  sequenceId: string,
  orderIndex: number,
  options: {
    thumbnailUrl?: string;
    variantImageUrl?: string | null;
    variantImageStatus?: 'pending' | 'generating' | 'completed' | 'failed';
  } = {}
): Promise<CreatedTestShot> {
  const db = getDb();
  const now = new Date();
  const shotId = generateId();

  const {
    thumbnailUrl = `http://localhost:3001/api/test/image?w=1024&h=576&label=thumb`,
    variantImageUrl = null,
    variantImageStatus = 'pending',
  } = options;

  // Shot order is hierarchical now (#1067): (scenes.orderIndex,
  // shots.shotNumber). This helper makes a scene-less shot, so the caller's
  // 0-based index lands on the 1-based shotNumber.
  await db.insert(shots).values({
    id: shotId,
    sequenceId,
    shotNumber: orderIndex + 1,
    createdAt: now,
    updatedAt: now,
  });

  // The still-image surface lives on each shot's anchor frame now (#989). The
  // frame gets its OWN id (id-reuse was migration-only); it's resolved by
  // (shotId, orderIndex 0).
  const anchorFrameId = generateId();
  // The still itself is a `frame_variants` version the frame SELECTS (#1067) —
  // there is no `frames.imageUrl` to write. Seed the version first so the
  // frame's pointer has a target.
  const primaryVersionId = thumbnailUrl === null ? null : generateId();
  await db.insert(frames).values({
    id: anchorFrameId,
    shotId,
    sequenceId,
    orderIndex: 0,
    role: 'first',
    imageStatus: 'completed',
    selectedImageVersionId: primaryVersionId,
    createdAt: now,
    updatedAt: now,
  });
  if (primaryVersionId !== null) {
    await db.insert(frameVariants).values({
      id: primaryVersionId,
      frameId: anchorFrameId,
      sequenceId,
      kind: 'model',
      model: 'nano_banana_2',
      url: thumbnailUrl,
      status: 'completed',
      generatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  // The 3×3 grid sheet (was shots.variantImage*) is a kind:'framing'
  // frame_variants version with no sourceVariantId.
  if (variantImageUrl !== null) {
    await db.insert(frameVariants).values({
      id: generateId(),
      frameId: anchorFrameId,
      sequenceId,
      kind: 'framing',
      model: 'nano_banana_2',
      url: variantImageUrl,
      status: variantImageStatus,
      createdAt: now,
      updatedAt: now,
    });
  }

  return { id: shotId, sequenceId, orderIndex };
}

/**
 * Create test talent + default sheet.
 */
export async function createTestTalent(
  teamId: string,
  name: string
): Promise<CreatedTestTalent> {
  const db = getDb();
  const now = new Date();
  const talentId = generateId();
  const sheetId = generateId();

  await db.insert(talent).values({
    id: talentId,
    teamId,
    name,
    isInTeamLibrary: true,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(talentSheets).values({
    id: sheetId,
    talentId,
    name: 'Default',
    imageUrl: `http://localhost:3001/api/test/image?w=512&h=512&label=sheet`,
    imagePath: `talent/${name.toLowerCase().replace(/\s+/g, '-')}/sheet.webp`,
    isDefault: true,
    source: 'manual_upload',
    createdAt: now,
    updatedAt: now,
  });

  return { id: talentId, teamId, name, defaultSheetId: sheetId };
}

/**
 * Create test talent with reference media (multiple media items).
 */
export async function createTestTalentWithMedia(
  teamId: string,
  name: string,
  mediaCount = 2
): Promise<{
  id: string;
  name: string;
  teamId: string;
  sheetId: string;
  mediaIds: string[];
}> {
  const db = getDb();
  const now = new Date();
  const talentId = generateId();
  const sheetId = generateId();

  await db.insert(talent).values({
    id: talentId,
    teamId,
    name,
    isInTeamLibrary: true,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(talentSheets).values({
    id: sheetId,
    talentId,
    name: 'Default',
    imageUrl: `http://localhost:3001/api/test/image?w=512&h=512&label=sheet`,
    isDefault: true,
    source: 'manual_upload',
    createdAt: now,
    updatedAt: now,
  });

  const mediaIds: string[] = [];
  for (let i = 0; i < mediaCount; i++) {
    const mediaId = generateId();
    mediaIds.push(mediaId);
    await db.insert(talentMedia).values({
      id: mediaId,
      talentId,
      type: 'image',
      url: `http://localhost:3001/api/test/image?w=400&h=400&label=media`,
      path: `${teamId}/${talentId}/${mediaId}.jpg`,
      createdAt: now,
      updatedAt: now,
    });
  }

  return { id: talentId, name, teamId, sheetId, mediaIds };
}

/**
 * Create a test location + default sheet.
 */
export async function createTestLocation(
  teamId: string,
  name: string
): Promise<{ id: string; teamId: string; name: string }> {
  const db = getDb();
  const now = new Date();

  const [inserted] = await db
    .insert(locationLibrary)
    .values({
      teamId,
      name,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: locationLibrary.id });

  if (!inserted) {
    throw new Error('Failed to create test location');
  }

  const sheetId = generateId();
  await db.insert(locationSheets).values({
    id: sheetId,
    locationId: inserted.id,
    name: 'Default',
    imageUrl: `http://localhost:3001/api/test/image?w=1024&h=576&label=location`,
    imagePath: `locations/${name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')}/sheet.webp`,
    isDefault: true,
    source: 'ai_generated',
    createdAt: now,
    updatedAt: now,
  });

  return { id: inserted.id, teamId, name };
}

/**
 * Basic cleanup for a team's test data.
 * Prefer specific cleanups when possible.
 */
export async function cleanupTeamTestData(teamId: string): Promise<void> {
  const db = getDb();

  // Best-effort broad cleanup. Prefer the specific cleanup* functions in practice.
  await db.delete(sequences).where(eq(sequences.teamId, teamId));
  await db.delete(styles).where(eq(styles.teamId, teamId));
  await db.delete(talent).where(eq(talent.teamId, teamId));
  await db.delete(locationLibrary).where(eq(locationLibrary.teamId, teamId));
}

/**
 * Targeted cleanup of common E2E test data patterns (used by cleanTestData).
 */
export async function cleanTestData(): Promise<void> {
  const db = getDb();

  await db.delete(user).where(like(user.email, '%@e2e.test'));
  await db.delete(teams).where(like(teams.slug, 'test-team-%'));

  try {
    await db.delete(sequences).where(like(sequences.title, 'E2E Test%'));
  } catch {
    // table may not exist yet
  }

  try {
    await db.delete(talent).where(like(talent.name, 'E2E Test%'));
  } catch {
    // table may not exist yet
  }
}

/**
 * Nuclear option: delete all rows from all user tables.
 * Use very sparingly.
 */
export async function resetTestDatabase(): Promise<void> {
  const db = getDb();

  const tables = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%'`
  );

  for (const row of tables) {
    await db.run(sql.raw(`DELETE FROM "${row.name}"`));
  }
}

/**
 * Create a test character for a sequence.
 */
export async function createTestCharacter(
  sequenceId: string,
  characterId: string,
  name: string,
  talentId: string | null = null,
  options: {
    sheetImageUrl?: string;
    sheetStatus?: 'pending' | 'generating' | 'completed' | 'failed';
  } = {}
): Promise<{
  id: string;
  sequenceId: string;
  characterId: string;
  name: string;
}> {
  const db = getDb();
  const now = new Date();
  const id = generateId();

  const {
    sheetImageUrl = `http://localhost:3001/api/test/image?w=512&h=512&label=character`,
    sheetStatus = 'completed',
  } = options;

  await db.insert(characters).values({
    id,
    sequenceId,
    characterId,
    name,
    talentId,
    age: '30s',
    sheetStatus,
    createdAt: now,
    updatedAt: now,
  });

  // The live sheet is read from the version row, not the mirror (#1419).
  // Keyed to the character's own id — the shape the backfill produced and the
  // one `applyConvergent` snapshots a pre-versioning image under.
  if (sheetImageUrl) {
    await db.insert(characterSheetVariants).values({
      id,
      characterId: id,
      model: 'prior',
      url: sheetImageUrl,
      status: 'completed',
      generatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  return { id, sequenceId, characterId, name };
}

/**
 * Clean up all sequences and styles for a team.
 */
export async function cleanupTestSequences(teamId: string): Promise<void> {
  const db = getDb();
  await db.delete(sequences).where(eq(sequences.teamId, teamId));
  await db.delete(styles).where(eq(styles.teamId, teamId));
}

/**
 * Clean up a specific sequence and its style.
 */
export async function cleanupSequenceById(
  sequenceId: string,
  styleId: string
): Promise<void> {
  const db = getDb();
  await db.delete(sequences).where(eq(sequences.id, sequenceId));
  await db.delete(styles).where(eq(styles.id, styleId));
}

/**
 * Clean up test talent (and cascaded sheets/media) for a team.
 */
export async function cleanupTestTalent(teamId: string): Promise<void> {
  const db = getDb();
  await db.delete(talent).where(eq(talent.teamId, teamId));
}

/**
 * Clean up a specific talent by ID (cascades to sheets/media).
 */
export async function cleanupTalentById(talentId: string): Promise<void> {
  const db = getDb();
  await db.delete(talent).where(eq(talent.id, talentId));
}

/**
 * Find and clean up talent by team + name (for UI-created test entities).
 *
 * Specs share one team, so a by-name cleanup must never widen to the whole
 * team: doing so deletes talent that other parallel workers created mid-test
 * and their list assertions then fail on missing rows (#827).
 */
export async function cleanupTalentByName(
  teamId: string,
  name: string
): Promise<void> {
  const db = getDb();
  const [created] = await db
    .select({ id: talent.id })
    .from(talent)
    .where(and(eq(talent.teamId, teamId), eq(talent.name, name)));
  if (created) {
    await db.delete(talent).where(eq(talent.id, created.id));
  }
}

/**
 * Clean up test locations for a team (cascades to sheets).
 */
export async function cleanupTestLocations(teamId: string): Promise<void> {
  const db = getDb();
  await db.delete(locationLibrary).where(eq(locationLibrary.teamId, teamId));
}

/**
 * Clean up a specific location by ID.
 */
export async function cleanupLocationById(locationId: string): Promise<void> {
  const db = getDb();
  await db.delete(locationLibrary).where(eq(locationLibrary.id, locationId));
}

/**
 * Find and clean up a location by team + name (for UI-created test entities).
 */
export async function cleanupLocationByName(
  teamId: string,
  name: string
): Promise<void> {
  const db = getDb();
  const [created] = await db
    .select({ id: locationLibrary.id })
    .from(locationLibrary)
    .where(
      and(eq(locationLibrary.teamId, teamId), eq(locationLibrary.name, name))
    );
  if (created) {
    await db.delete(locationLibrary).where(eq(locationLibrary.id, created.id));
  }
}

/**
 * Look up a seeded system location by name (isPublic).
 */
export async function getSystemLocationByName(name: string): Promise<{
  id: string;
  name: string;
  teamId: string;
  referenceImageUrl: string;
}> {
  const db = getDb();
  const rows = await db
    .select()
    .from(locationLibrary)
    .where(
      and(eq(locationLibrary.name, name), eq(locationLibrary.isPublic, true))
    )
    .limit(1);
  if (rows.length === 0) {
    throw new Error(
      `System location "${name}" not found in test DB — was \`bun scripts/seed.ts --test\` run during global setup?`
    );
  }
  const found = rows[0];
  if (!found) {
    throw new Error('test setup: expected location row');
  }
  return {
    id: found.id,
    name: found.name,
    teamId: found.teamId,
    referenceImageUrl: found.referenceImageUrl ?? '',
  };
}

/**
 * Look up a seeded system talent by name (isPublic + default sheet).
 */
export async function getSystemTalentByName(name: string): Promise<{
  id: string;
  name: string;
  teamId: string;
  sheetId: string;
}> {
  const db = getDb();
  const rows = await db
    .select()
    .from(talent)
    .where(and(eq(talent.name, name), eq(talent.isPublic, true)))
    .limit(1);
  const found = rows[0];
  if (!found) {
    throw new Error(
      `System talent "${name}" not found in test DB — was \`bun scripts/seed.ts --test\` run during global setup?`
    );
  }
  const sheets = await db
    .select()
    .from(talentSheets)
    .where(
      and(eq(talentSheets.talentId, found.id), eq(talentSheets.isDefault, true))
    )
    .limit(1);
  const defaultSheet = sheets[0];
  if (!defaultSheet) {
    throw new Error(
      `System talent "${name}" has no default sheet — re-run seed`
    );
  }
  return {
    id: found.id,
    name: found.name,
    teamId: found.teamId,
    sheetId: defaultSheet.id,
  };
}

/**
 * Get all shots for a sequence (for polling workflow progress).
 */
export async function getTestSequenceShots(sequenceId: string): Promise<
  Array<{
    id: string;
    orderIndex: number;
    shotNumber: number;
    thumbnailUrl: string | null;
    thumbnailStatus: string | null;
    videoUrl: string | null;
    videoStatus: string | null;
  }>
> {
  const db = getDb();
  // Shot order is hierarchical now (#1067): (scenes.orderIndex,
  // shots.shotNumber). The reported orderIndex is the owning scene's.
  const rows = await db
    .select({
      id: shots.id,
      sceneOrderIndex: scenes.orderIndex,
      shotNumber: shots.shotNumber,
    })
    .from(shots)
    .leftJoin(scenes, eq(scenes.id, shots.sceneId))
    .where(eq(shots.sequenceId, sequenceId));
  // The video lives on the version the shot's render segment points at (#1067
  // phase 2d); project it back under the legacy videoUrl name.
  const videoRows = await db
    .select({ shotId: shots.id, videoUrl: videoVariants.url })
    .from(shots)
    .innerJoin(renderSegments, eq(renderSegments.id, shots.renderSegmentId))
    .innerJoin(
      videoVariants,
      eq(videoVariants.id, renderSegments.selectedVideoVersionId)
    )
    .where(eq(shots.sequenceId, sequenceId));
  const videoByShot = new Map(videoRows.map((v) => [v.shotId, v.videoUrl]));
  const primaryRows = await db
    .select({ shotId: shots.id, status: videoVariants.status })
    .from(shots)
    .innerJoin(
      videoVariants,
      eq(videoVariants.renderSegmentId, shots.renderSegmentId)
    )
    .where(
      and(eq(shots.sequenceId, sequenceId), eq(videoVariants.isPrimary, true))
    )
    .orderBy(asc(videoVariants.id));
  const statusByShot = new Map(primaryRows.map((v) => [v.shotId, v.status]));
  // The still-image surface lives on each shot's anchor frame now (#989);
  // project it back under the legacy thumbnail* names — keyed by shotId
  // (orderIndex 0), never by id-reuse.
  const frameRows = await db
    .select({
      shotId: frames.shotId,
      imageUrl: frameVariants.url,
      imageStatus: frames.imageStatus,
    })
    .from(frames)
    .leftJoin(
      frameVariants,
      eq(frameVariants.id, frames.selectedImageVersionId)
    )
    .where(and(eq(frames.sequenceId, sequenceId), eq(frames.orderIndex, 0)));
  const framesByShot = new Map(frameRows.map((f) => [f.shotId, f]));
  return rows
    .map((row) => {
      const frame = framesByShot.get(row.id);
      return {
        id: row.id,
        orderIndex: row.sceneOrderIndex ?? 0,
        shotNumber: row.shotNumber ?? 0,
        thumbnailUrl: frame?.imageUrl ?? null,
        thumbnailStatus: frame?.imageStatus ?? null,
        videoUrl: videoByShot.get(row.id) ?? null,
        videoStatus: statusByShot.get(row.id) ?? null,
      };
    })
    .sort((a, b) => a.orderIndex - b.orderIndex || a.shotNumber - b.shotNumber);
}

/**
 * Get a shot by ID (for verify/poll assertions).
 */
export async function getTestShot(shotId: string): Promise<{
  id: string;
  thumbnailUrl: string | null;
  variantImageStatus: string | null;
} | null> {
  const db = getDb();
  // The still image lives on the shot's anchor frame now (#989), resolved by
  // (shotId, orderIndex 0) — never by id-reuse; the variant grid sheet is the
  // latest kind:'framing' frame_variants version on that frame.
  const [frame] = await db
    .select({ id: frames.id, imageUrl: frameVariants.url })
    .from(frames)
    .leftJoin(
      frameVariants,
      eq(frameVariants.id, frames.selectedImageVersionId)
    )
    .where(and(eq(frames.shotId, shotId), eq(frames.orderIndex, 0)));

  if (!frame) return null;

  const [gridSheet] = await db
    .select({ status: frameVariants.status })
    .from(frameVariants)
    .where(
      and(
        eq(frameVariants.frameId, frame.id),
        eq(frameVariants.kind, 'framing'),
        isNull(frameVariants.sourceVariantId)
      )
    )
    .orderBy(desc(frameVariants.id))
    .limit(1);

  return {
    id: shotId,
    thumbnailUrl: frame.imageUrl,
    variantImageStatus: gridSheet?.status ?? null,
  };
}

/**
 * Get a character by ID (for verify/poll assertions).
 */
export async function getTestCharacter(characterId: string): Promise<{
  id: string;
  name: string;
  talentId: string | null;
  sheetStatus: string | null;
} | null> {
  const db = getDb();
  const result = await db.query.characters.findFirst({
    where: { id: characterId },
    columns: {
      id: true,
      name: true,
      talentId: true,
      sheetStatus: true,
    },
  });

  if (!result) return null;

  return {
    id: result.id,
    name: result.name,
    talentId: result.talentId,
    sheetStatus: result.sheetStatus,
  };
}

/**
 * Get sequence-level music status.
 */
export async function getTestSequenceStatus(sequenceId: string): Promise<{
  musicStatus: string | null;
  musicUrl: string | null;
} | null> {
  const db = getDb();
  const row = await db.query.sequences.findFirst({
    where: { id: sequenceId },
    columns: {
      musicStatus: true,
      musicUrl: true,
    },
  });
  return row ?? null;
}
