import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { enhanceScript, validateScript } from "#actions/script";
import { listStyles } from "#actions/styles";
import { ScriptEditor } from "@/components/sequence/script-editor";
import { StyleSelector } from "@/components/sequence/style-selector";
import { SectionHeading } from "@/components/typography";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  useCreateSequence,
  useSequence,
  useUpdateSequence,
} from "@/hooks/use-sequences";
import type { Style } from "@/types/database";

// Zod validation schema for script form
const scriptFormSchema = z.object({
  script: z
    .string()
    .min(10, "Script must be at least 10 characters")
    .max(10000, "Script must be 10,000 characters or less")
    .refine((val) => val.trim().length >= 10, {
      message: "Script must contain at least 10 non-whitespace characters",
    }),
  styleId: z.string().uuid("Please select a visual style"),
  name: z.string().min(1, "Name is required").max(100, "Name is too long"),
});

type ScriptFormData = z.infer<typeof scriptFormSchema>;

interface ScriptStepProps {
  sequenceId?: string; // If provided, we're editing an existing sequence
  onSuccess: (sequenceId: string) => void; // Called when sequence is saved/updated
}

export const ScriptStep = ({ sequenceId, onSuccess }: ScriptStepProps) => {
  // Form state
  const [formData, setFormData] = useState<Partial<ScriptFormData>>({
    script: "",
    name: "Untitled Sequence",
    styleId: undefined,
  });

  // Validation state
  const [errors, setErrors] = useState<
    Partial<Record<keyof ScriptFormData, string>>
  >({});
  const [validationResult, setValidationResult] = useState<Awaited<
    ReturnType<typeof validateScript>
  > | null>(null);
  const [enhancementResult, setEnhancementResult] = useState<Awaited<
    ReturnType<typeof enhanceScript>
  > | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);

  // Styles state
  const [availableStyles, setAvailableStyles] = useState<Style[]>([]);

  // Load existing sequence data if editing
  const { data: existingSequence, isLoading: isLoadingSequence } = useSequence(
    sequenceId || "",
  );

  // TanStack Query mutations
  const createSequenceMutation = useCreateSequence();
  const updateSequenceMutation = useUpdateSequence();

  // Determine which mutation to use
  const isEditMode = !!sequenceId;
  const saveMutation = isEditMode
    ? updateSequenceMutation
    : createSequenceMutation;

  // Load existing sequence data into form
  useEffect(() => {
    if (existingSequence && isEditMode) {
      setFormData({
        script: existingSequence.script || "",
        name: existingSequence.title || "Untitled Sequence",
        styleId: existingSequence.style_id || undefined,
      });
    }
  }, [existingSequence, isEditMode]);

  // Load styles from database
  useEffect(() => {
    const loadStyles = async () => {
      const result = await listStyles();
      if (result.success && result.styles) {
        setAvailableStyles(result.styles);
      }
    };
    loadStyles();
  }, []);

  // Auto-validate script on changes (debounced)
  useEffect(() => {
    if (!formData.script) {
      setValidationResult(null);
      return;
    }

    const timeoutId = setTimeout(async () => {
      setIsValidating(true);
      try {
        const result = await validateScript(formData.script || "");
        setValidationResult(result);
      } catch (error) {
        console.error("Script validation failed:", error);
      } finally {
        setIsValidating(false);
      }
    }, 1000); // 1 second debounce

    return () => clearTimeout(timeoutId);
  }, [formData.script]);

  // Validate form data with Zod
  const validateForm = useCallback((): boolean => {
    try {
      scriptFormSchema.parse(formData);
      setErrors({});
      return true;
    } catch (error) {
      if (error instanceof z.ZodError) {
        const fieldErrors: Partial<Record<keyof ScriptFormData, string>> = {};
        error.issues.forEach((err: z.ZodIssue) => {
          const path = err.path[0] as keyof ScriptFormData;
          if (!fieldErrors[path]) {
            fieldErrors[path] = err.message;
          }
        });
        setErrors(fieldErrors);
      }
      return false;
    }
  }, [formData]);

  // Handle field changes
  const handleFieldChange = useCallback(
    (field: keyof ScriptFormData, value: string | undefined) => {
      setFormData((prev) => ({ ...prev, [field]: value }));
      // Clear error for this field when user types
      setErrors((prev) => ({ ...prev, [field]: undefined }));
      // Clear enhancement when script changes
      if (field === "script") {
        setEnhancementResult(null);
      }
    },
    [],
  );

  // Handle script enhancement
  const handleEnhanceScript = useCallback(async () => {
    if (!formData.script) return;

    setIsEnhancing(true);
    try {
      const result = await enhanceScript(formData.script);
      setEnhancementResult(result);

      if (result.success) {
        handleFieldChange("script", result.enhancedScript);
      }
    } catch (error) {
      console.error("Script enhancement failed:", error);
    } finally {
      setIsEnhancing(false);
    }
  }, [formData.script, handleFieldChange]);

  // Handle save and generate
  const handleSaveAndGenerate = useCallback(async () => {
    if (!validateForm()) {
      console.error("Script validation failed");
      return;
    }

    try {
      let savedSequenceId: string;

      // Save or update the sequence
      if (isEditMode && sequenceId) {
        const result = await updateSequenceMutation.mutateAsync({
          id: sequenceId,
          script: formData.script,
          styleId: formData.styleId || null,
          name: formData.name,
        });
        savedSequenceId = result.id;
      } else {
        const result = await createSequenceMutation.mutateAsync({
          script: formData.script || "",
          styleId: formData.styleId || null,
          name: formData.name,
        });
        savedSequenceId = result.id;
      }

      // Success - notify parent
      onSuccess(savedSequenceId);
    } catch (error) {
      // Errors are handled by the mutation's onError callback
      console.error("Error in save and generate:", error);
    }
  }, [
    formData,
    validateForm,
    isEditMode,
    sequenceId,
    createSequenceMutation,
    updateSequenceMutation,
    onSuccess,
  ]);

  // Handle save only (for edit mode)
  const handleSaveOnly = useCallback(async () => {
    // Validate only script and name for save-only
    const saveSchema = scriptFormSchema.pick({ script: true, name: true });
    try {
      saveSchema.parse({ script: formData.script, name: formData.name });
      setErrors({});
    } catch (error) {
      if (error instanceof z.ZodError) {
        const fieldErrors: Partial<Record<keyof ScriptFormData, string>> = {};
        error.issues.forEach((err: z.ZodIssue) => {
          const path = err.path[0] as keyof ScriptFormData;
          if (!fieldErrors[path]) {
            fieldErrors[path] = err.message;
          }
        });
        setErrors(fieldErrors);
        return;
      }
    }

    if (!sequenceId) return;

    try {
      await updateSequenceMutation.mutateAsync({
        id: sequenceId,
        script: formData.script,
        styleId: formData.styleId || null,
        name: formData.name,
      });
    } catch (error) {
      console.error("Error saving:", error);
    }
  }, [formData, sequenceId, updateSequenceMutation]);

  // Check if form is valid for generation
  const canGenerate = useMemo(() => {
    return (
      formData.script &&
      formData.script.trim().length >= 10 &&
      formData.styleId &&
      validationResult?.success === true &&
      !saveMutation.isPending
    );
  }, [formData, validationResult, saveMutation.isPending]);

  // Combine all loading states
  const isLoading = saveMutation.isPending || isLoadingSequence;

  // Get error messages
  const scriptError = errors.script || validationResult?.errors?.[0];
  const hasWarnings = (validationResult?.warnings?.length || 0) > 0;
  const hasSuggestions = (validationResult?.suggestions?.length || 0) > 0;

  // Show main error from mutations
  const mutationError = saveMutation.error || updateSequenceMutation.error;

  return (
    <div className="space-y-8" data-testid="script-step">
      {/* Error Alert for mutations */}
      {mutationError && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{mutationError.message}</AlertDescription>
        </Alert>
      )}

      {/* Success Alert for save only */}
      {isEditMode && updateSequenceMutation.isSuccess && (
        <Alert>
          <AlertTitle>Success</AlertTitle>
          <AlertDescription>Script saved successfully!</AlertDescription>
        </Alert>
      )}

      {/* Script Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <SectionHeading>
            {sequenceId ? "Edit Script" : "Your Script"}
          </SectionHeading>
          {formData.script && formData.script.trim().length >= 10 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleEnhanceScript}
              disabled={isEnhancing || isLoading}
              data-testid="enhance-script-button"
            >
              {isEnhancing ? "Enhancing..." : "✨ Enhance with AI"}
            </Button>
          )}
        </div>

        <ScriptEditor
          value={formData.script || ""}
          onValueChange={(value) => handleFieldChange("script", value)}
          placeholder="Write your story here... For example: 'A lone astronaut discovers a mysterious signal from deep space. As they investigate, they uncover an ancient alien artifact that holds the key to humanity's future.'"
          error={scriptError}
          disabled={isLoading}
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
                <AlertTitle>Considerations:</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc list-inside space-y-1">
                    {validationResult.warnings.map((warning: string) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {hasSuggestions && (
              <Alert>
                <AlertTitle>Suggestions:</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc list-inside space-y-1">
                    {validationResult.suggestions.map((suggestion: string) => (
                      <li key={suggestion}>{suggestion}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        {/* Enhancement Results */}
        {enhancementResult?.success && (
          <Alert>
            <AlertTitle>Script Enhanced!</AlertTitle>
            <AlertDescription>
              <div className="space-y-2">
                <div>
                  Applied {enhancementResult.improvements.length} improvements:
                </div>
                <ul className="list-disc list-inside space-y-1">
                  {enhancementResult.improvements.map((improvement: string) => (
                    <li key={improvement}>{improvement}</li>
                  ))}
                </ul>
              </div>
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Style Selection */}
      <div className="space-y-4">
        <SectionHeading>Choose Visual Style</SectionHeading>

        <StyleSelector
          selectedStyleId={formData.styleId || null}
          onStyleSelect={(styleId) => handleFieldChange("styleId", styleId)}
          styles={availableStyles}
          loading={availableStyles.length === 0}
          disabled={isLoading}
          data-testid="style-selector"
        />

        {errors.styleId && (
          <div className="text-sm text-destructive">{errors.styleId}</div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex justify-end gap-2">
        {sequenceId && (
          <Button
            variant="outline"
            onClick={handleSaveOnly}
            disabled={
              isLoading ||
              !formData.script ||
              formData.script.trim().length < 10
            }
            size="lg"
            data-testid="save-button"
          >
            {updateSequenceMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        )}
        <Button
          onClick={handleSaveAndGenerate}
          disabled={!canGenerate || isLoading}
          size="lg"
          data-testid="generate-storyboard-button"
        >
          {saveMutation.isPending
            ? "Generating..."
            : sequenceId
              ? "Regenerate Storyboard →"
              : "Generate Storyboard →"}
        </Button>
      </div>
    </div>
  );
};
