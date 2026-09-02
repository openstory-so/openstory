import { Badge } from '@/components/ui/badge';
import { cn } from '@/shared/utils';
import type { FC } from 'react';

const THIRTY_DAYS_S = 30 * 24 * 60 * 60;

/**
 * Release-date marker for catalog tiles: always the short month-year date,
 * rendered solid (primary) when first seen within the last month and as a
 * translucent pill otherwise, so recent models pop without extra copy.
 * Rendered as an overlay in the corner of tile previews (pass positioning
 * via className). `firstSeenAt` is mostly the modelschemas tracking epoch
 * today, so back-catalog dates read as Jun 2026 until release dates are
 * backdated upstream.
 */
export const ReleaseBadge: FC<{
  /** Epoch seconds (`firstSeenAt` / family `releasedAt`); renders nothing when absent. */
  releasedAt: number | null | undefined;
  className?: string;
}> = ({ releasedAt, className }) => {
  if (!releasedAt) return null;
  const isRecent = Date.now() / 1000 - releasedAt < THIRTY_DAYS_S;
  const label = new Date(releasedAt * 1000).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  });
  if (isRecent) {
    return <Badge className={className}>{label}</Badge>;
  }
  return (
    <Badge
      variant="secondary"
      className={cn('bg-background/70 backdrop-blur-sm', className)}
    >
      {label}
    </Badge>
  );
};
