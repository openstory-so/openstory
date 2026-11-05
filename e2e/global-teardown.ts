import { E2E_COVERAGE, dumpCoverage } from './coverage';
import { stopAimockServer } from './mocks/aimock-server';

/**
 * Playwright global teardown - stops aimock after all tests complete.
 */
export default async function globalTeardown() {
  if (E2E_COVERAGE) await dumpCoverage();
  await stopAimockServer();
}
