/**
 * `openstory sync`: a one-way mirror of an organization's sequences into
 * `<dir>/<organization>/<sequence-slug>/` (#2222). OpenStory writes; the folder
 * is output only and nothing reads it back. A full pass runs at start, then a
 * sequence is synced again a couple of seconds after its realtime events
 * settle. Every pass is safe to repeat, so a missed event is fixed by the next.
 *
 * `<dir>/.openstory/sync.json` maps organization and sequence ids to folders,
 * so a slug change renames the folder. Archived or deleted sequences drop out
 * of the list and their folders are left alone.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { recordOf, stringOf } from './api.js';
import { downloadSequenceAssets } from './assets.js';
import type { CliContext, Command } from './context.js';
import { parseOrigin } from './context.js';
import { openStoryApiKey, signIn } from './login.js';

const SETTLE_MS = 2000;
const RELIST_MS = 60_000;
/** The realtime route takes at most this many channels per connection. */
const MAX_CHANNELS = 64;

export type SyncState = {
  v: 1;
  origin: string;
  organizations: Record<string, string>;
  sequences: Record<string, { organization: string; folder: string }>;
};

type Sequence = { id: string; slug: string };

export type SyncArgs = { origin: string; dir: string; once: boolean };

export function parseSync(args: string[], home: string, cwd: string): SyncArgs {
  const { origin, rest } = parseOrigin(args);
  let dir = join(home, 'openstory');
  let once = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    if (arg === '--dir') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error('--dir needs a directory');
      }
      dir = resolve(cwd, value);
      i += 1;
    } else if (arg === '--once') once = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { origin, dir, once };
}

const stateFile = (dir: string) => join(dir, '.openstory', 'sync.json');

export async function readSyncState(
  dir: string,
  origin: string
): Promise<SyncState> {
  let text: string;
  try {
    text = await readFile(stateFile(dir), 'utf8');
  } catch {
    return { v: 1, origin, organizations: {}, sequences: {} };
  }
  const parsed = recordOf(JSON.parse(text));
  if (parsed.origin !== origin) {
    throw new Error(
      `${dir} mirrors ${String(parsed.origin)}. Pick another --dir for ${origin}.`
    );
  }
  const sequences: SyncState['sequences'] = {};
  for (const [id, value] of Object.entries(recordOf(parsed.sequences))) {
    const row = recordOf(value);
    if (
      typeof row.organization === 'string' &&
      typeof row.folder === 'string'
    ) {
      sequences[id] = { organization: row.organization, folder: row.folder };
    }
  }
  const organizations: Record<string, string> = {};
  for (const [id, folder] of Object.entries(recordOf(parsed.organizations))) {
    if (typeof folder === 'string') organizations[id] = folder;
  }
  return { v: 1, origin, organizations, sequences };
}

async function writeSyncState(dir: string, state: SyncState): Promise<void> {
  const file = stateFile(dir);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.partial`, `${JSON.stringify(state, null, 2)}\n`);
  await rename(`${file}.partial`, file);
}

/** Moves `from` to `to` under `dir` when only the old one exists. */
async function renameFolder(dir: string, from: string, to: string) {
  if (from === to) return;
  const source = join(dir, from);
  const target = join(dir, to);
  if (!existsSync(source) || existsSync(target)) return;
  await mkdir(dirname(target), { recursive: true });
  await rename(source, target);
}

/** One folder name segment: never a path, never hidden. */
function folderName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error(
      `OpenStory answered with an unusable folder name: ${value}`
    );
  }
  return value;
}

export class Mirror {
  private key: string | null = null;
  private organization: { id: string; folder: string } | null = null;

  constructor(
    private readonly context: CliContext,
    private readonly args: SyncArgs,
    private state: SyncState
  ) {}

  private auth() {
    return { ...this.context, origin: this.args.origin };
  }

  /** A GET with the stored key; a 401 signs in once more. */
  async get(path: string): Promise<Response> {
    this.key ??= await openStoryApiKey(this.auth());
    const run = (key: string) =>
      this.context.fetch(new URL(path, this.args.origin), {
        headers: { authorization: `Bearer ${key}` },
      });
    let response = await run(this.key);
    if (response.status === 401) {
      this.key = await signIn(this.auth());
      response = await run(this.key);
    }
    return response;
  }

  private async json(path: string): Promise<Record<string, unknown>> {
    const response = await this.get(path);
    if (!response.ok) {
      throw new Error(`OpenStory answered ${response.status} for ${path}`);
    }
    return recordOf(await response.json());
  }

  /** The key's organization folder: `personal` for the sign-up one, else its slug. */
  async syncOrganization(): Promise<string> {
    const org = await this.json('/api/v1/organization');
    const id = stringOf(org.id, 'an organization id');
    const folder =
      org.personal === true
        ? 'personal'
        : folderName(stringOf(org.slug, 'an organization slug'));
    const previous = this.state.organizations[id];
    if (previous !== undefined) {
      await renameFolder(this.args.dir, previous, folder);
      for (const row of Object.values(this.state.sequences)) {
        if (row.organization === id) {
          row.folder = join(folder, row.folder.slice(previous.length + 1));
        }
      }
    }
    this.state.organizations[id] = folder;
    this.organization = { id, folder };
    await writeSyncState(this.args.dir, this.state);
    return folder;
  }

  async listSequences(): Promise<Sequence[]> {
    const found: Sequence[] = [];
    let path: string | null = '/api/v1/sequences?limit=100';
    while (path !== null) {
      const page = await this.json(path);
      const rows = Array.isArray(page.sequences) ? page.sequences : [];
      for (const value of rows) {
        const row = recordOf(value);
        found.push({
          id: stringOf(row.id, 'a sequence id'),
          slug: folderName(stringOf(row.slug, 'a sequence slug')),
        });
      }
      const next = recordOf(recordOf(page._links).next).href;
      path = typeof next === 'string' ? next : null;
    }
    return found;
  }

  /** One sequence's id and slug; null once it is archived or deleted. */
  async getSequence(id: string): Promise<Sequence | null> {
    const response = await this.get(
      `/api/v1/sequences/${encodeURIComponent(id)}`
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`OpenStory answered ${response.status} for ${id}`);
    }
    const row = recordOf(await response.json());
    if (row.status === 'archived') return null;
    return {
      id: stringOf(row.id, 'a sequence id'),
      slug: folderName(stringOf(row.slug, 'a sequence slug')),
    };
  }

  async syncSequence(sequence: Sequence): Promise<void> {
    const organization = this.organization;
    if (organization === null) throw new Error('Sync the organization first');
    const folder = join(organization.folder, sequence.slug);
    const previous = this.state.sequences[sequence.id];
    if (previous) await renameFolder(this.args.dir, previous.folder, folder);
    this.state.sequences[sequence.id] = {
      organization: organization.id,
      folder,
    };
    await writeSyncState(this.args.dir, this.state);
    const result = await downloadSequenceAssets({
      sequenceId: sequence.id,
      origin: this.args.origin,
      cacheDir: join(this.args.dir, '.openstory', 'cache'),
      dest: join(this.args.dir, folder),
      history: false,
      includeExports: false,
      fetch: this.context.fetch,
      key: async () => (this.key ??= await openStoryApiKey(this.auth())),
      refresh: async () => (this.key = await signIn(this.auth())),
    });
    if (result.saved + result.removed > 0) {
      this.context.stdout.write(
        `${folder}: saved ${result.saved}, removed ${result.removed}\n`
      );
    }
  }

  /** Startup pass: every listed sequence, unchanged files skipped. */
  async fullPass(): Promise<Sequence[]> {
    await this.syncOrganization();
    const sequences = await this.listSequences();
    for (const sequence of sequences) await this.syncSequence(sequence);
    return sequences;
  }
}

/** The ids each `data:` frame of an SSE chunk names as its channel. */
export function channelsInFrames(text: string): string[] {
  const channels: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const channel = recordOf(JSON.parse(line.slice(5))).channel;
      if (typeof channel === 'string') channels.push(channel);
    } catch {
      // A partial or non-JSON frame carries no channel.
    }
  }
  return channels;
}

/** Runs `job` once per id, `SETTLE_MS` after its last event, one job at a time. */
export function settler(
  job: (id: string) => Promise<void>,
  onError: (error: unknown) => void,
  settleMs = SETTLE_MS
) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let chain = Promise.resolve();
  return (id: string) => {
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        chain = chain.then(() => job(id)).catch(onError);
      }, settleMs)
    );
  };
}

async function watch(mirror: Mirror, start: Sequence[], context: CliContext) {
  let sequences = new Map(start.map((s) => [s.id, s]));
  const report = (error: unknown) =>
    context.stderr.write(
      `sync: ${error instanceof Error ? error.message : String(error)}\n`
    );
  const resync = settler(async (id) => {
    if (!sequences.has(id)) return;
    // The current slug, so a rename moves the folder now, not at the next list.
    const sequence = await mirror.getSequence(id);
    if (sequence) await mirror.syncSequence(sequence);
  }, report);
  let abort = new AbortController();

  // ponytail: one connection with the newest 64 sequences; older ones resync on the next start.
  const listen = async () => {
    for (let delay = 1000; ; delay = Math.min(delay * 2, 30_000)) {
      const ids = [...sequences.keys()].slice(0, MAX_CHANNELS);
      const signal = abort.signal;
      try {
        if (ids.length > 0) {
          const response = await mirror.get(
            `/api/realtime?channels=${ids.map(encodeURIComponent).join(',')}`
          );
          if (!response.ok || !response.body) {
            throw new Error(`realtime answered ${response.status}`);
          }
          delay = 1000;
          const reader = response.body.getReader();
          signal.addEventListener('abort', () => void reader.cancel());
          if (signal.aborted) void reader.cancel();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const end = buffer.lastIndexOf('\n\n');
            if (end === -1) continue;
            for (const id of channelsInFrames(buffer.slice(0, end))) {
              resync(id);
            }
            buffer = buffer.slice(end + 2);
          }
        }
      } catch (error) {
        if (!signal.aborted) report(error);
      }
      if (!signal.aborted) {
        await new Promise((r) => setTimeout(r, ids.length ? delay : RELIST_MS));
      }
    }
  };
  void listen();

  for (;;) {
    await new Promise((r) => setTimeout(r, RELIST_MS));
    try {
      await mirror.syncOrganization();
      const listed = await mirror.listSequences();
      const added = listed.filter((s) => {
        const known = sequences.get(s.id);
        return known === undefined || known.slug !== s.slug;
      });
      sequences = new Map(listed.map((s) => [s.id, s]));
      for (const sequence of added) resync(sequence.id);
      if (added.length > 0) {
        abort.abort();
        abort = new AbortController();
      }
    } catch (error) {
      report(error);
    }
  }
}

export const sync: Command = {
  usage: 'openstory sync [--dir dir] [--once] [--origin url]',
  async run(args, context) {
    const request = parseSync(args, context.home, context.cwd);
    const state = await readSyncState(request.dir, request.origin);
    const mirror = new Mirror(context, request, state);
    const sequences = await mirror.fullPass();
    context.stdout.write(
      `Synced ${sequences.length} sequences into ${request.dir}\n`
    );
    if (!request.once) await watch(mirror, sequences, context);
  },
};
