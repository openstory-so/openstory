/**
 * Sequences E2E Tests
 * Tests sequence creation and viewing flows.
 *
 * Runs under the chromium project with storageState (signed-in). Anonymous
 * routing for `/` and `/sequences/new` is covered in auth.spec.ts.
 */

import { test, expect } from 'playwright/test';
import { fillScriptEditor, waitForScriptEditor } from '../fixtures/test-utils';

test.describe('Sequences', () => {
  test('can access sequences list page', async ({ page }) => {
    await page.goto('/sequences');

    await expect(page).toHaveURL(/\/sequences/);
  });

  test('restores remembered search when returning to a bare /sequences', async ({
    page,
  }) => {
    await page.goto('/sequences');
    await page.evaluate(() => {
      localStorage.setItem(
        'openstory:sequences-list:v1',
        JSON.stringify({
          search: 'night diner',
          analysisModel: null,
          imageModel: null,
          aspectRatio: '9:16',
          styleId: null,
          supportMode: false,
          hideInternal: false,
        })
      );
    });
    await page.goto('/sequences');

    await expect
      .poll(() => new URL(page.url()).searchParams.get('q'))
      .toBe('night diner');
    await expect
      .poll(() => new URL(page.url()).searchParams.get('aspectRatio'))
      .toBe('9:16');
    await expect(
      page.getByRole('textbox', { name: 'Search by title…' })
    ).toHaveValue('night diner');
  });

  test('remembered support mode does not break a non-admin list', async ({
    page,
  }) => {
    await page.goto('/sequences');
    await page.evaluate(() => {
      localStorage.setItem(
        'openstory:sequences-list:v1',
        JSON.stringify({
          search: '',
          analysisModel: null,
          imageModel: null,
          aspectRatio: null,
          styleId: null,
          supportMode: true,
          hideInternal: false,
        })
      );
    });
    await page.goto('/sequences');

    await expect(
      page.getByRole('textbox', { name: 'Search by title…' })
    ).toBeVisible();
    await expect(page.getByText('Failed to load sequences')).toHaveCount(0);
  });

  test('home page has script input', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveURL('/');
    // The script field is a TipTap-backed contenteditable wrapped in the
    // MarkdownEditor component. Target it by data-slot so the assertion is
    // resilient to internal ProseMirror DOM shape.
    const editor = page.locator('[data-slot="markdown-editor"]');
    await expect(editor).toBeVisible();
  });

  test('long multi-scene script scrolls inside the editor', async ({
    page,
  }) => {
    await page.goto('/');
    const prose = await waitForScriptEditor(page);
    const script = Array.from(
      { length: 30 },
      (_, i) => `INT. SCENE ${i + 1} - NIGHT\n\nAction line ${i + 1}.`
    ).join('\n\n');

    await prose.click();
    await page.keyboard.press('ControlOrMeta+A');
    await prose.evaluate((el, text) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
      el.dispatchEvent(ev);
    }, script);

    const paragraphs = page.locator(
      '[data-slot="markdown-editor"] .ProseMirror p'
    );
    await expect(paragraphs).toHaveCount(60);

    const editor = page.locator('[data-slot="markdown-editor"]');
    const metrics = await editor.evaluate((el) => {
      el.scrollTop = 400;
      return {
        canScroll: el.scrollHeight > el.clientHeight + 1,
        scrollTopAfter: el.scrollTop,
      };
    });
    expect(metrics.canScroll).toBe(true);
    expect(metrics.scrollTopAfter).toBeGreaterThan(100);
  });

  test('composer starts empty with Match script selected, not Action', async ({
    page,
  }) => {
    await page.goto('/');
    await page.evaluate(() =>
      localStorage.removeItem('openstory:sequence-draft:v1')
    );
    await page.reload();
    await waitForScriptEditor(page);
    await expect(
      page.getByRole('button', { name: 'Style category: Film & Cinematic' })
    ).toBeVisible({ timeout: 15_000 });
    // Hydrated empty state — not just first-paint placeholder (the old
    // sample seed ran after styles/draft settled).
    await expect(page.locator('[data-slot="markdown-editor"]')).toHaveAttribute(
      'data-markdown',
      ''
    );
    await expect(
      page.getByText('Paste a screenplay, or a one-liner we can expand.')
    ).toBeVisible();
    const automatic = page.getByRole('button', {
      name: 'Match script: derive a style from the script',
    });
    await expect(automatic).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.getByRole('button', { name: 'Select Action style' })
    ).toBeVisible();
    const generate = page.getByRole('button', {
      name: 'Generate',
      exact: true,
    });
    await expect(generate).toBeDisabled();
    // ⌘+Enter requestSubmit()s even while Generate is disabled.
    await page.locator('[data-slot="markdown-editor"] .ProseMirror').click();
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    await fillScriptEditor(page, 'A cat walks into a diner at dawn.');
    await expect(automatic).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.getByRole('button', { name: 'Select Action style' })
    ).toBeVisible();
    await expect(generate).toBeEnabled();
  });

  test('typing still works when motion/audio catalog pricing is missing', async ({
    page,
  }) => {
    // #1354: Generate's ActionCost floors unpriced motion/audio. That used to
    // call getPostHogClient() (createServerOnlyFn) on every keystroke.
    await page.route('**/_serverFn/**', async (route) => {
      const id = route.request().url().split('/_serverFn/')[1]?.split('?')[0];
      let decoded = '';
      try {
        decoded = Buffer.from(id ?? '', 'base64url').toString();
      } catch {
        decoded = '';
      }
      if (!decoded.includes('getCatalogFalPricingFn')) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          result: {
            'openai/gpt-image-2': {
              unitPriceMicros: 1_000_000,
              unit: 'units',
              typicalUnitsPerCall: 0.22,
            },
          },
        }),
      });
    });

    await page.goto('/');
    await fillScriptEditor(page, 'A cat walks into a diner at dawn.');
    await expect(
      page.getByRole('button', { name: 'Generate', exact: true })
    ).toBeEnabled();
  });

  test('Try-this-style URL seeds the style sample, not Match script', async ({
    page,
  }) => {
    await page.goto('/?style=product-ad');
    await waitForScriptEditor(page);
    await expect(
      page.getByRole('button', { name: 'View Product Ad details' })
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole('button', {
        name: 'Match script: derive a style from the script',
      })
    ).toHaveAttribute('aria-pressed', 'false');
    await expect(
      page.locator('[data-slot="markdown-editor"]')
    ).not.toHaveAttribute('data-markdown', '');
  });

  test('composer style row defaults to cinematic and can switch family', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'Style category: Film & Cinematic' })
    ).toBeVisible({ timeout: 15_000 });
    // Switching family still auto-selects that family's first style; a
    // selected tile relabels from "Select … style" to "View … details".
    await page.getByRole('button', { name: /^Style category:/ }).click();
    await page.getByRole('menuitemradio', { name: 'E-commerce' }).click();
    await expect(
      page.getByRole('button', { name: 'View Product Ad details' })
    ).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: 'Match script: derive a style from the script',
      })
    ).toHaveAttribute('aria-pressed', 'false');
  });

  test('signed-in user can access /sequences/new', async ({ page }) => {
    // chromium project loads e2e/.auth/user.json — this is the logged-in alias
    // of the home composer (#1104). Anonymous redirect is in auth.spec.ts.
    await page.goto('/sequences/new');

    await expect(page).toHaveURL('/sequences/new');
    const editor = page.locator('[data-slot="markdown-editor"]');
    await expect(editor).toBeVisible();
  });
});
