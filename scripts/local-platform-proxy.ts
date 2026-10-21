/**
 * `getPlatformProxy()` for local CLI scripts, without the spurious workerd
 * warnings about Durable Object / Workflow classes (#859).
 *
 * `getPlatformProxy` reads `wrangler.jsonc` but starts Miniflare with an **empty
 * worker** (`script: ""`) — it never bundles our `main` entry (`src/server.ts`)
 * where `RealtimeChannel` and the workflow classes are exported. So workerd is
 * handed the `REALTIME → RealtimeChannel` DO namespace (and the workflow
 * bindings) from the config but finds no such class in the worker it's running,
 * and warns:
 *
 *   "A DurableObjectNamespace in the config referenced the class
 *    "RealtimeChannel", but no such Durable Object class is exported ...
 *    Future versions of workerd may make this a startup-time error."
 *
 * These scripts only touch D1 (and R2 for the import script); they never call
 * `env.REALTIME` or the workflow bindings. So we hand `getPlatformProxy` a
 * slimmed copy of the config with the un-hostable class declarations stripped.
 * That silences both warnings and pre-empts the future startup-error.
 *
 * The slimmed config is written to the **repo root** (next to `wrangler.jsonc`),
 * not a temp dir, because `getPlatformProxy` resolves several things relative to
 * the config file's directory (verified against wrangler 4.91 source):
 *   - `.env` / `.env.local` discovery (so local vars resolve)
 *   - `main` and `migrations_dir`
 * and keys local D1/R2 persistence by binding identity (`database_id` etc.).
 * Keeping the D1/R2 bindings byte-identical and the file at the repo root means
 * the proxy lands on the exact same `.wrangler/state` SQLite files that
 * `bun dev` / `wrangler dev` use.
 */
import JSON5 from 'json5';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy, type PlatformProxy } from 'wrangler';

const WRANGLER_CONFIG = fileURLToPath(
  new URL('../wrangler.jsonc', import.meta.url)
);

/**
 * Config keys declaring classes the empty proxy worker can't host. `migrations`
 * is the DO class-migration list (`new_sqlite_classes`), meaningless once
 * `durable_objects` is gone.
 */
const UNHOSTABLE_KEYS = ['durable_objects', 'workflows', 'migrations'] as const;

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toRecord(value: object): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) record[key] = entry;
  return record;
}

function stripUnhostable(block: Record<string, unknown>): void {
  for (const key of UNHOSTABLE_KEYS) delete block[key];
}

function readEnvBlocks(
  value: unknown
): Record<string, Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error('wrangler env must be an object');
  const env: Record<string, Record<string, unknown>> = {};
  for (const [name, block] of Object.entries(toRecord(value))) {
    if (!isObject(block)) {
      throw new Error(`wrangler env.${name} must be an object`);
    }
    env[name] = toRecord(block);
  }
  return env;
}

/**
 * Write a DO/Workflow-stripped copy of `wrangler.jsonc` to the repo root and
 * return its path. Per-pid filename so concurrent runs don't clobber each other.
 */
function writeSlimmedConfig(): string {
  // JSON5 handles wrangler.jsonc's comments + trailing commas.
  const parsed: unknown = JSON5.parse(readFileSync(WRANGLER_CONFIG, 'utf8'));
  if (!isObject(parsed)) {
    throw new Error('wrangler.jsonc must be a JSON object');
  }
  const config = toRecord(parsed);
  stripUnhostable(config);
  const env = readEnvBlocks(config.env);
  if (env) {
    for (const block of Object.values(env)) stripUnhostable(block);
    config.env = env;
  }

  const slimmedPath = fileURLToPath(
    new URL(`../wrangler.local-proxy.${process.pid}.jsonc`, import.meta.url)
  );
  writeFileSync(slimmedPath, JSON.stringify(config, null, 2));
  return slimmedPath;
}

/**
 * Drop-in for `getPlatformProxy({ environment, remoteBindings: false })` that
 * uses the slimmed config. Local scripts only read local D1/R2, so
 * `remoteBindings` is always disabled (skips the remote-proxy session that
 * `remote: true` bindings would otherwise need a CLOUDFLARE_API_TOKEN for).
 */
export async function getLocalPlatformProxy<Env = Record<string, unknown>>(
  options: { environment?: string } = {}
): Promise<PlatformProxy<Env>> {
  const configPath = writeSlimmedConfig();
  try {
    // getPlatformProxy reads configPath synchronously before this resolves, so
    // the file can be removed as soon as the proxy is built.
    return await getPlatformProxy<Env>({
      configPath,
      environment: options.environment,
      remoteBindings: false,
    });
  } finally {
    rmSync(configPath, { force: true });
  }
}
