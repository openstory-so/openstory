import { E2E_COVERAGE, cleanClientCoverage } from './coverage';
import { startAimockServer } from './mocks/aimock-server';
import { startBytePlusAssetsMock } from './mocks/byteplus-assets-mock';

/**
 * Playwright global setup — aimock only (LLM/fal on :4010).
 *
 * Test D1 migrate + seed runs in `e2e/start-webserver.ts` *before* Workerd
 * starts. Doing it here races the vite Miniflare (SQLITE_BUSY_RECOVERY).
 */
export default async function globalSetup() {
  if (E2E_COVERAGE) cleanClientCoverage();
  await startAimockServer();
  if (process.env.E2E_RECORD !== '1') await startBytePlusAssetsMock();
}
