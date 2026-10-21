/**
 * Pins the Worker compatibility date chosen in #1999. Production and test
 * inherit the top-level value in wrangler.jsonc; a second date in this file
 * would be an override and should fail this test.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const wrangler = readFileSync('wrangler.jsonc', 'utf8');

describe('worker compatibility date', () => {
  test('is 2026-10-08 everywhere the app Worker declares one', () => {
    const dates = [
      ...wrangler.matchAll(/"compatibility_date":\s*"([^"]+)"/g),
    ].map((match) => match[1]);
    expect(dates).toEqual(['2026-10-08']);
  });

  test('keeps enable_request_signal, which has no default date', () => {
    const flags = wrangler.match(/"compatibility_flags":\s*\[([^\]]*)\]/)?.[1];
    expect(flags).toContain('"enable_request_signal"');
  });
});
