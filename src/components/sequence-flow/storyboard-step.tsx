import type * as React from "react";
import { useCallback, useMemo, useState } from "react";
import { generateFrames } from "#actions/sequence";
import { StoryboardFrame } from "@/components/sequence/storyboard-frame";
import { SectionHeading } from "@/components/typography";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { Frame, Sequence } from "@/types/database";

interface StoryboardStepProps {
  sequence: Sequence;
  frames: Frame[];
  isGenerating: boolean;
  generationError: string | null;
  onGenerationStart: () => void;
  onGenerationComplete: () => void;
  onGenerationError: (error: string) => void;
  onFrameReorder: (frames: Frame[]) => void;
  onNext: () => void;
  onPrevious: () => void;
}

export const StoryboardStep: React.FC<StoryboardStepProps> = ({
  sequence,
  frames,
  isGenerating,
  generationError,
  onGenerationStart,
  onGenerationComplete,
  onGenerationError,
  onFrameReorder,
  onNext,
  onPrevious,
}) => {
  const [currentOperation, setCurrentOperation] = useState<string | null>(null);
  const hasFrames = frames.length > 0;
  const styleId = sequence.style_id;

  const handleGenerateStoryboard = useCallback(async () => {
    if (!sequence.script || !styleId) return;

    onGenerationStart();
    setCurrentOperation("Analyzing script...");

    try {
      const result = await generateFrames(
        sequence.script,
        styleId,
        sequence.id,
      );

      if (result.success && result.frames) {
        onGenerationComplete();
      } else {
        onGenerationError(result.error || "Failed to generate storyboard");
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unexpected error during generation";
      onGenerationError(errorMessage);
    } finally {
      setCurrentOperation(null);
    }
  }, [
    sequence,
    styleId,
    onGenerationStart,
    onGenerationComplete,
    onGenerationError,
  ]);

  const handleFrameReorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      const newFrames = [...frames];
      const [removed] = newFrames.splice(fromIndex, 1);
      newFrames.splice(toIndex, 0, removed);

      // Update order_index for all frames
      const updatedFrames = newFrames.map((frame, index) => ({
        ...frame,
        order_index: index,
      }));

      onFrameReorder(updatedFrames);
    },
    [frames, onFrameReorder],
  );

  const handleNext = useCallback(() => {
    if (hasFrames) {
      onNext();
    }
  }, [hasFrames, onNext]);

  const canGenerate = useMemo(() => {
    return (
      sequence.script &&
      sequence.script.trim().length >= 10 &&
      styleId &&
      !isGenerating
    );
  }, [sequence.script, styleId, isGenerating]);

  const canProceed = hasFrames && !isGenerating;

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
        <SectionHeading>Storyboard</SectionHeading>
        <p className="text-muted-foreground">
          Generate visual frames from your script. Each frame represents a key
          moment in your story.
        </p>
      </div>

      {/* Generation Controls */}
      {!hasFrames && (
        <div className="space-y-4">
          <div className="text-center py-8 border-2 border-dashed border-muted rounded-lg">
            <div className="space-y-4">
              <div className="text-muted-foreground">
                Ready to generate your storyboard from the script
              </div>

              <Button
                onClick={handleGenerateStoryboard}
                disabled={!canGenerate}
                size="lg"
                data-testid="generate-storyboard-button"
              >
                {isGenerating ? "Generating..." : "Generate Storyboard"}
              </Button>
            </div>
          </div>

          {generationError && (
            <Alert variant="destructive">
              <div className="space-y-2">
                <div className="font-medium">Generation Failed</div>
                <div className="text-sm">{generationError}</div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleGenerateStoryboard}
                  disabled={!canGenerate}
                >
                  Try Again
                </Button>
              </div>
            </Alert>
          )}
        </div>
      )}

      {/* Loading State */}
      {isGenerating && (
        <div className="space-y-4">
          <div className="flex items-center justify-center py-8">
            <div className="text-center space-y-4">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
              <div className="space-y-2">
                <div className="font-medium">Generating Your Storyboard</div>
                {currentOperation && (
                  <div className="text-sm text-muted-foreground">
                    {currentOperation}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Generated Frames */}
      {hasFrames && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              {frames.length} frames generated
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={handleGenerateStoryboard}
              disabled={!canGenerate}
              data-testid="regenerate-storyboard-button"
            >
              Regenerate All
            </Button>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            {frames
              .sort((a: Frame, b: Frame) => a.order_index - b.order_index)
              .map((frame: Frame, index: number) => (
                <StoryboardFrame
                  key={frame.id}
                  frame={frame}
                  onReorder={(frameId: string, newOrder: number) => {
                    const currentIndex = frames.findIndex(
                      (f: Frame) => f.id === frameId,
                    );
                    if (currentIndex !== -1) {
                      handleFrameReorder(currentIndex, newOrder - 1); // Convert to 0-based index
                    }
                  }}
                  data-testid={`storyboard-frame-${index}`}
                />
              ))}
          </div>

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

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          onClick={onPrevious}
          data-testid="back-to-script-button"
        >
          ← Back to Script
        </Button>

        {hasFrames && (
          <Button
            onClick={handleNext}
            disabled={!canProceed}
            size="lg"
            data-testid="next-to-motion-button"
          >
            Add Motion →
          </Button>
        )}
      </div>
    </div>
  );
};
