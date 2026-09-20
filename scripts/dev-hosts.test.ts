import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvFile } from './env-file';
import {
  applyMappingToEnv,
  buildMapping,
  machineTunnelName,
  provisionMapping,
  writeMapping,
  type CloudflareIo,
} from './dev-hosts';
import { tunnelIngressConfig, type DevTunnelsFile } from '@/platform/dev-hosts';

let temps: string[] = [];

afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps = [];
});

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openstory-hosts-'));
  temps.push(dir);
  return join(dir, '.env.local');
}

describe('machineTunnelName', () => {
  it('slugs the hostname into a wrangler tunnel name', () => {
    expect(machineTunnelName('Toms-MacBook-Pro.local')).toBe(
      'openstory-dev-tomsmacbookprolocal'
    );
  });
});

describe('applyMappingToEnv', () => {
  const file: DevTunnelsFile = {
    v: 1,
    tunnelName: 'openstory-dev-box',
    tunnelId: '11111111-1111-1111-1111-111111111111',
    zone: 'openstory.so',
    routes: [{ port: 3003, hostname: 'qk3mnpst.openstory.so' }],
  };

  it('writes VITE_APP_URL for a mapped worktree port', () => {
    const envFile = tempFile();
    const origin = applyMappingToEnv(envFile, 3003, file);
    expect(origin).toBe('https://qk3mnpst.openstory.so');
    const env = parseEnvFile(envFile);
    expect(env.get('VITE_APP_URL')).toBe('https://qk3mnpst.openstory.so');
    expect(env.get('PORT')).toBe('3003');
  });

  it('ignores e2e port 3020', () => {
    const envFile = tempFile();
    expect(applyMappingToEnv(envFile, 3020, file)).toBeUndefined();
    expect(() => readFileSync(envFile, 'utf8')).toThrow();
  });
});

describe('provisionMapping', () => {
  it('creates a tunnel, publishes 10 port routes, and CNAMEs each hostname', async () => {
    const cnames: Array<{ hostname: string; target: string }> = [];
    let ingress: ReturnType<typeof tunnelIngressConfig> | undefined;
    const io: CloudflareIo = {
      accountId: 'acct',
      apiToken: 'token',
      createTunnel: async (name) => ({
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        name,
      }),
      findTunnel: async () => undefined,
      putIngress: async (_id, config) => {
        ingress = config;
      },
      upsertCname: async (hostname, target) => {
        cnames.push({ hostname, target });
      },
    };
    let n = 0;
    const file = await provisionMapping(io, {
      tunnelName: 'openstory-dev-test',
      nextBytes: () => {
        const bytes = new Uint8Array(8);
        bytes.fill(n);
        n += 1;
        return bytes;
      },
    });
    expect(file.tunnelName).toBe('openstory-dev-test');
    expect(file.routes).toHaveLength(10);
    expect(ingress?.ingress).toHaveLength(11);
    expect(cnames).toHaveLength(10);
    expect(cnames[0]?.target).toBe(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.cfargotunnel.com'
    );
  });

  it('reuses an existing wrangler tunnel of the same machine name', async () => {
    const io: CloudflareIo = {
      accountId: 'acct',
      apiToken: 'token',
      createTunnel: async () => {
        throw new Error('should not create');
      },
      findTunnel: async () => ({
        id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        name: 'openstory-dev-box',
      }),
      putIngress: async () => undefined,
      upsertCname: async () => undefined,
    };
    const file = await provisionMapping(io, {
      tunnelName: 'openstory-dev-box',
    });
    expect(file.tunnelId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  });
});

describe('writeMapping', () => {
  it('round-trips JSON to the shared path shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openstory-map-'));
    temps.push(dir);
    const path = join(dir, '.openstory', 'dev-tunnels.json');
    let n = 0;
    const file = buildMapping({
      tunnelName: 'openstory-dev-box',
      tunnelId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      nextBytes: () => {
        const bytes = new Uint8Array(8);
        bytes.fill(n);
        n += 1;
        return bytes;
      },
    });
    writeMapping(file, path);
    expect(JSON.parse(readFileSync(path, 'utf8')).tunnelName).toBe(
      'openstory-dev-box'
    );
  });
});
