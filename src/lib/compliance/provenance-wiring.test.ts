/**
 * Pairing scan: every workflow that writes a generated object to R2 must
 * record a provenance row for it. The #1180 first pass missed sheets,
 * music, upscales, and the 3×3 grid because those persist sites were
 * never wired — this test is what keeps that from happening again.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const WORKFLOWS_DIR = 'src/lib/workflows';
const UPLOAD =
  /uploadResponse|uploadImageToStorage|uploadAudioToStorage|uploadFile\s*\(/;
const RECORD = /recordProvenance/;

describe('provenance wiring', () => {
  test('every workflow that uploads a generated asset records provenance', () => {
    const missing: string[] = [];
    for (const entry of readdirSync(WORKFLOWS_DIR)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const file = join(WORKFLOWS_DIR, entry);
      const source = readFileSync(file, 'utf8');
      if (!UPLOAD.test(source)) continue;
      if (!RECORD.test(source)) missing.push(file);
    }
    expect(missing).toEqual([]);
  });
});
