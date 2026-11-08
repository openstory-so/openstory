import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from './cli.js';
import { channelsInFrames, readSyncState, settler } from './sync.js';

const origin = 'https://os.test';
let temps: string[] = [];
afterEach(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
  temps = [];
  vi.useRealTimers();
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openstory-sync-'));
  temps.push(dir);
  await mkdir(join(dir, '.openstory'), { recursive: true });
  await writeFile(
    join(dir, '.openstory', 'credentials.json'),
    JSON.stringify({ keys: { [origin]: 'key' } })
  );
  return dir;
}

function server(world: {
  personal: boolean;
  orgSlug: string;
  sequences: { id: string; slug: string }[];
}): typeof fetch {
  return async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/api/v1/organization') {
      return Response.json({
        id: 'ORG',
        slug: world.orgSlug,
        personal: world.personal,
      });
    }
    if (url.pathname === '/api/v1/sequences') {
      return Response.json({ sequences: world.sequences, _links: {} });
    }
    const assets = /^\/api\/v1\/sequences\/([^/]+)\/assets$/.exec(url.pathname);
    if (assets) {
      return Response.json({
        sequenceId: assets[1],
        assets: [
          { relativePath: 'script.txt', versionId: 'v1', text: 'INT. ROOM' },
        ],
      });
    }
    return new Response('not found', { status: 404 });
  };
}

async function run(dir: string, fetchFn: typeof fetch, extra: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  await main(['sync', '--once', '--origin', origin, ...extra], {
    home: dir,
    cwd: dir,
    stdout: { write: (t) => out.push(t) },
    stderr: { write: (t) => err.push(t) },
    fetch: fetchFn,
  });
  return { out: out.join(''), err: err.join('') };
}

describe('openstory sync', () => {
  it('mirrors into personal/<slug> and renames folders when slugs change', async () => {
    const dir = await home();
    const world = {
      personal: true,
      orgSlug: 'org-abc',
      sequences: [{ id: 'S1', slug: 'the-chase' }],
    };
    const first = await run(dir, server(world));
    expect(first.err).toBe('');
    const script = join(
      dir,
      'openstory',
      'personal',
      'the-chase',
      'script.txt'
    );
    expect(await readFile(script, 'utf8')).toBe('INT. ROOM');

    // A note the user left survives the rename with the rest of the folder.
    await writeFile(
      join(dir, 'openstory', 'personal', 'the-chase', 'notes.md'),
      'mine'
    );
    world.sequences = [{ id: 'S1', slug: 'the-long-chase' }];
    await run(dir, server(world));
    const moved = join(dir, 'openstory', 'personal', 'the-long-chase');
    expect(await readFile(join(moved, 'notes.md'), 'utf8')).toBe('mine');
    expect(existsSync(join(dir, 'openstory', 'personal', 'the-chase'))).toBe(
      false
    );

    // An organization that stops being personal moves to its slug.
    world.personal = false;
    await run(dir, server(world));
    expect(
      existsSync(
        join(dir, 'openstory', 'org-abc', 'the-long-chase', 'notes.md')
      )
    ).toBe(true);
    const state = await readSyncState(join(dir, 'openstory'), origin);
    expect(state.sequences.S1?.folder).toBe(join('org-abc', 'the-long-chase'));
  });

  it('refuses a rename onto a folder that already exists', async () => {
    const dir = await home();
    const world = {
      personal: true,
      orgSlug: 'o',
      sequences: [{ id: 'S1', slug: 'the-chase' }],
    };
    await run(dir, server(world));
    await mkdir(join(dir, 'openstory', 'personal', 'the-long-chase'));
    world.sequences = [{ id: 'S1', slug: 'the-long-chase' }];
    expect((await run(dir, server(world))).err).toContain('already exists');
  });

  it('refuses a folder that mirrors another server', async () => {
    const dir = await home();
    const world = { personal: true, orgSlug: 'o', sequences: [] };
    await run(dir, server(world));
    const other = await run(dir, server(world), [
      '--origin',
      'http://localhost:3000',
    ]);
    expect(other.err).toContain('mirrors https://os.test');
  });

  it('refuses a slug that is not a plain folder name', async () => {
    const dir = await home();
    const result = await run(
      dir,
      server({
        personal: true,
        orgSlug: 'o',
        sequences: [{ id: 'S1', slug: '../escape' }],
      })
    );
    expect(result.err).toContain('unusable folder name');
  });
});

it('reads the channel of each realtime frame', () => {
  expect(
    channelsInFrames(
      'data: {"type":"connected"}\n\ndata: {"channel":"S1","event":"x"}\n\ndata: {bad'
    )
  ).toEqual(['S1']);
});

it('runs a resync once, after the events settle', async () => {
  vi.useFakeTimers();
  const job = vi.fn(async () => {});
  const resync = settler(job, () => {}, 2000);
  resync('S1');
  await vi.advanceTimersByTimeAsync(1500);
  resync('S1');
  await vi.advanceTimersByTimeAsync(1500);
  expect(job).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(600);
  expect(job).toHaveBeenCalledTimes(1);
});
