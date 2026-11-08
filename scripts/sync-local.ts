/**
 * `bun dev`'s library mirror (#2222): `openstory sync` from source into the
 * data folder, against this dev server. Waits for the server, and only runs
 * once `openstory login` has stored a key for this origin.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { main } from '../packages/cli/src/cli.ts';

const [dataDir, origin] = process.argv.slice(2);
if (!dataDir || !origin) {
  console.error('Usage: bun scripts/sync-local.ts <dataDir> <origin>');
  process.exit(1);
}

function hasKey(): boolean {
  try {
    const file = join(homedir(), '.openstory', 'credentials.json');
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const keys =
      typeof parsed === 'object' && parsed !== null && 'keys' in parsed
        ? parsed.keys
        : null;
    return typeof keys === 'object' && keys !== null && origin in keys;
  } catch {
    return false;
  }
}

if (!hasKey()) {
  console.log(
    `[sync] To mirror your library into ${dataDir}, run once: bunx @openstory/cli@latest login --origin ${origin}`
  );
  process.exit(0);
}

for (;;) {
  try {
    if ((await fetch(origin)).status < 500) break;
  } catch {
    // Not listening yet.
  }
  await new Promise((r) => setTimeout(r, 2000));
}
await main(['sync', '--dir', dataDir, '--origin', origin]);
