/**
 * Location Fixture for E2E Tests
 * Creates test library locations for testing location library flows
 */

import { z } from 'zod';

export type TestLibraryLocation = {
  id: string;
  name: string;
  teamId: string;
  referenceImageUrl: string;
};

/**
 * Create test library location with reference image
 */
export async function createTestLibraryLocation(
  teamId: string,
  name: string
): Promise<TestLibraryLocation> {
  const res = await fetch('http://localhost:3020/api/test/location', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, name }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create test location via API: ${res.status}`);
  }

  const created = z
    .object({
      id: z.string(),
      teamId: z.string(),
      name: z.string(),
    })
    .parse(await res.json());

  return {
    ...created,
    referenceImageUrl: `http://localhost:3020/api/test/image?w=1024&h=576&label=location`,
  };
}

/**
 * Create multiple test library locations for a team
 */
export async function createTestLibraryLocationSet(
  teamId: string,
  names: string[]
): Promise<TestLibraryLocation[]> {
  const locations: TestLibraryLocation[] = [];
  for (const name of names) {
    const location = await createTestLibraryLocation(teamId, name);
    locations.push(location);
  }
  return locations;
}

/**
 * Clean up test library locations by team ID (use only when test isolation isn't needed)
 */
export async function cleanupTestLocations(teamId: string): Promise<void> {
  await fetch('http://localhost:3020/api/test/location', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId }),
  });
}

/**
 * Clean up a specific location by ID (use for parallel test isolation)
 */
export async function cleanupLocationById(locationId: string): Promise<void> {
  await fetch('http://localhost:3020/api/test/location', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locationId }),
  });
}

/**
 * Look up a seeded system location by name. System locations are inserted by
 * `scripts/seed.ts --test` during global setup; they have real R2 reference
 * images so workflows can use them for location matching and sheet rendering.
 * Tests should prefer these over fabricated locations with placeholder URLs.
 */
export async function getSystemLocationByName(
  name: string
): Promise<TestLibraryLocation> {
  const res = await fetch(
    `http://localhost:3020/api/test/location?name=${encodeURIComponent(name)}`
  );
  if (!res.ok) {
    throw new Error(
      `System location "${name}" not found via test API — was \`bun scripts/seed.ts --test\` run during global setup?`
    );
  }
  const loc = z
    .object({
      id: z.string(),
      name: z.string(),
      teamId: z.string(),
      referenceImageUrl: z.string(),
    })
    .parse(await res.json());
  return loc;
}
