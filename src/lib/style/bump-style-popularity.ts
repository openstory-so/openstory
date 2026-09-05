import { getPostHogClient } from '@/lib/posthog-server';

import { getLogger } from '@/shared/observability/logger';

const logger = getLogger(['openstory', 'style', 'bump-style-popularity']);

type ScopedDbLike = {
  styles: { incrementUsage: (id: string) => Promise<void> };
};

export type BumpStylePopularityArgs = {
  scopedDb: ScopedDbLike;
  styleId: string;
  sequenceIds: string[];
  teamId: string;
  userId: string;
};

/**
 * Fire-and-forget analytics + popularity bump for "this user picked this style".
 * Failures must never break the critical path that drives the click.
 */
export function bumpStylePopularity(args: BumpStylePopularityArgs) {
  void args.scopedDb.styles.incrementUsage(args.styleId).catch((err) => {
    logger.error('incrementUsage failed', {
      styleId: args.styleId,
      teamId: args.teamId,
      userId: args.userId,
      sequenceCount: args.sequenceIds.length,
      err,
    });
  });
  const posthog = getPostHogClient();
  if (!posthog) return;
  posthog.capture({
    distinctId: args.userId,
    event: 'style_selected',
    properties: {
      styleId: args.styleId,
      sequenceIds: args.sequenceIds,
      teamId: args.teamId,
    },
  });
}
