/**
 * Talent E2E Tests
 * Tests talent library management including reference media uploads
 */

import { test, expect } from 'playwright/test';
import { test as testWithUser } from '../fixtures/auth.fixture';
import { setupMockRoutes } from '../mocks/handlers';
import {
  createTestTalentWithMedia,
  cleanupTalentById,
  type TestTalentWithMedia,
} from '../fixtures/talent.fixture';
import {
  addTalentDialog,
  attestAssetRights,
  attestPortraitRights,
  dropNamedTalentImage,
  openAddTalentFromLibrary,
  openAddTalentFromSequence,
  submitAddTalent,
  uniqueTalentName,
  uploadNamedTalentImage,
  waitForSubjectKind,
} from '../fixtures/add-talent';
import {
  waitForLibraryPageLoad,
  cleanupTalentByName,
  openLibraryCard,
  returnToLibraryList,
  waitForUploadComplete,
  TALENT_DETAIL_URL,
} from '../fixtures/test-utils';
import path from 'node:path';

function waitForTalentPageLoad(page: import('playwright/test').Page) {
  return waitForLibraryPageLoad(page, 'Add Talent');
}

test.describe('Talent Library', () => {
  test('can access talent page', async ({ page }) => {
    await page.goto('/talent');
    await waitForTalentPageLoad(page);

    await expect(page).toHaveURL(/\/talent/);
    await expect(
      page.getByRole('heading', { name: 'Talent Library' })
    ).toBeVisible();
  });

  test('has Add Talent button', async ({ page }) => {
    await page.goto('/talent');
    await waitForTalentPageLoad(page);

    const addButton = page.getByRole('button', {
      name: 'Add Talent',
    });
    await expect(addButton.first()).toBeVisible();
    await expect(addButton.first()).toBeEnabled();
  });
});

// Tests create talents via UI - use unique names to avoid collisions in parallel
testWithUser.describe('Add Talent with Reference Media', () => {
  testWithUser.beforeEach(async ({ page }) => {
    // Set up mock routes for R2 and other external services
    await setupMockRoutes(page);
  });

  testWithUser('can open Add Talent dialog', async ({ page }) => {
    await page.goto('/talent');
    await waitForTalentPageLoad(page);

    // Click Add Talent button
    const button = page.getByRole('button', { name: 'Add Talent' }).first();
    await button.click();

    // Dialog should open
    await expect(
      page.getByRole('dialog', { name: 'Add Talent' })
    ).toBeVisible();

    // Check for form fields
    await expect(page.getByLabel('Name')).toBeVisible();
    await expect(page.getByLabel('Description')).toBeVisible();
    await expect(page.getByText('Reference Media')).toBeVisible();
  });

  testWithUser(
    'can create talent without media',
    async ({ page, testUser }) => {
      const uniqueName = `E2E Test Actor ${crypto.randomUUID().slice(0, 8)}`;

      await page.goto('/talent');
      await waitForTalentPageLoad(page);

      // Click Add Talent button
      await page.getByRole('button', { name: 'Add Talent' }).first().click();

      // Fill in the form with unique name
      await page.getByLabel('Name').fill(uniqueName);
      await page.getByLabel('Description').fill('Test description for E2E');

      // Submit the form
      await page.getByRole('button', { name: 'Add Talent' }).click();

      // Wait for dialog to close and talent to appear in list
      await expect(
        page.getByRole('dialog', { name: 'Add Talent' })
      ).not.toBeVisible({ timeout: 10000 });

      // Talent should appear in the list
      await expect(page.getByText(uniqueName)).toBeVisible({
        timeout: 10000,
      });

      await cleanupTalentByName(testUser.teamId, uniqueName);
    }
  );

  testWithUser(
    'can create talent from a photo and shows generating-sheet progress',
    async ({ page, testUser }) => {
      const uniqueName = uniqueTalentName('Photo');
      const dialog = await openAddTalentFromLibrary(page);

      await dialog.getByLabel('Name').fill(uniqueName);
      await uploadNamedTalentImage(page, 'test-image.jpg');
      await waitForSubjectKind(page, 'Human');
      await attestPortraitRights(page);
      await submitAddTalent(page);

      await expect(page.getByText('Generating talent sheet')).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText(uniqueName)).toBeVisible({ timeout: 10_000 });
      const card = page.getByRole('link', { name: uniqueName });
      await expect(card.getByText('Human')).toBeVisible();
      await expect(card.getByText('Generating sheet…')).toBeVisible();

      await cleanupTalentByName(testUser.teamId, uniqueName);
    }
  );

  testWithUser(
    'detects an uploaded character sheet and shows creating-portrait progress',
    async ({ page, testUser }) => {
      const uniqueName = uniqueTalentName('Sheet');
      const dialog = await openAddTalentFromLibrary(page);

      await dialog.getByLabel('Name').fill(uniqueName);
      await uploadNamedTalentImage(page, 'character-sheet.jpg');
      await expect(dialog.getByText('Sheet', { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await waitForSubjectKind(page, 'Animated');
      await expect(
        dialog.getByRole('checkbox', {
          name: /hold the rights to this asset/i,
        })
      ).toBeVisible();
      await expect(dialog.getByLabel('Basis for authorization')).toHaveCount(0);
      await attestAssetRights(page);
      await submitAddTalent(page);

      await expect(
        page.getByText('Creating portrait from the uploaded sheet')
      ).toBeVisible({ timeout: 10_000 });
      const card = page.getByRole('link', { name: uniqueName });
      await expect(card).toBeVisible({ timeout: 10_000 });
      await expect(card.getByText('AI', { exact: true })).toBeVisible();
      await expect(card.getByText('Creating portrait…')).toBeVisible();

      await cleanupTalentByName(testUser.teamId, uniqueName);
    }
  );

  testWithUser(
    'classifies a creature as Other and uses asset rights',
    async ({ page, testUser }) => {
      const uniqueName = uniqueTalentName('Creature');
      const dialog = await openAddTalentFromLibrary(page);

      await dialog.getByLabel('Name').fill(uniqueName);
      await uploadNamedTalentImage(page, 'creature.jpg');
      await waitForSubjectKind(page, 'Other');
      await attestAssetRights(page);
      await submitAddTalent(page);

      const card = page.getByRole('link', { name: uniqueName });
      await expect(card).toBeVisible({ timeout: 10_000 });
      await expect(card.getByText('AI', { exact: true })).toBeVisible();
      await expect(card.getByText('Human')).toHaveCount(0);

      await cleanupTalentByName(testUser.teamId, uniqueName);
    }
  );

  testWithUser(
    'subject toggle overrides vision and swaps attestation',
    async ({ page, testUser }) => {
      const uniqueName = uniqueTalentName('Override');
      const dialog = await openAddTalentFromLibrary(page);

      await dialog.getByLabel('Name').fill(uniqueName);
      await uploadNamedTalentImage(page, 'test-image.jpg');
      await waitForSubjectKind(page, 'Human');
      await expect(dialog.getByLabel('Basis for authorization')).toBeVisible();

      await dialog.getByRole('radio', { name: 'Animated' }).click();
      await expect(
        dialog.getByRole('radio', { name: 'Animated' })
      ).toBeChecked();
      await expect(
        dialog.getByRole('checkbox', {
          name: /hold the rights to this asset/i,
        })
      ).toBeVisible();
      await expect(dialog.getByLabel('Basis for authorization')).toHaveCount(0);

      await attestAssetRights(page);
      await submitAddTalent(page);

      const card = page.getByRole('link', { name: uniqueName });
      await expect(card).toBeVisible({ timeout: 10_000 });
      await expect(card.getByText('AI', { exact: true })).toBeVisible();

      await cleanupTalentByName(testUser.teamId, uniqueName);
    }
  );

  testWithUser(
    'Generate from photos fills description from vision',
    async ({ page, testUser }) => {
      const uniqueName = uniqueTalentName('Generate');
      const dialog = await openAddTalentFromLibrary(page);

      await dialog.getByLabel('Name').fill(uniqueName);
      await uploadNamedTalentImage(page, 'character-sheet.jpg');
      await waitForSubjectKind(page, 'Animated');

      await dialog
        .getByRole('button', { name: 'Generate from photos' })
        .click();
      await expect(dialog.getByLabel('Description')).toHaveValue(
        /chrome robot/i,
        { timeout: 15_000 }
      );
      await expect(
        page.getByText('Description generated from photos')
      ).toBeVisible();

      await attestAssetRights(page);
      await submitAddTalent(page);
      await expect(page.getByText(uniqueName)).toBeVisible({ timeout: 10_000 });

      await cleanupTalentByName(testUser.teamId, uniqueName);
    }
  );

  testWithUser(
    'blocks create until portrait rights are attested',
    async ({ page }) => {
      const uniqueName = uniqueTalentName('No Attest');
      const dialog = await openAddTalentFromLibrary(page);

      await dialog.getByLabel('Name').fill(uniqueName);
      await uploadNamedTalentImage(page, 'test-image.jpg');
      await waitForSubjectKind(page, 'Human');

      await dialog.getByRole('button', { name: 'Add Talent' }).click();
      await expect(dialog).toBeVisible();
      await expect(
        page.getByText(
          'Confirm you have authorization for this person’s likeness'
        )
      ).toBeVisible({ timeout: 10_000 });
    }
  );

  testWithUser(
    'blocks a human photo without an authorization basis',
    async ({ page }) => {
      const uniqueName = uniqueTalentName('No Basis');
      const dialog = await openAddTalentFromLibrary(page);

      await dialog.getByLabel('Name').fill(uniqueName);
      await uploadNamedTalentImage(page, 'test-image.jpg');
      await waitForSubjectKind(page, 'Human');
      await dialog
        .getByRole('checkbox', { name: /authorization to use this person/i })
        .check();

      await dialog.getByRole('button', { name: 'Add Talent' }).click();
      await expect(dialog).toBeVisible();
      await expect(page.getByText('Add a basis for authorization')).toBeVisible(
        {
          timeout: 10_000,
        }
      );
    }
  );

  testWithUser('shows the picked file while it uploads', async ({ page }) => {
    const uniqueName = `Test Upload Progress ${crypto.randomUUID().slice(0, 8)}`;

    await page.goto('/talent');
    await waitForTalentPageLoad(page);

    // Click Add Talent button
    await page.getByRole('button', { name: 'Add Talent' }).first().click();

    await page.getByLabel('Name').fill(uniqueName);

    // Start file upload
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Browse files' }).click();
    const fileChooser = await fileChooserPromise;

    const testImagePath = path.join(
      import.meta.dirname,
      '../fixtures/test-image.jpg'
    );
    await fileChooser.setFiles(testImagePath);

    // The picked file lands in the list with a preview, and the upload runs to
    // completion. Asserting only "submit is enabled" proved nothing: submit is
    // enabled from the moment the dialog opens, so it passed before the file
    // was even registered (#827).
    await expect(page.locator('[data-slot="file-upload-item"]')).toHaveCount(1);
    await waitForUploadComplete(page);
    // Note: This test doesn't submit, so no cleanup needed
  });

  testWithUser('can cancel Add Talent dialog', async ({ page }) => {
    await page.goto('/talent');
    await waitForTalentPageLoad(page);

    // Click Add Talent button
    await page.getByRole('button', { name: 'Add Talent' }).first().click();

    // Dialog should be visible
    await expect(
      page.getByRole('dialog', { name: 'Add Talent' })
    ).toBeVisible();

    // Click Cancel
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Dialog should close
    await expect(
      page.getByRole('dialog', { name: 'Add Talent' })
    ).not.toBeVisible();
  });
});

// Same AddTalentDialog as the talent library, but the sequence composer
// auto-selects the new row so the user does not have to find it in the picker.
testWithUser.describe('Add Talent from new sequence page', () => {
  testWithUser.beforeEach(async ({ page }) => {
    await setupMockRoutes(page);
  });

  testWithUser(
    'name-only create auto-selects the talent on the composer',
    async ({ page, testUser }) => {
      const uniqueName = uniqueTalentName('Seq Name');
      const { picker } = await openAddTalentFromSequence(page);

      await addTalentDialog(page).getByLabel('Name').fill(uniqueName);
      await submitAddTalent(page);

      await expect(page).toHaveURL(/\/sequences\/new/);
      await expect(picker).toBeVisible();
      await expect(picker.getByText(uniqueName)).toBeVisible({
        timeout: 10_000,
      });
      await expect(
        picker.getByRole('button', { name: /^Cast 1 role$/i })
      ).toBeVisible();

      await cleanupTalentByName(testUser.teamId, uniqueName);
    }
  );

  testWithUser(
    'photo create uses the same dialog and auto-selects the talent',
    async ({ page, testUser }) => {
      const uniqueName = uniqueTalentName('Seq Photo');
      const { picker } = await openAddTalentFromSequence(page);

      await addTalentDialog(page).getByLabel('Name').fill(uniqueName);
      // Drop (not browse) so the same image cannot also land in the composer's
      // Elements dropzone underneath the dialog (#1269).
      await dropNamedTalentImage(page, 'test-image.jpg');
      await expect(page.getByText('Upload reference elements')).toHaveCount(0);
      await waitForSubjectKind(page, 'Human');
      await attestPortraitRights(page);
      await submitAddTalent(page);

      await expect(page).toHaveURL(/\/sequences\/new/);
      await expect(picker).toBeVisible();
      await expect(picker.getByText(uniqueName)).toBeVisible({
        timeout: 10_000,
      });
      await expect(
        picker.getByRole('button', { name: /^Cast 1 role$/i })
      ).toBeVisible();
      await expect(page.getByRole('link', { name: uniqueName })).toHaveCount(0);
      await expect(
        // CSS, not role: the picker dialog is still open so `main` is aria-hidden.
        page.locator('main').locator('button', { hasText: 'Elements' })
      ).toHaveText('Elements');

      await cleanupTalentByName(testUser.teamId, uniqueName);
    }
  );
});

// Tests that need testUser for creating test data
// Each test creates its own data with unique names for parallel execution
testWithUser.describe('Edit Talent with Reference Media', () => {
  let testTalent: TestTalentWithMedia;

  testWithUser.beforeEach(async ({ page, testUser }) => {
    // Set up mock routes
    await setupMockRoutes(page);

    // Create test talent with media using unique name
    testTalent = await createTestTalentWithMedia(
      testUser.teamId,
      `E2E Edit Test Talent ${crypto.randomUUID().slice(0, 8)}`,
      2
    );
  });

  testWithUser.afterEach(async () => {
    await cleanupTalentById(testTalent.id);
  });

  testWithUser('can view talent detail page with media', async ({ page }) => {
    await page.goto('/talent');
    await waitForTalentPageLoad(page);

    // Click on the talent card to view details (use variable, not hardcoded)
    await openLibraryCard(page, testTalent.name, TALENT_DETAIL_URL);

    // Should be on detail page
    await expect(
      page.getByRole('heading', { name: testTalent.name })
    ).toBeVisible();

    // Should show reference media section
    await expect(page.getByText('Reference Media')).toBeVisible();
  });

  testWithUser(
    'can open edit dialog from talent detail page',
    async ({ page }) => {
      await page.goto('/talent');
      await waitForTalentPageLoad(page);

      // Click on the talent to view details
      await openLibraryCard(page, testTalent.name, TALENT_DETAIL_URL);

      // Pencil trigger only — do NOT use name /edit/i. With "Show costs" on
      // (#1140), the sidebar wallet button is labeled "Credit balance …" and
      // "Credit" matches /edit/i, so .first() would open Add Credits instead.
      await page.locator('button:has(svg.lucide-pencil)').first().click();

      // Edit dialog should open
      await expect(
        page.getByRole('dialog', { name: 'Edit Talent' })
      ).toBeVisible();

      // Form should be pre-filled
      await expect(page.getByLabel('Name')).toHaveValue(testTalent.name);
    }
  );

  // Previously skipped as "the update mutation doesn't complete / the dialog
  // doesn't close after save". That was #827: arriving from a library list with
  // enough cards exhausted the browser's connection budget with per-card SSE
  // streams, so the update POST could never be sent. Fixed by multiplexing.
  testWithUser('can update talent name and description', async ({ page }) => {
    await page.goto('/talent');
    await waitForTalentPageLoad(page);
    await openLibraryCard(page, testTalent.name, TALENT_DETAIL_URL);

    // Open edit dialog
    await page.locator('button:has(svg.lucide-pencil)').first().click();

    await expect(
      page.getByRole('dialog', { name: 'Edit Talent' })
    ).toBeVisible();

    // Update name
    const updatedName = `E2E Updated Talent ${crypto.randomUUID().slice(0, 8)}`;
    await page.getByLabel('Name').fill(updatedName);
    await page.getByLabel('Description').fill('Updated description');

    // Save changes
    await page.getByRole('button', { name: 'Save Changes' }).click();

    // Wait for the save to complete and dialog to close
    await expect(
      page.getByRole('dialog', { name: 'Edit Talent' })
    ).not.toBeVisible({ timeout: 15000 });

    // Updated name should appear on the detail page
    await expect(
      page.getByRole('heading', {
        name: updatedName,
      })
    ).toBeVisible({ timeout: 10000 });
  });

  testWithUser('can add media to existing talent', async ({ page }) => {
    await page.goto('/talent');
    await waitForTalentPageLoad(page);
    await openLibraryCard(page, testTalent.name, TALENT_DETAIL_URL);

    // Open edit dialog
    await page.locator('button:has(svg.lucide-pencil)').first().click();

    await expect(
      page.getByRole('dialog', { name: 'Edit Talent' })
    ).toBeVisible();

    // Click Add Media button
    await page.getByRole('button', { name: 'Add Media' }).click();

    // Add Media dialog should open
    await expect(
      page.getByRole('dialog', { name: 'Add Reference Media' })
    ).toBeVisible();
  });

  testWithUser('displays existing media in edit dialog', async ({ page }) => {
    await page.goto('/talent');
    await waitForTalentPageLoad(page);
    await openLibraryCard(page, testTalent.name, TALENT_DETAIL_URL);

    // Open edit dialog
    await page.locator('button:has(svg.lucide-pencil)').first().click();

    await expect(
      page.getByRole('dialog', { name: 'Edit Talent' })
    ).toBeVisible();

    // Should display reference media section with existing images
    await expect(
      page.getByText('Reference Media', { exact: true })
    ).toBeVisible();

    // Should have image previews (from the 2 media items we created)
    const mediaImages = page
      .getByRole('dialog', { name: 'Edit Talent' })
      .locator('img[alt="Reference"]');
    await expect(mediaImages).toHaveCount(2);
  });

  testWithUser('can cancel edit dialog without saving', async ({ page }) => {
    await page.goto('/talent');
    await waitForTalentPageLoad(page);
    await openLibraryCard(page, testTalent.name, TALENT_DETAIL_URL);

    // Open edit dialog
    await page.locator('button:has(svg.lucide-pencil)').first().click();

    // Change the name
    await page.getByLabel('Name').fill('Should Not Be Saved');

    // Cancel
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Dialog should close
    await expect(
      page.getByRole('dialog', { name: 'Edit Talent' })
    ).not.toBeVisible();

    // Original name should still be visible
    await expect(
      page.getByRole('heading', { name: testTalent.name })
    ).toBeVisible();
  });
});

// Each test creates its own data with unique names for parallel execution
testWithUser.describe('Talent with Media - List View', () => {
  let testTalentAlpha: TestTalentWithMedia;
  let testTalentBeta: TestTalentWithMedia;

  testWithUser.beforeEach(async ({ page, testUser }) => {
    await setupMockRoutes(page);
    const suffix = crypto.randomUUID().slice(0, 8);
    testTalentAlpha = await createTestTalentWithMedia(
      testUser.teamId,
      `E2E Talent Alpha ${suffix}`,
      1
    );
    testTalentBeta = await createTestTalentWithMedia(
      testUser.teamId,
      `E2E Talent Beta ${suffix}`,
      3
    );
  });

  testWithUser.afterEach(async () => {
    await cleanupTalentById(testTalentAlpha.id);
    await cleanupTalentById(testTalentBeta.id);
  });

  testWithUser('displays multiple talents in grid', async ({ page }) => {
    await page.goto('/talent');
    await waitForTalentPageLoad(page);

    await expect(page.getByText(testTalentAlpha.name)).toBeVisible();
    await expect(page.getByText(testTalentBeta.name)).toBeVisible();
  });

  testWithUser('can navigate between talent detail pages', async ({ page }) => {
    await page.goto('/talent');
    await waitForTalentPageLoad(page);

    // Click first talent
    await openLibraryCard(page, testTalentAlpha.name, TALENT_DETAIL_URL);
    await expect(
      page.getByRole('heading', { name: testTalentAlpha.name })
    ).toBeVisible();

    // Go back to list
    await returnToLibraryList(page, 'Back to Talent', /\/talent(\?|$)/);

    // Click second talent
    await openLibraryCard(page, testTalentBeta.name, TALENT_DETAIL_URL);
    await expect(
      page.getByRole('heading', { name: testTalentBeta.name })
    ).toBeVisible();
  });
});
