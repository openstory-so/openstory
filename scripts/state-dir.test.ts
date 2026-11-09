import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireLock,
  markerFile,
  moveRepoState,
  prepareStateDir,
  proxyPersistPath,
  resolveStateDir,
  syncedFolderWarning,
  vitePersistPath,
  writeMarker,
} from './state-dir';

let temps: string[] = [];
afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps = [];
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openstory-state-'));
  temps.push(dir);
  return dir;
}
function setup(env: Record<string, string> = {}, worktree = false) {
  const home = tempDir();
  const repoRoot = tempDir();
  return { env, home, repoRoot, worktree };
}

describe('resolveStateDir', () => {
  it('keeps a fresh main checkout in .wrangler until it is set up', () => {
    const input = setup();
    expect(resolveStateDir(input)).toEqual({
      dataDir: null,
      state: join(input.repoRoot, '.wrangler', 'state'),
    });
  });

  it('uses ~/openstory once its marker exists', () => {
    const input = setup();
    writeMarker(join(input.home, 'openstory'));
    expect(resolveStateDir(input).state).toBe(
      join(input.home, 'openstory', '.openstory', 'state')
    );
  });

  it.each([
    ['test env', { CLOUDFLARE_ENV: 'test' }, false],
    ['CI', { CI: 'true' }, false],
    ['a worktree', {}, true],
  ])('keeps %s in .wrangler even when a data folder is set', (_, env, wt) => {
    const input = setup(env, wt);
    const dir = join(input.home, 'lib');
    writeMarker(dir);
    writeMarker(join(input.home, 'openstory'));
    input.env = { ...env, OPENSTORY_DATA_DIR: dir };
    expect(resolveStateDir(input).dataDir).toBeNull();
  });

  it('fails loudly when the chosen folder has no marker', () => {
    const input = setup({ OPENSTORY_DATA_DIR: '/Volumes/Unplugged/lib' });
    expect(() => resolveStateDir(input)).toThrow(/Is the drive plugged in/);
  });

  it('gives each consumer the path shape it expects', () => {
    const dir = { dataDir: null, state: '/s' };
    expect(vitePersistPath(dir)).toBe('/s');
    expect(proxyPersistPath(dir)).toBe('/s/v3');
  });
});

describe('prepareStateDir', () => {
  it('sets up ~/openstory and moves .wrangler/state into it', () => {
    const input = { ...setup(), interactive: true };
    const old = join(input.repoRoot, '.wrangler', 'state');
    mkdirSync(join(old, 'v3', 'd1'), { recursive: true });
    writeFileSync(join(old, 'v3', 'd1', 'db.sqlite'), 'rows');
    const dir = prepareStateDir(input);
    expect(dir.dataDir).toBe(join(input.home, 'openstory'));
    expect(readFileSync(join(dir.state, 'v3', 'd1', 'db.sqlite'), 'utf8')).toBe(
      'rows'
    );
    expect(existsSync(old)).toBe(false);
  });

  it('never creates the folder without a terminal', () => {
    const input = { ...setup(), interactive: false };
    expect(prepareStateDir(input).dataDir).toBeNull();
    expect(existsSync(markerFile(join(input.home, 'openstory')))).toBe(false);
  });

  it('stops and names both folders rather than merging', () => {
    const root = tempDir();
    mkdirSync(join(root, 'a', 'v3'), { recursive: true });
    mkdirSync(join(root, 'b'), { recursive: true });
    expect(() => moveRepoState(join(root, 'a'), join(root, 'b'))).toThrow(
      `${join(root, 'a')} and ${join(root, 'b')}`
    );
  });
});

describe('lock', () => {
  it('refuses a folder a live process holds and takes over a dead one', () => {
    const dir = tempDir();
    writeMarker(dir);
    const lock = join(dir, '.openstory', '.lock');
    // pid 1 is always alive.
    writeFileSync(lock, '1\n');
    expect(() => acquireLock(dir)).toThrow(/in use by process 1/);
    writeFileSync(lock, '999999999\n');
    acquireLock(dir);
    expect(readFileSync(lock, 'utf8').trim()).toBe(String(process.pid));
  });
});

it.each([
  ['~/Library/Mobile Documents/x', 'iCloud Drive'],
  ['~/Documents/openstory', 'iCloud Desktop & Documents'],
  ['/Users/x/Dropbox (Work)/lib', 'Dropbox'],
  ['/Users/x/OneDrive - Acme/lib', 'OneDrive'],
  ['~/openstory', null],
  ['/Volumes/Media/openstory', null],
])('warns on synced folder %s', (path, expected) => {
  expect(syncedFolderWarning(path, '/Users/x')).toBe(expected);
});

it('only the two consumers (and Studio) pick a persist path', () => {
  const root = resolve(import.meta.dirname, '..');
  const hits = (pattern: string) =>
    execFileSync(
      'git',
      ['grep', '--untracked', '-l', '-E', pattern, '--', '*.ts'],
      {
        cwd: root,
        encoding: 'utf8',
      }
    )
      .trim()
      .split('\n')
      .filter((file) => file !== 'scripts/state-dir.test.ts')
      .sort();
  expect(hits('resolveStateDir\\(')).toEqual([
    'drizzle.config.local.ts',
    'scripts/db-worktree.ts',
    'scripts/local-platform-proxy.ts',
    'scripts/state-dir.ts',
    'vite.config.ts',
  ]);
  expect(hits('persistState|persist: \\{|\\.wrangler/state/v3')).toEqual([
    'scripts/local-platform-proxy.ts',
    'scripts/state-dir.ts',
    'vite.config.ts',
  ]);
});
