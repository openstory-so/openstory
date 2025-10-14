import { Skeleton } from "@/components/ui/skeleton";

interface FrameSkeletonProps {
  index: number;
  isGenerating?: boolean;
}

export const FrameSkeleton: React.FC<FrameSkeletonProps> = ({
  index,
  isGenerating = true,
}) => {
  return (
    <div
      className="relative rounded-lg border bg-card p-4 space-y-3"
      data-testid={`frame-skeleton-${index}`}
    >
      {/* Frame header */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-16" />
        {isGenerating && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-primary" />
            <span>Generating...</span>
          </div>
        )}
      </div>

      {/* Thumbnail placeholder */}
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

      {/* Description placeholder */}
      <div className="space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-3 w-3/5" />
      </div>

      {/* Action buttons placeholder */}
      <div className="flex gap-2">
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-20" />
      </div>
    </div>
  );
};

interface FrameSkeletonGridProps {
  count?: number;
  isGenerating?: boolean;
}

export const FrameSkeletonGrid: React.FC<FrameSkeletonGridProps> = ({
  count = 3,
  isGenerating = true,
}) => {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      {Array.from({ length: count }).map((_, index) => (
        <FrameSkeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton key
          key={`frame-skeleton-${index}`}
          index={index}
          isGenerating={isGenerating}
        />
      ))}
    </div>
  );
};
