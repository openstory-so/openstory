import type { Page } from 'playwright/test';
import { expect, test } from '../fixtures/auth.fixture';

const HYDRATION_TIMEOUT = 15_000;

/** The composer is server-rendered; wait for TipTap to mount before clicking. */
async function waitForComposer(page: Page): Promise<void> {
  await expect(
    page.locator('[data-slot="markdown-editor"] .ProseMirror')
  ).toBeVisible({ timeout: HYDRATION_TIMEOUT });
}

test.describe('Images and Videos studio', () => {
  test('signed-in user can open Images from the sidebar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Images', exact: true }).click();
    await expect(page).toHaveURL(/\/images/);
    await expect(
      page.locator('[data-slot="markdown-editor"] .ProseMirror')
    ).toBeVisible({ timeout: HYDRATION_TIMEOUT });
    await expect(
      page.getByRole('button', { name: 'Generate image' })
    ).toBeVisible();
  });

  test('signed-in user can open Videos from the sidebar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Videos', exact: true }).click();
    await expect(page).toHaveURL(/\/videos/);
    await expect(
      page.getByRole('button', { name: 'Generate video' })
    ).toBeVisible();
    await waitForComposer(page);
    await expect(
      page.getByRole('combobox', { name: 'Video mode' })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Generation settings' }).click();
    await expect(page.getByLabel('Image Model')).toHaveCount(0);
    await expect(page.getByLabel(/Motion Model/)).toBeVisible();
  });

  test('video modes follow the model', async ({ page }) => {
    await page.goto('/videos');
    await waitForComposer(page);
    const mode = page.getByRole('combobox', { name: 'Video mode' });
    await mode.click();
    await page.getByRole('option', { name: 'Reference to video' }).click();
    await expect(
      page.getByRole('button', { name: 'Reference', exact: true })
    ).toBeVisible();
    await mode.click();
    await page.getByRole('option', { name: 'Image to video' }).click();
    await expect(
      page.getByRole('button', { name: 'Start frame' })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'End frame' })).toBeVisible();
  });

  test('signed-in user can open Models from the sidebar', async ({ page }) => {
    await page.goto('/');
    const models = page.getByRole('link', { name: 'Models', exact: true });
    // Production e2e builds leave MODELS_ENABLED off; the catalog is then
    // 404 and off the nav. Skip rather than wait 60s for a missing link.
    test.skip(
      (await models.count()) === 0,
      'Models catalog is flag-gated off in this build'
    );
    await models.click();
    await expect(page).toHaveURL(/\/models/);
    await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible();
  });

  test('/studio redirects to /images', async ({ page }) => {
    await page.goto('/studio');
    await expect(page).toHaveURL(/\/images/);
  });

  test('empty-prompt Generate offers a random prompt (#1393)', async ({
    page,
  }) => {
    await page.goto('/images');
    await waitForComposer(page);
    const generate = page.getByRole('button', { name: 'Generate image' });
    await expect(generate).toBeEnabled();
    await generate.click();
    const dialog = page.getByRole('alertdialog', {
      name: 'What should we make?',
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Try something random' })
    ).toBeVisible();
    await dialog.getByRole('button', { name: "I'll write it" }).click();
    await expect(dialog).toBeHidden();
  });

  test('Shuffle fills an empty image prompt', async ({ page }) => {
    await page.goto('/images');
    const editor = page.locator('[data-slot="markdown-editor"]');
    await expect(editor.locator('.ProseMirror')).toBeVisible({
      timeout: HYDRATION_TIMEOUT,
    });
    await expect(editor).toHaveAttribute('data-markdown', '');
    await page.getByRole('button', { name: 'Shuffle' }).click();
    await expect(editor).not.toHaveAttribute('data-markdown', '');
  });
});
