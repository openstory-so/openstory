#!/usr/bin/env bun
/**
 * Record e2e fixtures, then vendor provider media URLs onto durable R2.
 *
 * Extra args are forwarded to Playwright so
 * `bun test:e2e:record e2e/tests/characters.spec.ts` still works. A trailing
 * `&& bun scripts/mirror-…` in package.json would steal those args.
 */

import { spawn } from 'node:child_process';
import {
  deleteAssetGroup,
  listAigcAssetGroups,
} from '@/models/server/byteplus-assets';
import { bytePlusOpenApiConfig } from '@/models/server/byteplus-config';

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

// The record server's Ark group (aigcGroupName() for VITE_APP_URL :3020).
const E2E_ARK_GROUP = 'openstory-virtual-localhost-3020';

/** Free every Ark slot the recording took: deleting the group wipes its assets. */
async function disposeArkAssets(): Promise<void> {
  const config = bytePlusOpenApiConfig();
  if (!config) return;
  const groups = (await listAigcAssetGroups(config, E2E_ARK_GROUP)).filter(
    (g) => g.Name === E2E_ARK_GROUP && g.Id
  );
  for (const group of groups) {
    await deleteAssetGroup(config, group.Id ?? '');
    console.log(`Deleted Ark asset group ${group.Name} (${group.Id})`);
  }
}

async function main(): Promise<void> {
  const extra = process.argv.slice(2);
  const playwrightCode = await run('bun', ['playwright', 'test', ...extra]);
  await disposeArkAssets();
  if (playwrightCode !== 0) process.exit(playwrightCode);

  const mirrorCode = await run('bun', ['scripts/mirror-e2e-fixture-media.ts']);
  process.exit(mirrorCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
