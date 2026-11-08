/**
 * Where local D1/R2/DO state lives (#2222). The one resolver: `vite.config.ts`
 * and `scripts/local-platform-proxy.ts` read it, and nothing else picks a
 * persist path (`state-dir.test.ts` pins that).
 *
 *   OPENSTORY_DATA_DIR set        → <dir>/.openstory/state (marker required)
 *   main checkout, set up         → ~/openstory/.openstory/state
 *   worktree, CI, CLOUDFLARE_ENV=test, or not set up yet → <repo>/.wrangler/state
 *
 * A worktree ignores OPENSTORY_DATA_DIR: a copied .env.local must never run an
 * unmerged branch's migrations against the library. Rationale and layout:
 * docs/architecture/local-library.md.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');

export type StateDir = {
  /** The data folder, or null when state stays in the repo's .wrangler. */
  dataDir: string | null;
  /** The persist root wrangler calls `.wrangler/state` (holds `v3/`). */
  state: string;
};

export type StateEnv = {
  env: Record<string, string | undefined>;
  home: string;
  repoRoot: string;
  worktree: boolean;
};

export const defaultDataDir = (home: string) => join(home, 'openstory');
export const markerFile = (dataDir: string) =>
  join(dataDir, '.openstory', 'openstory.json');
const lockFile = (dataDir: string) => join(dataDir, '.openstory', '.lock');
const dataState = (dataDir: string) => join(dataDir, '.openstory', 'state');
const repoState = (repoRoot: string) => join(repoRoot, '.wrangler', 'state');

/**
 * Git worktree: its git dir differs from the common one. Outside git (a
 * downloaded copy) is not a worktree; any other git failure throws, since
 * guessing "main checkout" would point a worktree at the library.
 */
export function isWorktree(cwd: string = REPO_ROOT): boolean {
  let out: string;
  try {
    out = execFileSync('git', ['rev-parse', '--git-dir', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String(error.stderr)
        : '';
    if (stderr.includes('not a git repository')) return false;
    throw new Error(
      `Could not tell whether ${cwd} is a git worktree: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const [gitDir, commonDir] = out
    .trim()
    .split('\n')
    .map((dir) => resolve(cwd, dir));
  return gitDir !== commonDir;
}

function currentEnv(): StateEnv {
  return {
    env: process.env,
    home: homedir(),
    repoRoot: REPO_ROOT,
    worktree: isWorktree(),
  };
}

/** Pure: which folder this process should persist to. Throws on a missing marker. */
export function resolveStateDir(input: StateEnv = currentEnv()): StateDir {
  const { env, home, repoRoot, worktree } = input;
  const inRepo = { dataDir: null, state: repoState(repoRoot) };
  if (env.CLOUDFLARE_ENV === 'test' || env.CI || worktree) return inRepo;
  const chosen = env.OPENSTORY_DATA_DIR?.trim();
  if (chosen) {
    const dataDir = resolve(chosen.replace(/^~(?=\/|$)/, home));
    if (!existsSync(markerFile(dataDir))) {
      throw new Error(
        `OPENSTORY_DATA_DIR is ${dataDir} but ${markerFile(dataDir)} is missing. ` +
          'Is the drive plugged in? Run `bun setup` to create a new data folder.'
      );
    }
    return { dataDir, state: dataState(dataDir) };
  }
  const dataDir = defaultDataDir(home);
  return existsSync(markerFile(dataDir))
    ? { dataDir, state: dataState(dataDir) }
    : inRepo;
}

/** Persist path for `@cloudflare/vite-plugin`'s `persistState` (it appends `v3`). */
export const vitePersistPath = (dir: StateDir) => dir.state;

/** Persist path for `getPlatformProxy` (it uses the path as the `v3` root). */
export const proxyPersistPath = (dir: StateDir) => join(dir.state, 'v3');

/** Creates the marker so every later resolve lands on this folder. */
export function writeMarker(dataDir: string): void {
  mkdirSync(dirname(markerFile(dataDir)), { recursive: true });
  if (existsSync(markerFile(dataDir))) return;
  writeFileSync(
    markerFile(dataDir),
    `${JSON.stringify({ v: 1, createdAt: new Date().toISOString() }, null, 2)}\n`
  );
}

/**
 * `bun dev`'s first step: on a main checkout with a terminal, set up
 * ~/openstory once, then move an existing .wrangler/state into the data folder.
 */
export function prepareStateDir(
  input: StateEnv & { interactive: boolean } = {
    ...currentEnv(),
    interactive: Boolean(process.stdout.isTTY),
  }
): StateDir {
  const { env, worktree } = input;
  const local = env.CLOUDFLARE_ENV === 'test' || env.CI || worktree;
  if (!local && !env.OPENSTORY_DATA_DIR?.trim() && input.interactive) {
    writeMarker(defaultDataDir(input.home));
  }
  const dir = resolveStateDir(input);
  if (dir.dataDir === null) return dir;
  assertUnlocked(dir.dataDir);
  moveRepoState(repoState(input.repoRoot), dir.state);
  return dir;
}

/** One-time move. Both present means two libraries: stop rather than merge. */
export function moveRepoState(from: string, to: string): void {
  if (!existsSync(join(from, 'v3'))) return;
  if (existsSync(to)) {
    throw new Error(
      `Local state exists in both ${from} and ${to}. ` +
        'Keep one: move or delete the other, then run bun dev again.'
    );
  }
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if (!isCode(error, 'EXDEV')) throw error;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
  process.stdout.write(`[state] moved ${from} → ${to}\n`);
}

function lockHolder(dataDir: string): number | null {
  let pid: number;
  try {
    pid = Number(readFileSync(lockFile(dataDir), 'utf8').trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    // EPERM: alive but someone else's.
    return isCode(error, 'EPERM') ? pid : null;
  }
}

export function assertUnlocked(dataDir: string): void {
  const pid = lockHolder(dataDir);
  if (pid !== null) {
    throw new Error(
      `${dataState(dataDir)} is in use by process ${pid}. Stop that dev server first.`
    );
  }
}

/** Held by the dev server for its lifetime; a dead holder's lock is taken over. */
export function acquireLock(dataDir: string): void {
  assertUnlocked(dataDir);
  writeFileSync(lockFile(dataDir), `${process.pid}\n`);
  process.once('exit', () => {
    try {
      if (readFileSync(lockFile(dataDir), 'utf8').trim() === `${process.pid}`) {
        rmSync(lockFile(dataDir));
      }
    } catch {
      // Already gone.
    }
  });
}

/** Paths where a live SQLite file can be corrupted by a sync client. */
export function syncedFolderWarning(path: string, home: string): string | null {
  const p = resolve(path.replace(/^~(?=\/|$)/, home));
  const synced = [
    [join(home, 'Library', 'Mobile Documents'), 'iCloud Drive'],
    [join(home, 'Desktop'), 'iCloud Desktop & Documents'],
    [join(home, 'Documents'), 'iCloud Desktop & Documents'],
  ] as const;
  for (const [root, name] of synced) {
    if (p === root || p.startsWith(`${root}/`)) return name;
  }
  if (/(^|\/)Dropbox( \([^/]*\))?(\/|$)/.test(p)) return 'Dropbox';
  if (/(^|\/)OneDrive( - [^/]*)?(\/|$)/.test(p)) return 'OneDrive';
  if (p.includes('/Library/CloudStorage/')) return 'a cloud storage provider';
  return null;
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
