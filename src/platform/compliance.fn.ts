/**
 * Compliance server functions — the user's own side (#1180).
 *
 * The account restriction banner (rights attestations live in
 * `@/cast/upload-rights.fn`). Admin moderation
 * lives in `./moderation.fn`; public report intake in `./content-reports.fn`.
 */

import { authMiddleware } from './middleware.fn';
import {
  loadComplianceState,
  summarizeCompliance,
} from '@/platform/server/compliance/generation-gate';
import { resolveUserTeam } from '@/platform/server/db/scoped';
import { createServerFn } from '@tanstack/react-start';

/**
 * The account's enforcement standing. Read by `ComplianceRestrictionBanner`,
 * and computed by the same code the generation gate uses so the two cannot
 * disagree.
 */
export const getComplianceStatusFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const team = await resolveUserTeam(context.user.id);
    const state = await loadComplianceState(context.user.id, team?.teamId);
    return summarizeCompliance(state);
  });
