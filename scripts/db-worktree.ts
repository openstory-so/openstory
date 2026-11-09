/**
 * Copy local Wrangler D1 + R2 state between the main checkout and a worktree.
 * The main checkout's state is its data folder (~/openstory) when it has one
 * (#2222); --fork clones from there, and --promote refuses to overwrite it.
 *
 *   bun scripts/db-worktree.ts --fork      # main repo  → current worktree
 *   bun scripts/db-worktree.ts --promote   # current worktree → main repo
 *
 * Use --fork right after `git worktree add` so the new worktree starts with the
 * same D1 schema + data as your main checkout (no re-migrate, no re-seed). Use
 * --promote when you've built up useful state inside a worktree and want it to
 * become the "primary" local state for future worktrees to fork from.
 *
 * R2 is copied alongside D1: since #771, R2 is a local Miniflare binding and
 * DB rows reference `/r2/<key>` URLs served from it — forking D1 without the
 * R2 blobs would leave every stored thumbnail/video 404ing in the worktree.
 * R2 state is optional on the source (a fresh checkout may have none yet).
 * KV/cache/workflows aren't copied; they're either regenerated on demand or
 * stateless. Run with the dev server stopped on both sides.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolveStateDir } from './state-dir';

// D1 is required (the whole point of the script); R2 is best-effort.
const STATE_SUBDIRS = [
  { subdir: 'v3/d1', label: 'D1', required: true },
  { subdir: 'v3/r2', label: 'R2', required: false },
];

const mode = process.argv[2];
if (mode !== '--fork' && mode !== '--promote') {
  console.error('Usage: bun scripts/db-worktree.ts --fork | --promote');
  process.exit(1);
}

const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
  encoding: 'utf-8',
}).trim();
const mainRepoRoot = path.dirname(path.resolve(gitCommonDir));
const here = process.cwd();

if (mainRepoRoot === here) {
  console.error(
    `[db-worktree] already in the main repo (${mainRepoRoot}). ${mode} only makes sense from a worktree.`
  );
  process.exit(1);
}

// The main checkout's state: its data folder when it has one.
const main = resolveStateDir({
  env: { OPENSTORY_DATA_DIR: process.env.OPENSTORY_DATA_DIR },
  home: homedir(),
  repoRoot: mainRepoRoot,
  worktree: false,
});
const worktreeState = path.join(here, '.wrangler', 'state');

if (mode === '--promote' && main.dataDir) {
  console.error(
    `[db-worktree] the main checkout uses the data folder ${main.dataDir}. Promote would overwrite your library; copy what you need by hand.`
  );
  process.exit(1);
}

const [srcRoot, destRoot, verb] =
  mode === '--promote'
    ? [worktreeState, main.state, 'promoted']
    : [main.state, worktreeState, 'forked'];

for (const { subdir, label, required } of STATE_SUBDIRS) {
  const src = path.join(srcRoot, subdir);
  const dest = path.join(destRoot, subdir);

  if (!existsSync(src)) {
    if (required) {
      console.error(
        `[db-worktree] no ${label} state at ${src}. ${mode === '--fork' ? 'Bootstrap the main repo first with bun db:migrate:local + bun db:seed:local.' : 'Run bun db:migrate:local + bun db:seed:local in this worktree first.'}`
      );
      process.exit(1);
    }
    console.log(`[db-worktree] no ${label} state at ${src} — skipped`);
    continue;
  }

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.dirname(dest), { recursive: true });
  // APFS clone: instant, and the worktree's writes never touch the library.
  if (process.platform === 'darwin') {
    execFileSync('cp', ['-c', '-R', src, dest]);
  } else {
    cpSync(src, dest, { recursive: true });
  }
  console.log(`[db-worktree] ${verb} ${label} state: ${src} → ${dest}`);
}
