import * as React from "react";
import {
  type FrameGenerationResult,
  generateFrames,
} from "@/app/actions/anonymous-flow/index.mock";
import { StoryboardFrame } from "@/components/sequence/storyboard-frame";
import { SectionHeading } from "@/components/typography";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type {
  AnonymousFlowAction,
  AnonymousFlowState,
} from "@/reducers/anonymous-flow-reducer";

interface StoryboardStepProps {
  state: AnonymousFlowState;
  dispatch: React.Dispatch<AnonymousFlowAction>;
  onNext: () => void;
  onPrevious: () => void;
}

export const StoryboardStep: React.FC<StoryboardStepProps> = ({
  state,
  dispatch,
  onNext,
  onPrevious,
}) => {
  const [generationError, setGenerationError] = React.useState<string | null>(
    null,
  );

  const handleGenerateStoryboard = React.useCallback(async () => {
    if (!state.sequence || !state.sequence.styleId) return;

    dispatch({ type: "START_STORYBOARD_GENERATION" });
    setGenerationError(null);

    try {
      const result: FrameGenerationResult = await generateFrames(
        state.sequence.script,
        state.sequence.styleId,
        state.sequence.id,
      );

      if (result.success) {
        dispatch({
          type: "COMPLETE_STORYBOARD_GENERATION",
          payload: result.frames,
        });
      } else {
        dispatch({
          type: "FAIL_STORYBOARD_GENERATION",
          payload: result.error || "Failed to generate storyboard",
        });
        setGenerationError(result.error || "Failed to generate storyboard");
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unexpected error during generation";
      dispatch({ type: "FAIL_STORYBOARD_GENERATION", payload: errorMessage });
      setGenerationError(errorMessage);
    }
  }, [state.sequence, dispatch]);

  const _handleRegenerateFrame = React.useCallback(
    async (_frameId: string) => {
      // For now, just regenerate the whole storyboard
      // In a real implementation, this would regenerate just the specific frame
      await handleGenerateStoryboard();
    },
    [handleGenerateStoryboard],
  );

  const handleFrameReorder = React.useCallback(
    (fromIndex: number, toIndex: number) => {
      dispatch({ type: "REORDER_FRAMES", payload: { fromIndex, toIndex } });
    },
    [dispatch],
  );

  const handleNext = React.useCallback(() => {
    if ((state.sequence?.frames?.length || 0) > 0) {
      // Mark step 2 as completed
      dispatch({ type: "MARK_STEP_COMPLETED", payload: 2 });
      onNext();
    }
  }, [state.sequence?.frames.length, dispatch, onNext]);

  const canGenerate = React.useMemo(() => {
    return (
      state.sequence &&
      state.sequence.script.trim().length >= 10 &&
      state.sequence.styleId &&
      !state.generation.isGeneratingStoryboard
    );
  }, [state.sequence, state.generation.isGeneratingStoryboard]);

  const hasFrames = (state.sequence?.frames?.length || 0) > 0;
  const canProceed = hasFrames && !state.generation.isGeneratingStoryboard;

  if (!state.sequence) {
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
                {state.generation.isGeneratingStoryboard
                  ? "Generating..."
                  : "Generate Storyboard"}
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
      {state.generation.isGeneratingStoryboard && (
        <div className="space-y-4">
          <div className="flex items-center justify-center py-8">
            <div className="text-center space-y-4">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
              <div className="space-y-2">
                <div className="font-medium">Generating Your Storyboard</div>
                {state.generation.currentOperation && (
                  <div className="text-sm text-muted-foreground">
                    {state.generation.currentOperation}
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
              {state.sequence.frames.length} frames generated
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
            {state.sequence.frames
              .sort((a, b) => a.order_index - b.order_index)
              .map((frame, index) => (
                <StoryboardFrame
                  key={frame.id}
                  frame={frame}
                  onReorder={(frameId: string, newOrder: number) => {
                    const currentIndex =
                      state.sequence?.frames.findIndex(
                        (f) => f.id === frameId,
                      ) ?? -1;
                    if (currentIndex !== -1) {
                      handleFrameReorder(currentIndex, newOrder - 1); // Convert to 0-based index
                    }
                  }}
                  data-testid={`storyboard-frame-${index}`}
                />
              ))}
          </div>

          {state.generation.storyboardError && (
            <Alert variant="destructive">
              <div className="space-y-2">
                <div className="font-medium">Generation Error</div>
                <div className="text-sm">
                  {state.generation.storyboardError}
                </div>
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
