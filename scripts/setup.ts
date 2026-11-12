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
import {
  ensureLocalEnv,
  parseEnvFile,
  parseEnvString,
  upsertEnvVars,
} from './env-file';
import { runProdSetup } from './setup-prod';
import { homedir } from 'node:os';
import {
  defaultDataDir,
  isWorktree,
  markerFile,
  syncedFolderWarning,
  writeMarker,
} from './state-dir';

const isDeploy = process.argv.includes('--deploy');
const isPrPreview = process.argv.includes('--pr-preview');
const isProd = process.argv.includes('--prod');

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
  {
    key: 'ELEVENLABS_API_KEY',
    message: 'ElevenLabs API key — character voices, dialogue & music',
    hint: 'Get one at: https://elevenlabs.io/app/settings/api-keys (Enter to skip)',
  },
  {
    key: 'SEED_SPEECH_API_KEY',
    needs: 'ELEVENLABS_API_KEY',
    message: 'BytePlus Seed Speech API key — Seed Audio character voices',
    hint: 'Optional: https://console.byteplus.com/voice/new/setting/apikeys (Enter to skip)',
  },
  {
    key: 'ARK_API_KEY',
    message: 'BytePlus Ark API key — Seedance & Seedream direct from BytePlus',
    hint: 'Optional, ap-southeast only: https://console.byteplus.com/ark (Enter to skip)',
  },
  {
    key: 'BYTEPLUS_ACCESS_KEY',
    needs: 'ARK_API_KEY',
    message: 'BytePlus IAM Access Key — realistic faces on Seedance 2.5',
    hint: 'BytePlus console → IAM → Key management (Enter to skip)',
  },
  {
    key: 'BYTEPLUS_SECRET_KEY',
    needs: 'BYTEPLUS_ACCESS_KEY',
    message: 'BytePlus IAM Secret Key — pairs with the Access Key',
    hint: 'Shown once when the Access Key is created (Enter to skip)',
  },
] satisfies readonly {
  key: string;
  needs?: string;
  message: string;
  hint: string;
}[];

async function localSetup() {
  p.intro(chalk.bold('Welcome to OpenStory Setup'));

  // Secrets + required defaults (same bootstrap `bun dev` runs).
  const added = ensureLocalEnv();
  if (added.length > 0) {
    p.log.success(`.env.local — added ${added.join(', ')}`);
  } else {
    p.log.success('.env.local — already configured');
  }

  await chooseDataDir();

  // AI keys — the only values worth prompting for. Everything else is
  // optional and documented in .env.example.
  const vars = parseEnvFile(ENV_FILE);

  for (const { key, needs, message, hint } of AI_KEYS) {
    if (vars.has(key)) {
      p.log.success(`${key} — already configured`);
      continue;
    }
    // Re-read: the key this one needs may have been saved a moment ago.
    if (needs && !parseEnvFile(ENV_FILE).has(needs)) continue;

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

  p.outro(
    `Run ${chalk.bold('bun dev')} to start the development server.\nPublic HTTPS: ${chalk.bold('bun tunnel:provision')} then press t + Enter in bun dev.\nTo deploy to production, run: ${chalk.bold('bun setup --prod')}`
  );
}

/** Where the local library lives (#2222). Default ~/openstory needs no env var. */
async function chooseDataDir() {
  if (isWorktree()) {
    p.log.info('Data folder — a worktree keeps its state in .wrangler');
    return;
  }
  const home = homedir();
  const current =
    parseEnvFile(ENV_FILE).get('OPENSTORY_DATA_DIR') ?? defaultDataDir(home);
  const raw = await p.text({
    message: 'Data folder — your local library and its database',
    placeholder: current,
    defaultValue: current,
  });
  if (p.isCancel(raw)) {
    p.cancel('Setup cancelled. Progress saved to .env.local');
    process.exit(0);
  }
  const dir = resolve(raw.trim().replace(/^~(?=\/|$)/, home) || current);
  const synced = syncedFolderWarning(dir, home);
  if (synced) {
    p.log.warn(
      `${dir} is synced by ${synced}. A live database there can be corrupted; pick a local folder.`
    );
    const ok = await p.confirm({
      message: 'Use it anyway?',
      initialValue: false,
    });
    if (p.isCancel(ok) || !ok) return chooseDataDir();
  }
  writeMarker(dir);
  const isDefault = dir === defaultDataDir(home);
  if (!isDefault || parseEnvFile(ENV_FILE).has('OPENSTORY_DATA_DIR')) {
    upsertEnvVars(ENV_FILE, { OPENSTORY_DATA_DIR: isDefault ? '' : dir });
  }
  p.log.success(`Data folder — ${dir} (${markerFile(dir)})`);
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
