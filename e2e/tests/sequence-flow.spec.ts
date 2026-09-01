/**
 * Sequence Creation Flow E2E Tests
 *
 * Tests the complete flow:
 * 1. Create sequence with suggested talent
 * 2. Generate and select variants
 * 3. Recast character with different talent
 */

import { expect } from 'playwright/test';
import { test as testWithUser } from '../fixtures/auth.fixture';
import { setupMockRoutes } from '../mocks/handlers';
import { fillScriptEditor } from '../fixtures/test-utils';
import {
  createTestTalentSet,
  cleanupTalentById,
  type TestTalent,
} from '../fixtures/talent.fixture';
import {
  createTestSequence,
  createTestShot,
  createTestCharacter,
  cleanupSequenceById,
  getTestShot,
  getTestCharacter,
  type TestSequence,
  type TestShot,
  type TestCharacter,
} from '../fixtures/sequence.fixture';

// Each test creates its own data with unique names for parallel execution
testWithUser.describe('Sequence Creation Flow', () => {
  let testTalents: TestTalent[] = [];

  testWithUser.beforeEach(async ({ page, testUser }) => {
    // Setup mock routes for AI/workflow calls
    await setupMockRoutes(page);

    // Create test talent for the test user's team with unique names
    const suffix = crypto.randomUUID().slice(0, 8);
    testTalents = await createTestTalentSet(testUser.teamId, [
      `E2E Test Actor One ${suffix}`,
      `E2E Test Actor Two ${suffix}`,
    ]);
  });

  testWithUser.afterEach(async () => {
    // Cleanup test data - only the specific talents we created
    for (const t of testTalents) {
      await cleanupTalentById(t.id);
    }
    testTalents = [];
  });

  testWithUser(
    'can create sequence with suggested talent',
    async ({ page }) => {
      // Navigate to new sequence page
      await page.goto('/sequences/new');

      // Wait for React hydration + data loading by checking the style grid is populated
      // The style grid requires useStyles() query data, which only loads after hydration
      await expect(
        page.getByRole('grid', { name: 'Style selection' })
      ).toBeVisible({ timeout: 15000 });

      await expect(page).toHaveURL('/sequences/new');

      // Enter a simple test script
      const testScript = `
INT. COFFEE SHOP - DAY

JOHN, a 30-something developer, sits at a table with his laptop.

JOHN
I need to fix this bug before the demo.

SARAH, his colleague, approaches with two coffees.

SARAH
Here's your caffeine fix. How's it going?
    `.trim();

      // Click a style to force React interaction and confirm hydration
      // The style grid may be SSR-rendered before React hydrates. Target style
      // tiles by aria-label so the trailing "View all" tile is never picked.
      const firstStyle = page
        .getByRole('grid', { name: 'Style selection' })
        .getByRole('button', { name: /^Select .+ style$/ })
        .first();
      await firstStyle.click();

      // Now fill the editor - React is hydrated since style click worked
      await fillScriptEditor(page, testScript);

      // Wait for "Generate" button to become enabled - this proves:
      // 1. React hydration is complete (event handlers attached)
      // 2. Textarea fill was picked up by React state (script is set)
      // 3. Style was selected (from our click above)
      await expect(page.getByRole('button', { name: /Generate/i })).toBeEnabled(
        { timeout: 10000 }
      );

      // Open talent suggestion dialog
      const talentButton = page
        .locator('main')
        .getByRole('button', { name: 'Talent' });
      await talentButton.click();

      // Wait for talent dialog to open - the dialog is rendered via a portal
      // Use a longer timeout as it may need to fetch talent data
      const talentDialog = page.getByRole('dialog');
      await expect(talentDialog).toBeVisible({ timeout: 10000 });
      await expect(
        talentDialog.getByText('Select Talent for Casting')
      ).toBeVisible();

      // Verify our test talents appear in the dialog (use variable names)
      const firstTalent = testTalents[0];
      const secondTalent = testTalents[1];
      if (!firstTalent || !secondTalent) {
        throw new Error('test setup: expected two test talents');
      }
      await expect(page.getByText(firstTalent.name)).toBeVisible();
      await expect(page.getByText(secondTalent.name)).toBeVisible();

      // Select first talent by clicking on it
      await page.getByText(firstTalent.name).click();

      // Submit dialog (button text reflects selection count)
      await talentDialog
        .getByRole('button', { name: /^Cast \d+ roles?$/i })
        .click();
      await expect(talentDialog).not.toBeVisible();

      // Verify submit button is ready (may have different text based on state)
      const submitButton = page.getByRole('button', {
        name: /Generate/i,
      });
      await expect(submitButton).toBeVisible();
    }
  );
});

// Each test creates its own data with unique names for parallel execution
testWithUser.describe('Variant Selection', () => {
  let testSequence: TestSequence;
  let testShot: TestShot;
  const originalThumbnailUrl =
    'http://localhost:3001/api/test/image?w=1024&h=576&label=thumb';

  testWithUser.beforeEach(async ({ page, testUser }) => {
    await setupMockRoutes(page);

    // Create pre-seeded sequence with shot that has variant image (unique name)
    testSequence = await createTestSequence(
      testUser.teamId,
      testUser.id,
      `E2E Variant Test Sequence ${crypto.randomUUID().slice(0, 8)}`
    );
    testShot = await createTestShot(testSequence.id, 0, {
      // Use real placeholder images
      thumbnailUrl: originalThumbnailUrl,
      variantImageUrl:
        'http://localhost:3001/api/test/image?w=3072&h=3072&label=variants',
      variantImageStatus: 'completed',
    });
  });

  testWithUser.afterEach(async () => {
    await cleanupSequenceById(testSequence.id, testSequence.styleId);
  });

  testWithUser('can select variant from grid', async ({ page }) => {
    // Verify initial state in database
    const shotBefore = await getTestShot(testShot.id);
    expect(shotBefore?.thumbnailUrl).toBe(originalThumbnailUrl);

    // Navigate directly to the sequence scenes page
    await page.goto(`/sequences/${testSequence.id}/scenes`);

    // Don't use networkidle - the page has a realtime SSE connection that never settles
    // Wait for the sequence title to be visible (indicates data has loaded and React is hydrated)
    await expect(
      page.getByRole('heading', { name: testSequence.title })
    ).toBeVisible({ timeout: 15000 });

    // Also wait for the shot thumbnail to be visible
    // Shots load via a separate API call from the sequence data, so needs its own timeout
    const shotThumbnail = page.getByRole('img', { name: 'Scene 1' });
    await expect(shotThumbnail).toBeVisible({
      timeout: 15000,
    });

    // Variants moved from a tab to a dialog opened from the canvas image (#986):
    // select the shot, then open the variants dialog from the starting frame.
    // The list item is a real <a href> (#1339), so the click lands whether or
    // not React has hydrated; selection is URL state, so gate on `?shot=<id>`
    // rather than on the SSR-visible thumbnail.
    await page.getByRole('link', { name: 'Scene 1' }).click();
    await expect(page).toHaveURL(new RegExp(`shot=${testShot.id}`), {
      timeout: 15_000,
    });
    // `exact` so this never also matches the dialog's own "Regenerate frame
    // variants" button.
    const variantsButton = page.getByRole('button', {
      name: 'Frame variants',
      exact: true,
    });
    await expect(variantsButton).toBeVisible({ timeout: 10000 });
    // Selecting the scene above is a real <a href> navigation, so this button
    // renders server-side and stays inert until React hydrates it — a single
    // click lands on nothing. Click until the dialog is actually up (the open
    // dialog aria-hides the button, so ask the dialog, not the button).
    const variantsDialog = page.getByRole('dialog', { name: 'Frame variants' });
    await expect(async () => {
      if (!(await variantsDialog.isVisible())) await variantsButton.click();
      await expect(variantsDialog).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 20_000 });

    const variantGrid = page.getByRole('grid', { name: 'Variant selection' });

    // Wait for variant grid to be visible
    await expect(variantGrid).toBeVisible({ timeout: 10000 });

    // Click on variant 5 (center tile)
    const variant5 = page.getByRole('button', { name: 'Select variant 5' });
    await expect(variant5).toBeVisible();
    await variant5.click();

    // Confirmation dialog should appear
    await expect(page.getByText('Select this variant?')).toBeVisible();

    // Selecting a tile no longer writes the thumbnail synchronously (#989).
    // `selectShotVariantFn` runs the full synchronous path — reads the latest
    // framing grid sheet from frame_variants, crops the chosen tile, checks
    // credits, and triggers the upscale workflow — then returns. The actual
    // still REPOINT happens asynchronously inside that workflow (covered by
    // upscale-shot-variant-workflow.test.ts's persistUpscaleSelection), and
    // normal e2e no-ops workflow triggers (workflow/client.ts), so there is no
    // synchronous DB thumbnail change to observe here. Assert the interaction
    // round-trips cleanly instead: the select POST returns 200 and the flow
    // completes without an error toast.
    const selectResponse = page.waitForResponse(
      (resp) =>
        resp.request().method() === 'POST' &&
        (resp.request().postData() ?? '').includes('variantIndex') &&
        resp.status() === 200,
      { timeout: 15_000 }
    );

    // Confirm selection
    await page.getByRole('button', { name: 'Confirm' }).click();
    await selectResponse;

    // Dialog should close and no failure toast should surface.
    await expect(page.getByText('Select this variant?')).not.toBeVisible();
    await expect(page.getByText('Failed to select variant')).not.toBeVisible();
  });
});

// Each test creates its own data with unique names for parallel execution
testWithUser.describe('Character Recast', () => {
  let testTalents: TestTalent[] = [];
  let testSequence: TestSequence;
  let testCharacter: TestCharacter;

  testWithUser.beforeEach(async ({ page, testUser }) => {
    await setupMockRoutes(page);

    // Create test talent with unique names
    const suffix = crypto.randomUUID().slice(0, 8);
    testTalents = await createTestTalentSet(testUser.teamId, [
      `E2E Current Actor ${suffix}`,
      `E2E New Actor ${suffix}`,
    ]);

    const firstTalent = testTalents[0];
    if (!firstTalent) {
      throw new Error('test setup: expected at least one test talent');
    }

    // Create pre-seeded sequence with character (unique name)
    testSequence = await createTestSequence(
      testUser.teamId,
      testUser.id,
      `E2E Recast Test Sequence ${suffix}`
    );

    // Create a character linked to the first talent
    testCharacter = await createTestCharacter(
      testSequence.id,
      'char_001',
      'John',
      firstTalent.id,
      {
        // Use real placeholder image
        sheetImageUrl:
          'http://localhost:3001/api/test/image?w=1920&h=1080&label=character',
        sheetStatus: 'completed',
      }
    );
  });

  testWithUser.afterEach(async () => {
    // Cleanup specific entities we created
    for (const t of testTalents) {
      await cleanupTalentById(t.id);
    }
    await cleanupSequenceById(testSequence.id, testSequence.styleId);
    testTalents = [];
  });

  testWithUser(
    'can recast character with different talent',
    async ({ page }) => {
      const firstTalent = testTalents[0];
      const secondTalent = testTalents[1];
      if (!firstTalent || !secondTalent) {
        throw new Error('test setup: expected two test talents');
      }

      // Verify initial state - character is linked to first talent
      const characterBefore = await getTestCharacter(testCharacter.id);
      expect(characterBefore?.talentId).toBe(firstTalent.id);

      // Navigate to the character detail page
      await page.goto(`/sequences/${testSequence.id}/cast/${testCharacter.id}`);

      // Wait for character detail to load
      await page.waitForLoadState('domcontentloaded');
      await expect(page.locator('h1').filter({ hasText: 'John' })).toBeVisible({
        timeout: 15000,
      });

      // Click Recast button. `exact` so the rename-sequence control
      // (aria-label includes the sequence title, which contains "Recast")
      // is not a strict-mode match.
      const recastButton = page.getByRole('button', {
        name: 'Recast',
        exact: true,
      });
      await expect(recastButton).toBeVisible();
      await recastButton.click();

      // Talent picker dialog should open
      const talentDialog = page.getByRole('dialog');
      await expect(talentDialog).toBeVisible();
      await expect(talentDialog.getByText('Select Talent')).toBeVisible();

      // Select the second talent (use variable name)
      await page.getByText(secondTalent.name).click();

      // Recast confirmation dialog should appear (use regex with variable)
      await expect(
        page.getByText(new RegExp(`Recast ${secondTalent.name} as John`, 'i'))
      ).toBeVisible();

      // Confirm the recast
      await page.getByRole('button', { name: 'Recast', exact: true }).click();

      // The confirmation dialog should close (loading state may briefly appear)
      // With mocks, the mutation should complete quickly
      await expect(
        page.getByText(new RegExp(`Recast ${secondTalent.name} as John`, 'i'))
      ).not.toBeVisible({ timeout: 10000 });

      // Verify the database was updated - character now linked to second talent
      await expect
        .poll(
          async () => {
            const characterAfter = await getTestCharacter(testCharacter.id);
            return characterAfter?.talentId;
          },
          { timeout: 20_000 }
        )
        .toBe(secondTalent.id);
    }
  );
});

// Skip empty state test in parallel mode - it interferes with other tests
// by cleaning up all talent for the shared team. This test works in serial mode.
// TODO: Consider running this test with a dedicated user/team for isolation
testWithUser.describe.skip('Empty States', () => {
  testWithUser(
    'shows empty state when no talent in library',
    async ({ page }) => {
      await setupMockRoutes(page);

      await page.goto('/sequences/new');

      // Wait for React hydration + data loading
      await expect(
        page.getByRole('grid', { name: 'Style selection' })
      ).toBeVisible({ timeout: 15000 });

      // Open talent dialog - find button in main content area
      const talentButton = page
        .locator('main')
        .getByRole('button', { name: 'Talent' });
      await expect(talentButton).toBeVisible();
      await talentButton.click();

      // Wait for dialog to open
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible({ timeout: 10000 });

      // Verify empty state
      await expect(page.getByText('No talent in library')).toBeVisible();
    }
  );
});
