import type * as React from "react";
import { ScriptEditor } from "@/components/sequence/script-editor";

interface ScriptSectionProps {
  script: string;
  onScriptChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
}

export const ScriptSection: React.FC<ScriptSectionProps> = ({
  script,
  onScriptChange,
  error,
  disabled = false,
}) => {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-xl font-semibold">Write Your Script</h2>
        <p className="text-muted-foreground">
          Start by writing your video script. Include scene descriptions,
          character names, and dialogue.
        </p>
      </div>

      <ScriptEditor
        value={script}
        onValueChange={onScriptChange}
        error={error}
        maxLength={10000}
        placeholder="Enter your script here... For example:

FADE IN:

EXT. COFFEE SHOP - DAY

A bustling street corner with people walking by. SARAH, a young writer, sits by the window with her laptop..."
        disabled={disabled}
      />
    </div>
  );
};
