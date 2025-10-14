import type * as React from "react";
import { Button } from "@/components/ui/button";

interface GenerationSectionProps {
  onGenerateStoryboard: () => void;
  canGenerate: boolean;
  isSubmitting: boolean;
  submitError?: string;
  validationRequirements: {
    hasScript: boolean;
    hasStyle: boolean;
  };
}

export const GenerationSection: React.FC<GenerationSectionProps> = ({
  onGenerateStoryboard,
  canGenerate,
  isSubmitting,
  submitError,
  validationRequirements,
}) => {
  return (
    <div className="flex flex-col gap-4 pt-4 border-t">
      <Button
        onClick={onGenerateStoryboard}
        disabled={!canGenerate}
        size="lg"
        className="w-full"
        data-testid="generate-button"
      >
        {isSubmitting ? (
          <>
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-background border-t-transparent mr-2" />
            Generating Storyboard...
          </>
        ) : (
          "Generate Storyboard"
        )}
      </Button>

      {/* Error Message */}
      {submitError && (
        <div
          className="text-sm text-destructive p-3 rounded-md bg-destructive/10"
          data-testid="submit-error"
        >
          {submitError}
        </div>
      )}

      {/* Validation Help */}
      {!canGenerate && !isSubmitting && (
        <div className="text-sm text-muted-foreground space-y-1">
          <p>To generate your storyboard, you need to:</p>
          <ul className="list-disc list-inside space-y-1 ml-4">
            {!validationRequirements.hasScript && (
              <li>Write a script (at least 10 characters)</li>
            )}
            {!validationRequirements.hasStyle && <li>Select a visual style</li>}
          </ul>
        </div>
      )}
    </div>
  );
};
