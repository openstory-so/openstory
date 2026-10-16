/**
 * Locations E2E Tests
 * The team's locations (#1695): the list, making one with no sequence, and
 * its page.
 */

import { test, expect } from 'playwright/test';
import { test as testWithUser } from '../fixtures/auth.fixture';
import { setupMockRoutes } from '../mocks/handlers';
import {
  createTestLocation,
  cleanupLocationById,
  type TestLocation,
} from '../fixtures/location.fixture';
import {
  waitForLibraryPageLoad,
  cleanupLocationByName,
  openLibraryCard,
  returnToLibraryList,
  LOCATION_DETAIL_URL,
} from '../fixtures/test-utils';

function waitForLocationsPageLoad(page: import('playwright/test').Page) {
  return waitForLibraryPageLoad(page, 'New location');
}

test.describe('Locations, signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('asks to sign in', async ({ page }) => {
    await page.goto('/locations');

    await expect(
      page.getByRole('heading', { name: 'Locations', exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Sign in to see your locations' })
    ).toBeVisible({ timeout: 30000 });
    await expect(
      page.getByRole('button', { name: 'New location' })
    ).toHaveCount(0);
  });
});

// Tests create locations via UI - use unique names to avoid collisions in parallel
testWithUser.describe('New location', () => {
  testWithUser.beforeEach(async ({ page }) => {
    await setupMockRoutes(page);
  });

  testWithUser('opens the New location dialog', async ({ page }) => {
    await page.goto('/locations');
    await waitForLocationsPageLoad(page);

    await page.getByRole('button', { name: 'New location' }).click();

    const dialog = page.getByRole('dialog', { name: 'New location' });
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(dialog.getByLabel('Name')).toBeVisible();
    await expect(dialog.getByLabel('Description (optional)')).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Browse files' })
    ).toBeVisible();
  });

  testWithUser(
    'makes a location with no photos and opens its page',
    async ({ page, testUser }) => {
      const uniqueName = `E2E Test Location ${crypto.randomUUID().slice(0, 8)}`;

      await page.goto('/locations');
      await waitForLocationsPageLoad(page);
      await page.getByRole('button', { name: 'New location' }).click();

      const dialog = page.getByRole('dialog', { name: 'New location' });
      await dialog.getByLabel('Name').fill(uniqueName);
      await dialog
        .getByLabel('Description (optional)')
        .fill('Test description for E2E');
      await dialog.getByRole('button', { name: 'Create' }).click();

      await expect(dialog).not.toBeVisible({ timeout: 10000 });
      await expect(page).toHaveURL(LOCATION_DETAIL_URL, { timeout: 30000 });
      await expect(page.getByRole('heading', { name: uniqueName })).toBeVisible(
        { timeout: 10000 }
      );

      await cleanupLocationByName(testUser.teamId, uniqueName);
    }
  );
});

// Each test creates its own data with unique names for parallel execution
testWithUser.describe('Location page', () => {
  let testLocation: TestLocation;

  testWithUser.beforeEach(async ({ page, testUser }) => {
    await setupMockRoutes(page);
    testLocation = await createTestLocation(
      testUser.teamId,
      `E2E Edit Test Location ${crypto.randomUUID().slice(0, 8)}`
    );
  });

  testWithUser.afterEach(async () => {
    await cleanupLocationById(testLocation.id);
  });

  testWithUser(
    'shows the bible, the sheet actions and the photos',
    async ({ page }) => {
      await page.goto('/locations');
      await waitForLocationsPageLoad(page);

      await openLibraryCard(page, testLocation.name, LOCATION_DETAIL_URL);

      await expect(
        page.getByRole('heading', { name: testLocation.name })
      ).toBeVisible();
      // The form waits on the location's own read, after the header's.
      await expect(page.getByLabel('Name')).toHaveValue(testLocation.name, {
        timeout: 30000,
      });
      await expect(page.getByLabel('Rendered as')).toBeVisible();
      await expect(
        page.getByRole('region', { name: 'Reference photos' })
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Add photos' })
      ).toBeVisible();
      // Nothing of a sequence's from no sequence.
      await expect(page.getByRole('button', { name: 'Replace' })).toHaveCount(
        0
      );
      await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0);
    }
  );

  testWithUser('deletes an unused location', async ({ page }) => {
    await page.goto(`/locations/${testLocation.id}`);

    await page.getByRole('button', { name: 'Delete' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete' })
      .click();

    await expect(page).toHaveURL(/\/locations(\?|$)/, { timeout: 30000 });
    await expect(page.getByText(`Deleted ${testLocation.name}`)).toBeVisible();
    await expect(
      page.getByRole('heading', { name: testLocation.name })
    ).toHaveCount(0);
  });
});

// Each test creates its own data with unique names for parallel execution
testWithUser.describe('Locations list', () => {
  let testLocationAlpha: TestLocation;
  let testLocationBeta: TestLocation;

  testWithUser.beforeEach(async ({ page, testUser }) => {
    await setupMockRoutes(page);
    const suffix = crypto.randomUUID().slice(0, 8);
    testLocationAlpha = await createTestLocation(
      testUser.teamId,
      `E2E Location Alpha ${suffix}`
    );
    testLocationBeta = await createTestLocation(
      testUser.teamId,
      `E2E Location Beta ${suffix}`
    );
  });

  testWithUser.afterEach(async () => {
    await cleanupLocationById(testLocationAlpha.id);
    await cleanupLocationById(testLocationBeta.id);
  });

  testWithUser('displays multiple locations in grid', async ({ page }) => {
    await page.goto('/locations');
    await waitForLocationsPageLoad(page);

    await expect(
      page.getByRole('heading', { name: testLocationAlpha.name })
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByRole('heading', { name: testLocationBeta.name })
    ).toBeVisible({ timeout: 10000 });
  });

  testWithUser(
    'can navigate between location detail pages',
    async ({ page }) => {
      await page.goto('/locations');
      await waitForLocationsPageLoad(page);

      await openLibraryCard(page, testLocationAlpha.name, LOCATION_DETAIL_URL);
      await expect(
        page.getByRole('heading', { name: testLocationAlpha.name })
      ).toBeVisible();

      await returnToLibraryList(page, 'Back to Locations', /\/locations(\?|$)/);

      await openLibraryCard(page, testLocationBeta.name, LOCATION_DETAIL_URL);
      await expect(
        page.getByRole('heading', { name: testLocationBeta.name })
      ).toBeVisible();
    }
  );
});
