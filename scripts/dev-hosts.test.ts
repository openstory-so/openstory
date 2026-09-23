import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvFile } from './env-file';
import {
  applyMappingToEnv,
  assignDevServerEnv,
  pickFreeDevPort,
  readMapping,
} from './dev-hosts';

let temps: string[] = [];

afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openstory-hosts-'));
  temps.push(dir);
  return dir;
}

function mapping(
  overrides: {
    v?: 1;
    tunnelName?: string;
    tunnelId?: string;
    zone?: string;
    routes?: Array<{ port: number; hostname: string }>;
  } = {}
) {
  return {
    v: 1 as const,
    tunnelName: 'openstory-dev-box',
    tunnelId: '11111111-1111-1111-1111-111111111111',
    zone: 'openstory.so',
    routes: [{ port: 3003, hostname: 'qk3mnpst.openstory.so' }],
    ...overrides,
  };
}

describe('assignDevServerEnv', () => {
  it('replaces a PORT the parent autoloaded before the file was rewritten', () => {
    const previousPort = process.env.PORT;
    const previousUrl = process.env.VITE_APP_URL;
    process.env.PORT = '3000';
    process.env.VITE_APP_URL = 'http://localhost:3000';
    try {
      assignDevServerEnv(3007, 'https://qk3mnpst.openstory.so');
      expect(process.env.PORT).toBe('3007');
      expect(process.env.VITE_APP_URL).toBe('https://qk3mnpst.openstory.so');
    } finally {
      restoreEnv('PORT', previousPort);
      restoreEnv('VITE_APP_URL', previousUrl);
    }
  });
});

function restoreEnv(key: 'PORT' | 'VITE_APP_URL', value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('applyMappingToEnv', () => {
  it('writes PORT and VITE_APP_URL, and drops a stale tunnel BETTER_AUTH_URL', () => {
    const envFile = join(tempDir(), '.env.local');
    writeFileSync(
      envFile,
      'BETTER_AUTH_URL=https://qk3mnpst.openstory.so\nFAL_KEY=x\n'
    );
    const origin = applyMappingToEnv(envFile, 3003, mapping());
    expect(origin).toBe('https://qk3mnpst.openstory.so');
    const env = parseEnvFile(envFile);
    expect(env.get('PORT')).toBe('3003');
    expect(env.get('VITE_APP_URL')).toBe('https://qk3mnpst.openstory.so');
    // Pinned, Google returns to the tunnel host even from localhost (#1701).
    expect(env.has('BETTER_AUTH_URL')).toBe(false);
    expect(env.get('FAL_KEY')).toBe('x');
  });

  it('ignores e2e port 3020', () => {
    const envFile = join(tempDir(), '.env.local');
    expect(applyMappingToEnv(envFile, 3020, mapping())).toBeUndefined();
    expect(() => readFileSync(envFile, 'utf8')).toThrow();
  });

  it('no-ops when the slot has no hostname', () => {
    const envFile = join(tempDir(), '.env.local');
    expect(applyMappingToEnv(envFile, 3004, mapping())).toBeUndefined();
    expect(() => readFileSync(envFile, 'utf8')).toThrow();
  });
});

describe('readMapping', () => {
  it('returns undefined for a missing file or invalid schema', () => {
    const dir = tempDir();
    expect(readMapping(join(dir, 'missing.json'))).toBeUndefined();
    const invalid = join(dir, 'invalid.json');
    writeFileSync(invalid, JSON.stringify({ tunnelName: 'x' }));
    expect(readMapping(invalid)).toBeUndefined();
  });

  it('reads a v1 map and fills zone when omitted', () => {
    const path = join(tempDir(), 'dev-tunnels.json');
    const { zone: _zone, ...rest } = mapping();
    writeFileSync(path, JSON.stringify(rest));
    const file = readMapping(path);
    expect(file?.tunnelName).toBe('openstory-dev-box');
    expect(file?.routes).toEqual([
      { port: 3003, hostname: 'qk3mnpst.openstory.so' },
    ]);
    expect(file?.zone).toBeTruthy();
  });
});

describe('pickFreeDevPort', () => {
  it('returns the preferred slot when that port is free', async () => {
    expect(await pickFreeDevPort(3003, async (port) => port === 3003)).toBe(
      3003
    );
  });

  it('hops to another 3000–3009 slot when the preferred port is taken', async () => {
    expect(await pickFreeDevPort(3003, async (port) => port === 3004)).toBe(
      3004
    );
  });

  it('never probes the e2e port when preferred is 3020', async () => {
    const seen: number[] = [];
    const port = await pickFreeDevPort(3020, async (candidate) => {
      seen.push(candidate);
      return candidate === 3001;
    });
    expect(port).toBe(3001);
    expect(seen[0]).toBe(3000);
    expect(seen).not.toContain(3020);
  });

  it('throws when every 3000–3009 slot is taken', async () => {
    await expect(pickFreeDevPort(3000, async () => false)).rejects.toThrow(
      /3000–3009/
    );
  });
});
