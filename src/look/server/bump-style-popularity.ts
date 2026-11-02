import { getPostHogClient } from '@/platform/server/observability/posthog-server';

import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'style', 'bump-style-popularity']);

type ScopedDbLike = {
  styles: { incrementUsage: (id: string) => Promise<void> };
};

export type BumpStylePopularityArgs = {
  scopedDb: ScopedDbLike;
  styleId: string;
  sequenceIds: string[];
  organizationId: string;
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
      organizationId: args.organizationId,
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
      organizationId: args.organizationId,
    },
  });
}
