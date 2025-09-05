import Image from "next/image";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import type { Frame } from "@/types/database";

interface StoryboardFrameWithScriptProps {
  frame: Frame;
  isGeneratingPreview?: boolean;
  onEdit?: (frameId: string) => void;
  onDelete?: (frameId: string) => void;
  onRegenerate?: (frameId: string) => void;
}

export const StoryboardFrameWithScript: React.FC<
  StoryboardFrameWithScriptProps
> = ({
  frame,
  isGeneratingPreview = false,
  onEdit,
  onDelete,
  onRegenerate,
}) => {
  // Extract script chunk from metadata or use description
  const metadata = frame.metadata as Record<string, unknown> | null;
  const scriptChunk = metadata?.scriptChunk as string | undefined;
  const displayScript = scriptChunk || frame.description;

  return (
    <div
      className="group relative flex gap-6 rounded-lg border bg-card p-6 transition-all hover:shadow-md"
      data-testid={`storyboard-frame-${frame.order_index}`}
    >
      {/* Frame number badge */}
      <div className="absolute -left-3 top-8 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
        {frame.order_index + 1}
      </div>

      {/* Script section - Left side */}
      <div className="flex-1 space-y-3">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Script Section
        </div>
        <div className="prose prose-sm max-w-none">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {displayScript}
          </p>
        </div>
        {frame.duration_ms && (
          <div className="text-xs text-muted-foreground">
            Duration: {(frame.duration_ms / 1000).toFixed(1)}s
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="w-px bg-border" />

      {/* Frame preview - Right side */}
      <div className="flex-1 space-y-3">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Generated Frame
        </div>

        {/* Frame image */}
        <div className="relative aspect-video w-full overflow-hidden rounded-md bg-muted">
          {frame.thumbnail_url ? (
            <Image
              src={frame.thumbnail_url}
              alt={`Frame ${frame.order_index + 1} preview`}
              className="h-full w-full object-cover"
              width={1920}
              height={1080}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-muted">
              {isGeneratingPreview ? (
                <div className="flex flex-col items-center gap-2">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
                  <span className="text-xs text-muted-foreground">
                    Generating preview...
                  </span>
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">
                  No preview available
                </span>
              )}
            </div>
          )}
        </div>

        {/* Action buttons - shown on hover */}
        <div className="flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
          {onRegenerate && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onRegenerate(frame.id)}
              className="flex-1"
            >
              Regenerate
            </Button>
          )}
          {onEdit && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onEdit(frame.id)}
              className="flex-1"
            >
              Edit
            </Button>
          )}
          {onDelete && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onDelete(frame.id)}
              className="flex-1"
            >
              Delete
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
