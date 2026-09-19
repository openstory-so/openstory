/**
 * Zero-touch local env bootstrap — runs as the first step of `bun dev` so
 * `bun install && bun dev` works with no manual setup. Also the toolchain
 * preflight, being the earliest thing `bun dev` / `bun dev:all` execute.
 *
 * Everything beyond the generated minimum (AI keys, OAuth, Stripe, …) is
 * optional — `bun setup` prompts for the AI keys, and .env.example documents
 * the rest.
 */

import { readFileSync } from 'node:fs';
import {
  defaultTunnelIo,
  ensureWorktreeTunnel,
  TunnelError,
} from './dev-tunnel';
import { ensureLocalEnv } from './env-file';

const isOlder = (a: string, b: string): boolean => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
};

/**
 * Fixes (issue #1418).
 */
const assertSupportedBun = (): void => {
  const current = process.versions.bun;
  if (!current) return; // not launched by Bun — the flag problem can't arise

  const manifest: { engines?: { bun?: string } } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  );

  const floor = /(\d+\.\d+\.\d+)/.exec(manifest.engines?.bun ?? '')?.[1];
  if (!floor || !isOlder(current, floor)) return;

  console.error(
    [
      '',
      `  Bun ${current} is too old — this project requires >= ${floor}.`,
      '',
      '  `bun dev:all` uses `bun run --parallel`, added in Bun 1.3.9. On older',
      '  versions it does not start the Stripe listener or export sidecar.',
      '',
      '  Fix:  bun upgrade',
      '',
    ].join('\n')
  );
  process.exit(1);
};

assertSupportedBun();

const added = ensureLocalEnv();
if (added.length > 0) {
  console.log(`[ensure-env] .env.local: added ${added.join(', ')}`);
}

// Reboot recovery for an already-claimed slot. Never claims a new one, and
// skipped in e2e so a leftover tunnel URL cannot rewrite the hermetic env.
if (process.env.E2E_TEST !== 'true' && process.env.CLOUDFLARE_ENV !== 'test') {
  try {
    const tunnel = await ensureWorktreeTunnel(defaultTunnelIo());
    if (tunnel) {
      console.log(
        `[ensure-env] tunnel ${tunnel.slot} → ${tunnel.origin} (pid ${tunnel.pid})`
      );
    }
  } catch (error) {
    const message =
      error instanceof TunnelError ? error.message : String(error);
    console.error(`[ensure-env] ${message}`);
    process.exit(1);
  }
}
