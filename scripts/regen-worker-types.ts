#!/usr/bin/env bun
/**
 * Regenerate the committed `worker-configuration.d.ts` and refuse a rewrite
 * that is not the same shape.
 *
 * `wrangler types` (runtime types on by default) writes two parts into that
 * file: the Env bindings, then `// Begin runtime types` and the workerd
 * declarations for this compatibility date and flags. There is no
 * `@cloudflare/workers-types` dependency, so the runtime half is what
 * typecheck uses. Env-only output is a few hundred lines — the ~310-line
 * file from #2053 — and every `R2Bucket` / `Workflow` name in it errors.
 *
 * A second failure mode, under Bun: workerd's runtime-type fetch of
 * `http://dummy.com/...` can escape to the network and the command still
 * exits 0 with a parking page after the marker (workers-sdk #16136). Wrangler
 * supports Node. This script runs `wrangler types` through `bun run`, which
 * honors the bin's node shebang, and restores the committed file unless the
 * new text still has runtime declarations, is not HTML, and is at least half
 * as long as what was committed.
 *
 * Secrets are typed from the push catalog (`scripts/push-secrets.ts`), not
 * from whatever `.env.local` holds: wrangler reads secret names from env files,
 * so this writes a throwaway one with every required runtime secret and passes
 * it with `--env-file`, which replaces the `.dev.vars` / `.env*` lookup.
 * Optional entries are typed `?:` in `src/platform/server/env/env.d.ts`.
 *
 * A deliberate new shape (for example after a wrangler upgrade that stops
 * inlining runtime types) is reviewed by hand:
 * `LEFTHOOK_EXCLUDE=typegen-regen`.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SECRETS, type SecretNeed } from './push-secrets';

export const RUNTIME_TYPES_MARKER = '// Begin runtime types';

/**
 * Bindings come and go. Half the committed file is still many times the
 * env-only output (~300 lines against ~16k).
 */
export const MIN_REGEN_RATIO = 0.5;

const HTML_LINE = /^\s*<(?:!doctype|html|head|body|script)\b/i;

export function rejectRegeneratedWorkerTypes(
  committed: string,
  next: string
): string | null {
  const committedLines = countLines(committed);
  const nextLines = countLines(next);
  const markerAt = next.indexOf(RUNTIME_TYPES_MARKER);
  if (markerAt === -1) {
    return [
      `Refusing to replace worker-configuration.d.ts: regenerated file has no "${RUNTIME_TYPES_MARKER}" marker.`,
      `It is ${nextLines} lines; the committed file is ${committedLines}.`,
      'That is the env-only shape. Typecheck needs the workerd runtime declarations in this file.',
    ].join('\n');
  }
  const runtime = next.slice(markerAt);
  if (!runtime.includes('declare ')) {
    return [
      'Refusing to replace worker-configuration.d.ts: the runtime section has no declarations.',
      `Regenerated file is ${nextLines} lines; the committed file is ${committedLines}.`,
    ].join('\n');
  }
  if (next.split('\n').some((line) => HTML_LINE.test(line))) {
    return [
      'Refusing to replace worker-configuration.d.ts: the regenerated file contains HTML.',
      'Runtime type generation fetches through workerd; a leaked response must not be committed.',
    ].join('\n');
  }
  if (committedLines > 0 && nextLines < committedLines * MIN_REGEN_RATIO) {
    return [
      `Refusing to replace worker-configuration.d.ts: regenerated file is ${nextLines} lines, under half of the committed ${committedLines}.`,
      'A wrangler.jsonc edit does not shrink the runtime declarations like that.',
    ].join('\n');
  }
  return null;
}

/** Required runtime secrets, as env-file lines; the values are placeholders. */
export function requiredSecretsEnvFile(
  catalog: Record<string, SecretNeed>
): string {
  return Object.entries(catalog)
    .filter(([, need]) => need.runtime && !need.optional)
    .map(([name]) => `${name}=x\n`)
    .join('');
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

function main() {
  const repoRoot = join(import.meta.dirname, '..');
  const target = join(repoRoot, 'worker-configuration.d.ts');
  const committed = existsSync(target) ? readFileSync(target, 'utf8') : '';

  const secretsDir = mkdtempSync(join(tmpdir(), 'openstory-worker-types-'));
  const secretsFile = join(secretsDir, 'secrets.env');
  writeFileSync(secretsFile, requiredSecretsEnvFile(SECRETS));
  const result = spawnSync(
    'bun',
    [
      'run',
      'wrangler',
      'types',
      '--include-runtime',
      '--env-file',
      secretsFile,
    ],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'inherit'],
    }
  );
  rmSync(secretsDir, { recursive: true, force: true });
  if (result.status !== 0) {
    if (committed) writeFileSync(target, committed);
    process.exit(result.status ?? 1);
  }

  const next = existsSync(target) ? readFileSync(target, 'utf8') : '';
  const reason = rejectRegeneratedWorkerTypes(committed, next);
  if (reason) {
    if (committed) writeFileSync(target, committed);
    console.error(reason);
    process.exit(1);
  }
}

if (import.meta.main) main();
