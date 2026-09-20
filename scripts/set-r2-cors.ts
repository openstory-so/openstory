/**
 * Apply CORS rules to OpenStory's R2 buckets. Idempotent — safe to re-run.
 *
 * Usage:
 *   bun scripts/set-r2-cors.ts                  # all envs
 *   bun scripts/set-r2-cors.ts --env=prd        # prod only
 *   bun scripts/set-r2-cors.ts --env=stg        # staging only
 *   bun scripts/set-r2-cors.ts --env=dev        # local dev only
 *
 * Auth: requires CLOUDFLARE_API_TOKEN in env, or `wrangler login`.
 */

import { buildRules, setBucketCors } from './r2-cors';

type EnvKey = 'prd' | 'dev';

type BucketConfig = {
  bucket: string;
  origins: string[];
  /** PUT allowed (presigned uploads from the browser). */
  includeWrites: boolean;
};

const CONFIG: Record<EnvKey, BucketConfig[]> = {
  prd: [
    {
      bucket: 'openstory-storage',
      origins: ['https://openstory.so', 'https://app.openstory.so'],
      includeWrites: true,
    },
    {
      bucket: 'openstory-public-assets',
      origins: ['https://openstory.so', 'https://app.openstory.so'],
      includeWrites: false,
    },
  ],
  dev: [
    {
      bucket: 'openstory-dev',
      // 3000–3009 are bun dev worktrees; 3020 is the e2e Playwright server.
      origins: [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:3002',
        'http://localhost:3003',
        'http://localhost:3004',
        'http://localhost:3005',
        'http://localhost:3006',
        'http://localhost:3007',
        'http://localhost:3008',
        'http://localhost:3009',
        'http://localhost:3020',
      ],
      includeWrites: true,
    },
  ],
};

function parseFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function isEnvKey(value: string): value is EnvKey {
  return value === 'prd' || value === 'dev';
}

function main(): void {
  const envFlag = parseFlag('env');
  if (envFlag !== undefined && !isEnvKey(envFlag)) {
    console.error(`Unknown --env=${envFlag}. Use prd or dev.`);
    process.exit(1);
  }

  const targets = envFlag ? CONFIG[envFlag] : Object.values(CONFIG).flat();

  for (const { bucket, origins, includeWrites } of targets) {
    console.log(
      `\n→ ${bucket} (origins: ${origins.join(', ')}, writes: ${includeWrites})`
    );
    setBucketCors(bucket, buildRules({ origins, includeWrites }));
  }
}

main();
