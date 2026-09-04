/**
 * Scene Script Tab
 * Edits the scene script extract. Duration is NOT edited here — it is a video
 * parameter (hashed only by `computeShotVideoInputHash`) and lives per-shot,
 * so it sits on the Motion tab next to the model that defines its legal values
 * and the segment it feeds. See `ShotDurationField`.
 */

import { Button } from '@/components/ui/button';
import type { MentionItem } from '@/components/scenes/prompt-mention/mention-items';
import { MarkdownEditor } from '@/components/text-editor/markdown-editor';
import { VoiceInputButton } from '@/components/voice/voice-input-button';
import { useEditorDictation } from '@/hooks/use-dictation';
import { CopyIcon, Loader2 } from 'lucide-react';

type SceneScriptTabProps = {
  /** The scene being edited — absent when the selection resolves to no single
   *  scene, which disables the editor rather than writing to a guessed target. */
  sceneId: string | undefined;
  scriptText: string | undefined;
  editedScript: string | undefined;
  onEditedScriptChange: (value: string | undefined) => void;
  isSaving: boolean;
  onSave: (nextExtract: string) => void;
  isCopied: boolean;
  onCopy: (text: string) => void;
  /** Pills the script's bare slugs for elements/cast/locations. */
  mentionItems?: MentionItem[];
};

export const SceneScriptTab: React.FC<SceneScriptTabProps> = ({
  sceneId,
  scriptText,
  editedScript,
  onEditedScriptChange,
  isSaving,
  onSave,
  isCopied,
  onCopy,
  mentionItems,
}) => {
  const { ref: editorRef, voice } = useEditorDictation();

  const savedScript = scriptText ?? '';
  const currentScript = editedScript ?? savedScript;
  const isDirty = editedScript !== undefined && editedScript !== savedScript;
  const canSave = isDirty && !!sceneId && !isSaving;

  // A multi-scene selection has no single script to edit. Say so, rather than
  // showing an empty editor that reads as "this scene has no script".
  if (!sceneId) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        Select a single scene to edit its script, or use the Script view to edit
        them all in one document.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label htmlFor="script-extract-input" className="text-sm font-medium">
            Scene script
          </label>
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">
              {currentScript.length} characters
            </span>
            <VoiceInputButton
              label="scene script"
              disabled={isSaving}
              {...voice}
            />
          </div>
        </div>
        <div className="relative">
          <MarkdownEditor
            id="script-extract-input"
            ref={editorRef}
            value={currentScript}
            onValueChange={(value) => onEditedScriptChange(value)}
            placeholder="Enter the script text for this scene… (type @ to insert elements, cast, locations)"
            className="min-h-[180px] pr-10"
            disabled={!sceneId || isSaving}
            mentionItems={mentionItems}
          />
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onCopy(currentScript)}
            disabled={!currentScript}
            aria-label="Copy scene script"
            className="absolute right-1 top-1 h-8 w-8"
          >
            {isCopied ? (
              <span className="text-xs">✓</span>
            ) : (
              <CopyIcon className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => onEditedScriptChange(undefined)}
          disabled={!isDirty || isSaving}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => onSave(currentScript)}
          disabled={!canSave}
        >
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isSaving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      {isDirty && (
        <p className="text-xs text-muted-foreground">
          Saving will mark the image and motion prompts as stale.
        </p>
      )}
    </div>
  );
};
