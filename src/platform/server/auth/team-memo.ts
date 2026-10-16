import { resolveUserTeam } from '@/platform/server/db/scoped';
import { loadComplianceState } from '@/platform/server/compliance/generation-gate';

/**
 * The team a user acts as and their compliance state, memoised per isolate
 * for a few seconds (#2082). A sequence page fires ~40 server fns within a
 * second or two, and each resolved both from the primary — two round trips,
 * 350–450 ms apiece from Europe — before any work. Concurrent calls share one
 * in-flight read; a change to membership or enforcement is seen within
 * `TEAM_MEMO_TTL_MS` on an isolate that already answered for the user. Only
 * a GET is answered from the memo: a write reads both fresh (and refreshes
 * the memo), so a removed member or a new enforcement bites on the next
 * write.
 */
const TEAM_MEMO_TTL_MS = 5_000;
export type ResolvedTeam = {
  team: Awaited<ReturnType<typeof resolveUserTeam>>;
  compliance: Awaited<ReturnType<typeof loadComplianceState>> | null;
};
const teamMemo = new Map<
  string,
  { until: number; value: Promise<ResolvedTeam> }
>();

export async function resolveTeamAndCompliance(
  userId: string,
  method: string
): Promise<ResolvedTeam> {
  const now = Date.now();
  const hit = method === 'GET' ? teamMemo.get(userId) : undefined;
  if (hit && hit.until > now) return hit.value;
  // ponytail: prune on insert; a per-user entry for the whole isolate life
  // would otherwise grow with every user it ever answered.
  for (const [key, entry] of teamMemo)
    if (entry.until <= now) teamMemo.delete(key);
  const value = (async () => {
    const team = await resolveUserTeam(userId);
    return {
      team,
      compliance: team ? await loadComplianceState(userId, team.teamId) : null,
    };
  })();
  teamMemo.set(userId, { until: now + TEAM_MEMO_TTL_MS, value });
  // A failed read is not kept: the next call reads again.
  value.catch(() => teamMemo.delete(userId));
  return value;
}
