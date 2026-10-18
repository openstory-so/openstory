/**
 * Sequence Creation Flow E2E Tests
 *
 * Tests the complete flow:
 * 1. Fill a new sequence (style + script)
 * 2. Generate and select variants
 */

import { expect } from 'playwright/test';
import { test as testWithUser } from '../fixtures/auth.fixture';
import { setupMockRoutes } from '../mocks/handlers';
import { fillScriptEditor } from '../fixtures/test-utils';
import {
  createTestSequence,
  createTestShot,
  cleanupSequenceById,
  getTestShot,
  type TestSequence,
  type TestShot,
} from '../fixtures/sequence.fixture';

// Each test creates its own data with unique names for parallel execution
testWithUser.describe('Sequence Creation Flow', () => {
  testWithUser.beforeEach(async ({ page }) => {
    await setupMockRoutes(page);
  });

  testWithUser(
    'can fill a new sequence once a style and script are set',
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
        .getByRole('button', { name: /^View .+ details$/ })
        .first();
      await firstStyle.click();
      await page.getByRole('button', { name: /^Use the .+ style$/ }).click();

      // Now fill the editor - React is hydrated since style click worked
      await fillScriptEditor(page, testScript);

      // Wait for "Generate" button to become enabled - this proves:
      // 1. React hydration is complete (event handlers attached)
      // 2. Textarea fill was picked up by React state (script is set)
      // 3. Style was selected (from our click above)
      await expect(page.getByRole('button', { name: /Generate/i })).toBeEnabled(
        { timeout: 10000 }
      );
    }
  );
});

// Each test creates its own data with unique names for parallel execution
testWithUser.describe('Variant Selection', () => {
  let testSequence: TestSequence;
  let testShot: TestShot;
  const originalThumbnailUrl =
    'http://localhost:3020/api/test/image?w=1024&h=576&label=thumb';

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
        'http://localhost:3020/api/test/image?w=3072&h=3072&label=variants',
      variantImageStatus: 'completed',
    });
  });

  testWithUser.afterEach(async () => {
    await cleanupSequenceById(testSequence.id, testSequence.styleId);
  });

  testWithUser(
    'phone: settings and scenes open as drawers (#2102)',
    async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/sequences/${testSequence.id}/scenes`);

      // One crumb on a phone, and it is the sequence title, not "Scenes".
      await expect(
        page.getByRole('navigation', { name: 'breadcrumb' })
      ).toContainText(testSequence.title);

      // Settings: the bottom bar's cog opens the inspector in a drawer.
      const renameTitle = page.getByRole('button', {
        name: `Rename sequence ${testSequence.title}`,
      });
      await expect(renameTitle).toBeHidden();
      const drawer = page.getByRole('dialog');
      // Retried: a click before hydration is dropped.
      await expect(async () => {
        await page
          .getByRole('button', { name: 'Open settings' })
          .click({ timeout: 1000 });
        await expect(renameTitle).toBeVisible({ timeout: 1000 });
      }).toPass({ timeout: 15000 });

      // Popovers work from inside the drawer: rename the sequence...
      await renameTitle.click();
      const renamed = `${testSequence.title} renamed`;
      await page.getByPlaceholder('Sequence title').fill(renamed);
      await page.keyboard.press('Enter');
      const renamedTitle = page.getByRole('button', {
        name: `Rename sequence ${renamed}`,
      });
      await expect(renamedTitle).toBeVisible();
      await expect(page.getByPlaceholder('Sequence title')).toBeHidden();

      // ...and set the target length.
      const lengthChip = drawer.getByTestId('film-length-chip');
      await lengthChip.click();
      await page.getByRole('radio', { name: '30s' }).click();
      await expect(lengthChip).toHaveText('30s');
      await page.keyboard.press('Escape');
      await expect(renamedTitle).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(renamedTitle).toBeHidden();

      // Scenes: the bar opens the list in a drawer; its footer controls work.
      await page.getByTestId('mobile-scene-nav').click();
      await expect(
        drawer.getByText('Whole sequence', { exact: true })
      ).toBeVisible();
      const stopSlider = drawer.getByRole('slider');
      const before = await stopSlider.getAttribute('aria-valuenow');
      await stopSlider.press('End');
      await expect(stopSlider).not.toHaveAttribute(
        'aria-valuenow',
        before ?? ''
      );
      await expect(
        drawer.getByText('Whole sequence', { exact: true })
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
    }
  );

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

    // The title is renamed from sequence settings (#2102), not a title row.
    await expect(
      page.getByRole('button', {
        name: `Rename sequence ${testSequence.title}`,
      })
    ).toBeVisible();

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
    // Video leads the shot tabs, so the canvas opens on the clip; the still
    // (and its variants button) is on the Start Frame tab.
    await page.getByRole('tab', { name: 'Start Frame' }).click();
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

testWithUser.describe('Theatre stitcher clip language (#1744)', () => {
  let testSequence: TestSequence;

  testWithUser.beforeEach(async ({ page, testUser }) => {
    await setupMockRoutes(page);
    testSequence = await createTestSequence(
      testUser.teamId,
      testUser.id,
      `E2E Theatre Clip Language ${crypto.randomUUID().slice(0, 8)}`
    );
    await createTestShot(testSequence.id, 0, {
      thumbnailUrl:
        'http://localhost:3020/api/test/image?w=1024&h=576&label=thumb',
    });
  });

  testWithUser.afterEach(async () => {
    await cleanupSequenceById(testSequence.id, testSequence.styleId);
  });

  testWithUser('stitches stills as clips, not scenes', async ({ page }) => {
    testWithUser.setTimeout(60_000);
    await page.goto(`/sequences/${testSequence.id}/scenes`);
    await expect(
      page.getByRole('heading', { name: testSequence.title })
    ).toBeVisible({ timeout: 15_000 });

    const theatrePlayer = page.getByTestId('sequence-player');
    await expect(theatrePlayer).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Loading scene \d+ of/)).toHaveCount(0);

    await expect
      .poll(
        async () => {
          const loading = await theatrePlayer.textContent();
          if (loading?.includes('Loading scene')) {
            throw new Error(`Theatre still uses scene copy: ${loading}`);
          }
          return (await theatrePlayer.getAttribute('data-state')) === 'ready';
        },
        {
          timeout: 30_000,
          message:
            'theatre stitcher: sequence-player ready without “Loading scene”',
        }
      )
      .toBe(true);

    await expect(page.getByText(/Loading scene \d+ of/)).toHaveCount(0);
  });
});
