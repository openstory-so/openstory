/**
 * Compliance configuration (#1180).
 *
 * Every environment variable the compliance surface reads is resolved here, so
 * "what can be configured" is one file rather than a grep. Each key is
 * declared optional in `src/platform/server/env/env.d.ts`.
 */

import { getEnv } from '#env';

/** Optional compliance env keys. Documented in `.env.example`. */
type ComplianceEnvKey =
  /** Where abuse reports are emailed. Unset ⇒ queue-only, no notification. */
  'ABUSE_REPORT_NOTIFY_EMAIL';

export function complianceEnv(key: ComplianceEnvKey): string | undefined {
  return getEnv()[key]?.trim() || undefined;
}
