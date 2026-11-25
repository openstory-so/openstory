/** `UPLOAD_RIGHTS_CHECKED` skips the likeness check, so only these in-process callers may name it; no route or MCP tool can. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..', '..');
const ALLOWED = [
  // Defines it and compares against it.
  'src/gateway/server/submit-job.ts',
  // The in-process transport: its caller ran `requireUploadRights` before the run.
  'src/gateway/server/adapter/in-process.ts',
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
      yield path;
  }
}

describe('UPLOAD_RIGHTS_CHECKED', () => {
  it('is named only by the allowlisted in-process files', () => {
    const naming = [...walk(join(ROOT, 'src'))]
      .filter((file) =>
        readFileSync(file, 'utf8').includes('UPLOAD_RIGHTS_CHECKED')
      )
      .map((file) => relative(ROOT, file))
      .sort();
    expect(naming).toEqual([...ALLOWED].sort());
  });
});
