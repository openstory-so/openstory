#!/usr/bin/env bun
/**
 * Tear down a PR preview's BytePlus Ark asset group (#1635).
 *
 * Each preview owns `openstory-virtual-pr-<n>-…`. Deleting the group wipes
 * every asset in it. Never pass production's group. Production's hourly
 * sweep is the backstop if this step is skipped.
 *
 *   bun scripts/delete-preview-byteplus-group.ts --pr 1635
 *
 * Needs BYTEPLUS_ACCESS_KEY / BYTEPLUS_SECRET_KEY. Missing keys skip
 * (exit 0) so preview cleanup still deletes the Worker and D1.
 */
import { deleteMatchingPreviewPrGroups } from '@/models/server/byteplus-preview-groups';
import { bytePlusOpenApiConfig } from '@/models/server/byteplus-config';

function parsePrNumber(argv: string[]): number | undefined {
  const flag = argv.indexOf('--pr');
  if (flag === -1) return undefined;
  const raw = argv[flag + 1];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const prNumber = parsePrNumber(process.argv.slice(2));
if (prNumber === undefined) {
  console.error('Usage: bun scripts/delete-preview-byteplus-group.ts --pr <n>');
  process.exit(1);
}

const config = bytePlusOpenApiConfig();
if (!config) {
  console.log(
    'BYTEPLUS_ACCESS_KEY / BYTEPLUS_SECRET_KEY missing — skipping Ark group cleanup'
  );
  process.exit(0);
}

const summary = await deleteMatchingPreviewPrGroups(config, prNumber);
if (summary.deleted.length === 0 && summary.failed.length === 0) {
  console.log(
    `No leftover openstory-virtual-pr-${prNumber} Ark asset group (already deleted or never created)`
  );
  process.exit(0);
}

for (const name of summary.deleted) {
  console.log(`Deleted BytePlus asset group ${name}`);
}
for (const name of summary.failed) {
  console.error(`Failed to delete BytePlus asset group ${name}`);
}
if (summary.failed.length > 0) process.exit(1);
