import {
  useReplaceFrameImage,
  useReplaceShotVideo,
} from '@/hooks/use-media-upload';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { errorMessage } from '@/lib/errors';
import { Loader2, Upload } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';

type ShotMediaDropZoneProps = {
  sequenceId: string;
  shotId: string;
  aspectRatio: AspectRatio;
  children: ReactNode;
};

/**
 * Drag-and-drop shortcut over the shot's canvas media (#1108 Phase 3): a
 * dropped image replaces the still (image-only path — video derives stale), a
 * dropped video replaces the clip. The inspector's Replace buttons remain the
 * click/keyboard path; this wrapper adds nothing else.
 */
export const ShotMediaDropZone: React.FC<ShotMediaDropZoneProps> = ({
  sequenceId,
  shotId,
  aspectRatio,
  children,
}) => {
  const [dragActive, setDragActive] = useState(false);
  const replaceImage = useReplaceFrameImage();
  const replaceVideo = useReplaceShotVideo();
  const uploading = replaceImage.isPending || replaceVideo.isPending;

  const handleDrop = (file: File) => {
    if (file.type.startsWith('image/')) {
      replaceImage.mutate(
        { file, sequenceId, shotId, aspectRatio },
        {
          onSuccess: (result) =>
            toast.success(
              'Image replaced',
              result.cropped
                ? {
                    description: `Cropped to ${aspectRatio} so motion generation matches the sequence.`,
                  }
                : undefined
            ),
          onError: (error) =>
            toast.error('Image upload failed', {
              description: errorMessage(error),
            }),
        }
      );
      return;
    }
    if (file.type.startsWith('video/')) {
      replaceVideo.mutate(
        { file, sequenceId, shotId },
        {
          onSuccess: () => toast.success('Video replaced'),
          onError: (error) =>
            toast.error('Video upload failed', {
              description: errorMessage(error),
            }),
        }
      );
      return;
    }
    toast.error('Drop an image or video file');
  };

  return (
    <div
      className="relative h-full w-full"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={(event) => {
        const related = event.relatedTarget;
        if (related instanceof Node && event.currentTarget.contains(related)) {
          return;
        }
        setDragActive(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragActive(false);
        if (uploading) return;
        const file = event.dataTransfer.files[0];
        if (file) handleDrop(file);
      }}
    >
      {children}
      {(dragActive || uploading) && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-background/80"
        >
          {uploading ? (
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          ) : (
            <Upload className="h-6 w-6 text-muted-foreground" />
          )}
          <p className="text-sm text-muted-foreground">
            {uploading ? 'Uploading…' : 'Drop to replace this shot’s media'}
          </p>
        </div>
      )}
      {/* Always mounted: a live region only announces changes that happen
          while it is already in the DOM, so the visual overlay above cannot
          double as one. */}
      <span aria-live="polite" className="sr-only">
        {uploading ? 'Uploading media…' : 'Ready to upload media'}
      </span>
    </div>
  );
};
