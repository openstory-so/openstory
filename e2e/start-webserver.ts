/**
 * Playwright webServer launcher.
 *
 * Migrate + seed the test D1 *before* Workerd opens it. Playwright starts
 * this process first, then globalSetup; if seed ran in globalSetup it would
 * open a second Miniflare against the same SQLite while vite already holds
 * it (SQLITE_BUSY_RECOVERY, workerd dies, every spec gets connection refused).
 *
 * Args after the script name are forwarded to vite (e.g. `dev --port=3001`).
 */

import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';

execFileSync('bun', ['scripts/migrate-local-d1.ts', '--test'], {
  stdio: 'inherit',
});
execFileSync('bun', ['scripts/seed.ts', '--test'], {
  stdio: 'inherit',
});

const vite = resolve(process.cwd(), 'node_modules/.bin/vite');
const child = spawn(vite, process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env,
});

const shutdown = (signal: NodeJS.Signals) => {
  if (!child.killed) child.kill(signal);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
