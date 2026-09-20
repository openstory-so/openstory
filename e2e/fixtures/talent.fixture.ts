/**
 * Talent Fixture for E2E Tests
 * Creates test talent with sheets for testing talent selection flows
 */

import { z } from 'zod';

export type TestTalent = {
  id: string;
  name: string;
  teamId: string;
  sheetId: string;
};

export type TestTalentWithMedia = TestTalent & {
  mediaIds: string[];
};

/**
 * Create test talent with a default sheet
 */
export async function createTestTalent(
  teamId: string,
  name: string
): Promise<TestTalent> {
  // Create via guarded test API (writes happen inside the single safe Miniflare)
  const res = await fetch('http://localhost:3020/api/test/talent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, name }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create test talent via API: ${res.status}`);
  }

  const created = z
    .object({
      id: z.string(),
      name: z.string(),
      teamId: z.string(),
      defaultSheetId: z.string(),
    })
    .parse(await res.json());

  return {
    id: created.id,
    name: created.name,
    teamId: created.teamId,
    sheetId: created.defaultSheetId,
  };
}

/**
 * Create multiple test talents for a team
 */
export async function createTestTalentSet(
  teamId: string,
  names: string[]
): Promise<TestTalent[]> {
  const talents: TestTalent[] = [];
  for (const name of names) {
    const talentRecord = await createTestTalent(teamId, name);
    talents.push(talentRecord);
  }
  return talents;
}

/**
 * Create test talent with reference media
 */
export async function createTestTalentWithMedia(
  teamId: string,
  name: string,
  mediaCount = 2
): Promise<TestTalentWithMedia> {
  const res = await fetch('http://localhost:3020/api/test/talent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, name, mediaCount }),
  });

  if (!res.ok) {
    throw new Error(
      `Failed to create test talent with media via API: ${res.status}`
    );
  }

  const created = z
    .object({
      id: z.string(),
      name: z.string(),
      teamId: z.string(),
      sheetId: z.string(),
      mediaIds: z.array(z.string()),
    })
    .parse(await res.json());

  return created;
}

/**
 * Clean up test talent by team ID (use only when test isolation isn't needed)
 */
export async function cleanupTestTalent(teamId: string): Promise<void> {
  await fetch('http://localhost:3020/api/test/talent', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId }),
  });
}

/**
 * Clean up a specific talent by ID (use for parallel test isolation)
 */
export async function cleanupTalentById(talentId: string): Promise<void> {
  await fetch('http://localhost:3020/api/test/talent', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ talentId }),
  });
}

/**
 * Look up a seeded system talent by name. System talents are inserted by
 * `scripts/seed.ts --test` during global setup; they have real R2 reference
 * images, so workflows can actually use them for character matching and
 * sheet rendering. Tests should use these instead of fabricating talent
 * with placeholder URLs.
 */
export async function getSystemTalentByName(name: string): Promise<TestTalent> {
  const res = await fetch(
    `http://localhost:3020/api/test/talent?name=${encodeURIComponent(name)}`
  );
  if (!res.ok) {
    throw new Error(
      `System talent "${name}" not found via test API — was \`bun scripts/seed.ts --test\` run during global setup?`
    );
  }
  const t = z
    .object({
      id: z.string(),
      name: z.string(),
      teamId: z.string(),
      sheetId: z.string(),
    })
    .parse(await res.json());
  return t;
}
