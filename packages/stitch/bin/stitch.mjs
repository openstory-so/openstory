#!/usr/bin/env node
// Installs skills/stitch into the agent's skill directory.
// `npx @openstory/stitch` writes .agents/skills/stitch in the current directory.
// `--global` writes ~/.agents/skills/stitch.

import { cp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillSrc = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'skills',
  'stitch'
);

const args = process.argv.slice(2);
const help = args.includes('--help') || args.includes('-h');
const globalInstall = args.includes('--global') || args.includes('-g');
const unknown = args.filter(
  (arg) => !['--help', '-h', '--global', '-g'].includes(arg)
);

if (help) {
  process.stdout.write(
    `Usage: stitch [--global]

Copy the stitch skill into .agents/skills/stitch.
--global copies it to ~/.agents/skills/stitch.
`
  );
  process.exit(0);
}

if (unknown.length > 0) {
  process.stderr.write(`Unknown argument: ${unknown[0]}\n`);
  process.exit(1);
}

const destRoot = globalInstall
  ? join(homedir(), '.agents', 'skills')
  : join(process.cwd(), '.agents', 'skills');
const dest = join(destRoot, 'stitch');

await mkdir(destRoot, { recursive: true });
await rm(dest, { recursive: true, force: true });
await cp(skillSrc, dest, { recursive: true });
process.stdout.write(`${dest}\n`);
