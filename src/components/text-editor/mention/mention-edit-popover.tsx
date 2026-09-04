/**
 * Edit affordance for an already-inserted mention pill (#1475). Clicking a
 * pill opens this: a preview of what it points at plus the same sectioned
 * list the `@` dropdown uses, so the target can be repointed in place instead
 * of deleted and retyped.
 *
 * Rename is optional (`onRename`) because only some targets are renameable —
 * sequence elements own an editable token, studio's positional `@ImageN`
 * references do not.
 */

import {
  filterMentionItems,
  mentionIsRenameable,
  SECTION_ORDER,
  type MentionItem,
} from '@/components/scenes/prompt-mention/mention-items';
import { AppImage } from '@/components/ui/app-image';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { deriveTokenFromFilename } from '@/lib/sequence-elements/derive-token';
import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { MentionList, type MentionListRef } from './mention-list';
import type { PromptMentionAttrs } from './mention-extension';

/**
 * The item a pill currently points at. Pills store the canonical tag as their
 * `id`, so match on that (case-insensitively — a legacy lowercased tag still
 * resolves) and fall back to the aliases the matcher already accepts.
 */
export function findMentionItem(
  items: MentionItem[],
  attrs: Pick<PromptMentionAttrs, 'id' | 'section'>
): MentionItem | undefined {
  const id = attrs.id?.toLowerCase();
  if (!id) return undefined;
  const sectionOk = (item: MentionItem) =>
    attrs.section === null || item.section === attrs.section;
  return (
    items.find((it) => sectionOk(it) && it.tag.toLowerCase() === id) ??
    items.find(
      (it) =>
        sectionOk(it) &&
        it.aliases?.some((a) => a.toLowerCase() === id) === true
    )
  );
}

/** Rows offered as replacements: everything but the pill's current target. */
export function replacementItems(
  items: MentionItem[],
  current: MentionItem | undefined,
  query: string
): MentionItem[] {
  const filtered = filterMentionItems(items, query).filter(
    (it) => it.id !== current?.id
  );
  const grouped: MentionItem[] = [];
  for (const section of SECTION_ORDER) {
    for (const item of filtered)
      if (item.section === section) grouped.push(item);
  }
  return grouped;
}

export const MentionEditPopover: React.FC<{
  attrs: PromptMentionAttrs;
  items: MentionItem[];
  onReplace: (item: MentionItem) => void;
  onRemove: () => void;
  /** Omitted when nothing about this target can be renamed. */
  onRename?: (item: MentionItem, name: string) => void;
  onClose: () => void;
}> = ({ attrs, items, onReplace, onRemove, onRename, onClose }) => {
  const current = findMentionItem(items, attrs);
  const [query, setQuery] = useState('');
  const [name, setName] = useState(current?.tag ?? '');
  const listRef = useRef<MentionListRef>(null);

  const rows = replacementItems(items, current, query);
  const renameable =
    onRename !== undefined &&
    current !== undefined &&
    mentionIsRenameable(current.section);
  // Same normalisation the server applies, so the pill lands on the token the
  // rename actually stores rather than the raw keystrokes.
  const nextToken = name.trim() === '' ? '' : deriveTokenFromFilename(name);
  const renameDirty =
    renameable && nextToken !== '' && nextToken !== current.tag;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
          {current?.thumbnailUrl ? (
            <AppImage
              src={current.thumbnailUrl}
              alt=""
              width={36}
              height={36}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-xs text-muted-foreground">@</span>
          )}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate">
            {current?.label ?? attrs.label ?? attrs.id}
          </span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {attrs.id}
          </span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto"
          aria-label="Remove mention"
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>

      {renameable && (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (renameDirty) onRename(current, nextToken);
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Rename target"
            className="h-8"
          />
          <Button type="submit" size="sm" disabled={!renameDirty}>
            Rename
          </Button>
        </form>
      )}

      <Input
        // Focused by the popover's `onOpenAutoFocus` — see `markdown-editor`.
        data-mention-filter=""
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Point at…"
        aria-label="Replace mention target"
        className="h-8"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onClose();
            return;
          }
          if (listRef.current?.onKeyDown({ event: e.nativeEvent }) === true) {
            e.preventDefault();
          }
        }}
      />
      <MentionList
        ref={listRef}
        items={rows}
        command={onReplace}
        className="max-h-56 w-full border-0 p-0 shadow-none"
      />
    </div>
  );
};
