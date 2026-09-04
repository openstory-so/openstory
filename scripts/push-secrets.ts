/**
 * Reconcile Cloudflare Worker secrets against a Doppler config.
 *
 * Runs on a trusted machine with your existing `doppler login` +
 * `wrangler login`. No service tokens land in CI; blast radius stays this
 * laptop.
 *
 * Classify every new secret before adding it. "Where the value lives"
 * (Doppler, Worker) is not "where the value is needed":
 *
 *   runtime  Worker reads it at request/cron time (`getEnv()` / `env.`).
 *            Script `process.env` does not count — that is local tooling.
 *   build    Vite inlines it at `vite build` (`import.meta.env`). A Worker
 *            secret is never visible to that build, so the value belongs in
 *            Workers Builds variables (next to `CLOUDFLARE_ENV=production`),
 *            not a runtime binding. GitHub vars from `setup-prod.ts` only
 *            feed CI tests and PR-preview deploys.
 *
 * Grep those two spellings in `src/` (and `worker-configuration.d.ts` does
 * not count — wrangler types every secret already on the Worker). Then set
 * the flags. `--push` writes only `runtime: true`. Build-only and unused
 * entries stay on the list so the next person classifies them instead of
 * re-adding them to a flat allowlist.
 *
 * Safety rules:
 * - Values stay in memory only. Never written to disk, never passed as argv
 *   (visible in `ps`), never echoed. They reach wrangler over stdin.
 * - Only an ALLOWLIST is pushed. Doppler always injects `DOPPLER_*` context
 *   vars; those must never become Worker bindings.
 * - Deploy/tooling credentials (`CLOUDFLARE_API_TOKEN`, etc.) are never
 *   pushed even if present in Doppler.
 * - Nothing is ever deleted. `wrangler secret bulk` can null-delete; this
 *   script never emits nulls — removals stay deliberate and manual.
 * - Dry run unless `--push` is passed.
 *
 * Secrets are written via `wrangler versions secret bulk` into a NEW version
 * (not the live Worker). The next deploy inherits the bindings.
 *
 * Usage:
 *   bun scripts/push-secrets.ts                # dry-run prd → production
 *   bun scripts/push-secrets.ts --push         # apply
 *   bun scripts/push-secrets.ts --config stg   # other Doppler config
 *   bun secrets:push:prd                       # package shortcut with --push
 */
import { spawnSync } from 'node:child_process';

const DOPPLER_PROJECT = 'openstory';

/** Worker reads it at request/cron time (`getEnv()` / `env.`). */
export type SecretNeed = {
  runtime: boolean;
  /** Vite inlines it at build time (`import.meta.env`) — Workers Builds vars. */
  build: boolean;
};

/**
 * App secrets production may hold. Source of truth is Doppler; this catalog
 * only gates what we write and how we report. Extend when the Worker starts
 * reading a new env var — classify runtime vs build, do not append blindly.
 */
export const SECRETS = {
  ADMIN_EMAILS: { runtime: true, build: false },
  API_KEY_ENCRYPTION_KEY: { runtime: true, build: false },
  ARK_API_KEY: { runtime: true, build: false },
  ARK_BASE_URL: { runtime: true, build: false },
  BYTEPLUS_ACCESS_KEY: { runtime: true, build: false },
  BYTEPLUS_SECRET_KEY: { runtime: true, build: false },
  BYTEPLUS_ASSET_GROUP_ID: { runtime: true, build: false },
  BYTEPLUS_OPENAPI_HOST: { runtime: true, build: false },
  BETTER_AUTH_SECRET: { runtime: true, build: false },
  EMAIL_FROM: { runtime: true, build: false },
  FAL_BILLING_KEY: { runtime: true, build: false },
  FAL_KEY: { runtime: true, build: false },
  GEMINI_API_KEY: { runtime: true, build: false },
  GOOGLE_CLIENT_ID: { runtime: true, build: false },
  GOOGLE_CLIENT_SECRET: { runtime: true, build: false },
  LANGFUSE_BASE_URL: { runtime: false, build: false },
  LANGFUSE_PROMPTS_ENABLED: { runtime: false, build: false },
  LANGFUSE_PUBLIC_KEY: { runtime: false, build: false },
  LANGFUSE_SECRET_KEY: { runtime: false, build: false },
  LLMTR_API_KEY: { runtime: true, build: false },
  OPENROUTER_KEY: { runtime: true, build: false },
  R2_PUBLIC_ASSETS_DOMAIN: { runtime: false, build: false },
  R2_PUBLIC_STORAGE_DOMAIN: { runtime: true, build: false },
  STRIPE_SECRET_KEY: { runtime: true, build: false },
  STRIPE_WEBHOOK_SECRET: { runtime: true, build: false },
  VITE_APP_NAME: { runtime: true, build: true },
  VITE_APP_URL: { runtime: true, build: true },
  VITE_PUBLIC_POSTHOG_HOST: { runtime: true, build: true },
  VITE_PUBLIC_POSTHOG_PROJECT_TOKEN: { runtime: true, build: true },
  VITE_R2_PUBLIC_ASSETS_DOMAIN: { runtime: false, build: true },
  XAI_API_KEY: { runtime: true, build: false },
} as const satisfies Record<string, SecretNeed>;

/** Doppler self-describing context — never Worker bindings. */
const NEVER_PUSH = /^DOPPLER_/;

/**
 * Present in Doppler / legacy Worker but not app runtime secrets for this
 * Worker (deploy tokens, retired integrations, S3-style R2 keys — prod uses
 * R2 bindings). Reported when skipped, never pushed.
 */
export const TOOLING_OR_LEGACY = new Set([
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_OAUTH_CLIENT_ID',
  'CLOUDFLARE_ZONE_ID',
  'DEPLOY_PLATFORM',
  'R2_ACCESS_KEY_ID',
  'R2_ACCOUNT_ID',
  'R2_BUCKET_NAME',
  'R2_SECRET_ACCESS_KEY',
  // Local fal billing-compare tooling (`scripts/verify-fal-costs.ts --compare`,
  // `scripts/env-file.ts`). The Worker's admin-scoped fal key is FAL_BILLING_KEY.
  'FAL_PRICING_KEY',
  // Pre-rename / retired names sometimes left on the Worker
  'APP_NAME',
  'APP_URL',
  'BETTER_AUTH_URL',
  'FAL_CONCURRENCY_LIMIT',
  'GH_OAUTH_CLIENT_ID',
  'GH_OAUTH_CLIENT_SECRET',
  'LANGFUSE_TRACING_ENVIRONMENT',
  'QSTASH_CURRENT_SIGNING_KEY',
  'QSTASH_NEXT_SIGNING_KEY',
  'QSTASH_TOKEN',
  'QSTASH_URL',
  'RESEND_API_KEY',
  'UPSTASH_REDIS_REST_TOKEN',
  'UPSTASH_REDIS_REST_URL',
]);

/** Doppler config name → wrangler `--env` (undefined = top-level worker). */
const WRANGLER_ENV_FOR_CONFIG: Record<string, string | undefined> = {
  prd: 'production',
  // stg / ci / dev have no dedicated wrangler env block for secret push.
};

export type SecretRow = {
  name: string;
  runtime: boolean;
  build: boolean;
  doppler: boolean;
  worker: boolean;
  action: string;
};

export function secretAction(
  need: SecretNeed,
  inDoppler: boolean,
  onWorker: boolean
): string {
  if (!need.runtime && need.build) {
    return 'build-only - set in Workers Builds';
  }
  if (!need.runtime) {
    return 'unused - nothing reads it';
  }
  if (inDoppler) return onWorker ? 'update' : 'CREATE';
  return onWorker ? 'worker-only (not in Doppler)' : 'MISSING';
}

/**
 * Runtime secrets with a non-empty Doppler value. Never emits null, never
 * includes build-only or unused entries.
 */
export function buildPushPayload(
  catalog: Record<string, SecretNeed>,
  doppler: Record<string, string>
): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const [name, need] of Object.entries(catalog)) {
    if (!need.runtime) continue;
    const value = doppler[name];
    if (value !== undefined && value !== '') payload[name] = value;
  }
  return payload;
}

export function secretRows(
  catalog: Record<string, SecretNeed>,
  dopplerNames: ReadonlySet<string>,
  workerNames: ReadonlySet<string>
): Array<SecretRow> {
  return Object.keys(catalog)
    .sort()
    .map((name) => {
      const need = catalog[name] ?? { runtime: false, build: false };
      const inDoppler = dopplerNames.has(name);
      const onWorker = workerNames.has(name);
      return {
        name,
        runtime: need.runtime,
        build: need.build,
        doppler: inDoppler,
        worker: onWorker,
        action: secretAction(need, inDoppler, onWorker),
      };
    });
}

function yn(value: boolean): 'y' | '-' {
  return value ? 'y' : '-';
}

export function formatSecretsTable(rows: Array<SecretRow>): string {
  const nameWidth = Math.max(
    ...rows.map((r) => r.name.length),
    'SECRET'.length
  );
  const flagWidth = 8;
  const header = [
    'SECRET'.padEnd(nameWidth),
    'runtime'.padStart(flagWidth),
    'build'.padStart(flagWidth),
    'doppler'.padStart(flagWidth),
    'worker'.padStart(flagWidth),
    '  action',
  ].join('');
  const body = rows.map((row) =>
    [
      row.name.padEnd(nameWidth),
      yn(row.runtime).padStart(flagWidth),
      yn(row.build).padStart(flagWidth),
      yn(row.doppler).padStart(flagWidth),
      yn(row.worker).padStart(flagWidth),
      `  ${row.action}`,
    ].join('')
  );
  return [header, ...body].join('\n');
}

function run(
  command: string,
  commandArgs: Array<string>,
  stdin?: string
): string {
  const result = spawnSync(command, commandArgs, {
    input: stdin,
    encoding: 'utf8',
    // Inherit stderr for auth prompts / errors; capture stdout so secret
    // payloads never print.
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${command} not found. Install it and ensure it is on PATH.`
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs[0] ?? ''} failed`);
  }
  return result.stdout;
}

function isNamedSecret(item: unknown): item is { name: string } {
  return (
    typeof item === 'object' &&
    item !== null &&
    'name' in item &&
    typeof item.name === 'string'
  );
}

function parseWorkerSecretList(raw: string): Array<{ name: string }> {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) {
    throw new Error('wrangler secret list: expected a JSON array');
  }
  return value.map((item, i) => {
    if (!isNamedSecret(item)) {
      throw new Error(`wrangler secret list: invalid entry at index ${i}`);
    }
    return { name: item.name };
  });
}

function parseDopplerJson(raw: string): Record<string, string> {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('doppler secrets download: expected a JSON object');
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string') out[key] = val;
  }
  return out;
}

/** Secret names currently bound to the target Worker (names only). */
function workerSecretNames(wranglerEnv: string | undefined): Set<string> {
  const cmdArgs = ['wrangler', 'secret', 'list'];
  if (wranglerEnv) cmdArgs.push('--env', wranglerEnv);
  const raw = run('bunx', cmdArgs);
  return new Set(parseWorkerSecretList(raw).map((s) => s.name));
}

/** Every secret in the Doppler config. Held in memory; never persisted. */
function dopplerSecrets(config: string): Record<string, string> {
  const raw = run('doppler', [
    'secrets',
    'download',
    '--project',
    DOPPLER_PROJECT,
    '--config',
    config,
    '--no-file',
    '--format',
    'json',
  ]);
  return parseDopplerJson(raw);
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const push = args.has('--push');
  const configIndex = process.argv.indexOf('--config');
  const dopplerConfig =
    configIndex !== -1 ? (process.argv[configIndex + 1] ?? 'prd') : 'prd';
  const wranglerEnv = WRANGLER_ENV_FOR_CONFIG[dopplerConfig];

  const catalog: Record<string, SecretNeed> = SECRETS;
  const expectedSet = new Set(Object.keys(catalog));
  const doppler = dopplerSecrets(dopplerConfig);
  const onWorker = workerSecretNames(wranglerEnv);

  const dopplerNames = Object.keys(doppler).filter((n) => !NEVER_PUSH.test(n));
  const payload = buildPushPayload(catalog, doppler);
  const rows = secretRows(catalog, new Set(dopplerNames), onWorker);

  const targetLabel = wranglerEnv
    ? `openstory --env=${wranglerEnv}`
    : 'openstory (default)';

  console.log(
    `\nDoppler: ${DOPPLER_PROJECT}/${dopplerConfig}   Worker: ${targetLabel}   mode: ${
      push ? 'PUSH' : 'dry run'
    }\n`
  );
  console.log(
    '  runtime = Worker reads it (pushed).  build = Vite inlines it (Workers Builds vars, not pushed).\n'
  );
  console.log(formatSecretsTable(rows));

  const unexpected = dopplerNames.filter((n) => !expectedSet.has(n));
  const tooling = unexpected.filter((n) => TOOLING_OR_LEGACY.has(n));
  const unknown = unexpected.filter((n) => !TOOLING_OR_LEGACY.has(n));
  if (tooling.length > 0) {
    console.log(
      `\n  tooling/legacy in Doppler, skipped: ${tooling.join(', ')}`
    );
  }
  if (unknown.length > 0) {
    console.log(
      `\n  not in the catalog, skipped: ${unknown.join(', ')}` +
        `\n  (add to SECRETS in scripts/push-secrets.ts with runtime/build flags if the Worker should have them)`
    );
  }
  const contextVars = Object.keys(doppler).filter((n) => NEVER_PUSH.test(n));
  if (contextVars.length > 0) {
    console.log(
      `  Doppler context vars, never pushed: ${contextVars.join(', ')}`
    );
  }

  const missing = rows
    .filter((r) => r.runtime && r.action === 'MISSING')
    .map((r) => r.name);
  const workerOnly = rows
    .filter((r) => r.runtime && r.action.startsWith('worker-only'))
    .map((r) => r.name);
  if (workerOnly.length > 0) {
    console.log(
      `\n  ${workerOnly.length} runtime secret(s) live on the Worker but not in Doppler:\n    ${workerOnly.join(', ')}` +
        `\n  Add them to the '${dopplerConfig}' config before relying on this script.`
    );
  }
  if (missing.length > 0) {
    console.log(
      `\n  ${missing.length} runtime secret(s) absent from BOTH:\n    ${missing.join(', ')}`
    );
  }

  // Worker secrets we do not manage — informational only.
  const unmanagedOnWorker = [...onWorker]
    .filter((n) => !expectedSet.has(n) && !NEVER_PUSH.test(n))
    .sort();
  if (unmanagedOnWorker.length > 0) {
    console.log(
      `\n  already on Worker, not managed by this script (left alone):\n    ${unmanagedOnWorker.join(', ')}`
    );
  }

  const count = Object.keys(payload).length;
  if (!push) {
    console.log(
      `\nDry run — nothing sent. ${count} runtime secret(s) would be written.` +
        ` Re-run with --push to apply (or \`bun secrets:push:prd\`).\n`
    );
    process.exit(0);
  }
  if (count === 0) {
    console.log('\nNothing to push.\n');
    process.exit(0);
  }

  /**
   * One API call, over stdin: no temp file, nothing in argv, nothing in shell
   * history. Deletions are impossible here because no key is ever set to null.
   *
   * `wrangler versions secret bulk` rather than plain `wrangler secret bulk`,
   * which edits the live Worker and refuses with Cloudflare error 10215 when
   * the newest uploaded version is not the deployed one (common with Workers
   * Builds). The versions API has no such precondition.
   */
  const bulkArgs = ['wrangler', 'versions', 'secret', 'bulk'];
  if (wranglerEnv) bulkArgs.push('--env', wranglerEnv);
  run('bunx', bulkArgs, JSON.stringify(payload));
  console.log(
    `\nWrote ${count} runtime secret(s) into a new version.` +
      `\nThey go live with the next deploy, which inherits them.\n`
  );
}

if (import.meta.main) main();
