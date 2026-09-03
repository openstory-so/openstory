/**
 * Manual Pipeline Driveability E2E (#1108 Phase 6 — plan §10).
 *
 * Proves the manual path that NEVER runs storyboard: starting from an empty
 * sequence, a filmmaker builds structure (scene + shot), writes a prompt,
 * injects their own still and clip, manages cast, soft-deletes with toast
 * Undo, and reorders scenes — with zero generation calls the whole way.
 *
 * Browser-visible generation traffic (fal.run / queue.fal.run / aimock :4010)
 * is counted and asserted zero. Server-side LLM calls wouldn't cross the
 * browser, but nothing in this path triggers a workflow either — the DB
 * assertions would catch a storyboard wipe (it hard-deletes shots).
 */

import path from 'node:path';
import { expect } from 'playwright/test';
import { test as testWithUser } from '../fixtures/auth.fixture';
import { setupMockRoutes } from '../mocks/handlers';
import {
  cleanupSequenceById,
  createTestSequence,
  getTestSequenceShots,
  type TestSequence,
} from '../fixtures/sequence.fixture';

const IMAGE_FIXTURE = path.join(
  import.meta.dirname,
  '../fixtures/test-image.jpg'
);
const VIDEO_FIXTURE = path.join(
  import.meta.dirname,
  '../fixtures/test-video.mp4'
);

testWithUser.describe('Manual pipeline (no storyboard)', () => {
  let testSequence: TestSequence;
  const generationRequests: string[] = [];

  testWithUser.beforeEach(async ({ page, testUser }) => {
    await setupMockRoutes(page);
    // Reset per test: the collector is describe-scoped, so a second test added
    // here would otherwise inherit this one's traffic and assert against it.
    generationRequests.length = 0;
    // Any fal/aimock traffic from the browser means the manual path leaked
    // into generation — collect and assert empty at the end.
    page.on('request', (request) => {
      const url = request.url();
      if (
        url.includes('fal.run') ||
        url.includes('localhost:4010') ||
        url.includes('127.0.0.1:4010')
      ) {
        generationRequests.push(url);
      }
    });
    testSequence = await createTestSequence(
      testUser.teamId,
      testUser.id,
      `E2E Manual Pipeline ${crypto.randomUUID().slice(0, 8)}`
    );
  });

  testWithUser.afterEach(async () => {
    await cleanupSequenceById(testSequence.id, testSequence.styleId);
  });

  testWithUser(
    'full manual CRUD path: structure, prompt, media inject, cast, undo, reorder',
    async ({ page }) => {
      testWithUser.setTimeout(180_000);

      // ---- Open the empty sequence -------------------------------------
      await page.goto(`/sequences/${testSequence.id}/scenes`);
      await expect(
        page.getByRole('heading', { name: testSequence.title })
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('No scenes yet.')).toBeVisible({
        timeout: 15_000,
      });

      // ---- 1. Add a scene (creates its first shot) ---------------------
      const sceneGroups = page.locator('[data-testid="scene-group"]');
      await page.getByRole('button', { name: 'Add scene' }).click();
      // DB first — the rail used to stay on "No scenes yet" until list
      // queries settled, which flakes under parallel D1 load (#1108/#1384).
      await expect
        .poll(
          async () => (await getTestSequenceShots(testSequence.id)).length,
          { timeout: 20_000 }
        )
        .toBeGreaterThan(0);
      await expect(sceneGroups).toHaveCount(1, { timeout: 15_000 });
      const shotCards = page.locator('[data-testid="scene-list-item"]');
      await expect(shotCards).toHaveCount(1, { timeout: 15_000 });

      // ---- 2. Rename the scene -----------------------------------------
      await sceneGroups
        .first()
        .getByRole('button', { name: /^Scene actions for/ })
        .click();
      await page.getByRole('menuitem', { name: 'Rename scene' }).click();
      const titleInput = page.getByLabel('Scene title');
      await titleInput.fill('Opening');
      await titleInput.press('Enter');
      // Header button reads "Opening 1 shot" (the shot card also echoes the
      // scene title, so target the header role, not text).
      await expect(
        sceneGroups.first().getByRole('button', { name: /^Opening/ })
      ).toBeVisible({ timeout: 10_000 });

      // ---- 3. Select the shot and edit its visual prompt ---------------
      await shotCards.first().click();
      await page.getByRole('tab', { name: 'Start Frame' }).click();
      const promptEditor = page
        .getByRole('tabpanel')
        .locator('[data-slot="markdown-editor"] .ProseMirror');
      await expect(promptEditor).toBeVisible({ timeout: 10_000 });
      await promptEditor.click();
      await promptEditor.fill(
        'A rain-soaked neon alley, lone figure under an umbrella'
      );
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Prompt saved')).toBeVisible({
        timeout: 10_000,
      });

      // ---- 4. Upload a still via Replace Image -------------------------
      // The mobile drawer mounts a second (hidden) copy of the tab — scope to
      // the visible desktop tabpanel.
      await page
        .getByRole('tabpanel', { name: 'Start Frame' })
        .locator('input[type="file"]')
        .setInputFiles(IMAGE_FIXTURE);
      await expect(page.getByText('Image replaced')).toBeVisible({
        timeout: 20_000,
      });
      // The uploaded still is now the selected version in local R2.
      await expect
        .poll(
          async () => {
            const shots = await getTestSequenceShots(testSequence.id);
            return shots[0]?.thumbnailUrl ?? null;
          },
          { timeout: 20_000 }
        )
        .toContain('/r2/');
      // No render exists yet, so nothing may claim to be generating.
      await expect(page.getByText('Generating…')).not.toBeVisible();

      // ---- 5. Upload a clip via Replace Video --------------------------
      await page.getByRole('tab', { name: 'Video' }).click();
      await page
        .getByRole('tabpanel', { name: 'Video' })
        .locator('input[type="file"]')
        .setInputFiles(VIDEO_FIXTURE);
      await expect(page.getByText('Video replaced')).toBeVisible({
        timeout: 20_000,
      });
      await expect
        .poll(
          async () => {
            const shots = await getTestSequenceShots(testSequence.id);
            return shots[0]?.videoUrl ?? null;
          },
          { timeout: 20_000 }
        )
        .toContain('/r2/');

      // ---- 6. Cast: add, edit bible, soft-delete + Undo ----------------
      // Manually added characters belong to no shot facet yet — the cast tab
      // scopes by selection, so operate at whole-sequence scope.
      await page.getByRole('button', { name: /Whole sequence/ }).click();
      await page.getByRole('tab', { name: 'Cast' }).click();
      await page.getByRole('button', { name: 'Add Character' }).click();
      await page.getByLabel('Name', { exact: true }).fill('Maya');
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Add Character' })
        .click();
      await expect(page.getByText('Added Maya')).toBeVisible({
        timeout: 10_000,
      });
      const mayaCard = page.getByRole('link', { name: /Maya/ });
      await expect(mayaCard).toBeVisible({ timeout: 10_000 });

      // Bible edit on the character detail page.
      await mayaCard.click();
      await expect(page.locator('h1').filter({ hasText: 'Maya' })).toBeVisible({
        timeout: 15_000,
      });
      // exact: "Age" is a substring of the sheet "Image Model" trigger
      // ("Image Model: …").
      await page.getByLabel('Age', { exact: true }).fill('34');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Character saved')).toBeVisible({
        timeout: 10_000,
      });

      // Back to the editor; soft-delete from the cast facet, then Undo.
      await page.goto(`/sequences/${testSequence.id}/scenes`);
      await expect(
        page.getByRole('heading', { name: testSequence.title })
      ).toBeVisible({ timeout: 15_000 });
      await page.getByRole('tab', { name: 'Cast' }).click();
      await page
        .getByRole('button', { name: 'Remove Maya from sequence' })
        .click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Remove', exact: true })
        .click();
      await expect(page.getByRole('link', { name: /Maya/ })).not.toBeVisible({
        timeout: 10_000,
      });
      await page
        .locator('[data-sonner-toast]')
        .filter({ hasText: 'Removed Maya' })
        .getByRole('button', { name: 'Undo' })
        .click();
      await expect(page.getByRole('link', { name: /Maya/ })).toBeVisible({
        timeout: 15_000,
      });

      // ---- 7. Soft-delete the shot, then Undo (media intact) -----------
      const shotsBefore = await getTestSequenceShots(testSequence.id);
      const uploadedStillUrl = shotsBefore[0]?.thumbnailUrl;
      // Guard the round-trip assertion below against passing vacuously: two
      // nulls would compare equal and prove nothing about losslessness.
      expect(uploadedStillUrl).toContain('/r2/');
      await shotCards.first().hover();
      await shotCards
        .first()
        .getByRole('button', { name: 'Shot actions' })
        .click();
      await page.getByRole('menuitem', { name: 'Remove shot' }).click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Remove', exact: true })
        .click();
      await expect(shotCards).toHaveCount(0, { timeout: 10_000 });
      await page
        .locator('[data-sonner-toast]')
        .filter({ hasText: 'Removed shot from Opening' })
        .getByRole('button', { name: 'Undo' })
        .click();
      await expect(shotCards).toHaveCount(1, { timeout: 15_000 });
      // Restore is lossless: the uploaded still is still the selected image.
      const shotsAfterRestore = await getTestSequenceShots(testSequence.id);
      expect(shotsAfterRestore[0]?.thumbnailUrl).toBe(uploadedStillUrl);

      // ---- 8. Reorder scenes and verify it sticks after reload ---------
      await page.getByRole('button', { name: 'Add scene' }).click();
      await expect(sceneGroups).toHaveCount(2, { timeout: 15_000 });
      await sceneGroups
        .first()
        .getByRole('button', { name: 'Scene actions for Opening' })
        .click();
      await page.getByRole('menuitem', { name: 'Move down' }).click();
      // Optimistic reorder: the untitled scene takes slot 1 ("Scene 1").
      await expect(
        sceneGroups.first().getByRole('button', { name: /^Scene 1/ })
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        sceneGroups.nth(1).getByRole('button', { name: /^Opening/ })
      ).toBeVisible();
      // DB first — reload SSRs the scene list with staleTime 30s, so a
      // reload before the reorder POST commits freezes Opening in slot 1
      // for the rest of the assertion (#1384).
      await expect
        .poll(
          async () => {
            const shots = await getTestSequenceShots(testSequence.id);
            return shots[1]?.thumbnailUrl ?? null;
          },
          { timeout: 20_000 }
        )
        .toBe(uploadedStillUrl);

      await page.reload();
      await expect(sceneGroups).toHaveCount(2, { timeout: 15_000 });
      await expect(
        sceneGroups.first().getByRole('button', { name: /^Scene 1/ })
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        sceneGroups.nth(1).getByRole('button', { name: /^Opening/ })
      ).toBeVisible();

      // ---- No generation traffic left the browser ----------------------
      expect(generationRequests).toEqual([]);
    }
  );
});
