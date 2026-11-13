import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CLI_VERSION,
  CLI_VERSION_HEADER,
  type FetchClock,
  versionedFetch,
} from './api.js';
import { main } from './cli.js';

describe('versionedFetch', () => {
  it('sends the CLI version on every request, beside the caller headers', async () => {
    const seen: Headers[] = [];
    const fetchFn = versionedFetch(async (_input, init) => {
      seen.push(new Headers(init?.headers));
      return new Response('{}');
    }, '1.2.3');
    await fetchFn('https://os.test/api/v1/stitches', {
      headers: { Authorization: 'Bearer k' },
    });
    expect(seen[0]?.get(CLI_VERSION_HEADER)).toBe('1.2.3');
    expect(seen[0]?.get('authorization')).toBe('Bearer k');
  });

  it('turns a 426 into the update message', async () => {
    const fetchFn = versionedFetch(
      async () =>
        Response.json(
          {
            error: {
              code: 'CLI_TOO_OLD',
              message: 'Update @openstory/cli to 0.2.0 or later.',
            },
          },
          { status: 426 }
        ),
      '0.1.0'
    );
    await expect(fetchFn('https://os.test/api/v1/device/code')).rejects.toThrow(
      'OpenStory needs a newer @openstory/cli (you have 0.1.0). Run npx @openstory/cli@latest. Update @openstory/cli to 0.2.0 or later.'
    );
  });

  it('sends 10, then waits until the gap since the last response is more than a second', async () => {
    const clock = fakeClock();
    const times: number[] = [];
    const fetchFn = versionedFetch(
      async () => {
        times.push(clock.now());
        await clock.sleep(40);
        return new Response('ok');
      },
      '1',
      clock
    );
    for (let i = 0; i < 11; i += 1) await fetchFn('https://os.test/x');
    expect(times[9]).toBe(360);
    expect(times[10]).toBe(1401);
    expect(keyWouldDeny(times)).toBe(false);
  });

  it('does not let a parallel burst past the tenth accept', async () => {
    const clock = fakeClock();
    const times: number[] = [];
    const fetchFn = versionedFetch(
      async () => {
        times.push(clock.now());
        return new Response('ok');
      },
      '1',
      clock
    );
    await Promise.all(
      Array.from({ length: 12 }, () => fetchFn('https://os.test/x'))
    );
    expect(keyWouldDeny(times)).toBe(false);
    expect(times.filter((t) => t === 0)).toHaveLength(10);
  });

  it('retries a rate-limited response after Retry-After', async () => {
    const clock = fakeClock();
    let calls = 0;
    const fetchFn = versionedFetch(
      async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json(
            {
              error: {
                code: 'RATE_LIMITED',
                message: 'API key rate limit exceeded. Retry shortly.',
              },
            },
            { status: 429, headers: { 'Retry-After': '1' } }
          );
        }
        return new Response('ok');
      },
      '1',
      clock
    );
    const response = await fetchFn('https://os.test/x');
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(clock.slept).toEqual([1000]);
  });

  it('treats a zero or missing Retry-After as a gap of more than a second', async () => {
    const cases: HeadersInit[] = [
      { 'Retry-After': '0' },
      {},
      { 'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT' },
    ];
    for (const headers of cases) {
      const clock = fakeClock();
      let calls = 0;
      const fetchFn = versionedFetch(
        async () => {
          calls += 1;
          if (calls === 1) {
            return Response.json(
              { error: { code: 'RATE_LIMITED', message: 'slow' } },
              { status: 429, headers }
            );
          }
          return new Response('ok');
        },
        '1',
        clock
      );
      const response = await fetchFn('https://os.test/x');
      expect(response.status).toBe(200);
      expect(clock.slept).toEqual([1001]);
    }
  });

  it('returns a 429 that is not the key limit', async () => {
    let calls = 0;
    const fetchFn = versionedFetch(async () => {
      calls += 1;
      return new Response('pending', { status: 429 });
    }, '1');
    const response = await fetchFn('https://os.test/api/v1/device/token');
    expect(calls).toBe(1);
    expect(await response.text()).toBe('pending');
  });
});

/** The api-key counter: reset only when the gap since the last accept is more than 1000ms. */
function keyWouldDeny(times: number[]): boolean {
  let count = 0;
  let last: number | null = null;
  for (const time of times) {
    if (last === null || time - last > 1000) {
      count = 1;
      last = time;
      continue;
    }
    if (count >= 10) return true;
    count += 1;
    last = time;
  }
  return false;
}

function fakeClock(): FetchClock & { slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  };
}

describe('openstory main', () => {
  it('prints the usage, the version, and refuses an unknown command', async () => {
    const home = await mkdtemp(join(tmpdir(), 'openstory-main-'));
    try {
      const out: string[] = [];
      const err: string[] = [];
      const io = {
        home,
        stdout: { write: (t: string) => out.push(t) },
        stderr: { write: (t: string) => err.push(t) },
      };
      await main(['--help'], io);
      expect(out.join('')).toContain('openstory pull <sequenceId>');
      out.length = 0;
      await main(['--version'], io);
      expect(out.join('')).toBe(`${CLI_VERSION}\n`);
      await main(['nope'], io);
      expect(err.join('')).toContain('Unknown command: nope');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = 0;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('sends the version header through a command and reports a 426', async () => {
    const home = await mkdtemp(join(tmpdir(), 'openstory-main-'));
    try {
      const err: string[] = [];
      const headers: (string | null)[] = [];
      await main(['login', '--origin', 'https://os.test'], {
        home,
        stdout: { write: () => {} },
        stderr: { write: (t) => err.push(t) },
        open: () => {},
        fetch: async (_input, init) => {
          headers.push(new Headers(init?.headers).get(CLI_VERSION_HEADER));
          return new Response('{}', { status: 426 });
        },
      });
      expect(headers).toEqual([CLI_VERSION]);
      expect(err.join('')).toContain('OpenStory needs a newer @openstory/cli');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = 0;
      await rm(home, { recursive: true, force: true });
    }
  });
});
