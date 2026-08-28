/**
 * The generation gate (#1180).
 *
 * May this account generate right now? The only no is a live enforcement
 * action. Identity verification is not part of this surface: BytePlus accepted
 * email login + a card on file as real-name authentication for an overseas
 * tool platform.
 *
 * Enforcement runs in `triggerWorkflow` (every durable generation funnels
 * through it). Direct model access also calls `requireGenerationAllowed`
 * beside the credit preflight. `generation-gate.wiring.test.ts` fails if a
 * `requireCredits` site has neither a gate nor a `triggerWorkflow` call.
 */

import { loadComplianceRecords } from '@/lib/db/scoped';
import {
  assertCanGenerate,
  resolveEnforcementState,
  restrictionNotice,
  type EnforcementState,
} from '@/lib/compliance/enforcement';

export type ComplianceState = {
  enforcement: EnforcementState;
};

/**
 * Load and resolve an account's enforcement standing.
 *
 * Shared by the restriction banner and the generation gate so the two
 * cannot disagree.
 */
export async function loadComplianceState(
  userId: string,
  teamId?: string | null,
  now: Date = new Date()
): Promise<ComplianceState> {
  const { enforcement } = await loadComplianceRecords(userId, teamId);
  return {
    enforcement: resolveEnforcementState(enforcement, now),
  };
}

/** Throw unless the account may run this generation. */
export async function requireGenerationAllowed(opts: {
  userId: string;
  teamId: string;
}): Promise<void> {
  const state = await loadComplianceState(opts.userId, opts.teamId);
  assertCanGenerate(state.enforcement);
}

/**
 * Summary for the client: what is restricted, and what the user can do about
 * it. Returned by `getComplianceStatusFn` and rendered by
 * `ComplianceRestrictionBanner`.
 */
export function summarizeCompliance(state: ComplianceState) {
  return {
    canGenerate: state.enforcement.canGenerate,
    canWrite: state.enforcement.canWrite,
    canAccess: state.enforcement.canAccess,
    restrictionNotice: restrictionNotice(state.enforcement),
  };
}
