/**
 * Cloudflare Workflows instance ID generation.
 *
 * CF Workflow instance IDs are global per Worker script. Two deployments
 * sharing the same script (production + PR previews) would collide if they
 * used the same ID. We namespace every ID with an environment slug derived
 * from `VITE_APP_URL` so PR-preview deployments cannot see each other's
 * instances or production's.
 */

const MAX_INSTANCE_ID_LENGTH = 100;

/**
 * Derive a stable, filesystem-safe environment slug from `VITE_APP_URL`.
 *
 * Production: `openstory.so` → `openstory-so`
 * Preview:    `pr-123.openstory.dev` → `pr-123-openstory-dev`
 * Local:      unset → `local`
 */
export function getEnvironmentSlug(env: { VITE_APP_URL?: string }): string {
  const url = env.VITE_APP_URL;
  if (!url) return 'local';
  try {
    return new URL(url).host.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  } catch {
    return 'local';
  }
}

/**
 * Build an instance ID of the form `${envSlug}_${workflowName}_${suffix}`.
 *
 * The suffix is whatever the caller wants to deduplicate on
 * (e.g. `${sequenceId}_${shotId}` for image-workflow). The envSlug prefix
 * is what isolates PR-preview deployments from each other and from prod.
 *
 * Cloudflare Workflows enforces `^[a-zA-Z0-9_-]+$` on instance IDs — no
 * colons, dots, slashes, or other separators. Any non-alphanumeric in the
 * suffix is collapsed to `-`, and the separator between envSlug /
 * workflowName / suffix is `_`.
 *
 * `generation` (default 1) mints a *different* id for the same dedup key, so a
 * trigger whose prior instance died can retry instead of colliding with its own
 * corpse forever (#1149). Generation 1 is the bare id — existing instances keep
 * their ids — and later generations append `_g<n>`. The tag is appended AFTER
 * truncation reserves room for it: truncation cuts the suffix's tail, so a tag
 * merely concatenated on could be sheared off and collapse two generations back
 * into one id.
 *
 * Truncates to 100 chars (CF limit). Truncation happens at the suffix
 * because the env slug + workflow name are needed for namespacing and the
 * suffix is the dedup key — if it gets cut, the worst case is two callers
 * with very similar suffixes colliding (already the same in QStash today).
 */
export function buildInstanceId({
  env,
  workflowName,
  suffix,
  generation = 1,
}: {
  env: { VITE_APP_URL?: string };
  workflowName: string;
  suffix: string;
  generation?: number;
}): string {
  const envSlug = getEnvironmentSlug(env);
  const safeWorkflowName = workflowName.replace(/[^a-zA-Z0-9_-]+/g, '-');
  const prefix = `${envSlug}_${safeWorkflowName}_`;
  const tag = generation > 1 ? `_g${generation}` : '';
  const room = MAX_INSTANCE_ID_LENGTH - prefix.length - tag.length;
  if (room <= 0) {
    throw new Error(
      `Instance ID prefix '${prefix}' exceeds the ${MAX_INSTANCE_ID_LENGTH}-char limit; shorten the env slug or workflow name`
    );
  }
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `${prefix}${safeSuffix.slice(0, room)}${tag}`;
}
