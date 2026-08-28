/**
 * Rewrite Grok edit aimock match.userMessage bodies so Image-N legends
 * match live stamp (`matchElementsToShotImage`). Quality Mode is the source
 * of truth for prompt text; the v2.0 clone gets the same prompts with its
 * own recorded model id. Responses stay as recorded.
 *
 *   bun scripts/patch-e2e-fal-edit-matchers.ts
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reconstructRecordedFalEditPrompts } from '@/lib/ai/recorded-e2e-fal-prompts';

const QUALITY_DIR = resolve(
  import.meta.dirname,
  '../e2e/fixtures/recorded/fal/xai-grok-imagine-image-quality-edit'
);
const V2_EDIT_DIR = resolve(
  import.meta.dirname,
  '../e2e/fixtures/recorded/fal/xai-grok-imagine-image-v2.0-edit'
);

/** Closest-prefix only if it is clearly the same still, not another 9-panel. */
const MIN_PREFIX = 200;

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function loadEditFixtures(dir: string) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const path = resolve(dir, name);
      const raw = readFileSync(path, 'utf8');
      const data: {
        fixtures: Array<{ match: { userMessage: string } }>;
      } = JSON.parse(raw);
      const userMessage = data.fixtures[0]?.match.userMessage;
      if (!userMessage) throw new Error(`No userMessage in ${name}`);
      return { name, path, raw, userMessage };
    });
}

function patchUserMessage(
  file: { path: string; raw: string; userMessage: string },
  next: string
) {
  const oldEncoded = JSON.stringify(file.userMessage);
  if (!file.raw.includes(oldEncoded)) {
    throw new Error(`Could not locate encoded userMessage in ${file.path}`);
  }
  writeFileSync(file.path, file.raw.replace(oldEncoded, JSON.stringify(next)));
  file.userMessage = next;
  file.raw = readFileSync(file.path, 'utf8');
}

const files = loadEditFixtures(QUALITY_DIR);
let patched = 0;
for (const live of reconstructRecordedFalEditPrompts()) {
  if (files.some((file) => file.userMessage === live.prompt)) continue;
  const closest = files
    .map((file) => ({
      file,
      prefix: commonPrefixLength(file.userMessage, live.prompt),
    }))
    .sort((a, b) => b.prefix - a.prefix)[0];
  if (!closest || closest.prefix < MIN_PREFIX) {
    console.log(
      `skip scene ${live.sceneNumber} ${live.kind} (best prefix ${closest?.prefix ?? 0})`
    );
    continue;
  }
  patchUserMessage(closest.file, live.prompt);
  patched++;
  console.log(
    `patched scene ${live.sceneNumber} ${live.kind} → ${closest.file.name} (prefix ${closest.prefix})`
  );
}

const qualityByName = new Map(
  files.map((file) => [file.name, file.userMessage])
);
let cloned = 0;
for (const file of loadEditFixtures(V2_EDIT_DIR)) {
  const prompt = qualityByName.get(file.name);
  if (!prompt || prompt === file.userMessage) continue;
  patchUserMessage(file, prompt);
  cloned++;
  console.log(`cloned prompt → v2.0-edit/${file.name}`);
}
console.log(
  `patched ${patched} quality/edit matchers, cloned ${cloned} onto v2.0-edit`
);
