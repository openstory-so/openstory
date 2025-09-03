import type * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { enhanceScript, validateScript } from "#actions/script";
import { generateFrames, saveSequence } from "#actions/sequence";
import { listStyles } from "#actions/styles";
import { ScriptEditor } from "@/components/sequence/script-editor";
import { StyleSelector } from "@/components/sequence/style-selector";
import { SectionHeading } from "@/components/typography";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type {
  SequenceFlowAction,
  SequenceFlowState,
} from "@/reducers/sequence-flow-reducer";

interface ScriptStepProps {
  state: SequenceFlowState;
  dispatch: React.Dispatch<SequenceFlowAction>;
  onNext: () => void;
}

export const ScriptStep: React.FC<ScriptStepProps> = ({
  state,
  dispatch,
  onNext,
}) => {
  const [validationResult, setValidationResult] = useState<Awaited<
    ReturnType<typeof validateScript>
  > | null>(null);
  const [enhancementResult, setEnhancementResult] = useState<Awaited<
    ReturnType<typeof enhanceScript>
  > | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);

  // Initialize sequence if not exists
  useEffect(() => {
    if (!state.sequence) {
      dispatch({ type: "INITIALIZE_SEQUENCE", payload: {} });
    }
  }, [state.sequence, dispatch]);

  // Load styles from database
  useEffect(() => {
    if (state.availableStyles.length === 0) {
      const loadStyles = async () => {
        const result = await listStyles();
        if (result.success && result.styles) {
          dispatch({ type: "SET_AVAILABLE_STYLES", payload: result.styles });
        }
      };
      loadStyles();
    }
  }, [state.availableStyles.length, dispatch]);

  // Auto-validate script on changes (debounced)
  useEffect(() => {
    if (!state.sequence?.script) {
      setValidationResult(null);
      return;
    }

    const timeoutId = setTimeout(async () => {
      setIsValidating(true);
      try {
        const result = await validateScript(state.sequence?.script || "");
        setValidationResult(result);
      } catch (error) {
        console.error("Script validation failed:", error);
      } finally {
        setIsValidating(false);
      }
    }, 1000); // 1 second debounce

    return () => clearTimeout(timeoutId);
  }, [state.sequence?.script]);

  const handleScriptChange = useCallback(
    (value: string) => {
      dispatch({ type: "UPDATE_SEQUENCE_SCRIPT", payload: value });
      // Clear previous enhancement when script changes
      setEnhancementResult(null);
    },
    [dispatch],
  );

  const handleStyleSelect = useCallback(
    (styleId: string) => {
      dispatch({ type: "SET_SEQUENCE_STYLE", payload: styleId });
    },
    [dispatch],
  );

  const handleEnhanceScript = useCallback(async () => {
    if (!state.sequence?.script) return;

    setIsEnhancing(true);
    try {
      const result = await enhanceScript(state.sequence.script);
      setEnhancementResult(result);

      if (result.success) {
        dispatch({
          type: "UPDATE_SEQUENCE_SCRIPT",
          payload: result.enhancedScript,
        });
      }
    } catch (error) {
      console.error("Script enhancement failed:", error);
    } finally {
      setIsEnhancing(false);
    }
  }, [state.sequence?.script, dispatch]);

  const handleNext = useCallback(async () => {
    if (!state.sequence || !state.sequence.styleId) return;

    const { script, styleId, name } = state.sequence;

    // First save the sequence to database
    dispatch({ type: "START_STORYBOARD_GENERATION" });

    try {
      // Save sequence to database
      const saveResult = await saveSequence(script, styleId, undefined, name);

      if (!saveResult.success || !saveResult.sequence) {
        throw new Error(saveResult.error || "Failed to save sequence");
      }

      // Update local state with the saved sequence ID
      dispatch({
        type: "LOAD_SEQUENCE",
        payload: {
          ...state.sequence,
          id: saveResult.sequence.id,
        },
      });

      // Generate frames
      const framesResult = await generateFrames(
        script,
        styleId,
        saveResult.sequence.id,
      );

      if (framesResult.success && framesResult.frames) {
        dispatch({
          type: "COMPLETE_STORYBOARD_GENERATION",
          payload: framesResult.frames,
        });

        // Mark step 1 as completed
        dispatch({ type: "MARK_STEP_COMPLETED", payload: 1 });

        // Proceed to next step
        onNext();
      } else {
        dispatch({
          type: "FAIL_STORYBOARD_GENERATION",
          payload: framesResult.error || "Failed to generate storyboard",
        });
      }
    } catch (error) {
      console.error("Error in handleNext:", error);
      dispatch({
        type: "FAIL_STORYBOARD_GENERATION",
        payload:
          error instanceof Error
            ? error.message
            : "Failed to generate storyboard",
      });
    }
  }, [state.sequence, dispatch, onNext]);

  const canProceed = useMemo(() => {
    if (!state.sequence) return false;
    return (
      state.sequence.script.trim().length >= 10 &&
      state.sequence.styleId !== null &&
      validationResult?.success === true
    );
  }, [state.sequence, validationResult]);

  const scriptError =
    validationResult?.errors?.[0] || state.ui.validationErrors.script;
  const hasWarnings = (validationResult?.warnings?.length || 0) > 0;
  const hasSuggestions = (validationResult?.suggestions?.length || 0) > 0;

  if (!state.sequence) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-8" data-testid="script-step">
      {/* Script Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <SectionHeading>Your Script</SectionHeading>
          {state.sequence.script.trim().length >= 10 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleEnhanceScript}
              disabled={isEnhancing}
              data-testid="enhance-script-button"
            >
              {isEnhancing ? "Enhancing..." : "✨ Enhance with AI"}
            </Button>
          )}
        </div>

        <ScriptEditor
          value={state.sequence.script}
          onValueChange={handleScriptChange}
          placeholder="Write your story here... For example: 'A lone astronaut discovers a mysterious signal from deep space. As they investigate, they uncover an ancient alien artifact that holds the key to humanity's future.'"
          error={scriptError}
          disabled={state.generation.isGeneratingStoryboard}
          data-testid="script-editor"
        />

        {/* Script Feedback */}
        {isValidating && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary" />
            <span>Analyzing script...</span>
          </div>
        )}

        {validationResult && (
          <div className="space-y-2">
            {validationResult.success && (
              <div className="text-sm text-muted-foreground">
                ✓ Script looks good! Estimated{" "}
                {validationResult.estimatedFrames} frames, ~
                {Math.floor(validationResult.estimatedDuration / 60)}:
                {(validationResult.estimatedDuration % 60)
                  .toString()
                  .padStart(2, "0")}{" "}
                duration
              </div>
            )}

            {hasWarnings && (
              <Alert>
                <div className="space-y-1">
                  <div className="font-medium">Considerations:</div>
                  <ul className="text-sm list-disc list-inside space-y-1">
                    {validationResult.warnings.map((warning: string) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              </Alert>
            )}

            {hasSuggestions && (
              <Alert>
                <div className="space-y-1">
                  <div className="font-medium">Suggestions:</div>
                  <ul className="text-sm list-disc list-inside space-y-1">
                    {validationResult.suggestions.map((suggestion: string) => (
                      <li key={suggestion}>{suggestion}</li>
                    ))}
                  </ul>
                </div>
              </Alert>
            )}
          </div>
        )}

        {/* Enhancement Results */}
        {enhancementResult?.success && (
          <Alert>
            <div className="space-y-2">
              <div className="font-medium">Script Enhanced!</div>
              <div className="text-sm">
                Applied {enhancementResult.improvements.length} improvements:
              </div>
              <ul className="text-sm list-disc list-inside space-y-1">
                {enhancementResult.improvements.map((improvement: string) => (
                  <li key={improvement}>{improvement}</li>
                ))}
              </ul>
            </div>
          </Alert>
        )}
      </div>

      {/* Style Selection */}
      <div className="space-y-4">
        <SectionHeading>Choose Visual Style</SectionHeading>

        <StyleSelector
          selectedStyleId={state.sequence.styleId}
          onStyleSelect={handleStyleSelect}
          styles={state.availableStyles}
          loading={state.availableStyles.length === 0}
          disabled={state.generation.isGeneratingStoryboard}
          data-testid="style-selector"
        />

        {state.ui.validationErrors.style && (
          <div className="text-sm text-destructive">
            {state.ui.validationErrors.style}
          </div>
        )}
      </div>

      {/* Next Button */}
      <div className="flex justify-end">
        <Button
          onClick={handleNext}
          disabled={!canProceed}
          size="lg"
          data-testid="next-to-storyboard-button"
        >
          Generate Storyboard →
        </Button>
      </div>
    </div>
  );
};
