/**
 * `bun dev` / `bun dev:all`. Runs ensure-env in this process, then starts the
 * app with that process's env. A shell `&&` would not: Bun autoloads
 * `.env.local` into the parent before ensure-env rewrites PORT, and the next
 * command inherits the stale value.
 */
import { spawn } from 'node:child_process';

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

const child = spawn(
  'bun',
  all
    ? ['run', '--parallel', 'dev:app', 'stripe:dev', 'dev:bunny']
    : ['run', 'dev:app'],
  { stdio: 'inherit', env: process.env }
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 1);
});
