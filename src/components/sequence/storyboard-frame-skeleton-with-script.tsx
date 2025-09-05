import type * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";

interface StoryboardFrameSkeletonWithScriptProps {
  index: number;
  isGenerating?: boolean;
}

export const StoryboardFrameSkeletonWithScript: React.FC<
  StoryboardFrameSkeletonWithScriptProps
> = ({ index, isGenerating = true }) => {
  return (
    <div
      className="relative flex gap-6 rounded-lg border bg-card p-6"
      data-testid={`frame-skeleton-${index}`}
    >
      {/* Frame number badge */}
      <div className="absolute -left-3 top-8 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-primary/50 text-sm font-bold text-primary-foreground">
        {index + 1}
      </div>

      {/* Script section skeleton - Left side */}
      <div className="flex-1 space-y-3">
        <Skeleton className="h-4 w-24" />
        <div className="space-y-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-5/6" />
        </div>
        <Skeleton className="h-3 w-20" />
      </div>

      {/* Divider */}
      <div className="w-px bg-border" />

      {/* Frame preview skeleton - Right side */}
      <div className="flex-1 space-y-3">
        <Skeleton className="h-4 w-28" />

        {/* Frame image skeleton */}
        <div className="relative aspect-video w-full overflow-hidden rounded-md bg-muted">
          <Skeleton className="h-full w-full" />
          {isGenerating && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80">
              <div className="text-center space-y-2">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
                <p className="text-sm text-muted-foreground">
                  Creating frame {index + 1}...
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Action buttons skeleton */}
        <div className="flex gap-2">
          <Skeleton className="h-8 flex-1" />
          <Skeleton className="h-8 flex-1" />
          <Skeleton className="h-8 flex-1" />
        </div>
      </div>
    </div>
  );
};
