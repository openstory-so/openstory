import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { isNewer, updateNotice } from './update-notice.js';

const DAY = 24 * 60 * 60 * 1000;

describe('updateNotice', () => {
  it('checks the registry at most once a day and hints only at a newer version', async () => {
    const home = await mkdtemp(join(tmpdir(), 'openstory-update-'));
    try {
      let calls = 0;
      let latest = '0.2.0';
      const fetchFn: typeof fetch = async () => {
        calls += 1;
        return Response.json({ version: latest });
      };
      const check = (now: number, current = '0.1.0') =>
        updateNotice({ home, current, now, fetch: fetchFn });

      expect(await check(1000)).toBe(
        'openstory 0.2.0 is out (you have 0.1.0): npx @openstory/cli@latest\n'
      );
      latest = '0.3.0';
      // Within the day: the cached answer, no request.
      expect(await check(1000 + DAY - 1)).toContain('openstory 0.2.0 is out');
      expect(await check(1000 + DAY - 1, '0.2.0')).toBeNull();
      expect(calls).toBe(1);
      // A day on: one more request.
      expect(await check(1000 + DAY)).toContain('openstory 0.3.0 is out');
      expect(calls).toBe(2);
      expect(
        JSON.parse(
          await readFile(join(home, '.openstory', 'cli-update.json'), 'utf8')
        )
      ).toEqual({ checkedAt: 1000 + DAY, latest: '0.3.0' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('swallows a failed check and still waits a day before the next', async () => {
    const home = await mkdtemp(join(tmpdir(), 'openstory-update-'));
    try {
      let calls = 0;
      const failing: typeof fetch = async () => {
        calls += 1;
        throw new Error('offline');
      };
      expect(
        await updateNotice({ home, current: '0.1.0', now: 0, fetch: failing })
      ).toBeNull();
      expect(
        await updateNotice({ home, current: '0.1.0', now: 1, fetch: failing })
      ).toBeNull();
      expect(calls).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('compares major.minor.patch', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
    expect(isNewer('garbage', '0.1.0')).toBe(false);
  });
});
