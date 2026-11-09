import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = join(packageDir, 'package.json');
const backupPath = join(packageDir, 'package.json.prepack');

// npm publish leaves workspace: specs as written. ^, ~, * and empty map to the sibling's version.
export function rewriteWorkspaceRange(spec, version) {
  const protocol = spec.slice('workspace:'.length);
  if (protocol === '^') return `^${version}`;
  if (protocol === '~') return `~${version}`;
  if (protocol === '*' || protocol === '') return version;
  return protocol;
}

export function rewriteWorkspaceDeps(pkg, readVersion) {
  let changed = false;
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue;
      const version = readVersion(name);
      if (!version) {
        throw new Error(`No workspace version for ${name}`);
      }
      deps[name] = rewriteWorkspaceRange(spec, version);
      changed = true;
    }
  }
  return changed;
}

function workspaceVersion(name) {
  const directory = name.startsWith('@openstory/')
    ? name.slice('@openstory/'.length)
    : name;
  const manifest = JSON.parse(
    readFileSync(join(packageDir, '..', directory, 'package.json'), 'utf8')
  );
  if (manifest.name !== name) {
    throw new Error(`${directory} is ${manifest.name}, not ${name}`);
  }
  return manifest.version;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--restore')) {
    try {
      renameSync(backupPath, packagePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  } else {
    const original = readFileSync(packagePath, 'utf8');
    const pkg = JSON.parse(original);
    if (rewriteWorkspaceDeps(pkg, workspaceVersion)) {
      writeFileSync(backupPath, original);
      writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    }
  }
}
