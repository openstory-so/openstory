/**
 * Per-machine tunnel hostnames (#740).
 *
 *   bun tunnel:provision   create 10 random *.openstory.so names, register
 *                          them on a Wrangler named tunnel (port 3000–3009)
 *   bun tunnel             print the map and Google OAuth URIs
 *
 * Map lives at ~/.openstory/dev-tunnels.json so every worktree/agent on this
 * laptop shares it. Press `t + Enter` in one `bun dev` to connect the named
 * tunnel; Cloudflare routes each hostname to its loopback port.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { hostname as osHostname, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { upsertEnvVars } from './env-file';

const DEV_TUNNEL_PORT_COUNT = 10;
const DEV_TUNNEL_BASE_PORT = 3000;
const DEV_TUNNELS_RELATIVE_PATH = '.openstory/dev-tunnels.json';

function tunnelZone(): string {
  const raw = process.env.OPENSTORY_API_URL;
  if (raw) {
    try {
      const host = new URL(raw).hostname;
      if (host && host !== 'localhost' && host !== '127.0.0.1') {
        return host.replace(/^www\./, '');
      }
    } catch {
      // fall through
    }
  }
  return 'openstory.so';
}

const DEV_TUNNEL_PORTS: readonly number[] = Array.from(
  { length: DEV_TUNNEL_PORT_COUNT },
  (_, i) => DEV_TUNNEL_BASE_PORT + i
);

const ADJECTIVES = [
  'amber',
  'briny',
  'cheeky',
  'cosmic',
  'dapper',
  'eager',
  'fancy',
  'fuzzy',
  'giddy',
  'goofy',
  'happy',
  'icy',
  'jaunty',
  'jazzy',
  'keen',
  'loopy',
  'lucky',
  'merry',
  'misty',
  'nimble',
  'noble',
  'odd',
  'peppy',
  'perky',
  'plucky',
  'proud',
  'quirky',
  'rusty',
  'silly',
  'snappy',
  'spry',
  'sunny',
  'tiny',
  'vivid',
  'witty',
  'wobbly',
  'zany',
  'zippy',
] as const;

const NOUNS = [
  'badger',
  'bagel',
  'bison',
  'comet',
  'dumpling',
  'emu',
  'falcon',
  'gecko',
  'gourd',
  'heron',
  'igloo',
  'koala',
  'lantern',
  'lemur',
  'llama',
  'mango',
  'marmot',
  'muffin',
  'newt',
  'noodle',
  'otter',
  'panda',
  'pebble',
  'pickle',
  'platypus',
  'quail',
  'raccoon',
  'raven',
  'sloth',
  'sock',
  'squid',
  'taco',
  'teapot',
  'trout',
  'waffle',
  'walrus',
  'wombat',
  'yak',
  'yacht',
  'zebra',
] as const;

type DevTunnelRoute = {
  port: number;
  hostname: string;
};

type DevTunnelsFile = {
  v: 1;
  tunnelName: string;
  tunnelId: string;
  zone: string;
  routes: DevTunnelRoute[];
};

function isDevTunnelPort(port: number): boolean {
  return (
    port >= DEV_TUNNEL_BASE_PORT &&
    port < DEV_TUNNEL_BASE_PORT + DEV_TUNNEL_PORT_COUNT
  );
}

function originForPort(file: DevTunnelsFile, port: number): string | undefined {
  const route = file.routes.find((r) => r.port === port);
  return route ? `https://${route.hostname}` : undefined;
}

function googleCallbackUrls(file: DevTunnelsFile): string[] {
  return file.routes.map(
    (route) => `https://${route.hostname}/api/auth/callback/google`
  );
}

function pickWord(
  list: readonly string[],
  bytes: Uint8Array,
  offset: number
): string {
  const hi = bytes[offset] ?? 0;
  const lo = bytes[offset + 1] ?? 0;
  return list[((hi << 8) | lo) % list.length] ?? list[0] ?? 'odd';
}

function randomLabel(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `${pickWord(ADJECTIVES, bytes, 0)}-${pickWord(NOUNS, bytes, 2)}`;
}

function allocateRoutes(): DevTunnelRoute[] {
  const taken = new Set<string>();
  const zone = tunnelZone();
  const routes: DevTunnelRoute[] = [];
  for (const port of DEV_TUNNEL_PORTS) {
    let label = randomLabel();
    let guard = 0;
    while (taken.has(label)) {
      label = randomLabel();
      guard += 1;
      if (guard > 50) {
        throw new Error('Could not allocate a unique hostname label');
      }
    }
    taken.add(label);
    routes.push({ port, hostname: `${label}.${zone}` });
  }
  return routes;
}

function tunnelIngressConfig(routes: readonly DevTunnelRoute[]): {
  ingress: Array<{ hostname?: string; service: string }>;
} {
  return {
    ingress: [
      ...routes.map((route) => ({
        hostname: route.hostname,
        service: `http://127.0.0.1:${route.port}`,
      })),
      { service: 'http_status:404' },
    ],
  };
}

function mappingPath(homeDir = homedir()): string {
  return join(homeDir, DEV_TUNNELS_RELATIVE_PATH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readMapping(path = mappingPath()): DevTunnelsFile | undefined {
  if (!existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !isRecord(parsed) ||
    parsed.v !== 1 ||
    typeof parsed.tunnelName !== 'string' ||
    typeof parsed.tunnelId !== 'string' ||
    !Array.isArray(parsed.routes)
  ) {
    return undefined;
  }
  const routes = parsed.routes.filter(
    (route): route is DevTunnelRoute =>
      isRecord(route) &&
      typeof route.port === 'number' &&
      typeof route.hostname === 'string'
  );
  if (routes.length === 0) return undefined;
  return {
    v: 1,
    tunnelName: parsed.tunnelName,
    tunnelId: parsed.tunnelId,
    zone: typeof parsed.zone === 'string' ? parsed.zone : tunnelZone(),
    routes,
  };
}

function writeMapping(file: DevTunnelsFile, path = mappingPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen({ port, host: '0.0.0.0', exclusive: true });
  });
}

/** Probe 3000–3009. Prefer `preferred` when it is in range and free. */
export async function pickFreeDevPort(preferred = 3000): Promise<number> {
  const ordered = isDevTunnelPort(preferred)
    ? [preferred, ...DEV_TUNNEL_PORTS.filter((port) => port !== preferred)]
    : [...DEV_TUNNEL_PORTS];
  for (const port of ordered) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(
    'All ports 3000–3009 are in use. Stop another `bun dev` (or whatever is bound there) and retry.'
  );
}

export function applyMappingToEnv(
  envFile: string,
  port: number,
  file: DevTunnelsFile
): string | undefined {
  if (!isDevTunnelPort(port)) return undefined;
  const origin = originForPort(file, port);
  if (!origin) return undefined;
  upsertEnvVars(envFile, {
    PORT: String(port),
    VITE_APP_URL: origin,
    BETTER_AUTH_URL: origin,
  });
  return origin;
}

function machineTunnelName(hostname = osHostname()): string {
  const slug = hostname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24);
  return `openstory-dev-${slug || 'local'}`;
}

function printMapping(file: DevTunnelsFile): void {
  console.log(`Tunnel ${file.tunnelName} (${file.tunnelId})`);
  console.log(`Map: ${mappingPath()}\n`);
  console.log('Port  Hostname');
  for (const route of file.routes) {
    console.log(`${String(route.port).padEnd(5)} https://${route.hostname}`);
  }
  console.log('\nAdd these Google OAuth redirect URIs:');
  for (const url of googleCallbackUrls(file)) {
    console.log(`  ${url}`);
  }
  console.log(
    `\nThen: set PORT to an unused 3000–3009 in the worktree, bun dev, press t + Enter once on this machine.`
  );
}

async function runCli(argv: string[]): Promise<void> {
  const reset = argv.includes('--reset');
  if (argv[0] === '--provision' || argv[0] === 'provision') {
    const path = mappingPath();
    const existing = !reset ? readMapping(path) : undefined;
    if (existing) {
      console.log(
        'Mapping already exists. Pass --reset to allocate new hostnames.\n'
      );
      printMapping(existing);
      return;
    }
    const file = await provisionMapping();
    writeMapping(file, path);
    printMapping(file);
    return;
  }
  const file = readMapping();
  if (!file) {
    throw new Error(
      `No mapping at ${mappingPath()}. Run \`bun tunnel:provision\` (uses \`wrangler login\`).`
    );
  }
  printMapping(file);
}

function wranglerAuthFileCandidates(
  homeDir: string,
  platform = process.platform
): string[] {
  const mac = join(
    homeDir,
    'Library/Preferences/.wrangler/config/default.toml'
  );
  const xdg = join(homeDir, '.config/.wrangler/config/default.toml');
  const home = join(homeDir, '.wrangler/config/default.toml');
  return platform === 'darwin' ? [mac, home] : [xdg, home];
}

function parseWranglerOauthToml(text: string): string | undefined {
  const match = /^oauth_token\s*=\s*"([^"]+)"/m.exec(text);
  return match?.[1];
}

function parseWranglerWhoami(json: unknown): {
  accountId: string;
  email?: string;
} {
  if (!isRecord(json) || json.loggedIn !== true) {
    throw new Error(
      'Not logged in to Wrangler. Run `wrangler login` and retry `bun tunnel:provision`.'
    );
  }
  const accounts = Array.isArray(json.accounts) ? json.accounts : [];
  const accountId = stringField(accounts[0], 'id');
  if (!accountId) {
    throw new Error(
      'Wrangler login has no Cloudflare account. Run `wrangler login` and pick the OpenStory account.'
    );
  }
  return { accountId, email: stringField(json, 'email') };
}

function jsonFromWranglerOutput(stdout: string): unknown {
  const start = stdout.indexOf('{');
  if (start < 0) {
    throw new Error(
      'wrangler whoami --json did not return JSON. Run `wrangler login`.'
    );
  }
  return JSON.parse(stdout.slice(start));
}

function cloudflareTunnelUrl(accountId: string, path = ''): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel${path}`;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value) || typeof value[key] !== 'string') return undefined;
  return value[key];
}

function resolveWranglerAuth(): { accountId: string; apiToken: string } {
  const whoami = jsonFromWranglerOutput(
    spawnSync('wrangler', ['whoami', '--json'], { encoding: 'utf8' }).stdout
  );
  const { accountId } = parseWranglerWhoami(whoami);

  for (const path of wranglerAuthFileCandidates(homedir())) {
    if (!existsSync(path)) continue;
    const token = parseWranglerOauthToml(readFileSync(path, 'utf8'));
    if (token) return { accountId, apiToken: token };
  }
  throw new Error(
    'Could not find a Wrangler OAuth token. Run `wrangler login` (browser, no API token) and retry.'
  );
}

function createTunnel(name: string): { id: string; name: string } {
  const created = spawnSync('wrangler', ['tunnel', 'create', name], {
    encoding: 'utf8',
  });
  const id =
    created.status === 0
      ? /ID:\s*([0-9a-f-]{36})/i.exec(created.stdout)?.[1]
      : undefined;
  if (!id) {
    throw new Error(
      `wrangler tunnel create failed: ${created.stderr || created.stdout || created.status}`
    );
  }
  return { id, name };
}

function routeDns(tunnelName: string, hostname: string): void {
  const routed = spawnSync(
    'cloudflared',
    ['tunnel', 'route', 'dns', tunnelName, hostname],
    { encoding: 'utf8' }
  );
  if (routed.status === 0) return;
  throw new Error(
    `Could not create DNS for ${hostname}. Wrangler login cannot write zone DNS. Run \`cloudflared tunnel login\` once (browser, not an API token), then retry. cloudflared said: ${routed.stderr || routed.stdout || 'not installed'}`
  );
}

async function provisionMapping(): Promise<DevTunnelsFile> {
  const { apiToken, accountId } = resolveWranglerAuth();
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  async function cf(
    method: string,
    url: string,
    body?: unknown
  ): Promise<unknown> {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: unknown = await response.json();
    if (!isRecord(json) || json.success !== true) {
      const first =
        isRecord(json) && Array.isArray(json.errors)
          ? json.errors[0]
          : undefined;
      throw new Error(
        stringField(first, 'message') ?? `Cloudflare API ${response.status}`
      );
    }
    return json.result;
  }

  const tunnelName = machineTunnelName();
  const listed = await cf(
    'GET',
    `${cloudflareTunnelUrl(accountId)}?is_deleted=false&name=${encodeURIComponent(tunnelName)}`
  );
  const rows = Array.isArray(listed) ? listed : [];
  const match = rows.find((row) => stringField(row, 'name') === tunnelName);
  const existingId = stringField(match, 'id');
  const tunnel = existingId
    ? { id: existingId, name: tunnelName }
    : createTunnel(tunnelName);

  const file: DevTunnelsFile = {
    v: 1,
    tunnelName: tunnel.name,
    tunnelId: tunnel.id,
    zone: tunnelZone(),
    routes: allocateRoutes(),
  };
  await cf(
    'PUT',
    cloudflareTunnelUrl(accountId, `/${tunnel.id}/configurations`),
    { config: tunnelIngressConfig(file.routes) }
  );
  for (const route of file.routes) {
    routeDns(tunnel.name, route.hostname);
  }
  return file;
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(
      `[tunnel] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  });
}
