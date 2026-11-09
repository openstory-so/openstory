import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CLI_VERSION, CLI_VERSION_HEADER, versionedFetch } from './api.js';
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
});

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
