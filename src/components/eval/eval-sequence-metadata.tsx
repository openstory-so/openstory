import type React from 'react';
import { AspectRatioIcon } from '@/components/icons/aspect-ratio-icon';
import { ModelBadge } from '@/components/model/model-badge';
import { StyleBadge } from '@/components/style/style-badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useArchiveSequence } from '@/hooks/use-sequences';
import type { SequenceWithShots } from '@/hooks/use-sequences-with-shots';
import { getImageModelById } from '@/lib/ai/models';
import {
  CREDITS_SHORT_TITLE,
  isCreditsShortError,
} from '@/lib/billing/credits-short';
import { getAspectRatioData } from '@/lib/constants/aspect-ratios';
import { errorMessage } from '@/lib/errors';
import { formatDistanceToNow } from '@/lib/format-date';
import { Link } from '@tanstack/react-router';
import {
  AlertTriangle,
  Archive,
  Calendar,
  CreditCard,
  ImageIcon,
  Mail,
  MoreVertical,
  User,
} from 'lucide-react';
import { toast } from 'sonner';
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
      <div className="flex shrink-0 items-start gap-1">
        <Link
          to="/sequences/$id/scenes"
          params={{ id: sequence.id }}
          className="min-w-0 flex-1 font-medium text-sm text-foreground line-clamp-2 hover:underline"
          title={sequence.title || 'Untitled Sequence'}
        >
          {sequence.title || 'Untitled Sequence'}
        </Link>
        <SequenceRowMenu sequence={sequence} />
      </div>

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

/**
 * Row actions (#1108 Phase 4). Archiving is the sequence-level soft delete
 * (status flip, reversible from the Archived strip below the list).
 */
const SequenceRowMenu: React.FC<{ sequence: SequenceWithShots }> = ({
  sequence,
}) => {
  const archive = useArchiveSequence();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          aria-label={`Actions for ${sequence.title || 'Untitled Sequence'}`}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={archive.isPending}
          onClick={() =>
            archive.mutate(sequence.id, {
              onSuccess: () =>
                toast.success(`Archived ${sequence.title || 'sequence'}`, {
                  description: 'Restore it from the Archived section below.',
                }),
              onError: (error) =>
                toast.error('Failed to archive sequence', {
                  description: errorMessage(error),
                }),
            })
          }
        >
          <Archive className="h-4 w-4" />
          {archive.isPending ? 'Archiving…' : 'Archive sequence'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
