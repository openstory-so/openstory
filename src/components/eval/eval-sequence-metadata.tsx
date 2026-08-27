import type React from 'react';
import { AspectRatioIcon } from '@/components/icons/aspect-ratio-icon';
import { ModelBadge } from '@/components/model/model-badge';
import { StyleBadge } from '@/components/style/style-badge';
import type { SequenceWithShots } from '@/hooks/use-sequences-with-shots';
import { getImageModelById } from '@/lib/ai/models';
import {
  CREDITS_SHORT_TITLE,
  isCreditsShortError,
} from '@/lib/billing/credits-short';
import { getAspectRatioData } from '@/lib/constants/aspect-ratios';
import { formatDistanceToNow } from '@/lib/format-date';
import { Link } from '@tanstack/react-router';
import {
  AlertTriangle,
  Calendar,
  CreditCard,
  ImageIcon,
  Mail,
  User,
} from 'lucide-react';
import { getCreatorIdentity } from './creator-identity';

type EvalSequenceMetadataProps = {
  sequence: SequenceWithShots;
  divergence?: { hasMusic: boolean };
};

export const EvalSequenceMetadata: React.FC<EvalSequenceMetadataProps> = ({
  sequence,
  divergence,
}) => {
  const ratioData = getAspectRatioData(sequence.aspectRatio);
  const imageModel = getImageModelById(sequence.imageModel);
  const dotTitle = divergence?.hasMusic
    ? 'Alternate music track available — click to compare'
    : null;

  return (
    <div className="relative h-full border-r border-b p-3 flex flex-col gap-2 overflow-y-auto">
      {dotTitle && (
        <span
          aria-label={dotTitle}
          title={dotTitle}
          data-slot="sequence-metadata-divergent-dot"
          className="absolute top-2 right-2 inline-flex h-2 w-2 items-center justify-center rounded-full bg-sky-500 ring-2 ring-sky-500/30"
        />
      )}
      <Link
        to="/sequences/$id/scenes"
        params={{ id: sequence.id }}
        className="font-medium text-sm text-foreground line-clamp-2 hover:underline shrink-0 pr-4"
        title={sequence.title || 'Untitled Sequence'}
      >
        {sequence.title || 'Untitled Sequence'}
      </Link>

      <CreatorIdentity sequence={sequence} />

      <div className="flex flex-wrap items-center gap-1">
        <ModelBadge model={sequence.analysisModel} />
        <StyleBadge styleId={sequence.styleId} />
      </div>

      {imageModel && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <ImageIcon className="h-3 w-3" />
          <span className="truncate">{imageModel.name}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <Calendar className="h-3 w-3" />
          <span>{formatDistanceToNow(new Date(sequence.createdAt))}</span>
        </div>

        {ratioData && (
          <div className="flex items-center gap-1">
            <AspectRatioIcon
              width={ratioData.width}
              height={ratioData.height}
              size="sm"
            />
            <span>{ratioData.label}</span>
          </div>
        )}
      </div>

      <div className="text-xs text-muted-foreground">
        {sequence.shots.length}{' '}
        {sequence.shots.length === 1 ? 'scene' : 'scenes'}
      </div>

      <SequenceListStatus sequence={sequence} />
    </div>
  );
};

const CreatorIdentity: React.FC<{ sequence: SequenceWithShots }> = ({
  sequence,
}) => {
  const { name, email } = getCreatorIdentity(sequence);
  if (!name && !email) return null;

  if (name) {
    return (
      <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <User className="h-3 w-3 shrink-0" />
          <span className="truncate">{name}</span>
        </div>
        {email && (
          <div className="flex items-center gap-1 pl-4">
            <span className="truncate">{email}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <Mail className="h-3 w-3 shrink-0" />
      <span className="truncate">{email}</span>
    </div>
  );
};

type SequenceListFailureInput = {
  status: SequenceWithShots['status'];
  statusError: SequenceWithShots['statusError'];
  musicError: SequenceWithShots['musicError'];
  shots: ReadonlyArray<{
    frame: { imageStatus: string | null };
    videoStatus: string | null;
  }>;
};

export function sequenceListFailure(sequence: SequenceListFailureInput): {
  creditsShort: boolean;
  errorCount: number;
} {
  const creditsShort =
    sequence.status === 'failed' && isCreditsShortError(sequence.statusError);
  let errorCount = 0;
  if (sequence.status === 'failed' && !creditsShort) errorCount++;
  if (sequence.musicError) errorCount++;
  errorCount += sequence.shots.filter(
    (f) => f.frame.imageStatus === 'failed'
  ).length;
  errorCount += sequence.shots.filter((f) => f.videoStatus === 'failed').length;
  return { creditsShort, errorCount };
}

export const SequenceListStatus: React.FC<{
  sequence: SequenceListFailureInput;
}> = ({ sequence }) => {
  const { creditsShort, errorCount } = sequenceListFailure(sequence);
  if (!creditsShort && errorCount === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      {creditsShort && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <CreditCard className="h-3 w-3 shrink-0" />
          <span>{CREDITS_SHORT_TITLE}</span>
        </div>
      )}
      {errorCount > 0 && (
        <div className="flex items-center gap-1 text-xs text-destructive">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          <span>
            {errorCount} {errorCount === 1 ? 'error' : 'errors'}
          </span>
        </div>
      )}
    </div>
  );
};
