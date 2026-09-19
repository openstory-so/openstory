import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvFile } from './env-file';
import {
  claimSlot,
  ensureWorktreeTunnel,
  generateIngressYaml,
  provisionPlan,
  releaseSlot,
  slotStatus,
  type TunnelIo,
} from './dev-tunnel';

let tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openstory-tunnel-'));
  tempRoots.push(dir);
  return dir;
}

function makeIo(
  root: string,
  options?: {
    worktree?: string;
    alive?: Set<number>;
    nextPid?: { value: number };
    spawns?: Array<{ slot: string; port: number; configPath: string }>;
    kills?: number[];
  }
): TunnelIo {
  const alive = options?.alive ?? new Set<number>();
  const nextPid = options?.nextPid ?? { value: 1000 };
  const spawns = options?.spawns ?? [];
  const kills = options?.kills ?? [];
  const worktree = options?.worktree ?? join(root, 'wt-a');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(root, 'home'), { recursive: true });
  return {
    homeDir: join(root, 'home'),
    worktree,
    envFile: join(worktree, '.env.local'),
    now: () => 1_700_000_000_000,
    isPidAlive: (pid) => alive.has(pid),
    cloudflaredPath: () => '/usr/local/bin/cloudflared',
    spawnTunnel: ({ slot, port, configPath }) => {
      spawns.push({ slot, port, configPath });
      const pid = nextPid.value++;
      alive.add(pid);
      return { pid };
    },
    killPid: (pid) => {
      kills.push(pid);
      alive.delete(pid);
    },
    sleep: async () => undefined,
  };
}

describe('generateIngressYaml', () => {
  it('pins one hostname to the slot origin and 404s everything else', () => {
    expect(
      generateIngressYaml({
        slot: 'dev2',
        port: 3001,
        credentialsFile: '/tmp/cred.json',
      })
    ).toBe(
      [
        'tunnel: openstory-dev2',
        'credentials-file: /tmp/cred.json',
        'ingress:',
        '  - hostname: dev2.openstory.so',
        '    service: http://127.0.0.1:3001',
        '  - service: http_status:404',
        '',
      ].join('\n')
    );
  });
});

describe('provisionPlan', () => {
  it('creates ten named tunnels and DNS routes, not one shared UUID', () => {
    const plan = provisionPlan();
    expect(plan).toHaveLength(10);
    expect(plan[0]).toEqual({
      slot: 'dev1',
      tunnel: 'openstory-dev1',
      hostname: 'dev1.openstory.so',
      create: 'cloudflared tunnel create openstory-dev1',
      route: 'cloudflared tunnel route dns openstory-dev1 dev1.openstory.so',
      googleCallback: 'https://dev1.openstory.so/api/auth/callback/google',
    });
    expect(plan[9]?.tunnel).toBe('openstory-dev10');
    expect(plan[9]?.googleCallback).toBe(
      'https://dev10.openstory.so/api/auth/callback/google'
    );
  });
});

describe('claimSlot', () => {
  it('takes the first free slot, writes env, and starts cloudflared', async () => {
    const root = tempDir();
    const spawns: Array<{ slot: string; port: number; configPath: string }> =
      [];
    const io = makeIo(root, { spawns });

    const claimed = await claimSlot(io);

    expect(claimed).toEqual({
      slot: 'dev1',
      origin: 'https://dev1.openstory.so',
      port: 3000,
      pid: 1000,
      tunnelName: 'openstory-dev1',
      reused: false,
    });
    expect(spawns).toHaveLength(1);
    const spawn = spawns[0];
    if (!spawn) throw new Error('expected cloudflared spawn');
    expect(spawn.port).toBe(3000);
    const env = parseEnvFile(io.envFile);
    expect(env.get('VITE_APP_URL')).toBe('https://dev1.openstory.so');
    expect(env.get('BETTER_AUTH_URL')).toBe('https://dev1.openstory.so');
    expect(env.get('PORT')).toBe('3000');
    const yaml = readFileSync(spawn.configPath, 'utf8');
    expect(yaml).toContain('hostname: dev1.openstory.so');
    expect(yaml).toContain('service: http://127.0.0.1:3000');
  });

  it('reuses the worktree slot instead of claiming a second one', async () => {
    const root = tempDir();
    const io = makeIo(root);
    const first = await claimSlot(io);
    const second = await claimSlot(io);
    expect(second.slot).toBe(first.slot);
    expect(second.pid).toBe(first.pid);
    expect(second.reused).toBe(true);
  });

  it('skips a live slot owned by another worktree', async () => {
    const root = tempDir();
    const alive = new Set<number>();
    const a = makeIo(root, {
      worktree: join(root, 'wt-a'),
      alive,
      nextPid: { value: 1000 },
    });
    const b = makeIo(root, {
      worktree: join(root, 'wt-b'),
      alive,
      nextPid: { value: 2000 },
    });
    await claimSlot(a);
    const claimedB = await claimSlot(b);
    expect(claimedB.slot).toBe('dev2');
    expect(claimedB.port).toBe(3001);
    expect(claimedB.origin).toBe('https://dev2.openstory.so');
  });

  it('reclaims a dead pid from another worktree and prefers the lowest slot', async () => {
    const root = tempDir();
    const alive = new Set<number>();
    const a = makeIo(root, {
      worktree: join(root, 'wt-a'),
      alive,
      nextPid: { value: 1000 },
    });
    await claimSlot(a);
    alive.clear();
    const b = makeIo(root, {
      worktree: join(root, 'wt-b'),
      alive,
      nextPid: { value: 2000 },
    });
    const claimed = await claimSlot(b);
    expect(claimed.slot).toBe('dev1');
    expect(claimed.pid).toBe(2000);
  });

  it('respawns this worktree on the same slot after the pid dies', async () => {
    const root = tempDir();
    const alive = new Set<number>();
    const io = makeIo(root, { alive, nextPid: { value: 1000 } });
    await claimSlot(io);
    alive.clear();
    const again = await claimSlot(io);
    expect(again.slot).toBe('dev1');
    expect(again.pid).toBe(1001);
    expect(again.reused).toBe(true);
  });

  it('tells you to install cloudflared when the binary is missing', async () => {
    const root = tempDir();
    const io = makeIo(root);
    io.cloudflaredPath = () => null;
    await expect(claimSlot(io)).rejects.toThrow(/cloudflared is not on PATH/i);
  });

  it('refuses a full pool of live slots', async () => {
    const root = tempDir();
    const alive = new Set<number>();
    const nextPid = { value: 1 };
    for (let i = 0; i < 10; i++) {
      await claimSlot(
        makeIo(root, {
          worktree: join(root, `wt-${i}`),
          alive,
          nextPid,
        })
      );
    }
    await expect(
      claimSlot(
        makeIo(root, {
          worktree: join(root, 'wt-full'),
          alive,
          nextPid,
        })
      )
    ).rejects.toThrow(/all 10 local-dev tunnel slots are in use/i);
  });
});

describe('releaseSlot', () => {
  it('kills cloudflared, frees the slot, and restores a localhost app URL', async () => {
    const root = tempDir();
    const kills: number[] = [];
    const io = makeIo(root, { kills });
    const claimed = await claimSlot(io);
    const released = await releaseSlot(io);
    expect(released?.slot).toBe('dev1');
    expect(kills).toEqual([claimed.pid]);
    expect(await slotStatus(io)).toBeUndefined();
    const env = parseEnvFile(io.envFile);
    expect(env.get('VITE_APP_URL')).toBe('http://localhost:3000');
    expect(env.get('BETTER_AUTH_URL')).toBe('http://localhost:3000');
    expect(env.get('PORT')).toBe('3000');
  });
});

describe('ensureWorktreeTunnel', () => {
  it('is a no-op when the worktree is on localhost', async () => {
    const root = tempDir();
    const spawns: Array<{ slot: string; port: number; configPath: string }> =
      [];
    const io = makeIo(root, { spawns });
    writeFileSync(io.envFile, 'VITE_APP_URL=http://localhost:3000\n');
    const ensured = await ensureWorktreeTunnel(io);
    expect(ensured).toBeUndefined();
    expect(spawns).toHaveLength(0);
  });

  it('restarts a dead claimed tunnel without taking a new slot', async () => {
    const root = tempDir();
    const alive = new Set<number>();
    const spawns: Array<{ slot: string; port: number; configPath: string }> =
      [];
    const io = makeIo(root, { alive, spawns, nextPid: { value: 50 } });
    await claimSlot(io);
    expect(spawns).toHaveLength(1);
    alive.clear();
    const ensured = await ensureWorktreeTunnel(io);
    expect(ensured?.slot).toBe('dev1');
    expect(ensured?.pid).toBe(51);
    expect(spawns).toHaveLength(2);
  });
});
