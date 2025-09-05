import type React from "react";
import { useCallback, useState } from "react";
import { generateFrameMotion } from "#actions/sequence";
import { MotionPreview } from "@/components/sequence/motion-preview";
import { SectionHeading } from "@/components/typography";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Frame, Sequence } from "@/types/database";

interface MotionStepProps {
  sequence: Sequence;
  frames: Frame[];
  generatingFrameIds: Set<string>;
  generationErrors: Map<string, string>;
  onMotionGenerationStart: (frameId: string) => void;
  onMotionGenerationComplete: (frameId: string, motionUrl: string) => void;
  onMotionGenerationError: (frameId: string, error: string) => void;
  onPrevious: () => void;
}

export const MotionStep: React.FC<MotionStepProps> = ({
  sequence,
  frames,
  generatingFrameIds,
  generationErrors,
  onMotionGenerationStart,
  onMotionGenerationComplete,
  onMotionGenerationError,
  onPrevious,
}) => {
  const [currentOperation, setCurrentOperation] = useState<string | null>(null);
  const styleId = sequence.style_id;

  const handleGenerateFrameMotion = useCallback(
    async (frameId: string) => {
      if (!styleId) return;

      const frame = frames.find((f: Frame) => f.id === frameId);
      if (!frame) return;

      onMotionGenerationStart(frameId);

      try {
        // Use script chunk from metadata if available, otherwise fall back to description
        const metadata = frame.metadata as Record<string, unknown> | null;
        const scriptChunk = metadata?.scriptChunk as string | undefined;
        const frameText =
          scriptChunk || frame.description || `Frame ${frameId}`;

        const result = await generateFrameMotion(frameId, frameText, styleId);

        if (result.success && result.videoUrl) {
          onMotionGenerationComplete(frameId, result.videoUrl);
        } else {
          onMotionGenerationError(
            frameId,
            result.error || "Failed to generate motion",
          );
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : "Unexpected error during motion generation";
        onMotionGenerationError(frameId, errorMessage);
      }
    },
    [
      frames,
      styleId,
      onMotionGenerationStart,
      onMotionGenerationComplete,
      onMotionGenerationError,
    ],
  );

  const handleGenerateAllMotion = useCallback(async () => {
    if (!styleId) return;

    const framesToGenerate = frames.filter((frame: Frame) => !frame.video_url);
    if (framesToGenerate.length === 0) return;

    setCurrentOperation("Generating motion for all frames...");

    // Start generation for all frames
    for (const frame of framesToGenerate) {
      onMotionGenerationStart(frame.id);
    }

    try {
      // Generate motion for each frame sequentially
      // In production, this could be parallelized with Promise.all
      for (const frame of framesToGenerate) {
        try {
          // Use script chunk from metadata if available, otherwise fall back to description
          const metadata = frame.metadata as Record<string, unknown> | null;
          const scriptChunk = metadata?.scriptChunk as string | undefined;
          const frameText =
            scriptChunk || frame.description || `Frame ${frame.id}`;

          const result = await generateFrameMotion(
            frame.id,
            frameText,
            styleId,
          );

          if (result.success && result.videoUrl) {
            onMotionGenerationComplete(frame.id, result.videoUrl);
          } else {
            onMotionGenerationError(
              frame.id,
              result.error || "Failed to generate motion",
            );
          }
        } catch (frameError) {
          const errorMessage =
            frameError instanceof Error
              ? frameError.message
              : "Failed to generate motion";
          onMotionGenerationError(frame.id, errorMessage);
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unexpected error during batch motion generation";

      // Mark all as failed
      for (const frame of framesToGenerate) {
        onMotionGenerationError(frame.id, errorMessage);
      }
    } finally {
      setCurrentOperation(null);
    }
  }, [
    frames,
    styleId,
    onMotionGenerationStart,
    onMotionGenerationComplete,
    onMotionGenerationError,
  ]);

  const framesWithMotion = frames.filter((frame: Frame) => frame.video_url);
  const framesWithoutMotion = frames.filter((frame: Frame) => !frame.video_url);
  const totalFrames = frames.length;

  const hasAnyMotion = framesWithMotion.length > 0;
  const allFramesHaveMotion =
    totalFrames > 0 && framesWithMotion.length === totalFrames;

  if (!sequence || frames.length === 0) {
    return (
      <div className="space-y-8" data-testid="motion-step">
        <Alert>
          <div className="space-y-2">
            <div className="font-medium">No Frames Available</div>
            <div className="text-sm">
              Please go back and generate your storyboard first.
            </div>
          </div>
        </Alert>

        <div className="flex justify-start">
          <Button
            variant="outline"
            onClick={onPrevious}
            data-testid="back-to-storyboard-button"
          >
            ← Back to Storyboard
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8" data-testid="motion-step">
      {/* Header */}
      <div className="space-y-2">
        <SectionHeading>Add Motion</SectionHeading>
        <p className="text-muted-foreground">
          Bring your storyboard to life with AI-generated motion. Generate
          videos for individual frames or all at once.
        </p>
      </div>

      {/* Progress Overview */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Motion Progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">
                {framesWithMotion.length} of {totalFrames} frames have motion
              </div>
              <div className="text-sm text-muted-foreground">
                {framesWithoutMotion.length} frames remaining
              </div>
            </div>

            {framesWithoutMotion.length > 0 && (
              <Button
                onClick={handleGenerateAllMotion}
                disabled={generatingFrameIds.size > 0}
                data-testid="generate-all-motion-button"
              >
                {generatingFrameIds.size > 0
                  ? "Generating..."
                  : "Generate All Motion"}
              </Button>
            )}
          </div>

          {currentOperation && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary" />
              <span>{currentOperation}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Frame Motion List */}
      <div className="space-y-6">
        {frames
          .sort((a: Frame, b: Frame) => a.order_index - b.order_index)
          .map((frame: Frame, index: number) => {
            const isGenerating = generatingFrameIds.has(frame.id);
            const error = generationErrors.get(frame.id);

            return (
              <div key={frame.id} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Frame {index + 1}</span>
                  <span className="text-xs text-muted-foreground">
                    {frame.video_url ? "✓ Motion generated" : "No motion"}
                  </span>
                </div>

                <div className="space-y-4">
                  <MotionPreview
                    frame={frame}
                    videoUrl={frame.video_url || undefined}
                    thumbnailUrl={frame.thumbnail_url || undefined}
                    duration={frame.duration_ms || undefined}
                    loading={isGenerating}
                    data-testid={`motion-preview-${index}`}
                  />

                  {error && (
                    <Alert variant="destructive">
                      <div className="text-sm">{error}</div>
                    </Alert>
                  )}

                  {!frame.video_url && (
                    <Button
                      onClick={() => handleGenerateFrameMotion(frame.id)}
                      disabled={isGenerating}
                      size="sm"
                    >
                      {isGenerating ? "Generating..." : "Generate Motion"}
                    </Button>
                  )}

                  {frame.video_url && (
                    <Button
                      variant="outline"
                      onClick={() => handleGenerateFrameMotion(frame.id)}
                      disabled={isGenerating}
                      size="sm"
                    >
                      {isGenerating ? "Regenerating..." : "Regenerate"}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
      </div>

      {/* Completion Status */}
      {allFramesHaveMotion && (
        <Alert>
          <div className="space-y-2">
            <div className="font-medium">🎬 Sequence Complete!</div>
            <div className="text-sm">
              All frames now have motion videos. Your sequence is ready!
            </div>
          </div>
        </Alert>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          onClick={onPrevious}
          data-testid="back-to-storyboard-button"
        >
          ← Back to Storyboard
        </Button>

        {hasAnyMotion && (
          <div className="text-sm text-muted-foreground">
            Step 3 of 3 - Motion generation complete!
          </div>
        )}
      </div>
    </div>
  );
};
