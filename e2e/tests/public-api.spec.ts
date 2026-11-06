/**
 * Public API end to end (#2243): a developer key made in Settings, the
 * `/api/v1` resources it reads, the device login an agent uses, and revoking.
 */
import type { APIRequestContext, Page } from 'playwright/test';
import { z } from 'zod';
import { expect, test } from '../fixtures/auth.fixture';
import { createTestSequence } from '../fixtures/sequence.fixture';
import { HYDRATION_TIMEOUT, waitForHydration } from '../fixtures/test-utils';

const anonymous = async (playwright: {
  request: { newContext: (o: object) => Promise<APIRequestContext> };
}) =>
  playwright.request.newContext({
    baseURL: 'http://localhost:3020',
    storageState: { cookies: [], origins: [] },
  });

async function createKey(page: Page, name: string): Promise<string> {
  await page.goto('/settings/developer');
  await waitForHydration(page, 'form');
  await page.getByPlaceholder('Key name (e.g. Production server)').fill(name);
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect(page.getByText(`Key “${name}” created`)).toBeVisible();
  const key = (
    await page.locator('code').filter({ hasText: 'osk_' }).textContent()
  )?.trim();
  expect(key).toMatch(/^osk_/);
  await page.getByRole('button', { name: 'Done' }).click();
  return key ?? '';
}

test.describe('Public API', () => {
  test('a developer key reads sequences and styles, and stops working once revoked', async ({
    page,
    playwright,
    testUser,
  }) => {
    const sequence = await createTestSequence(
      testUser.organizationId,
      testUser.id,
      'Public API sequence'
    );
    const key = await createKey(page, 'E2E key');
    const keyed = await playwright.request.newContext({
      baseURL: 'http://localhost:3020',
      storageState: { cookies: [], origins: [] },
      extraHTTPHeaders: { authorization: `Bearer ${key}` },
    });
    // The key limiter (10 per window) resets only after a 1s quiet gap, and
    // an asset manifest spends about three of them.
    let calls = 0;
    const pace = () =>
      ++calls % 3 === 0
        ? new Promise((r) => setTimeout(r, 1100))
        : Promise.resolve();
    const api = {
      get: async (url: string) => {
        await pace();
        return keyed.get(url);
      },
      post: async (url: string, options: { data: unknown }) => {
        await pace();
        return keyed.post(url, options);
      },
    };

    const root = await api.get('/api/v1');
    expect(root.ok()).toBe(true);
    expect(JSON.stringify(await root.json())).toContain('_links');

    const openapi = await api.get('/api/v1/openapi.json');
    expect((await openapi.json()).openapi).toMatch(/^3\./);

    const list = await api.get('/api/v1/sequences');
    expect(JSON.stringify(await list.json())).toContain(sequence.id);

    const one = await api.get(`/api/v1/sequences/${sequence.id}`);
    expect((await one.json()).title).toBe('Public API sequence');

    const assets = await api.get(`/api/v1/sequences/${sequence.id}/assets`);
    expect(assets.ok()).toBe(true);
    const history = await api.get(
      `/api/v1/sequences/${sequence.id}/assets?scope=history&exports=true`
    );
    expect(history.ok()).toBe(true);

    const exports = await api.get(`/api/v1/sequences/${sequence.id}/exports`);
    expect(exports.ok(), await exports.text()).toBe(true);
    // No clip is rendered, so there is nothing to export.
    const render = await api.post(`/api/v1/sequences/${sequence.id}/exports`, {
      data: {},
    });
    expect(render.ok()).toBe(false);

    const styles = await api.get('/api/v1/styles');
    const styleList = await styles.json();
    expect(styles.ok()).toBe(true);
    const firstStyle = JSON.stringify(styleList).match(
      /"id":"([0-9A-HJKMNP-TV-Z]{26})"/
    )?.[1];
    expect(firstStyle).toBeTruthy();
    expect((await api.get(`/api/v1/styles/${firstStyle}`)).ok()).toBe(true);

    // Bad input is a 4xx with a reason, never a 500.
    const missing = await api.get(
      '/api/v1/sequences/01NOTAREALSEQUENCE00000000'
    );
    expect(missing.status()).toBe(404);
    const badCreate = await api.post('/api/v1/sequences', {
      data: { script: '' },
    });
    expect(badCreate.status()).toBeGreaterThanOrEqual(400);
    expect(badCreate.status()).toBeLessThan(500);
    const badStyle = await api.post('/api/v1/styles', { data: {} });
    expect(badStyle.status()).toBeGreaterThanOrEqual(400);
    expect(badStyle.status()).toBeLessThan(500);
    const badEnhance = await api.post('/api/v1/scripts/enhance', { data: {} });
    expect(badEnhance.status()).toBeGreaterThanOrEqual(400);
    expect(badEnhance.status()).toBeLessThan(500);

    // Revoke it in Settings; the same key is then refused.
    await page.goto('/settings/developer');
    await waitForHydration(page, '[aria-label="Revoke E2E key"]');
    await page.getByRole('button', { name: 'Revoke E2E key' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /Revoke/ })
      .click();
    await expect(
      page.getByRole('button', { name: 'Revoke E2E key' })
    ).toHaveCount(0);
    expect((await api.get('/api/v1/sequences')).status()).toBe(401);
    await keyed.dispose();
  });

  test('a request with no key is refused', async ({ playwright }) => {
    const api = await anonymous(playwright);
    expect((await api.get('/api/v1/sequences')).status()).toBe(401);
    const wrong = await api.get('/api/v1/sequences', {
      headers: { authorization: 'Bearer osk_not-a-real-key' },
    });
    expect(wrong.status()).toBe(401);
    await api.dispose();
  });

  test('device login: approving gives the agent a key, denying refuses it', async ({
    page,
    playwright,
  }) => {
    const agent = await anonymous(playwright);

    const start = async () => {
      const res = await agent.post('/api/v1/device/code');
      expect(res.ok()).toBe(true);
      return z
        .object({
          device_code: z.string(),
          user_code: z.string(),
          verification_url_complete: z.string(),
        })
        .parse(await res.json());
    };
    // `wait` long-polls, so a poll sooner than the interval is not 429.
    const poll = (deviceCode: string, wait = 0) =>
      agent.get(
        `/api/v1/device/token?device_code=${encodeURIComponent(deviceCode)}&wait=${wait}s`
      );

    const approved = await start();
    expect((await poll(approved.device_code)).status()).toBe(428);
    await page.goto(approved.verification_url_complete);
    await expect(page.getByText(approved.user_code)).toBeVisible();
    await waitForHydration(page, 'form');
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText(/^Approved\./)).toBeVisible({
      timeout: HYDRATION_TIMEOUT,
    });
    const token = await poll(approved.device_code, 5);
    expect(token.status()).toBe(200);
    const { api_key } = z
      .object({ api_key: z.string() })
      .parse(await token.json());
    const me = await agent.get('/api/v1/sequences', {
      headers: { authorization: `Bearer ${api_key}` },
    });
    expect(me.ok()).toBe(true);
    // A code is good for one key only.
    expect((await poll(approved.device_code, 5)).status()).toBe(410);

    const denied = await start();
    await page.goto('/device');
    await waitForHydration(page, 'form');
    await page.getByPlaceholder('ABCD-EFGH').fill(denied.user_code);
    await page.getByPlaceholder('ABCD-EFGH').press('Enter');
    await page.getByRole('button', { name: 'Deny' }).click();
    await expect(page.getByText(/^Denied\./)).toBeVisible({
      timeout: HYDRATION_TIMEOUT,
    });
    expect((await poll(denied.device_code, 5)).status()).toBe(403);

    await page.goto('/device?user_code=NOPE-NOPE');
    await expect(page.getByText(/isn’t valid/)).toBeVisible();
    await agent.dispose();
  });

  test('a key that calls too fast is told to slow down', async ({
    page,
    playwright,
  }) => {
    const key = await createKey(page, 'E2E burst key');
    const api = await playwright.request.newContext({
      baseURL: 'http://localhost:3020',
      storageState: { cookies: [], origins: [] },
      extraHTTPHeaders: { authorization: `Bearer ${key}` },
    });
    const statuses = await Promise.all(
      Array.from({ length: 15 }, () =>
        api.get('/api/v1/styles').then((r) => r.status())
      )
    );
    expect(statuses).toContain(200);
    expect(statuses).toContain(429);
    await api.dispose();
  });
});
