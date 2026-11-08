/** `openstory`: the OpenStory account commands. stitch plays cuts; this talks to openstory.so. */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

import { CLI_VERSION, versionedFetch } from './api.js';
import type { Command, Writer } from './context.js';
import { login, moveOldCredentials } from './login.js';
import { pull } from './pull.js';
import { share } from './share.js';
import { updateNotice } from './update-notice.js';

/** One line per subcommand; each lives in its own file. */
const COMMANDS: Record<string, Command> = { login, pull, share };

export const usage = `Usage: ${Object.values(COMMANDS)
  .map((command) => command.usage)
  .join('\n       ')}

openstory login signs in with a device code: it prints a short code and
opens the approval page. The key is kept in ~/.openstory/credentials.json,
one per server. pull and share sign in the same way on first use.

openstory pull downloads a sequence into ./<sequenceId> (or --dir). A later
run skips a file that is already there at the same version. --history adds
every completed version. --exports adds rendered MP4s.

openstory share uploads a cut (the same arguments as stitch) to OpenStory
and prints a link anyone can open. Every still is checked for a real person;
one who is needs --portrait-rights with the basis for using their likeness
(a release reference, "self", a contract id).

--origin picks the OpenStory server (default https://openstory.so).
Run it with npx @openstory/cli@latest <command>.
`;

export async function main(
  argv: string[],
  io: {
    cwd?: string;
    stdout?: Writer;
    stderr?: Writer;
    home?: string;
    open?: (url: string) => void;
    fetch?: typeof fetch;
    now?: () => number;
  } = {}
): Promise<void> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const home = io.home ?? homedir();
  const rawFetch = io.fetch ?? fetch;
  // Only a person at a terminal sees the hint; tests inject stderr.
  const notice: { hint: string | null } = { hint: null };
  if (io.stderr === undefined && process.stderr.isTTY && !process.env.CI) {
    void updateNotice({
      home,
      current: CLI_VERSION,
      now: (io.now ?? Date.now)(),
      fetch: rawFetch,
    }).then((text) => {
      notice.hint = text;
    });
  }
  try {
    const [name, ...args] = argv;
    if (name === '--version' || name === '-v') {
      stdout.write(`${CLI_VERSION}\n`);
      return;
    }
    if (name === undefined || name === '--help' || name === '-h') {
      stdout.write(usage);
      return;
    }
    const command = COMMANDS[name];
    if (command === undefined) {
      throw new Error(`Unknown command: ${name}. Run openstory --help`);
    }
    if (args.includes('--help') || args.includes('-h')) {
      stdout.write(`Usage: ${command.usage}\n`);
      return;
    }
    await moveOldCredentials(home);
    await command.run(args, {
      cwd: io.cwd ?? process.cwd(),
      home,
      stdout,
      stderr,
      open: io.open ?? ((url) => openUrl(url, stderr)),
      fetch: versionedFetch(rawFetch),
    });
  } catch (error) {
    stderr.write(
      `${error instanceof Error ? error.message : 'openstory failed'}\n`
    );
    process.exitCode = 1;
  } finally {
    if (notice.hint !== null) stderr.write(notice.hint);
  }
}

export function openUrl(url: string, stderr: Writer): void {
  // Windows goes through rundll32, not `cmd /c start`: cmd parses & and ^
  // in a URL, and the sign-in URL comes from the server.
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'rundll32'
        : 'xdg-open';
  const args =
    process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  const failed = (reason: string) =>
    stderr.write(`Could not open a browser (${reason}). Open ${url}\n`);
  child.on('error', (error) => failed(error.message));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) failed(`${command} exited ${code}`);
  });
  child.unref();
}
