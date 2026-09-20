/**
 * Sequence Fixture for E2E Tests
 * Creates pre-seeded sequences with shots and characters for testing
 */

import { z } from 'zod';

export type TestSequence = {
  id: string;
  teamId: string;
  styleId: string;
  title: string;
};

export type TestShot = {
  id: string;
  sequenceId: string;
  orderIndex: number;
};

export type TestCharacter = {
  id: string;
  sequenceId: string;
  characterId: string;
  name: string;
};

/**
 * Create a test style for the team (required by sequence)
 */
export async function createTestStyle(teamId: string): Promise<string> {
  const res = await fetch('http://localhost:3020/api/test/style', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create test style via API: ${res.status}`);
  }

  const created = z.object({ id: z.string() }).parse(await res.json());
  return created.id;
}

/**
 * Create a test sequence with a style
 */
export async function createTestSequence(
  teamId: string,
  userId: string,
  title = 'E2E Test Sequence'
): Promise<TestSequence> {
  // No style is created here on purpose: the API route already creates the
  // sequence's own style, and `cleanupSequenceById` only deletes that one — so
  // a second style here leaked an orphan row onto the shared team on every
  // call, permanently widening the team's style catalog mid-run.
  const res = await fetch('http://localhost:3020/api/test/sequence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, userId, title }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create test sequence via API: ${res.status}`);
  }

  const created = z
    .object({
      id: z.string(),
      teamId: z.string(),
      styleId: z.string(),
      title: z.string(),
    })
    .parse(await res.json());
  return created;
}

/**
 * Create a test shot with a thumbnail (for variant testing)
 */
export async function createTestShot(
  sequenceId: string,
  orderIndex: number,
  options: {
    thumbnailUrl?: string;
    variantImageUrl?: string;
    variantImageStatus?: 'pending' | 'generating' | 'completed' | 'failed';
  } = {}
): Promise<TestShot> {
  const res = await fetch('http://localhost:3020/api/test/shot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sequenceId, orderIndex, ...options }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create test shot via API: ${res.status}`);
  }

  const created = z
    .object({ id: z.string(), sequenceId: z.string(), orderIndex: z.number() })
    .parse(await res.json());
  return created;
}

/**
 * Create a test character for a sequence (for recast testing)
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
): Promise<TestCharacter> {
  const res = await fetch('http://localhost:3020/api/test/character', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sequenceId,
      characterId,
      name,
      talentId,
      ...options,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create test character via API: ${res.status}`);
  }

  const created = z
    .object({
      id: z.string(),
      sequenceId: z.string(),
      characterId: z.string(),
      name: z.string(),
    })
    .parse(await res.json());
  return created;
}

/**
 * Get all shots for a sequence, hierarchically ordered by
 * (scene orderIndex, shotNumber) — #1067.
 * Used by the full-sequence spec to poll until every shot has its
 * thumbnail/video/music URLs set during the e2e workflow run.
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
  const res = await fetch(
    `http://localhost:3020/api/test/shot?sequenceId=${encodeURIComponent(sequenceId)}`
  );
  if (!res.ok) {
    throw new Error(
      `Failed to get shots for sequence ${sequenceId}: ${res.status}`
    );
  }
  return z
    .array(
      z.object({
        id: z.string(),
        orderIndex: z.number(),
        shotNumber: z.number(),
        thumbnailUrl: z.string().nullable(),
        thumbnailStatus: z.string().nullable(),
        videoUrl: z.string().nullable(),
        videoStatus: z.string().nullable(),
      })
    )
    .parse(await res.json());
}

/**
 * Get a shot by ID to verify test assertions
 */
export async function getTestShot(shotId: string): Promise<{
  id: string;
  thumbnailUrl: string | null;
  variantImageStatus: string | null;
} | null> {
  const res = await fetch(
    `http://localhost:3020/api/test/shot?id=${encodeURIComponent(shotId)}`
  );
  if (!res.ok) return null;
  return z
    .object({
      id: z.string(),
      thumbnailUrl: z.string().nullable(),
      variantImageStatus: z.string().nullable(),
    })
    .parse(await res.json());
}

/**
 * Get a character by ID to verify test assertions
 */
export async function getTestCharacter(characterId: string): Promise<{
  id: string;
  name: string;
  talentId: string | null;
  sheetStatus: string | null;
} | null> {
  const res = await fetch(
    `http://localhost:3020/api/test/character?id=${encodeURIComponent(characterId)}`
  );
  if (!res.ok) return null;
  return z
    .object({
      id: z.string(),
      name: z.string(),
      talentId: z.string().nullable(),
      sheetStatus: z.string().nullable(),
    })
    .parse(await res.json());
}

/**
 * Get sequence-level music status. Music is generated once per sequence
 * (not per shot — see src/audio/server/workflows/music-workflow.ts:133 TODO).
 * Per-shot video completion is checked via getTestSequenceShots; final
 * composition is now client-side via Mediabunny, so no merged-video row
 * is written.
 */
export async function getTestSequenceStatus(sequenceId: string): Promise<{
  musicStatus: string | null;
  musicUrl: string | null;
} | null> {
  const res = await fetch(
    `http://localhost:3020/api/test/sequence?sequenceId=${encodeURIComponent(sequenceId)}`
  );
  if (!res.ok) return null;
  return z
    .object({
      musicStatus: z.string().nullable(),
      musicUrl: z.string().nullable(),
    })
    .nullable()
    .parse(await res.json());
}

/**
 * Clean up all test sequences and related data for a team (use only when test isolation isn't needed)
 */
export async function cleanupTestSequences(teamId: string): Promise<void> {
  await fetch('http://localhost:3020/api/test/sequence', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId }),
  });
}

/**
 * Clean up a specific sequence and its style by ID (use for parallel test isolation)
 */
export async function cleanupSequenceById(
  sequenceId: string,
  styleId: string
): Promise<void> {
  await fetch('http://localhost:3020/api/test/sequence', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sequenceId, styleId }),
  });
}
