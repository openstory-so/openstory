import type { MentionItem } from '@/components/scenes/prompt-mention/mention-items';
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from '@/components/text-editor/markdown-editor';
import { cn } from '@/lib/utils';
import type * as React from 'react';
import { useCallback } from 'react';

type ScriptEditorProps = {
  value: string;
  onValueChange: (value: string) => void;
  ref?: React.Ref<HTMLDivElement | null>;
  /** Handle for the composer's dictation mic, which lives in the toolbar below. */
  editorRef?: React.Ref<MarkdownEditorHandle>;
  error?: string;
  maxLength?: number;
  placeholder?: string;
  disabled?: boolean;
  showCharacterCount?: boolean;
  loading?: boolean;
  /**
   * Sequence cast/elements/locations. When provided, their canonical tags in
   * the script render as @-mention pills (and `@` autocompletes them) — same
   * behaviour as the scene prompt editors. The create screen passes the draft
   * elements' tokens (#1079); pass the full sequence sets once analysed.
   */
  mentionItems?: MentionItem[];
};

export const ScriptEditor: React.FC<ScriptEditorProps> = ({
  value,
  onValueChange,
  ref,
  editorRef,
  error,
  maxLength = 5000,
  placeholder = 'Enter your script here...',
  disabled = false,
  showCharacterCount = true,
  loading = false,
  mentionItems,
}) => {
  const handleChange = useCallback(
    (markdown: string) => {
      onValueChange(markdown);
    },
    [onValueChange]
  );

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      const target = event.target;
      const form = target instanceof Element ? target.closest('form') : null;
      form?.requestSubmit();
      return true;
    }
    return false;
  }, []);

  const isOverLimit = Boolean(maxLength && value.length > maxLength);
  const hasError = Boolean(error) || isOverLimit;
  const editorValue = loading ? 'Loading...' : value;

  return (
    <>
      {/* 4 editor rows (24px line-height) + the editor's vertical padding —
          the floor the flex layout can't crush the editor below. Phones get
          min-h-20 so SSR (empty, no ProseMirror) matches the hydrated empty
          height — min-h-16 was 12px short and jumped on mount (#1255). */}
      <div className="min-h-20 md:min-h-28 flex-1 flex flex-col overflow-hidden">
        <MarkdownEditor
          scrollRef={ref}
          ref={editorRef}
          id="script"
          name="script"
          value={editorValue}
          onValueChange={handleChange}
          onKeyDown={handleKeyDown}
          mentionItems={mentionItems}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={hasError}
          // This is the one height-bounded editor, so it owns the scrolling.
          // overscroll-contain: hitting its scroll bounds must not chain the
          // touch gesture into scrolling the page underneath.
          className={cn(
            'min-h-[2lh] md:min-h-[4lh] flex-1 overflow-y-auto overscroll-contain bg-transparent dark:bg-transparent border-none shadow-none focus-within:ring-0 focus-within:border-input pb-10',
            hasError && 'border-destructive focus-within:ring-destructive/20'
          )}
          data-testid="script-editor-textarea"
        />
      </div>

      <div className="shrink-0 flex items-center justify-between">
        {showCharacterCount && (
          <div className="text-sm text-muted-foreground">
            <span
              className={cn(isOverLimit && 'text-destructive font-medium')}
              data-testid="character-count"
            >
              {value.length.toLocaleString()}
            </span>
            {maxLength && (
              <>
                {' / '}
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
    </>
  );
};
