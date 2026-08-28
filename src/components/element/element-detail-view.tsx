import { ElementTokenButton } from '@/components/element/element-token-button';
import { ReplaceElementPopover } from '@/components/element/replace-element-popover';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { AppImage } from '@/components/ui/app-image';
import {
  useDeleteSequenceElement,
  useRenameSequenceElementToken,
  useSequenceElements,
  useShotCountsForAllElements,
} from '@/hooks/use-sequence-elements';
import { cn } from '@/lib/utils';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

type ElementDetailViewProps = {
  sequenceId: string;
  elementId: string;
};

type DetailRowProps = {
  label: string;
  value: string | number | undefined | null;
  className?: string;
};

const DetailRow: React.FC<DetailRowProps> = ({ label, value, className }) => {
  if (!value) return null;

  return (
    <div className={cn('space-y-1', className)}>
      <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm leading-relaxed">{value}</dd>
    </div>
  );
};

export const ElementDetailView: React.FC<ElementDetailViewProps> = ({
  sequenceId,
  elementId,
}) => {
  const navigate = useNavigate();
  const { data: elements, isLoading, error } = useSequenceElements(sequenceId);
  const { data: shotCounts } = useShotCountsForAllElements(sequenceId);
  const deleteElement = useDeleteSequenceElement();
  const renameToken = useRenameSequenceElementToken();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const element = elements?.find((el) => el.id === elementId);
  const counts = elementId ? shotCounts?.[elementId] : undefined;
  const affectedShotCount = counts?.shotCount ?? 0;
  const affectedVideoCount = counts?.videoCount ?? 0;

  const isAnalyzing =
    element?.visionStatus === 'pending' ||
    element?.visionStatus === 'analyzing';

  const handleRename = async (nextToken: string) => {
    const result = await renameToken.mutateAsync({
      sequenceId,
      elementId,
      token: nextToken,
    });
    const updates: string[] = [];
    if (result.scriptUpdated) updates.push('script');
    if (result.shotsUpdated > 0) {
      updates.push(
        `${result.shotsUpdated} shot${result.shotsUpdated === 1 ? '' : 's'}`
      );
    }
    const suffix =
      updates.length > 0 ? ` — updated ${updates.join(' + ')}` : '';
    toast.success(`Renamed to ${nextToken}${suffix}`);
  };

  const handleDelete = () => {
    deleteElement.mutate(
      { elementId, sequenceId },
      {
        onSuccess: () => {
          toast.success(`Deleted ${element?.token ?? 'element'}`);
          void navigate({
            to: '/sequences/$id/elements',
            params: { id: sequenceId },
          });
        },
        onError: (err) => {
          toast.error('Failed to delete element', {
            description: err instanceof Error ? err.message : 'Unknown error',
          });
        },
      }
    );
  };

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center">
          <p className="text-sm text-destructive">Failed to load element</p>
          <p className="mt-1 text-xs text-muted-foreground">{error.message}</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b p-4">
          <Skeleton className="h-8 w-32" />
        </div>
        <div className="flex-1 p-4">
          <Skeleton className="aspect-video w-full rounded-lg" />
          <div className="mt-4 space-y-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
      </div>
    );
  }

  if (!element) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
        <ImagePlus className="h-16 w-16 text-muted-foreground/30" />
        <div className="text-center">
          <p className="text-sm font-medium">Element not found</p>
          <Link
            to="/sequences/$id/elements"
            params={{ id: sequenceId }}
            className="mt-2 text-sm text-primary hover:underline"
          >
            Back to elements
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <Link
          to="/sequences/$id/elements"
          params={{ id: sequenceId }}
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
          aria-label="Back to elements"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="font-mono text-lg font-semibold">{element.token}</h1>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-6 p-4">
          <p className="text-sm text-muted-foreground">
            Type @ in a prompt or script to insert{' '}
            <span className="font-mono">{element.token}</span>.
          </p>

          <div className="group relative aspect-video overflow-hidden rounded-lg bg-muted">
            {isAnalyzing ? (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/70 backdrop-blur-sm">
                <Loader2 className="size-8 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Analyzing…</p>
              </div>
            ) : null}
            <AppImage
              src={element.imageUrl}
              alt={element.token}
              width={640}
              height={360}
              className="h-full w-full object-contain"
            />
            {element.visionStatus === 'completed' && (
              <ElementTokenButton
                token={element.token}
                onRename={handleRename}
              />
            )}
          </div>

          <div className="flex gap-3">
            <ReplaceElementPopover
              sequenceId={sequenceId}
              elementId={element.id}
              token={element.token}
              affectedShotCount={affectedShotCount}
              affectedVideoCount={affectedVideoCount}
              disabled={isAnalyzing}
              trigger="button"
            />
            <Button
              type="button"
              variant="outline"
              disabled={deleteElement.isPending || isAnalyzing}
              onClick={() => setDeleteOpen(true)}
              aria-label={`Delete ${element.token}`}
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          </div>

          <dl className="space-y-4">
            {isAnalyzing ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Analyzing image…
              </div>
            ) : element.visionStatus === 'failed' ? (
              <p className="text-sm text-destructive">
                Vision failed: {element.visionError ?? 'unknown error'}
              </p>
            ) : (
              <DetailRow label="Description" value={element.description} />
            )}
            {affectedShotCount > 0 ? (
              <DetailRow
                label="Used in"
                value={`${affectedShotCount} shot${affectedShotCount === 1 ? '' : 's'}${
                  affectedVideoCount > 0
                    ? ` (${affectedVideoCount} with video)`
                    : ''
                }`}
              />
            ) : (
              <DetailRow
                label="Used in"
                value="No shots yet — mention it with @ in a prompt or script"
              />
            )}
          </dl>
        </div>
      </ScrollArea>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {element.token}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the reference image from the sequence.
              {affectedShotCount > 0 && (
                <span>{` ${affectedShotCount} shot${affectedShotCount === 1 ? '' : 's'} still mention it — those prompts will keep the token until you edit them.`}</span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteElement.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteElement.isPending}
            >
              {deleteElement.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              <span>{deleteElement.isPending ? 'Deleting…' : 'Delete'}</span>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
