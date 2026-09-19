/**
 * Interactive setup for OpenStory.
 *
 * Local dev barely needs it: `bun dev` bootstraps .env.local automatically
 * (scripts/ensure-env.ts), so `bun install && bun dev` just works. Run
 * `bun setup` to add the AI keys that unlock generation features.
 *
 * Modes:
 *   bun setup                 local dev — secrets + AI keys in .env.local
 *   bun setup --prod          production config + deploy (.env.production)
 *   bun setup --deploy        push secrets + deploy using .env.production
 *   bun setup --pr-preview    push PR-preview secrets to GitHub "staging"
 */

import * as p from '@clack/prompts';
import chalk from 'chalk';
import { resolve } from 'path';
import { claimSlot, defaultTunnelIo, TunnelError } from './dev-tunnel';
import {
  ensureLocalEnv,
  parseEnvFile,
  parseEnvString,
  upsertEnvVars,
} from './env-file';
import { runProdSetup } from './setup-prod';

const isDeploy = process.argv.includes('--deploy');
const isPrPreview = process.argv.includes('--pr-preview');
const isProd = process.argv.includes('--prod');
const wantTunnel = process.argv.includes('--tunnel');
const noTunnel = process.argv.includes('--no-tunnel');

const ENV_FILE = resolve(process.cwd(), '.env.local');

const AI_KEYS = [
  {
    key: 'FAL_KEY',
    message: 'Fal.ai API key — image, video & audio generation',
    hint: 'Get one at: https://fal.ai/dashboard/keys (Enter to skip)',
  },
  {
    key: 'OPENROUTER_KEY',
    message: 'OpenRouter API key — LLM script analysis',
    hint: 'Get one at: https://openrouter.ai/settings/keys (Enter to skip)',
  },
] as const;

async function localSetup() {
  p.intro(chalk.bold('Welcome to OpenStory Setup'));

  // Secrets + required defaults (same bootstrap `bun dev` runs).
  const added = ensureLocalEnv();
  if (added.length > 0) {
    p.log.success(`.env.local — added ${added.join(', ')}`);
  } else {
    p.log.success('.env.local — already configured');
  }

  // AI keys — the only values worth prompting for. Everything else is
  // optional and documented in .env.example.
  const vars = parseEnvFile(ENV_FILE);

  for (const { key, message, hint } of AI_KEYS) {
    if (vars.has(key)) {
      p.log.success(`${key} — already configured`);
      continue;
    }

    const raw = await p.text({
      message: `${message}\n${chalk.dim(hint)}`,
      placeholder: `Paste your ${key} here…`,
    });

    if (p.isCancel(raw)) {
      p.cancel('Setup cancelled. Progress saved to .env.local');
      process.exit(0);
    }

    if (typeof raw !== 'string' || !raw.trim()) continue;

    // Accept either a raw value or a pasted KEY=VALUE line.
    const parsed = parseEnvString(raw);
    if (parsed.size > 0) {
      upsertEnvVars(ENV_FILE, Object.fromEntries(parsed));
    } else {
      let value = raw.trim();
      if (
        value.length >= 2 &&
        ((value[0] === '"' && value.at(-1) === '"') ||
          (value[0] === "'" && value.at(-1) === "'"))
      ) {
        value = value.slice(1, -1);
      }
      upsertEnvVars(ENV_FILE, { [key]: value });
    }
    p.log.success(`${key} — saved`);
  }

  p.note(
    [
      'Optional services (Google OAuth, Stripe, PostHog, remote R2)',
      'are documented in .env.example — add them to .env.local when needed.',
    ].join('\n'),
    'Optional'
  );

  const shouldClaimTunnel = await resolveTunnelChoice();
  if (shouldClaimTunnel) {
    try {
      const claimed = await claimSlot(defaultTunnelIo());
      p.log.success(
        `Tunnel ${claimed.slot} → ${claimed.origin} (port ${claimed.port})`
      );
    } catch (error) {
      p.log.error(
        error instanceof TunnelError
          ? error.message
          : `Tunnel claim failed: ${String(error)}`
      );
    }
  }

  p.outro(
    `Run ${chalk.bold('bun dev')} to start the development server.\nPublic HTTPS (Google OAuth, inbound webhooks): ${chalk.bold('bun tunnel')}\nTo deploy to production, run: ${chalk.bold('bun setup --prod')}`
  );
}

async function resolveTunnelChoice(): Promise<boolean> {
  if (noTunnel) return false;
  if (wantTunnel) return true;
  if (!process.stdin.isTTY) return false;
  const yes = await p.confirm({
    message:
      'Claim a public HTTPS tunnel slot? (Google OAuth / inbound webhooks; needs cloudflared)',
    initialValue: false,
  });
  if (p.isCancel(yes) || typeof yes !== 'boolean') {
    p.cancel('Setup cancelled. Progress saved to .env.local');
    process.exit(0);
  }
  return yes;
}

async function main() {
  if (isPrPreview) return runProdSetup('pr-preview');
  if (isDeploy) return runProdSetup('deploy');
  if (isProd) return runProdSetup('prod');
  return localSetup();
}

main().catch((error) => {
  p.log.error(
    `Setup failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
