import type { Page } from 'playwright/test';
import { expect, test } from '../fixtures/auth.fixture';

const HYDRATION_TIMEOUT = 15_000;

/** The composer is server-rendered; wait for TipTap to mount before clicking. */
async function waitForComposer(page: Page): Promise<void> {
  await expect(
    page.locator('[data-slot="markdown-editor"] .ProseMirror')
  ).toBeVisible({ timeout: HYDRATION_TIMEOUT });
}

test.describe('Images and Clips studio', () => {
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

  test('signed-in user can open Clips from the sidebar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Clips', exact: true }).click();
    await expect(page).toHaveURL(/\/clips/);
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
    await page.goto('/clips');
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

  test('reference modal offers freehand drawing on images', async ({
    page,
  }) => {
    await page.goto('/images');
    await waitForComposer(page);
    await page.getByRole('button', { name: 'Reference', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add reference' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Draw' }).click();
    await expect(dialog.getByLabel('Drawing canvas')).toBeVisible();
    const add = dialog.getByRole('button', { name: 'Add drawing' });
    const erase = dialog.getByRole('button', { name: 'Erase' });
    const undo = dialog.getByRole('button', { name: 'Undo' });
    await expect(add).toBeDisabled();
    await expect(undo).toBeDisabled();
    await expect(erase).toBeDisabled();

    const box = await dialog.getByLabel('Drawing canvas').boundingBox();
    if (!box) throw new Error('Drawing canvas has no box');
    const stroke = async () => {
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, {
        steps: 5,
      });
      await page.mouse.up();
    };

    await stroke();
    await expect(add).toBeEnabled();
    await expect(erase).toBeEnabled();

    // Rubbing out or clearing everything leaves nothing to add, and the
    // eraser cannot be the tool on a blank canvas.
    await erase.click();
    await dialog.getByRole('button', { name: 'Clear' }).click();
    await expect(add).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Pen' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await undo.click();
    // Not clicked: the upload runs the real-person classifier, which has no
    // recorded fixture.
    await expect(add).toBeEnabled();
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

  test('remembered support mode does not break a non-admin list', async ({
    page,
  }) => {
    await page.goto('/images');
    await page.evaluate(() => {
      localStorage.setItem(
        'openstory:studio-list:v1',
        JSON.stringify({
          search: '',
          supportMode: true,
          hideInternal: false,
        })
      );
    });
    await page.goto('/images');

    await expect(
      page.getByRole('button', { name: 'Generate image' })
    ).toBeVisible({ timeout: HYDRATION_TIMEOUT });
    await expect(page.getByText('Failed to load')).toHaveCount(0);
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

  test('a long image prompt does not cover the gallery (#1474)', async ({
    page,
  }) => {
    await page.goto('/images');
    await waitForComposer(page);
    const editor = page.locator('[data-testid="studio-prompt"] .ProseMirror');
    const longPrompt = Array.from(
      { length: 40 },
      (_, i) =>
        `Line ${i + 1}: a detailed still that would otherwise cover the results.`
    ).join('\n');
    await editor.fill(longPrompt);

    const pane = page.getByTestId('studio-composer-pane');
    const viewport = page.viewportSize();
    const box = await pane.boundingBox();
    expect(box?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(
      (viewport?.height ?? 0) * 0.75
    );
    await expect(
      page.getByRole('link', { name: 'Favorites' })
    ).toBeInViewport();
    await expect(
      page.getByRole('button', { name: 'Generate image' })
    ).toBeInViewport();
  });
});
