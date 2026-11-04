/**
 * Location Fixture for E2E Tests
 * Creates organization locations (#1695) for the Locations page and the pipeline.
 */

import { z } from 'zod';

export type TestLocation = {
  id: string;
  name: string;
  organizationId: string;
  referenceImageUrl: string;
};

const createdSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  referenceImageUrl: z.string(),
});

async function postLocation(body: Record<string, string>) {
  const res = await fetch('http://localhost:3020/api/test/location', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Failed to create test location via API: ${res.status}`);
  }
  return createdSchema.parse(await res.json());
}

/** An organization location with a placeholder sheet. */
export async function createTestLocation(
  organizationId: string,
  name: string
): Promise<TestLocation> {
  return await postLocation({ organizationId, name });
}

/**
 * The organization location the full-pipeline run picks: named and described like
 * the "Sunlit Loft Studio" the location-match fixture was recorded against,
 * with a real R2 sheet the workflows can read.
 */
export async function createSunlitLoftLocation(
  organizationId: string
): Promise<TestLocation> {
  return await postLocation({ organizationId, preset: 'sunlit-loft' });
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
