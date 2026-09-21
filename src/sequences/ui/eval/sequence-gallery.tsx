import { Link } from '@tanstack/react-router';
import { Film, ArrowUpRight } from 'lucide-react';
import type { SequenceWithShots } from '../use-sequences-with-shots';
import { AppImage } from '@/ui/shadcn/app-image';
import { Card } from '@/ui/shadcn/card';
import { Badge } from '@/ui/shadcn/badge';
import { AspectRatioIcon } from '@/ui/icons/aspect-ratio-icon';
import {
  aspectRatioToDimensions,
  getAspectRatioData,
} from '@/models/aspect-ratios';
import { cn } from '@/ui/utils';
import { formatDistanceToNow } from '@/ui/format-date';
import { SequenceRowMenu } from './eval-sequence-metadata';
import { getCreatorIdentity } from './creator-identity';
import {
  isCreditsShortError,
  CREDITS_SHORT_TITLE,
} from '@/billing/credits-short';

const STATUS_LABELS = {
  draft: 'Draft',
  processing: 'In production',
  completed: 'Completed',
  failed: 'Needs attention',
  archived: 'Archived',
} as const;

export function SequenceGallery({
  sequences,
  supportMode,
  styleNameById,
}: {
  sequences: Pick<
    SequenceWithShots,
    | 'id'
    | 'title'
    | 'status'
    | 'statusError'
    | 'posterUrl'
    | 'styleId'
    | 'aspectRatio'
    | 'createdAt'
    | 'creatorName'
    | 'creatorEmail'
  >[];
  supportMode: boolean;
  styleNameById: Map<string, string>;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto flex flex-col gap-4">
      <output className="text-sm text-muted-foreground">
        {sequences.length} {sequences.length === 1 ? 'sequence' : 'sequences'}
        {supportMode && <span> loaded across all teams</span>}
      </output>
      <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 pb-4">
        {sequences.map((sequence) => {
          const creator = getCreatorIdentity(sequence);
          const insetPoster = sequence.aspectRatio !== '16:9';
          const posterDimensions = aspectRatioToDimensions(
            sequence.aspectRatio
          );
          const ratioData = getAspectRatioData(sequence.aspectRatio);
          const creditsShort =
            sequence.status === 'failed' &&
            isCreditsShortError(sequence.statusError);
          return (
            <li
              key={sequence.id}
              className="group"
              style={{
                contentVisibility: 'auto',
                containIntrinsicSize: 'auto 310px',
              }}
            >
              <Card className="h-full gap-0 py-0">
                <Link
                  to="/sequences/$id/scenes"
                  params={{ id: sequence.id }}
                  preload={false}
                  className={cn(
                    'relative flex aspect-video items-center justify-center overflow-hidden bg-muted focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2',
                    insetPoster && 'bg-muted/50'
                  )}
                  aria-label={`Open ${sequence.title || 'Untitled Sequence'}`}
                >
                  {sequence.posterUrl ? (
                    <div
                      className={cn(
                        'absolute inset-0 flex items-center justify-center',
                        insetPoster && 'p-3'
                      )}
                    >
                      <AppImage
                        unstyled
                        src={sequence.posterUrl}
                        alt=""
                        width={posterDimensions.width}
                        height={posterDimensions.height}
                        loading="lazy"
                        className={cn(
                          insetPoster
                            ? 'h-full w-auto max-w-full object-contain rounded-sm shadow-sm ring-1 ring-foreground/10 motion-safe:transition-shadow motion-safe:duration-300 group-hover:shadow-md group-focus-within:shadow-md'
                            : 'h-full w-full object-cover motion-safe:transition-transform motion-safe:duration-300 motion-safe:group-hover:scale-105'
                        )}
                      />
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-3 text-muted-foreground">
                      <Film className="size-9 opacity-40" strokeWidth={1} />
                      <span className="text-xs tracking-widest uppercase">
                        {sequence.status === 'draft'
                          ? 'A story in the making'
                          : 'Your story'}
                      </span>
                    </div>
                  )}
                  {!insetPoster && (
                    <Badge
                      variant="secondary"
                      className="absolute left-3 top-3 shadow-sm"
                    >
                      {creditsShort
                        ? CREDITS_SHORT_TITLE
                        : STATUS_LABELS[sequence.status]}
                    </Badge>
                  )}
                  <span className="absolute bottom-3 right-3 flex size-8 items-center justify-center rounded-full bg-background/90 opacity-0 motion-safe:transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <ArrowUpRight className="size-4" />
                  </span>
                </Link>
                <div className="flex flex-col gap-2 p-4">
                  <div className="flex items-start gap-2">
                    <Link
                      to="/sequences/$id/scenes"
                      params={{ id: sequence.id }}
                      preload={false}
                      className="min-w-0 flex-1 truncate font-medium hover:underline"
                      title={sequence.title}
                    >
                      {sequence.title || 'Untitled Sequence'}
                    </Link>
                    {!supportMode && <SequenceRowMenu sequence={sequence} />}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {styleNameById.get(sequence.styleId) ?? 'Custom style'} ·{' '}
                    {formatDistanceToNow(new Date(sequence.createdAt))}
                  </p>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    {ratioData && (
                      <span className="flex items-center gap-1">
                        <AspectRatioIcon
                          width={ratioData.width}
                          height={ratioData.height}
                          size="sm"
                        />
                        <span>{ratioData.label}</span>
                      </span>
                    )}
                    {insetPoster && (
                      <Badge variant="secondary">
                        {creditsShort
                          ? CREDITS_SHORT_TITLE
                          : STATUS_LABELS[sequence.status]}
                      </Badge>
                    )}
                  </div>
                  {supportMode && (
                    <div className="min-w-0 border-t pt-2 text-xs text-muted-foreground">
                      {creator.name && (
                        <p className="truncate font-medium text-foreground">
                          {creator.name}
                        </p>
                      )}
                      <p
                        className="truncate"
                        title={creator.email ?? undefined}
                      >
                        {creator.email ?? 'Unknown creator'}
                      </p>
                    </div>
                  )}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
