/**
 * Local single-tenant bootstrap.
 *
 * The hosted app is multi-team behind Better Auth; the local (npx/bunx) server
 * has exactly one implicit user and team and no auth. This module mints that
 * fixed principal and hands back a `ScopedDb` bound to it, so every existing
 * team-scoped write path works unchanged — the agent ingesting assets writes
 * through the same `scopedDb` surface the generation workflows use in prod.
 *
 * The user/team rows are created through `ensureUserAndTeam`, the same bootstrap
 * the Better Auth sign-up hook uses, so nothing here touches `teams` /
 * `team_members` directly.
 */

import {
  createScopedDb,
  ensureUserAndTeam,
  type ScopedDb,
} from '@/platform/server/db/scoped';

/** Stable id for the single local user. Any string is a valid `user.id`. */
export const LOCAL_USER_ID = 'local-user';
const LOCAL_USER_NAME = 'Local';
const LOCAL_USER_EMAIL = 'local@openstory.local';

let cached: ScopedDb | undefined;

/**
 * Ensure the local user + team exist and return a `ScopedDb` scoped to them.
 * Memoized per process — the row creation is idempotent, but the scoped handle
 * is cheap to reuse.
 */
export async function getLocalScopedDb(): Promise<ScopedDb> {
  if (cached) return cached;

  const result = await ensureUserAndTeam({
    id: LOCAL_USER_ID,
    name: LOCAL_USER_NAME,
    email: LOCAL_USER_EMAIL,
  });
  if (!result.success || !result.data) {
    throw new Error(
      `[local] failed to bootstrap local user/team: ${result.error ?? 'unknown error'}`
    );
  }
  const teamId = result.data.teamMembers?.[0]?.teamId;
  if (!teamId) {
    throw new Error('[local] bootstrap returned no team membership');
  }

  cached = createScopedDb(teamId, LOCAL_USER_ID);
  return cached;
}
