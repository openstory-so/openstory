/** `openstory pull`: download one sequence's files into a folder. */

import { join, resolve } from 'node:path';

import { downloadSequenceAssets } from './assets.js';
import type { Command } from './context.js';
import { parseOrigin } from './context.js';
import { openStoryApiKey, signIn } from './login.js';

export type PullArgs = {
  sequenceId: string;
  origin: string;
  dir: string;
  history: boolean;
  exports: boolean;
};

export function parsePull(args: string[], cwd: string): PullArgs {
  const { origin, rest: argv } = parseOrigin(args);
  let dir: string | null = null;
  let history = false;
  let exportsFlag = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--dir') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error('--dir needs a directory');
      }
      dir = resolve(cwd, value);
      i += 1;
    } else if (arg === '--history') history = true;
    else if (arg === '--exports') exportsFlag = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`);
    else rest.push(arg);
  }
  const sequenceId = rest[0];
  if (sequenceId === undefined) {
    throw new Error('openstory pull needs a sequence id');
  }
  if (rest.length > 1) throw new Error(`Unknown argument: ${rest[1]}`);
  return {
    sequenceId,
    origin,
    dir: dir ?? resolve(cwd, sequenceId),
    history,
    exports: exportsFlag,
  };
}

export const pull: Command = {
  usage:
    'openstory pull <sequenceId> [--history] [--exports] [--origin url] [--dir dir]',
  async run(args, context) {
    const request = parsePull(args, context.cwd);
    const auth = { ...context, origin: request.origin };
    const result = await downloadSequenceAssets({
      sequenceId: request.sequenceId,
      origin: request.origin,
      cacheDir: join(context.home, '.openstory', 'assets'),
      dest: request.dir,
      history: request.history,
      includeExports: request.exports,
      fetch: context.fetch,
      key: () => openStoryApiKey(auth),
      refresh: () => signIn(auth),
    });
    context.stdout.write(
      `Saved ${result.saved} files. Skipped ${result.skipped} already there.\n`
    );
  },
};
