import { test as base } from 'playwright/test';
import { E2E_COVERAGE, addClientCoverage } from '../coverage';

export { expect } from 'playwright/test';

/** Playwright `test` that records browser coverage under E2E_COVERAGE (#2243). */
export const test = base.extend({
  page: async ({ page }, use) => {
    if (!E2E_COVERAGE) return use(page);
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    await addClientCoverage(await page.coverage.stopJSCoverage());
  },
});
