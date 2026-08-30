/**
 * Pull Doppler `dev` into `.env.local` as a plaintext dotenv.
 *
 * Doppler 3.76 dropped `--output`. A filepath argument still writes an
 * *encrypted* blob (mode 0400) — that's the `4:base64:…` file `bun dev`
 * then can't rewrite. `--no-file --format env` is the plaintext path,
 * same flags `push-secrets.ts` uses for JSON.
 *
 * Usage: bun run secrets:pull
 */
import { spawnSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_FILE = resolve(process.cwd(), '.env.local');
const TMP_FILE = `${ENV_FILE}.tmp`;

const result = spawnSync(
  'doppler',
  [
    'secrets',
    'download',
    '--project',
    'openstory',
    '--config',
    'dev',
    '--format',
    'env',
    '--no-file',
  ],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
);

if (result.error) {
  if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error('doppler not found. Install it and ensure it is on PATH.');
  }
  throw result.error;
}
if (result.status !== 0) {
  throw new Error('doppler secrets download failed');
}

const body = result.stdout;
if (body.startsWith('4:base64:') || !body.includes('=')) {
  throw new Error(
    'doppler did not return a plaintext dotenv (refusing to overwrite .env.local)'
  );
}

writeFileSync(TMP_FILE, body, { encoding: 'utf8', mode: 0o600 });
renameSync(TMP_FILE, ENV_FILE);

console.log(`Wrote ${ENV_FILE}`);
