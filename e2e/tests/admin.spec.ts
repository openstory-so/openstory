/**
 * Admin and moderation (#2243): a system admin makes a gift code a user
 * redeems, triages a content report a user filed, and reads the usage table.
 */
import type { Browser, Page } from 'playwright/test';
import {
  authenticateUser,
  createTestUser,
  expect,
  test,
} from '../fixtures/auth.fixture';
import { HYDRATION_TIMEOUT, waitForHydration } from '../fixtures/test-utils';

async function signedIn(
  browser: Browser,
  options: { admin?: boolean; name?: string }
): Promise<{ page: Page; email: string; close: () => Promise<void> }> {
  const user = await createTestUser(options);
  const context = await browser.newContext({
    baseURL: 'http://localhost:3020',
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await authenticateUser(page, user.email);
  return { page, email: user.email, close: () => context.close() };
}

// One fixed admin address, so these run one at a time.
test.describe.configure({ mode: 'serial' });

test.describe('Admin', () => {
  test('a gift code an admin creates adds credit to a user', async ({
    browser,
  }) => {
    const admin = await signedIn(browser, { admin: true, name: 'E2E Admin' });
    await admin.page.goto('/credits?tab=gift-codes');
    await expect(admin.page.getByText('Create Gift Code').first()).toBeVisible({
      timeout: HYDRATION_TIMEOUT,
    });
    await waitForHydration(admin.page, '#gift-amount');
    await admin.page.locator('#gift-amount').fill('7');
    await admin.page.locator('#gift-note').fill('E2E gift');
    await admin.page.getByRole('button', { name: 'Create Gift Code' }).click();
    const created = admin.page.getByText('Gift code created:');
    await expect(created).toBeVisible({ timeout: HYDRATION_TIMEOUT });
    const code = (await created.locator('.font-mono').textContent())?.trim();
    expect(code).toBeTruthy();
    await expect(
      admin.page.getByText('All gift codes created by admins')
    ).toBeVisible();

    const user = await signedIn(browser, { name: 'E2E Gift Receiver' });
    await user.page.goto(`/gift/${code}`);
    // The new user's $100 test balance, plus the gift.
    await expect(user.page.getByText('$107.00')).toBeVisible({
      timeout: HYDRATION_TIMEOUT,
    });
    // A code is single-use by default: a second redemption is refused.
    await user.page.goto(`/gift/${code}`);
    await expect(
      user.page.getByText('You already redeemed this gift code.').first()
    ).toBeVisible({ timeout: HYDRATION_TIMEOUT });

    await user.close();
    await admin.close();
  });

  test('a report a user files is triaged and closed by an admin', async ({
    browser,
  }) => {
    const reporter = await signedIn(browser, { name: 'E2E Reporter' });
    const details = `E2E report ${Date.now()}: this clip uses my face.`;
    await reporter.page.goto('/report');
    await waitForHydration(reporter.page, 'form');
    await reporter.page.locator('#reason').click();
    await reporter.page
      .getByRole('option', { name: 'Uses my likeness without permission' })
      .click();
    await reporter.page
      .getByPlaceholder('https://… or OS-01J…')
      .fill('https://openstory.so/stitch/01NOTAREALSTITCH0000000000');
    await reporter.page.locator('#details').fill(details);
    await reporter.page.getByRole('button', { name: 'Submit report' }).click();
    await expect(reporter.page.getByText(/^Reference /).first()).toBeVisible({
      timeout: HYDRATION_TIMEOUT,
    });
    await reporter.close();

    const admin = await signedIn(browser, { admin: true, name: 'E2E Admin' });
    await admin.page.goto('/admin/moderation');
    const report = admin.page.getByText(details);
    await expect(report).toBeVisible({ timeout: HYDRATION_TIMEOUT });
    // Earlier runs leave reports behind; act on this run's card only.
    const card = admin.page
      .locator('div')
      .filter({ has: report })
      .filter({ has: admin.page.getByRole('button', { name: 'Mark triaged' }) })
      .last();
    await card.getByRole('button', { name: 'Mark triaged' }).click();
    await card.getByRole('button', { name: 'Close as actioned' }).click();
    await expect(report).toHaveCount(0, { timeout: HYDRATION_TIMEOUT });

    await admin.page.getByRole('tab', { name: 'Trace content' }).click();
    await admin.page
      .getByPlaceholder(/OS-01J… · videos/)
      .fill('01NOTAREALSHOT000000000000');
    await admin.page.getByPlaceholder(/OS-01J… · videos/).press('Enter');
    await admin.close();
  });

  test('the usage table lists users and filters by email', async ({
    browser,
  }) => {
    const admin = await signedIn(browser, { admin: true, name: 'E2E Admin' });
    await admin.page.goto('/admin/usage');
    const search = admin.page.getByPlaceholder(
      'Search by name, email, or organization...'
    );
    await expect(search).toBeVisible({ timeout: HYDRATION_TIMEOUT });
    await expect(admin.page.getByText(admin.email).first()).toBeVisible();
    await search.fill(admin.email);
    await expect(
      admin.page.getByRole('link', {
        name: `Open sequence support view for ${admin.email}`,
      })
    ).toBeVisible();
    await search.fill('nobody-matches-this@e2e.test');
    await expect(
      admin.page.getByRole('link', {
        name: `Open sequence support view for ${admin.email}`,
      })
    ).toHaveCount(0);
    await admin.close();
  });

  test('a non-admin is turned away from admin pages', async ({ page }) => {
    await page.goto('/admin/usage');
    await expect(page).not.toHaveURL(/\/admin\/usage/, {
      timeout: HYDRATION_TIMEOUT,
    });
  });
});
