/**
 * Pages no other spec visits (#2243): settings, credits, legal, docs, connect,
 * a sequence's assets and history, and the routes that only redirect.
 */
import { expect, test } from '../fixtures/auth.fixture';
import { test as anonymousTest } from '../fixtures/base';
import { createTestSequence } from '../fixtures/sequence.fixture';
import { HYDRATION_TIMEOUT, waitForHydration } from '../fixtures/test-utils';

const signedOut = anonymousTest;

test.describe('Settings and credits', () => {
  test('settings tabs render and the provider form takes input', async ({
    page,
  }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings\/api-keys/);
    await expect(page.getByText('API Keys').first()).toBeVisible();
    await expect(page.getByText('Publishing').first()).toBeVisible();
    await page.getByPlaceholder('fal_...').fill('fal_not-saved');

    await page.goto('/settings/organization');
    await expect(page.getByText('Members').first()).toBeVisible();
    await expect(page.getByText('Pending invitations').first()).toBeVisible();

    await page.goto('/settings/passkeys?setup=true');
    await expect(page.getByText('Set up a passkey').first()).toBeVisible();
    await page.goto('/settings/passkeys');
    await expect(page.getByText('No passkeys registered yet')).toBeVisible();
  });

  test('credits tabs switch and keep the tab in the URL', async ({ page }) => {
    await page.goto('/credits');
    await waitForHydration(page, '[role="tablist"]');
    await page.getByRole('tab', { name: 'Transactions' }).click();
    await expect(page).toHaveURL(/tab=transactions/);
    await page.getByRole('tab', { name: 'Gift Codes' }).click();
    await expect(page).toHaveURL(/tab=gift-codes/);
    await expect(page.getByPlaceholder('Enter code…')).toBeVisible();
  });

  test('pricing offers credits behind a dialog', async ({ page }) => {
    await page.goto('/pricing');
    await expect(page.getByRole('heading', { name: 'Pricing' })).toBeVisible();
    await waitForHydration(page, 'main button');
    await page.getByRole('button', { name: 'Add credits' }).first().click();
    await expect(page.getByText('Add to credit balance')).toBeVisible({
      timeout: HYDRATION_TIMEOUT,
    });
  });
});

test.describe('A sequence', () => {
  test('assets switch scope, history is empty, old tabs redirect', async ({
    page,
    testUser,
  }) => {
    const { id } = await createTestSequence(
      testUser.organizationId,
      testUser.id,
      'Pages sequence'
    );

    await page.goto(`/sequences/${id}/assets`);
    await expect(page.getByText('Pull command').first()).toBeVisible({
      timeout: HYDRATION_TIMEOUT,
    });
    await waitForHydration(page, 'main button');
    await page.getByText('All versions').click();
    await expect(page).toHaveURL(/scope=history/);
    await page.getByRole('button', { name: 'Include renders' }).click();
    await expect(page).toHaveURL(/exports=true/);

    await page.goto(`/sequences/${id}/history`);
    await expect(page.getByText('Nothing has happened yet.')).toBeVisible({
      timeout: HYDRATION_TIMEOUT,
    });

    for (const [from, to] of [
      ['music', /scenes\?facet=music/],
      ['cast', /scenes\?facet=cast/],
      ['elements', /scenes\?facet=elements/],
      ['locations', /scenes\?facet=location/],
      ['theatre', /\/scenes/],
    ] as const) {
      await page.goto(`/sequences/${id}/${from}`);
      await expect(page).toHaveURL(to);
    }
  });
});

signedOut.describe('Public pages', () => {
  signedOut.use({ storageState: { cookies: [], origins: [] } });

  signedOut('legal pages and the report form', async ({ page }) => {
    await page.goto('/privacy');
    await expect(
      page.getByRole('heading', { name: 'Privacy Policy' })
    ).toBeVisible();
    await page.goto('/terms');
    await expect(
      page.getByRole('heading', { name: 'Terms of Service' })
    ).toBeVisible();

    await page.goto('/report');
    await waitForHydration(page, 'form');
    await page.getByRole('button', { name: 'Submit report' }).click();
    await expect(page.getByText('Choose a reason').first()).toBeVisible();
  });

  signedOut('connect switches between agents', async ({ page }) => {
    await page.goto('/connect');
    await expect(
      page.getByRole('heading', { name: 'OpenStory in your agent' })
    ).toBeVisible();
    await waitForHydration(page, '[role="tablist"]');
    await page.getByRole('tab', { name: 'ChatGPT' }).click();
    await expect(page).toHaveURL(/tab=chatgpt/);
    await page.getByRole('tab', { name: 'CLI' }).click();
    await expect(
      page.getByRole('tablist', { name: 'Coding agent' })
    ).toBeVisible();
  });

  signedOut('styles search and the gallery', async ({ page }) => {
    await page.goto('/styles');
    await expect(page.getByRole('heading', { name: 'Styles' })).toBeAttached();
    await waitForHydration(page, 'input');
    await page.getByLabel('Search styles').fill('zzz-no-such-style');
    await expect(page.getByText('No styles found')).toBeVisible();
    await page.goto('/gallery');
    await expect(page.getByRole('heading', { name: 'Gallery' })).toBeAttached();
  });

  signedOut(
    'docs pages, the FAQ and the dependency graph',
    async ({ page }) => {
      await page.goto('/docs');
      await expect(page).toHaveURL(/\/docs\/user-guide\/creating-sequences/);
      for (const [slug, title] of [
        ['user-guide/scenes', 'Working with Scenes'],
        ['user-guide/cast', 'Cast & Characters'],
        ['developer-guide/public-api', 'Public API'],
        ['support/contact-us', 'Contact Us'],
      ] as const) {
        await page.goto(`/docs/${slug}`);
        await expect(
          page.getByRole('heading', { name: title }).first()
        ).toBeVisible();
      }
      await page.goto('/docs/no-such-page');
      await expect(
        page.getByRole('heading', { name: 'Page not found' })
      ).toBeVisible();
      await page.goto('/docs/faq');
      await expect(page).toHaveTitle(/Frequently Asked Questions/);
      await page.goto('/docs/dependency-graph');
      await expect(
        page.getByRole('heading', { name: 'What "Update all" regenerates' })
      ).toBeVisible();
      const llms = await page.request.get('/docs/llms.md');
      expect(llms.ok()).toBe(true);
    }
  );

  signedOut('a gift link asks a visitor to sign in', async ({ page }) => {
    await page.goto('/gift/ABC123');
    await expect(page.getByText('Credits incoming!')).toBeVisible();
    await page.getByRole('link', { name: 'Sign in to redeem' }).click();
    await expect(page).toHaveURL(/\/login\?redirectTo=/);
  });

  signedOut('signed-out visitors are sent to sign in', async ({ page }) => {
    for (const path of ['/settings/api-keys', '/credits', '/oauth/consent']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login\?redirectTo=/);
    }
  });
});

test('OAuth consent with no request explains itself', async ({ page }) => {
  await page.goto('/oauth/consent');
  await expect(
    page.getByText(
      'This page is missing its authorization request. Start again from the app that sent you here.'
    )
  ).toBeVisible({ timeout: HYDRATION_TIMEOUT });
});
