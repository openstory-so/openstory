/**
 * Scene Script Document — the whole script, as scene blocks (#1037).
 *
 * The sequence script is not a separate document: it IS the ordered scenes'
 * extracts joined together (`composeSequenceScript` is `slices.join('\n\n')`).
 * So this renders one block per scene and reading top-to-bottom gives you the
 * script, with no lossy round-trip between a joined document and the slices it
 * came from — each block edits exactly the `scene_script_versions` row it
 * displays.
 *
 * It replaces the old `/sequences/$id/script` page, which showed the composed
 * document through the *creation* composer: read-only after analysis, with a
 * full re-analysis fork as the only way to change anything.
 *
 * Structural edits (merge / split / move-boundary) are the other half of #1037
 * and are deliberately absent here — this pass is edit-in-place only.
 */

import { MarkdownEditor } from '@/components/text-editor/markdown-editor';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useSequenceMentionItems } from '@/hooks/use-mention-items';
import { useSaveSceneScript, type SceneWithScript } from '@/hooks/use-scenes';
import { cn } from '@/lib/utils';
import { plainSceneTitle } from '@/lib/utils/markdown-plain';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { MentionItem } from './prompt-mention/mention-items';

/** One scene as the document renders it: its heading and its script text. */
export type ScriptBlock = {
  sceneId: string;
  sceneNumber: number;
  title: string;
  extract: string;
};

/** The scene fields the document reads — kept minimal so the block builder is
 *  a pure function over a shape, not over a DB row. */
export type ScriptBlockScene = Pick<
  SceneWithScript,
  'id' | 'orderIndex' | 'title' | 'script'
>;

/** Build the ordered blocks from the scenes, each carrying its selected script
 *  version (#1030). */
export function buildScriptBlocks(
  scenes: readonly ScriptBlockScene[]
): ScriptBlock[] {
  return [...scenes]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((scene, index) => ({
      sceneId: scene.id,
      sceneNumber: index + 1,
      title: plainSceneTitle(scene.title),
      extract: scene.script?.extract ?? '',
    }));
}

/**
 * The part of the full script no scene has claimed yet (#1225). Extracts are
 * verbatim, in-order substrings of the script, so walk them forward and return
 * what follows the last one. An extract that can't be located (edited after
 * the split) is skipped rather than resetting the cursor.
 */
export function unsplitScriptTail(
  script: string,
  blocks: readonly Pick<ScriptBlock, 'extract'>[]
): string {
  let cursor = 0;
  for (const { extract } of blocks) {
    if (!extract) continue;
    const at = script.indexOf(extract, cursor);
    if (at !== -1) cursor = at + extract.length;
  }
  return script.slice(cursor).trim();
}

type SceneScriptBlockProps = {
  block: ScriptBlock;
  sequenceId: string;
  isSelected: boolean;
  onSelect: (sceneId: string) => void;
  mentionItems?: MentionItem[];
};

const SceneScriptBlock: React.FC<SceneScriptBlockProps> = ({
  block,
  sequenceId,
  isSelected,
  onSelect,
  mentionItems,
}) => {
  // `undefined` = no draft; the editor mirrors the saved text. Each block owns
  // its own draft so editing one scene never blocks or discards another's.
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const saveScript = useSaveSceneScript(sequenceId);

  const current = draft ?? block.extract;
  const isDirty = draft !== undefined && draft !== block.extract;

  const handleSave = () => {
    saveScript.mutate(
      { sceneId: block.sceneId, extract: current },
      {
        onSuccess: () => {
          setDraft(undefined);
          toast.success(`Scene ${block.sceneNumber} saved`);
        },
        onError: (error) => {
          toast.error(`Failed to save scene ${block.sceneNumber}`, {
            description:
              error instanceof Error ? error.message : 'Unknown error',
          });
        },
      }
    );
  };

  return (
    <section
      aria-label={`Scene ${block.sceneNumber}${block.title ? `: ${block.title}` : ''}`}
      onFocusCapture={() => onSelect(block.sceneId)}
      className={cn(
        'flex flex-col gap-2 rounded-lg border p-4 transition-colors',
        isSelected ? 'border-primary bg-primary/5' : 'border-transparent'
      )}
    >
      {/* Sticky header: a scene can run for several screens, so the controls
          have to travel with you. Pinned at the top rather than the bottom
          because that's also where the scene's identity lives — you always know
          which scene you're typing into. */}
      {/* `min-h-11` reserves the dirty state's height so the header doesn't grow
          — and shove the whole document down — the moment you type. 44px is the
          Save button (h-7 = 28px) plus this row's py-2 (16px); min-height is
          border-box, so it has to cover the padding, and the title alone (20px
          line-height + 16px) is shorter. */}
      <div className="sticky top-0 z-10 -mx-4 -mt-4 flex min-h-11 flex-wrap items-center gap-3 rounded-t-lg bg-background/95 px-4 py-2 backdrop-blur">
        <button
          type="button"
          onClick={() => onSelect(block.sceneId)}
          className="flex items-baseline gap-3 text-left"
        >
          <span className="text-xs font-medium tabular-nums text-muted-foreground">
            {block.sceneNumber}
          </span>
          <span className="text-sm font-medium">
            {block.title || 'Untitled scene'}
          </span>
        </button>

        {isDirty && (
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground lg:inline">
              Saving marks this scene&apos;s prompts as stale.
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDraft(undefined)}
              disabled={saveScript.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saveScript.isPending}
            >
              {saveScript.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {saveScript.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </div>

      <MarkdownEditor
        id={`scene-script-block-${block.sceneId}`}
        value={current}
        onValueChange={setDraft}
        placeholder="Enter the script text for this scene… (type @ to insert elements, cast, locations)"
        className="min-h-[120px]"
        disabled={saveScript.isPending}
        mentionItems={mentionItems}
      />
    </section>
  );
};

type SceneScriptDocumentProps = {
  sequenceId: string;
  scenes: readonly SceneWithScript[] | undefined;
  /** Scene ids highlighted by the current selection. */
  selectedSceneIds: readonly string[];
  onSelectScene: (sceneId: string) => void;
  /** The full script while it is still being split: the not-yet-split tail is
   *  shown read-only below the scene blocks and shrinks as scenes land. */
  splittingScript?: string | null;
};

export const SceneScriptDocument: React.FC<SceneScriptDocumentProps> = ({
  sequenceId,
  scenes,
  selectedSceneIds,
  onSelectScene,
  splittingScript,
}) => {
  const { items: mentionItems } = useSequenceMentionItems(sequenceId);
  const blocks = scenes ? buildScriptBlocks(scenes) : [];
  const tail = splittingScript
    ? unsplitScriptTail(splittingScript, blocks)
    : '';

  if (!scenes) {
    return (
      <div className="flex flex-col gap-4 p-6">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  const selected = new Set(selectedSceneIds);

  if (blocks.length === 0 && !tail) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">
          This sequence has no scenes yet.
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full w-full">
      <div className="mx-auto flex max-w-3xl flex-col gap-2 px-6 py-6">
        {blocks.map((block) => (
          <SceneScriptBlock
            key={block.sceneId}
            block={block}
            sequenceId={sequenceId}
            isSelected={selected.has(block.sceneId)}
            onSelect={onSelectScene}
            mentionItems={mentionItems}
          />
        ))}
        {tail && (
          <section
            aria-label="Script not yet split into scenes"
            aria-busy="true"
            className="flex flex-col gap-2 rounded-lg border border-dashed p-4"
          >
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Splitting into scenes…
            </div>
            <pre className="whitespace-pre-wrap font-sans text-sm text-muted-foreground">
              {tail}
            </pre>
          </section>
        )}
      </div>
    </ScrollArea>
  );
};
