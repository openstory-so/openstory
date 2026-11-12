/**
 * Publishes skills/ and packages/stitch/skills/ to openstory-so/skills (#2357).
 * That repo's main takes only pull requests, so this opens one sync PR with
 * all five manifests bumped and lets auto-merge land it. Run by
 * .github/workflows/publish-skills.yml with the plugin repo checked out at
 * ./plugin, SHA set to this repo's commit and GH_TOKEN able to push there.
 */
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import {
  cpSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const REPO = 'openstory-so/skills';
const BRANCH = 'sync-skills';
const SOURCES = ['skills', 'packages/stitch/skills'];
const PLUGIN = 'plugin';
/** That repo's version check requires all five to agree and rise. */
const MANIFESTS = [
  'plugin.json',
  '.codex-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  '.grok-plugin/plugin.json',
  'gemini-extension.json',
];

/** Minor for a new skill, patch otherwise (that repo's AGENTS.md). */
export function nextVersion(version: string, newSkill: boolean): string {
  const [, major, minor = '', patch = ''] =
    /^(\d+)\.(\d+)\.(\d+)$/.exec(version) ??
    (() => {
      throw new Error(`Not a semver version: ${version}`);
    })();
  return newSkill
    ? `${major}.${Number(minor) + 1}.0`
    : `${major}.${minor}.${Number(patch) + 1}`;
}

function keyPattern(key: string): RegExp {
  return new RegExp(`("${key}":\\s*)("(?:[^"\\\\]|\\\\.)*")`, 'g');
}

/** The one string value under `key`; the manifests hold exactly one each. */
export function readJsonString(text: string, key: string): string {
  const matches = [...text.matchAll(keyPattern(key))];
  if (matches.length !== 1)
    throw new Error(`Expected one "${key}", found ${matches.length}`);
  const value: unknown = JSON.parse(matches[0]?.[2] ?? '');
  if (typeof value !== 'string') throw new Error(`"${key}" is not a string`);
  return value;
}

/** Replaces the one string under `key` in place, keeping the hand formatting. */
export function setJsonString(
  text: string,
  key: string,
  value: string
): string {
  readJsonString(text, key);
  const next = text.replace(
    keyPattern(key),
    (_, head: string) => head + JSON.stringify(value)
  );
  JSON.parse(next);
  return next;
}

/** `git diff --name-status -z` as createCommitOnBranch file changes. */
export function fileChanges(
  nameStatus: string,
  read: (file: string) => string
) {
  const parts = nameStatus.split('\0').filter(Boolean);
  const additions: { path: string; contents: string }[] = [];
  const deletions: { path: string }[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const [status, file = ''] = [parts[i], parts[i + 1]];
    if (status === 'D') deletions.push({ path: file });
    else additions.push({ path: file, contents: read(file) });
  }
  return { additions, deletions };
}

function run(cmd: string, args: string[], options: ExecFileSyncOptions = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  })
    .toString()
    .trim();
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function main() {
  const sha = required('SHA');
  required('GH_TOKEN');
  const short = sha.slice(0, 7);

  // Test runs finish out of order: only main's tip may publish.
  const tip = run('git', ['ls-remote', 'origin', 'refs/heads/main']).split(
    '\t'
  )[0];
  if (tip !== sha) {
    console.log(
      `::notice::${short} is not main's tip; the newer run publishes`
    );
    return;
  }

  const target = path.join(PLUGIN, 'skills');
  const before = new Set(readdirSync(target));
  rmSync(target, { recursive: true });
  for (const source of SOURCES) cpSync(source, target, { recursive: true });

  const inPlugin = (cmd: string, args: string[]) =>
    run(cmd, args, { cwd: PLUGIN });
  const gh = (...args: string[]) => inPlugin('gh', [...args, '--repo', REPO]);
  // By number, and only from this repo's own branch: a fork can open a PR
  // from a branch of the same name.
  const pr = gh(
    'pr',
    'list',
    '--head',
    BRANCH,
    '--state',
    'open',
    '--json',
    'number,isCrossRepository',
    '-q',
    '[.[] | select(.isCrossRepository | not) | .number][0] // empty'
  );

  if (!inPlugin('git', ['status', '--porcelain', 'skills'])) {
    // A revert can leave an unmerged sync PR that would undo it.
    if (pr) gh('pr', 'close', pr, '--comment', `Skills match main at ${short}`);
    console.log('Skills already match; nothing to publish');
    return;
  }

  const manifest = (file: string) => path.join(PLUGIN, file);
  const current = readJsonString(
    readFileSync(manifest('plugin.json'), 'utf8'),
    'version'
  );
  const version = nextVersion(
    current,
    readdirSync(target).some((name) => !before.has(name))
  );
  const subject = run('git', ['log', '-1', '--format=%s']);
  const notes = `${version} syncs the skills from openstory-so/openstory@${short}: ${subject}`;
  for (const file of MANIFESTS) {
    let text = setJsonString(
      readFileSync(manifest(file), 'utf8'),
      'version',
      version
    );
    if (file === 'plugin.json')
      text = setJsonString(text, 'release_notes', notes);
    writeFileSync(manifest(file), text);
  }

  // One branch: a newer sync replaces an unmerged one instead of racing it.
  const base = inPlugin('git', ['rev-parse', 'HEAD']);
  // matching-refs answers 200 with [] when the branch is gone; any other failure throws.
  const exists = inPlugin('gh', [
    'api',
    `repos/${REPO}/git/matching-refs/heads/${BRANCH}`,
    '--jq',
    `.[] | select(.ref == "refs/heads/${BRANCH}") | .ref`,
  ]);
  if (exists) {
    inPlugin('gh', [
      'api',
      '-X',
      'PATCH',
      `repos/${REPO}/git/refs/heads/${BRANCH}`,
      '-f',
      `sha=${base}`,
      '-F',
      'force=true',
    ]);
  } else {
    inPlugin('gh', [
      'api',
      `repos/${REPO}/git/refs`,
      '-f',
      `ref=refs/heads/${BRANCH}`,
      '-f',
      `sha=${base}`,
    ]);
  }
  // main requires signed commits: GitHub signs createCommitOnBranch, not a git push.
  inPlugin('git', ['add', '-A']);
  const changes = fileChanges(
    inPlugin('git', [
      'diff',
      '--cached',
      '--name-status',
      '--no-renames',
      '-z',
    ]),
    (file) => readFileSync(path.join(PLUGIN, file)).toString('base64')
  );
  run('gh', ['api', 'graphql', '--input', '-'], {
    cwd: PLUGIN,
    stdio: ['pipe', 'pipe', 'inherit'],
    input: JSON.stringify({
      query:
        'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }',
      variables: {
        input: {
          branch: { repositoryNameWithOwner: REPO, branchName: BRANCH },
          expectedHeadOid: base,
          message: {
            headline: `Sync skills from openstory-so/openstory@${short} (${version})`,
          },
          fileChanges: changes,
        },
      },
    }),
  });
  const title = `Sync skills (${version})`;
  if (pr) gh('pr', 'edit', pr, '--title', title, '--body', notes);
  const number =
    pr ||
    gh(
      'pr',
      'create',
      '--head',
      BRANCH,
      '--base',
      'main',
      '--title',
      title,
      '--body',
      notes
    )
      .split('/')
      .pop();
  if (!number || !/^\d+$/.test(number))
    throw new Error(`No sync PR number (got ${number})`);
  gh('pr', 'merge', number, '--auto', '--squash', '--delete-branch');
  console.log(`Published ${version}`);
}

if (import.meta.main) main();
