import { startAimockServer } from './mocks/aimock-server';

/**
 * Playwright global setup — aimock only (LLM/fal on :4010).
 *
 * Test D1 migrate + seed runs in `e2e/start-webserver.ts` *before* Workerd
 * starts. Doing it here races the vite Miniflare (SQLITE_BUSY_RECOVERY).
 */
export default async function globalSetup() {
  await startAimockServer();
}
