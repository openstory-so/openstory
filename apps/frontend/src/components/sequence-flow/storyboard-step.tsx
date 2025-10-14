import type * as React from "react";
import { useCallback, useState } from "react";
import { generateFrames } from "#actions/sequence";
import { StoryboardFrameSkeletonWithScript } from "@/components/sequence/storyboard-frame-skeleton-with-script";
import { StoryboardFrameWithScript } from "@/components/sequence/storyboard-frame-with-script";
import { SectionHeading } from "@/components/typography";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useFalModels } from "@/hooks/use-fal-models";
import { useFramePreviewStatus, useUpdateFrame } from "@/hooks/use-frames";
import {
  type FrameGenerationMetadata,
  useStoryboardStatus,
} from "@/hooks/use-storyboard-status";
import { useStyles } from "@/hooks/use-styles";
import type { Frame } from "@/types/database";

interface StoryboardStepProps {
  sequenceId: string;
  onPrevious: () => void;
}

export const StoryboardStep: React.FC<StoryboardStepProps> = ({
  sequenceId,
  onPrevious,
}) => {
  const { data: falModelsResp } = useFalModels({
    type: "image",
    includeCosts: false,
  });

  // Load styles
  const { data: styles } = useStyles();

  // Use unified storyboard status hook (replaces multiple polling hooks)
  const {
    sequence,
    frames,
    activeJob,
    isGenerating: isBackgroundGenerating,
    hasFrames,
    canGenerate: canGenerateFromHook,
    refetch: refetchFrames,
  } = useStoryboardStatus(sequenceId);

  // Get expected frame count from sequence metadata or job
  const metadata = sequence?.metadata as FrameGenerationMetadata | null;
  const expectedFrameCount =
    metadata?.frameGeneration?.expectedFrameCount ||
    activeJob?.framesProgress?.total ||
    3;
  const completedFrames =
    metadata?.frameGeneration?.completedFrameCount ||
    activeJob?.framesProgress?.completed ||
    0;

  // Check for errors in sequence metadata
  const metadataError = metadata?.frameGeneration?.error;
  const hasMetadataError =
    metadataError && metadata?.frameGeneration?.status === "failed";

  // Update frame
  const { mutateAsync: updateFrame } = useUpdateFrame();

  // Track preview generation status for all frames
  const framePreviewStatus = useFramePreviewStatus(frames);

  // Local state for generation
  const [generationError, setGenerationError] = useState<string | null>(null);

  // Count frames with motion (hasFrames already available from hook)
  const framesWithMotion = frames.filter((frame: Frame) => frame.video_url);
  const totalFrames = frames.length;
  const _hasAnyMotion = framesWithMotion.length > 0;
  const allFramesHaveMotion =
    totalFrames > 0 && framesWithMotion.length === totalFrames;

  const handleGenerateStoryboard = useCallback(async () => {
    if (!canGenerateFromHook) return;

    setGenerationError(null);

    try {
      const result = await generateFrames(sequenceId);

      if (!result.success) {
        setGenerationError(result.error || "Failed to generate storyboard");
      } else {
        // Refetch frames to get the job ID and start polling
        await refetchFrames();
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unexpected error during generation";

      setGenerationError(errorMessage);
    }
  }, [canGenerateFromHook, sequenceId, refetchFrames]);

  // Next button - now goes to the next sequence step (removed motion page)
  const handleNext = useCallback(() => {
    if (hasFrames) {
      // Could navigate to an export or final step
      console.log("Sequence complete with motion!");
    }
  }, [hasFrames]);

  // Handle frame updates (e.g., after motion generation)
  const handleFrameUpdate = useCallback(
    async (updatedFrame: Frame) => {
      // Trigger a refetch to update the frames list
      await updateFrame({
        ...updatedFrame,
        description: updatedFrame.description ?? undefined,
      });
      await refetchFrames();
    },
    [refetchFrames, updateFrame],
  );

  const canProceed = hasFrames && !isBackgroundGenerating;

  if (!sequence) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-8" data-testid="storyboard-step">
      {/* Header */}
      <div className="space-y-2">
        <SectionHeading>Storyboard & Motion</SectionHeading>
        <p className="text-muted-foreground">
          Generate visual frames from your script and add motion to bring them
          to life. Each frame represents a key moment in your story.
        </p>
      </div>

      {/* Motion Progress Card - shown when frames exist */}
      {hasFrames && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Motion Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">
                  {framesWithMotion.length} of {totalFrames} frames have motion
                </div>
                <div className="text-sm text-muted-foreground">
                  {totalFrames - framesWithMotion.length} frames remaining
                </div>
              </div>
              {allFramesHaveMotion && (
                <div className="text-sm text-green-600 font-medium">
                  ✓ All frames have motion
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Show skeleton loaders when frames are being generated in background */}
      {isBackgroundGenerating && !hasFrames && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              Generating {expectedFrameCount} frames...
            </div>
            {completedFrames > 0 && (
              <div className="text-sm text-muted-foreground">
                {completedFrames} of {expectedFrameCount} completed
              </div>
            )}
          </div>
          <div className="space-y-6">
            {Array.from({ length: expectedFrameCount }).map((_, index) => (
              <StoryboardFrameSkeletonWithScript
                // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders are static
                key={`initial-skeleton-${index}`}
                index={index}
                isGenerating={true}
              />
            ))}
          </div>
        </div>
      )}

      {/* Generated Frames - show even if some are still generating */}
      {(hasFrames || (isBackgroundGenerating && frames.length > 0)) && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              {isBackgroundGenerating && frames.length < expectedFrameCount
                ? `${frames.length} of ${expectedFrameCount} frames ready`
                : `${frames.length} frames generated`}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={handleGenerateStoryboard}
              disabled={!canGenerateFromHook || isBackgroundGenerating}
              data-testid="regenerate-storyboard-button"
            >
              {isBackgroundGenerating ? "Generating..." : "Regenerate All"}
            </Button>
          </div>

          {/* Single column layout with script on left, frame on right */}
          <div className="space-y-6">
            {/* Show existing frames */}
            {frames
              .sort((a: Frame, b: Frame) => a.order_index - b.order_index)
              .map((frame: Frame) => {
                const previewStatus = framePreviewStatus.get(frame.id);
                return (
                  <StoryboardFrameWithScript
                    key={frame.id}
                    frame={frame}
                    styleId={sequence?.style_id || undefined}
                    isGeneratingPreview={previewStatus?.isGenerating || false}
                    onFrameUpdate={handleFrameUpdate}
                    onEdit={(frameId) => {
                      // TODO: Implement edit functionality
                      console.log("Edit frame:", frameId);
                    }}
                    onDelete={(frameId) => {
                      // TODO: Implement delete functionality
                      console.log("Delete frame:", frameId);
                    }}
                    onRegenerate={(payload: Record<string, unknown>) => {
                      // TODO: Implement regenerate functionality
                      console.log("Regenerate frame:", payload);
                      handleFrameUpdate(frame);
                    }}
                    falModels={falModelsResp?.models || []}
                    styles={styles || []}
                  />
                );
              })}

            {/* Show skeleton loaders for frames still being generated */}
            {isBackgroundGenerating &&
              frames.length < expectedFrameCount &&
              Array.from({ length: expectedFrameCount - frames.length }).map(
                (_, index) => (
                  <StoryboardFrameSkeletonWithScript
                    key={`pending-frame-${frames.length + index}`}
                    index={frames.length + index}
                    isGenerating={true}
                  />
                ),
              )}
          </div>

          {/* Show metadata error from sequence */}
          {hasMetadataError && (
            <Alert variant="destructive">
              <div className="space-y-2">
                <div className="font-medium">Generation Failed</div>
                <div className="text-sm">{metadataError}</div>
                {metadata?.frameGeneration?.failedAt && (
                  <div className="text-xs text-muted-foreground">
                    Failed at:{" "}
                    {new Date(
                      metadata.frameGeneration.failedAt,
                    ).toLocaleString()}
                  </div>
                )}
              </div>
            </Alert>
          )}

          {/* Show local generation error */}
          {generationError && (
            <Alert variant="destructive">
              <div className="space-y-2">
                <div className="font-medium">Generation Error</div>
                <div className="text-sm">{generationError}</div>
              </div>
            </Alert>
          )}
        </div>
      )}

      {/* Show metadata errors even when no frames exist */}
      {hasMetadataError && !hasFrames && !isBackgroundGenerating && (
        <Alert variant="destructive" className="w-full flex items-start gap-2">
          <div className="space-y-2">
            <div className="font-medium">Generation Failed</div>
            <div className="text-sm">Reason: {metadataError}</div>
            {metadata?.frameGeneration?.failedAt && (
              <div className="text-xs text-muted-foreground">
                Failed at:{" "}
                {new Date(metadata.frameGeneration.failedAt).toLocaleString()}
              </div>
            )}
          </div>
        </Alert>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          onClick={onPrevious}
          data-testid="back-to-script-button"
        >
          ← Back to Script
        </Button>

        {hasFrames && allFramesHaveMotion && (
          <Button
            onClick={handleNext}
            disabled={!canProceed}
            size="lg"
            data-testid="finish-sequence-button"
          >
            Finish Sequence →
          </Button>
        )}
      </div>
    </div>
  );
};
