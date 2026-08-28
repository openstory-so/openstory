import { defineConfig, devices } from 'playwright/test';
import { E2E_RECORDING } from './e2e/recording-mode';

/**
 * Playwright E2E Test Configuration
 * Uses separate test.db for isolation, mocks AI/workflow responses
 */
export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  testDir: './e2e/tests',
  outputDir: './e2e/results',

  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,

  // Fail fast on CI
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,

  // Reporter configuration
  // CI: github for annotations + html for uploadable report
  // Local: html only
  reporter: process.env.CI ? [['github'], ['html']] : 'html',

  // Global test timeout. Recording mode hits live OpenRouter / fal so it needs
  // headroom; CI is slower than local; replay-only local is the fast path.
  timeout: E2E_RECORDING ? 600_000 : process.env.CI ? 60_000 : 30_000,

  // Default expect() timeout. Recording lets streaming/vision calls take their
  // time; replay keeps the snappy 5s default so flakes surface fast.
  expect: { timeout: E2E_RECORDING ? 60_000 : 5_000 },

  // Shared settings for all projects
  use: {
    baseURL: 'http://localhost:3001',
    viewport: { width: 1920, height: 1080 },
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: process.env.CI
      ? 'on-first-retry'
      : { mode: 'on', size: { width: 1920, height: 1080 } },
    // The app is dark regardless of OS scheme. colorScheme only affects
    // native form controls / UA chrome.
    colorScheme: 'dark',
  },

  // Configure projects
  projects: [
    // Setup project - authenticates once, saves state
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
    },
    // Auth tests - run without stored state to test actual login flow
    {
      name: 'auth',
      testMatch: /auth\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
      },
    },
    // All other tests - use stored auth state
    {
      name: 'chromium',
      testIgnore: /auth\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        storageState: 'e2e/.auth/user.json',
      },
      dependencies: ['setup'],
    },
  ],

  webServer: (() => {
    const fullPipeline = process.env.PLAYWRIGHT_FULL_PIPELINE === 'true';
    const useBuiltServer = process.env.E2E_BUILT === 'true';
    const envPrefix = [
      'E2E_TEST=true',
      // CLOUDFLARE_ENV activates wrangler.jsonc's [env.test] block under both
      // `vite dev` and `vite preview` (both go through @cloudflare/vite-plugin
      // which reads the source wrangler.jsonc with its nested env blocks).
      'CLOUDFLARE_ENV=test',
      // Forward this process's env into the Worker's getEnv()/process.env.
      // @cloudflare/vite-plugin builds the worker env from wrangler.jsonc `vars`
      // + `.env*`/`.dev.vars` and, by default, does NOT include the launcher's
      // process.env (unstable_getVarsForDev → includeProcessEnv defaults false).
      // Without this, the per-run flags below (E2E_FULL_PIPELINE, E2E_RECORD,
      // OPENROUTER_BASE_URL, FAL_PROXY_URL) set here never reach the worker — so
      // workflows were skipped and the record branch never fired. This only
      // affects text vars, not bindings, so the D1/R2 remote-binding safety net
      // is unaffected.
      'CLOUDFLARE_INCLUDE_PROCESS_ENV=true',
      ...(fullPipeline
        ? ['E2E_FULL_PIPELINE=true', 'FAL_PROXY_URL=http://localhost:4010/fal']
        : []),
      // Propagate the record flag so the dev server's adapter factory can
      // disable the OpenRouter SDK's retry loop — see create-adapter.ts. We
      // do this only when recording because aimock buffers SSE responses
      // upstream, which can trip the SDK's retry path and produce duplicate
      // fixture writes for the same prompt.
      ...(process.env.E2E_RECORD === '1' ? ['E2E_RECORD=1'] : []),
      'PORT=3001',
      'VITE_APP_URL=http://localhost:3001',
      'OPENROUTER_BASE_URL=http://localhost:4010',
      'VITE_DISABLE_DEVTOOLS=true',
    ].join(' ');

    // The dev server runs the app inside Workerd via @cloudflare/vite-plugin,
    // matching production at the runtime layer. E2E_BUILT=true switches to
    // `vite preview` against a production-built worker — CI uses this to
    // catch bundling regressions; local keeps `vite dev` for HMR.
    //
    // Both paths read bindings from wrangler.jsonc [env.test]: an isolated
    // D1 (openstory-test) and isolated R2 buckets backed by Miniflare local
    // state in .wrangler/state/.
    //
    // Why `vite preview` (not `wrangler dev`)? Both serve a built worker,
    // but `wrangler dev` spawns a *separate* Node + Workerd process with its
    // own Miniflare. Historically, e2e fixtures also spawned Miniflare via
    // getPlatformProxy for direct D1 access, causing SQLITE_BUSY lock races
    // on the shared .wrangler D1 SQLite under parallel workers. All direct DB
    // access from playwright fixtures has been migrated to the guarded
    // /api/test/* routes (which execute inside the single in-process Miniflare
    // of the vite server). Migrate/seed runs in start-webserver.ts *before*
    // vite so a second Miniflare is never opened against a live Workerd D1
    // (SQLITE_BUSY_RECOVERY). `vite preview` still provides consistent
    // built-server testing.
    return {
      command: useBuiltServer
        ? `${envPrefix} bun e2e/start-webserver.ts preview --port=3001`
        : `${envPrefix} bun e2e/start-webserver.ts dev --port=3001`,
      // Wait for the TCP port, not an HTTP 2xx — SSR errors should surface to
      // the individual specs via `page.goto()` rather than fail server boot.
      port: 3001,
      reuseExistingServer: !useBuiltServer,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
    };
  })(),
});
