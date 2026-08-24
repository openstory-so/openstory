/**
 * Reconcile Cloudflare Worker secrets against a Doppler config.
 *
 * Runs on a trusted machine with your existing `doppler login` +
 * `wrangler login`. No service tokens land in CI; blast radius stays this
 * laptop.
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

/**
 * App secrets production may hold. Source of truth is Doppler; this list only
 * gates what we write. Extend when the Worker starts reading a new env var.
 */
const PUSHABLE_SECRETS = [
  'ADMIN_EMAILS',
  'API_KEY_ENCRYPTION_KEY',
  'ARK_API_KEY',
  'ARK_BASE_URL',
  'BETTER_AUTH_SECRET',
  'EMAIL_FROM',
  'FAL_BILLING_KEY',
  'FAL_KEY',
  'FAL_PRICING_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'LANGFUSE_BASE_URL',
  'LANGFUSE_PROMPTS_ENABLED',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'OPENROUTER_KEY',
  'R2_PUBLIC_ASSETS_DOMAIN',
  'R2_PUBLIC_STORAGE_DOMAIN',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'VITE_APP_NAME',
  'VITE_APP_URL',
  'VITE_PUBLIC_POSTHOG_HOST',
  'VITE_PUBLIC_POSTHOG_PROJECT_TOKEN',
  'VITE_R2_PUBLIC_ASSETS_DOMAIN',
] as const;

/** Doppler self-describing context — never Worker bindings. */
const NEVER_PUSH = /^DOPPLER_/;

/**
 * Present in Doppler / legacy Worker but not app runtime secrets for this
 * Worker (deploy tokens, retired integrations, S3-style R2 keys — prod uses
 * R2 bindings). Reported when skipped, never pushed.
 */
const TOOLING_OR_LEGACY = new Set([
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_OAUTH_CLIENT_ID',
  'CLOUDFLARE_ZONE_ID',
  'DEPLOY_PLATFORM',
  'R2_ACCESS_KEY_ID',
  'R2_ACCOUNT_ID',
  'R2_BUCKET_NAME',
  'R2_SECRET_ACCESS_KEY',
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

const args = new Set(process.argv.slice(2));
const push = args.has('--push');
const configIndex = process.argv.indexOf('--config');
const dopplerConfig =
  configIndex !== -1 ? (process.argv[configIndex + 1] ?? 'prd') : 'prd';
const wranglerEnv = WRANGLER_ENV_FOR_CONFIG[dopplerConfig];

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
function workerSecretNames(): Set<string> {
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

const expectedSet = new Set<string>(PUSHABLE_SECRETS);
const expected = [...PUSHABLE_SECRETS].sort();
const doppler = dopplerSecrets(dopplerConfig);
const onWorker = workerSecretNames();

const dopplerNames = Object.keys(doppler).filter((n) => !NEVER_PUSH.test(n));
const payload: Record<string, string> = {};
const rows: Array<[string, string]> = [];

for (const name of expected) {
  const inDoppler = name in doppler;
  const deployed = onWorker.has(name);
  if (inDoppler) {
    const value = doppler[name];
    if (value !== undefined && value !== '') payload[name] = value;
    rows.push([name, deployed ? 'update' : 'CREATE']);
  } else {
    rows.push([name, deployed ? 'worker-only (not in Doppler)' : 'MISSING']);
  }
}

const targetLabel = wranglerEnv
  ? `openstory --env=${wranglerEnv}`
  : 'openstory (default)';

console.log(
  `\nDoppler: ${DOPPLER_PROJECT}/${dopplerConfig}   Worker: ${targetLabel}   mode: ${
    push ? 'PUSH' : 'dry run'
  }\n`
);

const width = Math.max(...rows.map(([name]) => name.length), 8);
for (const [name, action] of rows) {
  console.log(`  ${name.padEnd(width)}  ${action}`);
}

const unexpected = dopplerNames.filter((n) => !expectedSet.has(n));
const tooling = unexpected.filter((n) => TOOLING_OR_LEGACY.has(n));
const unknown = unexpected.filter((n) => !TOOLING_OR_LEGACY.has(n));
if (tooling.length > 0) {
  console.log(`\n  tooling/legacy in Doppler, skipped: ${tooling.join(', ')}`);
}
if (unknown.length > 0) {
  console.log(
    `\n  not in the allowlist, skipped: ${unknown.join(', ')}` +
      `\n  (add to PUSHABLE_SECRETS in scripts/push-secrets.ts if the Worker should have them)`
  );
}
const contextVars = Object.keys(doppler).filter((n) => NEVER_PUSH.test(n));
if (contextVars.length > 0) {
  console.log(
    `  Doppler context vars, never pushed: ${contextVars.join(', ')}`
  );
}

const missing = rows.filter(([, a]) => a === 'MISSING').map(([n]) => n);
const workerOnly = rows
  .filter(([, a]) => a.startsWith('worker-only'))
  .map(([n]) => n);
if (workerOnly.length > 0) {
  console.log(
    `\n  ${workerOnly.length} allowlisted secret(s) live on the Worker but not in Doppler:\n    ${workerOnly.join(', ')}` +
      `\n  Add them to the '${dopplerConfig}' config before relying on this script.`
  );
}
if (missing.length > 0) {
  console.log(
    `\n  ${missing.length} allowlisted secret(s) absent from BOTH:\n    ${missing.join(', ')}`
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
    `\nDry run — nothing sent. ${count} secret(s) would be written.` +
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
  `\nWrote ${count} secret(s) into a new version.` +
    `\nThey go live with the next deploy, which inherits them.\n`
);
