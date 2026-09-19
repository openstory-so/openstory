/**
 * Local-dev HTTPS slots (#740).
 *
 *   bun tunnel                 claim a slot, write .env.local, start cloudflared
 *   bun teardown               kill that cloudflared and free the slot
 *   bun tunnel --status        print this worktree's slot
 *   bun tunnel:provision       one-time Cloudflare account setup
 *
 * `bun install && bun dev` stays on http://localhost:3000. Tunnels are opt-in
 * so a missing cloudflared binary never takes down ordinary local work, and so
 * the public hostname does not serve the fixed local OTP.
 *
 * Ten named tunnels, not one UUID with ten CNAMEs: extra connectors on a
 * single tunnel are load-balanced, and ingress is applied only after a
 * request already landed on a connector.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  DEV_TUNNEL_SLOT_NAMES,
  type DevTunnelSlotName,
  devTunnelHostname,
  devTunnelLocalPort,
  devTunnelName,
  devTunnelOrigin,
  slotFromOrigin,
} from '@/platform/dev-tunnel-slots';
import { parseEnvFile, upsertEnvVars } from './env-file';

type Occupancy = {
  pid: number;
  worktree: string;
  port: number;
};

type SlotFile = {
  v: 1;
  slots: Record<DevTunnelSlotName, Occupancy | null>;
};

export type ClaimedSlot = {
  slot: DevTunnelSlotName;
  origin: string;
  port: number;
  pid: number;
  tunnelName: string;
  reused: boolean;
};

export type TunnelIo = {
  homeDir: string;
  worktree: string;
  envFile: string;
  now: () => number;
  isPidAlive: (pid: number) => boolean;
  cloudflaredPath: () => string | null;
  spawnTunnel: (input: {
    slot: DevTunnelSlotName;
    port: number;
    configPath: string;
    logPath: string;
  }) => { pid: number };
  killPid: (pid: number, signal?: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
};

export class TunnelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TunnelError';
  }
}

const SLOT_FILE_NAME = '.openstory-dev-slots.json';
const LOCK_DIR_NAME = '.openstory-dev-slots.lock';
const LOCK_WAIT_MS = 10_000;

export function generateIngressYaml(input: {
  slot: DevTunnelSlotName;
  port: number;
  credentialsFile?: string;
}): string {
  const lines = [`tunnel: ${devTunnelName(input.slot)}`];
  if (input.credentialsFile) {
    lines.push(`credentials-file: ${input.credentialsFile}`);
  }
  lines.push(
    'ingress:',
    `  - hostname: ${devTunnelHostname(input.slot)}`,
    `    service: http://127.0.0.1:${input.port}`,
    '  - service: http_status:404',
    ''
  );
  return lines.join('\n');
}

export function provisionPlan(): Array<{
  slot: DevTunnelSlotName;
  tunnel: string;
  hostname: string;
  create: string;
  route: string;
  googleCallback: string;
}> {
  return DEV_TUNNEL_SLOT_NAMES.map((slot) => {
    const tunnel = devTunnelName(slot);
    const hostname = devTunnelHostname(slot);
    return {
      slot,
      tunnel,
      hostname,
      create: `cloudflared tunnel create ${tunnel}`,
      route: `cloudflared tunnel route dns ${tunnel} ${hostname}`,
      googleCallback: `${devTunnelOrigin(slot)}/api/auth/callback/google`,
    };
  });
}

function emptySlots(): SlotFile {
  return {
    v: 1,
    slots: {
      dev1: null,
      dev2: null,
      dev3: null,
      dev4: null,
      dev5: null,
      dev6: null,
      dev7: null,
      dev8: null,
      dev9: null,
      dev10: null,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOccupancy(value: unknown): Occupancy | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.pid !== 'number' ||
    typeof value.worktree !== 'string' ||
    typeof value.port !== 'number'
  ) {
    return null;
  }
  return { pid: value.pid, worktree: value.worktree, port: value.port };
}

function nodeErrorCode(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== 'string') return undefined;
  return error.code;
}

function slotFilePath(io: TunnelIo): string {
  return join(io.homeDir, SLOT_FILE_NAME);
}

function lockDirPath(io: TunnelIo): string {
  return join(io.homeDir, LOCK_DIR_NAME);
}

function ingressPath(io: TunnelIo, slot: DevTunnelSlotName): string {
  return join(io.homeDir, '.openstory', 'ingress', `${slot}.yml`);
}

function logPath(io: TunnelIo, slot: DevTunnelSlotName): string {
  return join(io.homeDir, '.openstory', 'logs', `${slot}.log`);
}

function credentialsFile(
  io: TunnelIo,
  slot: DevTunnelSlotName
): string | undefined {
  const named = join(io.homeDir, '.cloudflared', `${devTunnelName(slot)}.json`);
  if (existsSync(named)) return named;
  const envPath = process.env.OPENSTORY_TUNNEL_CREDENTIALS;
  if (envPath && existsSync(envPath)) return envPath;
  return undefined;
}

function readSlots(io: TunnelIo): SlotFile {
  const path = slotFilePath(io);
  if (!existsSync(path)) return emptySlots();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.slots)) {
      return emptySlots();
    }
    const slots = emptySlots();
    for (const name of DEV_TUNNEL_SLOT_NAMES) {
      slots.slots[name] = parseOccupancy(parsed.slots[name]);
    }
    return slots;
  } catch {
    return emptySlots();
  }
}

function writeSlots(io: TunnelIo, file: SlotFile): void {
  const path = slotFilePath(io);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(tmp, path);
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withLock<T>(io: TunnelIo, fn: () => Promise<T> | T): Promise<T> {
  const dir = lockDirPath(io);
  mkdirSync(io.homeDir, { recursive: true });
  const deadline = io.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, 'pid'), `${process.pid}\n`);
      break;
    } catch (error) {
      const code = nodeErrorCode(error);
      if (code !== 'EEXIST') throw error;
      if (io.now() > deadline) {
        throw new TunnelError(
          `Timed out waiting for ${dir}. If no other bun tunnel is running, delete that directory.`
        );
      }
      const pidFile = join(dir, 'pid');
      const lockPid = existsSync(pidFile)
        ? Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
        : Number.NaN;
      if (!Number.isFinite(lockPid) || !io.isPidAlive(lockPid)) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      await io.sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sweep(io: TunnelIo, file: SlotFile): void {
  const here = resolve(io.worktree);
  for (const name of DEV_TUNNEL_SLOT_NAMES) {
    const occupancy = file.slots[name];
    if (!occupancy) continue;
    if (resolve(occupancy.worktree) === here) continue;
    if (!io.isPidAlive(occupancy.pid)) file.slots[name] = null;
  }
}

function occupancyForWorktree(
  io: TunnelIo,
  file: SlotFile
): { slot: DevTunnelSlotName; occupancy: Occupancy } | undefined {
  const here = resolve(io.worktree);
  for (const name of DEV_TUNNEL_SLOT_NAMES) {
    const occupancy = file.slots[name];
    if (occupancy && resolve(occupancy.worktree) === here) {
      return { slot: name, occupancy };
    }
  }
  return undefined;
}

function firstFree(file: SlotFile): DevTunnelSlotName | undefined {
  return DEV_TUNNEL_SLOT_NAMES.find((name) => file.slots[name] === null);
}

function writeWorktreeEnv(io: TunnelIo, vars: Record<string, string>): void {
  mkdirSync(dirname(io.envFile), { recursive: true });
  upsertEnvVars(io.envFile, vars);
}

function startCloudflared(
  io: TunnelIo,
  slot: DevTunnelSlotName,
  port: number
): { pid: number } {
  const bin = io.cloudflaredPath();
  if (!bin) {
    throw new TunnelError(
      'cloudflared is not on PATH. Install it with `brew install cloudflared` (or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then run `bun tunnel:provision` once on this Cloudflare account.'
    );
  }
  const configPath = ingressPath(io, slot);
  mkdirSync(dirname(configPath), { recursive: true });
  mkdirSync(dirname(logPath(io, slot)), { recursive: true });
  writeFileSync(
    configPath,
    generateIngressYaml({
      slot,
      port,
      credentialsFile: credentialsFile(io, slot),
    })
  );
  return io.spawnTunnel({
    slot,
    port,
    configPath,
    logPath: logPath(io, slot),
  });
}

function claimed(
  slot: DevTunnelSlotName,
  pid: number,
  reused: boolean
): ClaimedSlot {
  return {
    slot,
    origin: devTunnelOrigin(slot),
    port: devTunnelLocalPort(slot),
    pid,
    tunnelName: devTunnelName(slot),
    reused,
  };
}

function persistClaim(
  io: TunnelIo,
  slot: DevTunnelSlotName,
  pid: number
): ClaimedSlot {
  const port = devTunnelLocalPort(slot);
  const origin = devTunnelOrigin(slot);
  writeWorktreeEnv(io, {
    VITE_APP_URL: origin,
    BETTER_AUTH_URL: origin,
    PORT: String(port),
  });
  return claimed(slot, pid, false);
}

export async function claimSlot(io: TunnelIo): Promise<ClaimedSlot> {
  return withLock(io, () => {
    const file = readSlots(io);
    sweep(io, file);
    const existing = occupancyForWorktree(io, file);
    if (existing) {
      const { slot, occupancy } = existing;
      if (io.isPidAlive(occupancy.pid)) {
        writeWorktreeEnv(io, {
          VITE_APP_URL: devTunnelOrigin(slot),
          BETTER_AUTH_URL: devTunnelOrigin(slot),
          PORT: String(occupancy.port),
        });
        writeSlots(io, file);
        return claimed(slot, occupancy.pid, true);
      }
      const { pid } = startCloudflared(io, slot, occupancy.port);
      file.slots[slot] = {
        pid,
        worktree: resolve(io.worktree),
        port: occupancy.port,
      };
      writeSlots(io, file);
      const result = persistClaim(io, slot, pid);
      return { ...result, reused: true };
    }
    const slot = firstFree(file);
    if (!slot) {
      throw new TunnelError(
        'All 10 local-dev tunnel slots are in use. Run `bun teardown` in a worktree you no longer need, or inspect ~/.openstory-dev-slots.json.'
      );
    }
    const port = devTunnelLocalPort(slot);
    const { pid } = startCloudflared(io, slot, port);
    file.slots[slot] = {
      pid,
      worktree: resolve(io.worktree),
      port,
    };
    writeSlots(io, file);
    return persistClaim(io, slot, pid);
  });
}

export async function releaseSlot(
  io: TunnelIo
): Promise<ClaimedSlot | undefined> {
  return withLock(io, () => {
    const file = readSlots(io);
    sweep(io, file);
    const existing = occupancyForWorktree(io, file);
    if (!existing) {
      writeSlots(io, file);
      return undefined;
    }
    const { slot, occupancy } = existing;
    if (io.isPidAlive(occupancy.pid)) io.killPid(occupancy.pid, 'SIGTERM');
    file.slots[slot] = null;
    writeSlots(io, file);
    const local = `http://localhost:${occupancy.port}`;
    writeWorktreeEnv(io, {
      VITE_APP_URL: local,
      BETTER_AUTH_URL: local,
      PORT: String(occupancy.port),
    });
    return claimed(slot, occupancy.pid, true);
  });
}

export async function slotStatus(
  io: TunnelIo
): Promise<ClaimedSlot | undefined> {
  const file = readSlots(io);
  const existing = occupancyForWorktree(io, file);
  if (!existing) return undefined;
  return claimed(existing.slot, existing.occupancy.pid, true);
}

export async function ensureWorktreeTunnel(
  io: TunnelIo
): Promise<ClaimedSlot | undefined> {
  const existing = occupancyForWorktree(io, readSlots(io));
  if (existing) return claimSlot(io);

  const appUrl = parseEnvFile(io.envFile).get('VITE_APP_URL');
  if (appUrl && slotFromOrigin(appUrl)) {
    throw new TunnelError(
      `VITE_APP_URL is ${appUrl} but this worktree has no slot in ~/.openstory-dev-slots.json. Run \`bun tunnel\` to claim one, or \`bun teardown\` to go back to localhost.`
    );
  }
  return undefined;
}

export function whichCloudflared(): string | null {
  const found = spawnSync('which', ['cloudflared'], { encoding: 'utf8' });
  const path = found.stdout.trim();
  return found.status === 0 && path.length > 0 ? path : null;
}

export function defaultTunnelIo(overrides?: Partial<TunnelIo>): TunnelIo {
  const homeDir = overrides?.homeDir ?? homedir();
  const worktree = resolve(overrides?.worktree ?? process.cwd());
  return {
    homeDir,
    worktree,
    envFile: overrides?.envFile ?? join(worktree, '.env.local'),
    now: overrides?.now ?? Date.now,
    isPidAlive: overrides?.isPidAlive ?? isPidAlive,
    cloudflaredPath: overrides?.cloudflaredPath ?? whichCloudflared,
    spawnTunnel:
      overrides?.spawnTunnel ??
      ((input) => {
        const bin = whichCloudflared();
        if (!bin) {
          throw new TunnelError('cloudflared is not on PATH.');
        }
        mkdirSync(dirname(input.logPath), { recursive: true });
        const logFd = openSync(input.logPath, 'a');
        const child = spawn(
          bin,
          [
            'tunnel',
            '--config',
            input.configPath,
            '--no-autoupdate',
            'run',
            devTunnelName(input.slot),
          ],
          {
            detached: true,
            stdio: ['ignore', logFd, logFd],
          }
        );
        child.unref();
        if (child.pid === undefined) {
          throw new TunnelError('cloudflared failed to start.');
        }
        return { pid: child.pid };
      }),
    killPid:
      overrides?.killPid ??
      ((pid, signal = 'SIGTERM') => {
        try {
          process.kill(pid, signal);
        } catch {
          // already gone
        }
      }),
    sleep: overrides?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    ...overrides,
  };
}

function printClaim(claimedSlot: ClaimedSlot, verb: string): void {
  console.log(
    `[tunnel] ${verb} ${claimedSlot.slot} → ${claimedSlot.origin} (port ${claimedSlot.port}, pid ${claimedSlot.pid})`
  );
}

async function runCli(argv: string[]): Promise<void> {
  const io = defaultTunnelIo();
  const flag = argv[0];
  if (flag === '--stop' || flag === 'teardown') {
    const released = await releaseSlot(io);
    if (!released) {
      console.log('[tunnel] this worktree does not hold a slot');
      return;
    }
    printClaim(released, 'released');
    return;
  }
  if (flag === '--status' || flag === 'status') {
    const status = await slotStatus(io);
    if (!status) {
      console.log('[tunnel] this worktree does not hold a slot');
      return;
    }
    printClaim(status, 'holds');
    return;
  }
  if (flag === '--provision' || flag === 'provision') {
    const bin = whichCloudflared();
    if (!bin) {
      throw new TunnelError(
        'cloudflared is not on PATH. Install it, run `cloudflared tunnel login`, then re-run `bun tunnel:provision`.'
      );
    }
    console.log(
      'Creating ten named tunnels (one hostname each). Google OAuth still needs these redirect URIs added by hand:\n'
    );
    for (const step of provisionPlan()) {
      console.log(`  ${step.googleCallback}`);
      for (const command of [step.create, step.route]) {
        console.log(`  $ ${command}`);
        const result = spawnSync(command, { shell: true, stdio: 'inherit' });
        if (result.status !== 0) {
          console.log(
            '  (if the tunnel or DNS record already exists, that is fine)'
          );
        }
      }
      console.log('');
    }
    console.log(
      'Then run `bun tunnel` in each worktree that needs a public HTTPS URL.'
    );
    return;
  }
  if (flag && flag !== '--start') {
    throw new TunnelError(
      'Usage: bun tunnel [--status|--stop|--provision|--start]'
    );
  }
  const claimedSlot = await claimSlot(io);
  printClaim(claimedSlot, claimedSlot.reused ? 'reusing' : 'claimed');
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(
      `[tunnel] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  });
}
