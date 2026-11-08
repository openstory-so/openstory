/** What every subcommand gets, and the flags they share. */

import { isHttpUrl } from '@openstory/stitch/bundle';

export type Writer = { write: (text: string) => void };

export type CliContext = {
  cwd: string;
  home: string;
  stdout: Writer;
  stderr: Writer;
  open: (url: string) => void;
  /** Sends the version header and turns a 426 into an error; OpenStory only. */
  fetch: typeof fetch;
};

/** A subcommand: one file under src/, one line in COMMANDS (cli.ts). */
export type Command = {
  usage: string;
  run: (args: string[], context: CliContext) => Promise<void>;
};

const DEFAULT_ORIGIN = 'https://openstory.so';

/** Takes `--origin url` out of the args; the rest are the command's own. */
export function parseOrigin(args: string[]): {
  origin: string;
  rest: string[];
} {
  let origin = DEFAULT_ORIGIN;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--origin') {
      const value = args[i + 1];
      if (value === undefined || !isHttpUrl(value)) {
        throw new Error('--origin needs an http(s) URL');
      }
      origin = new URL(value).origin;
      i += 1;
    } else rest.push(arg);
  }
  return { origin, rest };
}
