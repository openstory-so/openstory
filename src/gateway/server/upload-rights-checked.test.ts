/**
 * `UPLOAD_RIGHTS_CHECKED` skips the likeness check, so only these in-process
 * callers may reach it; no route or MCP tool can. Every value import and
 * re-export (alias, relative, namespace, dynamic) is resolved to the file it
 * lands on, as `db-access-allowlist.test.ts` does.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..', '..');
const DEFINED_IN = 'src/gateway/server/submit-job';
// In-process callers that ran `requireUploadRights` before the run; `in-process.ts` only takes the type.
const ALLOWED: readonly string[] = [
  // The Models page run: `createGeneratedAsset` checked every URL when it held at the click.
  'src/studio/server/workflows/asset-generation-workflow.ts',
  // Product stills (#2434): refs are stored uploads, classified when they were uploaded.
  'src/stills/server/image-generation.ts',
  // Motion and studio video: uploads gated when saved or at the click (`requireCheckedUploadRights`), clips in `check-reference-clip-rights`.
  'src/motion/server/video-job.ts',
  // Seed takes: the organization's Seed voice clips (made from text) and the user's own in-app mic take.
  'src/cast/server/voice/seed-audio.ts',
  // ElevenLabs Music: a text prompt, no upload.
  'src/audio/server/elevenlabs-gateway.ts',
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec|stories)\./.test(path)
    )
      yield path;
  }
}

/** `import … from`, `export … from` and `import(…)`, with what they name. */
const FROM_RE =
  /^\s*(?:import|export)\s+(?!type\s)([^;'"]*?)\s*from\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;

function resolves(file: string, spec: string): boolean {
  const target = spec.startsWith('.')
    ? relative(ROOT, resolve(file, '..', spec))
    : spec.replace(/^@\//, 'src/');
  return target.replace(/\.ts$/, '') === DEFINED_IN;
}

/** Whether the names reach the symbol: by name, by namespace, or all of it. */
function reaches(names: string): boolean {
  const values = names.replace(/\btype\s+\w+(\s+as\s+\w+)?/g, '');
  return /\bUPLOAD_RIGHTS_CHECKED\b|\*/.test(values);
}

const files = [...walk(join(ROOT, 'src'))];

describe('UPLOAD_RIGHTS_CHECKED', () => {
  it('is reached only by the allowlisted in-process files', () => {
    const reaching = files
      .filter((file) =>
        [...readFileSync(file, 'utf8').matchAll(FROM_RE)].some(
          ([, names, spec, dynamicSpec]) =>
            dynamicSpec !== undefined
              ? resolves(file, dynamicSpec)
              : spec !== undefined &&
                resolves(file, spec) &&
                reaches(names ?? '')
        )
      )
      .map((file) => relative(ROOT, file))
      .sort();
    expect(reaching).toEqual([...ALLOWED].sort());
  });

  it('is never passed on by an allowlisted file', () => {
    for (const file of ALLOWED) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text).not.toMatch(/export\s*\{[^}]*\bUPLOAD_RIGHTS_CHECKED\b/);
      expect(text).not.toMatch(
        /export\s+(const|let|var)\s+\w+\s*=\s*UPLOAD_RIGHTS_CHECKED\b/
      );
    }
  });
});
