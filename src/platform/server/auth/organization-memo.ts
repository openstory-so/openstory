import { getUserOrganizationMembership } from '@/platform/server/db/scoped';
import { loadComplianceState } from '@/platform/server/compliance/generation-gate';

/**
 * The user's membership of one organization and their compliance state,
 * memoised per isolate for a few seconds (#2082). A sequence page fires ~40 server fns within a
 * second or two, and each resolved both from the primary — two round trips,
 * 350–450 ms apiece from Europe — before any work. Concurrent calls share one
 * in-flight read; a change to membership or enforcement is seen within
 * `ORGANIZATION_MEMO_TTL_MS` on an isolate that already answered for the user. Only
 * a GET is answered from the memo: a write reads both fresh (and refreshes
 * the memo), so a removed member or a new enforcement bites on the next
 * write.
 */
const ORGANIZATION_MEMO_TTL_MS = 5_000;
export type ResolvedOrganization = {
  organization: Awaited<ReturnType<typeof getUserOrganizationMembership>>;
  compliance: Awaited<ReturnType<typeof loadComplianceState>> | null;
};
const organizationMemo = new Map<
  string,
  { until: number; value: Promise<ResolvedOrganization> }
>();

export async function resolveOrganizationAndCompliance(
  userId: string,
  method: string,
  organizationId: string
): Promise<ResolvedOrganization> {
  const now = Date.now();
  const memoKey = `${userId}:${organizationId}`;
  const hit = method === 'GET' ? organizationMemo.get(memoKey) : undefined;
  if (hit && hit.until > now) return hit.value;
  // ponytail: prune on insert; a per-user entry for the whole isolate life
  // would otherwise grow with every user it ever answered.
  for (const [key, entry] of organizationMemo)
    if (entry.until <= now) organizationMemo.delete(key);
  // Side by side (#2234): compliance needs only the ids; a non-member's is dropped.
  const value = Promise.all([
    getUserOrganizationMembership(userId, organizationId),
    loadComplianceState(userId, organizationId),
  ]).then(([membership, compliance]) => ({
    organization: membership,
    compliance: membership ? compliance : null,
  }));
  organizationMemo.set(memoKey, {
    until: now + ORGANIZATION_MEMO_TTL_MS,
    value,
  });
  // A failed read is not kept: the next call reads again.
  value.catch(() => organizationMemo.delete(memoKey));
  return value;
}
