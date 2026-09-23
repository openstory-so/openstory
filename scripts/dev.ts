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
  process.env.VIDEO_EXPORT_DEV_URL = 'http://localhost:8080';
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
