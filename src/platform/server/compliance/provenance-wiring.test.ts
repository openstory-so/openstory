/**
 * Pairing scan: every workflow that writes a generated object to R2 must
 * record a provenance row for it. The #1180 first pass missed sheets,
 * music, upscales, and the 3×3 grid because those persist sites were
 * never wired — this test is what keeps that from happening again.
 */

import { globSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const UPLOAD =
  /uploadResponse|uploadImageToStorage|storeGeneratedPng|uploadAudioToStorage|uploadFile\s*\(/;
const RECORD = /recordProvenance/;

describe('provenance wiring', () => {
  test('every workflow that uploads a generated asset records provenance', () => {
    const missing: string[] = [];
    for (const file of globSync('src/**/server/workflows/*.ts')) {
      if (file.endsWith('.test.ts')) continue;
      const source = readFileSync(file, 'utf8');
      if (!UPLOAD.test(source)) continue;
      if (!RECORD.test(source)) missing.push(file);
    }
    expect(missing).toEqual([]);
  });
});
