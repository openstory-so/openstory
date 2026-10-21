/**
 * `bun dev` / `bun dev:all`. Runs ensure-env in this process, then starts the
 * app with that process's env. A shell `&&` would not: Bun autoloads
 * `.env.local` into the parent before ensure-env rewrites PORT, and the next
 * command inherits the stale value.
 */
import { spawn, spawnSync } from 'node:child_process';

await import('./ensure-env.ts');

const all = process.argv.includes('--all');
if (all) {
  process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'true';
  // dev:bunny pins the renderer to 8080; it would otherwise inherit the
  // app's PORT from .env.local and collide with it.
  process.env.VIDEO_EXPORT_DEV_URL = 'http://localhost:8080';
  // The renderer runs on this machine: it fetches clips from the app here,
  // not through VITE_APP_URL, which is the dev tunnel when one is set up.
  process.env.VIDEO_EXPORT_DEV_MEDIA_ORIGIN = `http://localhost:${process.env.PORT ?? 3000}`;
}

// Ctrl-C reaches the whole process group. Stay alive until the child has
// shut down, so the shell prompt does not come back under its output.
process.on('SIGINT', () => {});

const interrupted = (r: { status: number | null; signal: string | null }) =>
  r.signal === 'SIGINT' || r.status === 130;

const finish = (r: { status: number | null; signal: string | null }) =>
  process.exit(interrupted(r) ? 0 : (r.status ?? 1));

if (!all) {
  // `bun dev` runs dev:app's steps here rather than through nested `bun run`
  // scripts: each `bun run` layer reports Ctrl-C's 130 as an error.
  for (const args of [
    ['scripts/migrate-local-d1.ts'],
    ['scripts/seed.ts', '--local'],
    ['scripts/build-content-collections.ts'],
  ]) {
    const r = spawnSync('bun', args, {
      stdio: 'inherit',
      env: process.env,
    });
    if (r.status !== 0) finish(r);
  }
}

const child = spawn(
  all ? 'bun' : 'node_modules/.bin/vite',
  all ? ['run', '--parallel', 'dev:app', 'stripe:dev', 'dev:bunny'] : ['dev'],
  { stdio: 'inherit', env: process.env }
);

child.on('exit', (status, signal) => finish({ status, signal }));
