#!/usr/bin/env bun
/**
 * Record e2e fixtures, then vendor provider media URLs onto durable R2.
 *
 * Extra args are forwarded to Playwright so
 * `bun test:e2e:record e2e/tests/talent.spec.ts` still works. A trailing
 * `&& bun scripts/mirror-…` in package.json would steal those args.
 */

import { spawn } from 'node:child_process';

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const extra = process.argv.slice(2);
  const playwrightCode = await run('bun', ['playwright', 'test', ...extra]);
  if (playwrightCode !== 0) process.exit(playwrightCode);

  const mirrorCode = await run('bun', ['scripts/mirror-e2e-fixture-media.ts']);
  process.exit(mirrorCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
