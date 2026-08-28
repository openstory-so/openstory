/**
 * Auth Fixture for E2E Tests
 *
 * Two modes:
 * 1. Stored auth (default): Uses pre-authenticated session from auth.setup.ts
 *    - Tests use `page` directly (already authenticated via storageState)
 *    - `testUser` reads stored user info from disk
 *
 * 2. Per-test auth (auth.spec.ts only): Creates new user for each test
 *    - Uses `authenticatedPage` fixture for fresh authentication
 */

import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect, type Page } from 'playwright/test';
import { z } from 'zod';

const TestUserResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  teamId: z.string(),
});

type TestUser = {
  id: string;
  email: string;
  name: string;
  teamId: string;
};

const userInfoFile = path.join(import.meta.dirname, '../.auth/user-info.json');

/**
 * Read stored user info from auth.setup.ts
 * Used by tests running with storageState
 */
function getStoredUserInfo(): TestUser {
  if (!fs.existsSync(userInfoFile)) {
    throw new Error(
      'Stored user info not found. Run auth.setup.ts first or use authenticatedPage fixture.'
    );
  }
  return JSON.parse(fs.readFileSync(userInfoFile, 'utf-8'));
}

/**
 * Create a test user with team directly in the database
 */
export async function createTestUser(
  options: { name?: string } = {}
): Promise<TestUser> {
  const { name = 'E2E Test User' } = options;

  // Create via the guarded test API so all writes go through the single
  // safe Miniflare process (instead of direct getPlatformProxy from this worker).
  const res = await fetch('http://localhost:3001/api/test/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create test user via API: ${res.status}`);
  }

  const created = TestUserResponseSchema.parse(await res.json());
  return created;
}

/**
 * Clean up test user and related data
 */
async function cleanupTestUser(userId: string, teamId: string): Promise<void> {
  // Cleanup via test API so the write happens inside the safe Worker Miniflare
  await fetch('http://localhost:3001/api/test/user', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, teamId }),
  });
}

/**
 * Authenticate a user by navigating directly to /verify and entering OTP.
 *
 * This uses the test-only /api/test/verify backdoor, which automatically
 * formats the record as `sign-in-otp-${email}` with the `:0` suffix that
 * Better Auth's emailOTP plugin expects.
 */
export async function authenticateUser(
  page: Page,
  email: string
): Promise<void> {
  const testOtp = '123456';

  // Welcome-credits dialog (#1096) re-shows every 3h until the team has a
  // credit_usage row. Fresh e2e users have none — pre-seed a recent dismiss
  // so the modal never overlays the UI under test. storageState carries it
  // into specs that reuse the shared session.
  await page.addInitScript(() => {
    localStorage.setItem(
      'openstory:welcome-credits-dismissed-at',
      String(Date.now())
    );
  });

  // Create OTP via test API (the route normalizes to the identifier
  // Better Auth's signIn.emailOtp will actually look up).
  await fetch('http://localhost:3001/api/test/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, otp: testOtp }),
  });

  // Navigate directly to verify page with email
  await page.goto(`/verify?email=${encodeURIComponent(email)}`);

  // Wait for the OTP input to be ready and type the code
  const otpInput = page.locator('input[data-input-otp="true"]');
  await otpInput.waitFor({ timeout: 30_000 });
  await expect(otpInput).toBeEnabled({ timeout: 30_000 });
  await otpInput.click();
  await otpInput.pressSequentially(testOtp, { delay: 50 });

  // Wait for auto-verify to trigger and redirect
  await page.waitForTimeout(500);
  await page.waitForURL(
    (url) =>
      !url.pathname.includes('/login') && !url.pathname.includes('/verify'),
    { timeout: 30_000 }
  );
}

// Extended test with stored auth fixtures
// For tests using storageState (most tests):
// - `testUser` reads stored user info from disk
// - `page` is already authenticated via storageState config
export const test = base.extend<{
  testUser: TestUser;
  authenticatedPage: Page;
}>({
  // Default: read stored user info (for tests with storageState)
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture syntax requires empty object destructuring
  testUser: async ({}, use) => {
    const storedUser = getStoredUserInfo();
    await use(storedUser);
    // No cleanup needed - shared user persists across tests
  },

  // For auth.spec.ts: creates fresh user and authenticates per-test
  authenticatedPage: async ({ page }, use) => {
    const freshUser = await createTestUser();
    await authenticateUser(page, freshUser.email);
    await use(page);
    await cleanupTestUser(freshUser.id, freshUser.teamId);
  },
});

export { expect } from 'playwright/test';
