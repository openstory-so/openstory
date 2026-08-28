import { PromptDiffView } from '@/components/prompts/prompt-diff-view';
import { AppImage } from '@/components/ui/app-image';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ShotVariant } from '@/lib/db/schema';
import type { ShotView } from '@/lib/shots/shot-view';
import type { VariantType } from '@/lib/db/schema/shot-variants';

type DivergencePromptDiff = {
  label: string;
  before: string;
  after: string;
};

type DivergenceCompareDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shot: ShotView;
  variant: ShotVariant;
  onPromote: () => void;
  onDiscard: () => void;
  isPromoting?: boolean;
  isDiscarding?: boolean;
  /** Optional list of upstream entity changes between the snapshot and live inputs. */
  upstreamChanges?: string[];
  /** Optional field-level prompt diff — rendered as a word-level diff panel. */
  promptDiff?: DivergencePromptDiff;
};

const ARTIFACT_LABEL: Record<VariantType, string> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
};

function liveAssetForVariant(
  shot: ShotView,
  variantType: VariantType
): { url: string | null; kind: 'image' | 'video' | 'audio' } {
  switch (variantType) {
    case 'image':
      return { url: shot.image?.url ?? null, kind: 'image' };
    case 'video':
      return { url: shot.video?.url ?? null, kind: 'video' };
    case 'audio':
      // Unreachable: nothing creates an audio `shot_variants` row, and per-shot
      // audio has no live column to compare against (#1067).
      return { url: null, kind: 'audio' };
  }
}

const AssetPreview: React.FC<{
  url: string | null | undefined;
  kind: 'image' | 'video' | 'audio';
  alt: string;
}> = ({ url, kind, alt }) => {
  if (!url) {
    return (
      <div className="flex aspect-video items-center justify-center rounded-md border border-dashed border-muted-foreground/40 text-xs text-muted-foreground">
        No asset
      </div>
    );
  }
  if (kind === 'image') {
    return (
      <AppImage
        src={url}
        alt={alt}
        width={640}
        height={360}
        className="aspect-video w-full rounded-md object-cover"
      />
    );
  }
  if (kind === 'video') {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption -- Compare-dialog renders user-supplied generated assets that have no caption track.
      <video
        src={url}
        controls
        className="aspect-video w-full rounded-md bg-black"
      />
    );
  }
  // eslint-disable-next-line jsx-a11y/media-has-caption -- Compare-dialog renders user-supplied generated audio without captions.
  return <audio src={url} controls className="w-full" />;
};

export const DivergenceCompareDialog: React.FC<
  DivergenceCompareDialogProps
> = ({
  open,
  onOpenChange,
  shot,
  variant,
  onPromote,
  onDiscard,
  isPromoting = false,
  isDiscarding = false,
  upstreamChanges,
  promptDiff,
}) => {
  const live = liveAssetForVariant(shot, variant.variantType);
  const label = ARTIFACT_LABEL[variant.variantType];
  const busy = isPromoting || isDiscarding;

  // Two-click confirm: promote replaces the live primary and (for image)
  // clears downstream video. Destructive ops need a confirmation step or
  // undo window; two-click avoids nested modals here.
  const [confirmingPromote, setConfirmingPromote] = useState(false);
  // Reset whenever the dialog opens/closes or the variant swaps, so a
  // fresh open (or a caller swapping variants while open) never starts
  // mid-confirm.
  useEffect(() => {
    setConfirmingPromote(false);
  }, [open, variant.id]);

  const handlePromoteClick = () => {
    if (confirmingPromote) {
      onPromote();
      setConfirmingPromote(false);
      return;
    }
    setConfirmingPromote(true);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Compare alternate {label}</DialogTitle>
          <DialogDescription>
            An alternate {label} was generated from the inputs you had at the
            time. Compare it against the live version, then promote or discard.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Live (current inputs)</span>
            <AssetPreview
              url={live.url}
              kind={live.kind}
              alt={`Live ${label}`}
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">
              Alternate (older inputs)
            </span>
            <AssetPreview
              url={variant.url}
              kind={live.kind}
              alt={`Alternate ${label}`}
            />
          </div>
        </div>

        {upstreamChanges && upstreamChanges.length > 0 && (
          <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3">
            <span className="text-sm font-medium">What changed</span>
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {upstreamChanges.map((change) => (
                <li key={change}>• {change}</li>
              ))}
            </ul>
          </div>
        )}

        {promptDiff && (
          <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3">
            <span className="text-sm font-medium">{promptDiff.label}</span>
            <PromptDiffView
              before={promptDiff.before}
              after={promptDiff.after}
            />
          </div>
        )}

        {confirmingPromote && (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            role="alert"
            aria-live="polite"
          >
            Promote replaces the current {label}
            <span>
              {variant.variantType === 'image'
                ? ' and clears the live video.'
                : '.'}
            </span>{' '}
            Click Promote again to confirm.
          </div>
        )}

        <DialogFooter className="flex flex-row justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onDiscard}
            disabled={busy}
          >
            {isDiscarding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <span>Discard</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handlePromoteClick}
            disabled={busy}
            variant={confirmingPromote ? 'destructive' : 'default'}
          >
            {isPromoting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {confirmingPromote ? 'Confirm Promote' : 'Promote'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
