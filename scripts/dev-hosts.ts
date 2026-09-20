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
import { hostname as osHostname, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  allocateRoutes,
  DEV_TUNNELS_RELATIVE_PATH,
  DEV_TUNNEL_ZONE,
  googleCallbackUrls,
  isDevTunnelPort,
  originForPort,
  tunnelIngressConfig,
  type DevTunnelsFile,
} from '@/platform/dev-hosts';
import { upsertEnvVars } from './env-file';

export class DevHostsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevHostsError';
  }
}

export type CloudflareIo = {
  accountId: string;
  apiToken: string;
  createTunnel: (name: string) => Promise<{ id: string; name: string }>;
  findTunnel: (
    name: string
  ) => Promise<{ id: string; name: string } | undefined>;
  putIngress: (
    tunnelId: string,
    config: ReturnType<typeof tunnelIngressConfig>
  ) => Promise<void>;
  upsertCname: (hostname: string, target: string) => Promise<void>;
};

export function mappingPath(homeDir = homedir()): string {
  return join(homeDir, DEV_TUNNELS_RELATIVE_PATH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRoute(
  value: unknown
): DevTunnelsFile['routes'][number] | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.port !== 'number' || typeof value.hostname !== 'string') {
    return undefined;
  }
  return { port: value.port, hostname: value.hostname };
}

export function readMapping(path = mappingPath()): DevTunnelsFile | undefined {
  if (!existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.routes)) {
    return undefined;
  }
  if (
    typeof parsed.tunnelName !== 'string' ||
    typeof parsed.tunnelId !== 'string'
  ) {
    return undefined;
  }
  const routes = parsed.routes
    .map(parseRoute)
    .filter((route) => route !== undefined);
  if (routes.length === 0) return undefined;
  return {
    v: 1,
    tunnelName: parsed.tunnelName,
    tunnelId: parsed.tunnelId,
    zone: typeof parsed.zone === 'string' ? parsed.zone : DEV_TUNNEL_ZONE,
    routes,
  };
}

export function writeMapping(file: DevTunnelsFile, path = mappingPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
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

export function machineTunnelName(hostname = osHostname()): string {
  const slug = hostname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24);
  return `openstory-dev-${slug || 'local'}`;
}

function randomBytes(): Uint8Array {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function buildMapping(input: {
  tunnelName: string;
  tunnelId: string;
  nextBytes?: () => Uint8Array;
}): DevTunnelsFile {
  return {
    v: 1,
    tunnelName: input.tunnelName,
    tunnelId: input.tunnelId,
    zone: DEV_TUNNEL_ZONE,
    routes: allocateRoutes(input.nextBytes ?? randomBytes),
  };
}

export async function provisionMapping(
  io: CloudflareIo,
  options?: { tunnelName?: string; nextBytes?: () => Uint8Array }
): Promise<DevTunnelsFile> {
  const tunnelName = options?.tunnelName ?? machineTunnelName();
  const existing = await io.findTunnel(tunnelName);
  const tunnel = existing ?? (await io.createTunnel(tunnelName));
  const file = buildMapping({
    tunnelName: tunnel.name,
    tunnelId: tunnel.id,
    nextBytes: options?.nextBytes,
  });
  await io.putIngress(tunnel.id, tunnelIngressConfig(file.routes));
  const target = `${tunnel.id}.cfargotunnel.com`;
  for (const route of file.routes) {
    await io.upsertCname(route.hostname, target);
  }
  return file;
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
    if (!reset && readMapping(path)) {
      console.log(
        'Mapping already exists. Pass --reset to allocate new hostnames.\n'
      );
      const file = readMapping(path);
      if (file) printMapping(file);
      return;
    }
    const io = await defaultCloudflareIo();
    const file = await provisionMapping(io);
    writeMapping(file, path);
    printMapping(file);
    return;
  }
  const file = readMapping();
  if (!file) {
    throw new DevHostsError(
      `No mapping at ${mappingPath()}. Run \`bun tunnel:provision\` (needs wrangler login / CLOUDFLARE_API_TOKEN).`
    );
  }
  printMapping(file);
}

export async function defaultCloudflareIo(): Promise<CloudflareIo> {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!apiToken || !accountId) {
    throw new DevHostsError(
      'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required to register hostnames. They are the same credentials wrangler deploy uses.'
    );
  }
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  function stringField(value: unknown, key: string): string | undefined {
    if (!isRecord(value) || typeof value[key] !== 'string') return undefined;
    return value[key];
  }

  function firstId(rows: unknown): string | undefined {
    if (!Array.isArray(rows) || rows.length === 0) return undefined;
    return stringField(rows[0], 'id');
  }

  function cfErrorMessage(json: unknown, status: number): string {
    if (!isRecord(json) || !Array.isArray(json.errors)) {
      return `Cloudflare API ${status}`;
    }
    const first = json.errors[0];
    return stringField(first, 'message') ?? `Cloudflare API ${status}`;
  }

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
      throw new DevHostsError(cfErrorMessage(json, response.status));
    }
    return json.result;
  }

  return {
    accountId,
    apiToken,
    createTunnel: async (name) => {
      const created = spawnSync('wrangler', ['tunnel', 'create', name], {
        encoding: 'utf8',
      });
      if (created.status === 0) {
        const id = /ID:\s*([0-9a-f-]{36})/i.exec(created.stdout)?.[1];
        if (id) return { id, name };
      }
      const result = await cf(
        'POST',
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnels`,
        { name, config_src: 'cloudflare' }
      );
      const id = stringField(result, 'id');
      if (!id) throw new DevHostsError('tunnel create did not return an id');
      return { id, name };
    },
    findTunnel: async (name) => {
      const result = await cf(
        'GET',
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnels?is_deleted=false&name=${encodeURIComponent(name)}`
      );
      const rows = Array.isArray(result) ? result : [];
      const match = rows.find((row) => stringField(row, 'name') === name);
      const id = stringField(match, 'id');
      if (!id) return undefined;
      return { id, name };
    },
    putIngress: async (tunnelId, config) => {
      await cf(
        'PUT',
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnels/${tunnelId}/configurations`,
        { config }
      );
    },
    upsertCname: async (hostname, target) => {
      const zoneResult = await cf(
        'GET',
        `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(DEV_TUNNEL_ZONE)}`
      );
      const zoneId = firstId(zoneResult);
      if (!zoneId) {
        throw new DevHostsError(`Could not find zone ${DEV_TUNNEL_ZONE}`);
      }
      const existing = await cf(
        'GET',
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`
      );
      const recordId = firstId(existing);
      const payload = {
        type: 'CNAME',
        name: hostname,
        content: target,
        proxied: true,
        ttl: 1,
      };
      if (recordId) {
        await cf(
          'PUT',
          `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`,
          payload
        );
        return;
      }
      await cf(
        'POST',
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
        payload
      );
    },
  };
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(
      `[tunnel] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  });
}
