import type * as React from "react";
import { StyleSelector } from "@/components/sequence/style-selector";
import type { Style } from "@/types/database";

interface StyleSectionProps {
  selectedStyleId: string | null;
  onStyleSelect: (styleId: string) => void;
  styles: Style[];
  loading?: boolean;
  error?: boolean;
  disabled?: boolean;
}

export const StyleSection: React.FC<StyleSectionProps> = ({
  selectedStyleId,
  onStyleSelect,
  styles,
  loading = false,
  error = false,
  disabled = false,
}) => {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-xl font-semibold">Choose Your Style</h2>
        <p className="text-muted-foreground">
          Select a visual style that matches your story's mood and aesthetic.
          This will be applied consistently across all frames.
        </p>
      </div>

      <StyleSelector
        selectedStyleId={selectedStyleId}
        onStyleSelect={onStyleSelect}
        styles={styles}
        loading={loading}
        disabled={disabled}
      />

      {error && (
        <div
          className="text-sm text-destructive p-3 rounded-md bg-destructive/10"
          data-testid="styles-error"
        >
          Failed to load styles. Please try again.
        </div>
      )}
    </div>
  );
};
