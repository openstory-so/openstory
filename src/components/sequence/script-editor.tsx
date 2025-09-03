import type * as React from "react";
import { useCallback } from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface ScriptEditorProps {
  value: string;
  onValueChange: (value: string) => void;
  error?: string;
  maxLength?: number;
  placeholder?: string;
  disabled?: boolean;
  showCharacterCount?: boolean;
}

export const ScriptEditor: React.FC<ScriptEditorProps> = ({
  value,
  onValueChange,
  error,
  maxLength = 5000,
  placeholder = "Enter your script here...",
  disabled = false,
  showCharacterCount = true,
}) => {
  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      if (maxLength && newValue.length <= maxLength) {
        onValueChange(newValue);
      }
    },
    [onValueChange, maxLength],
  );

  const isOverLimit = maxLength && value.length > maxLength;
  const hasError = Boolean(error) || isOverLimit;

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Textarea
          value={value}
          onChange={handleChange}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={hasError ? "true" : "false"}
          className={cn(
            "min-h-32 resize-none",
            hasError && "border-destructive focus-visible:ring-destructive/20",
          )}
          data-testid="script-editor-textarea"
        />
      </div>

      <div className="flex items-center justify-between">
        {showCharacterCount && (
          <div className="text-sm text-muted-foreground">
            <span
              className={cn(isOverLimit && "text-destructive font-medium")}
              data-testid="character-count"
            >
              {value.length.toLocaleString()}
            </span>
            {maxLength && (
              <>
                {" / "}
                <span>{maxLength.toLocaleString()}</span>
                <span> characters</span>
              </>
            )}
          </div>
        )}

        {error && (
          <div
            className="text-sm text-destructive font-medium"
            data-testid="error-message"
            role="alert"
            aria-live="polite"
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
};
