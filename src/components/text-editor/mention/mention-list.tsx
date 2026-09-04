// oxlint-disable jsx-a11y/prefer-tag-over-role -- WAI-ARIA APG listbox-with-options pattern needs role="listbox"/"option" on non-native elements; native <select>/<datalist>/<option> can't host a typed query against rich sectioned items with thumbnails.
/**
 * The dropdown rendered by the Tiptap mention suggestion plugin. Mirrors the
 * sectioned UI we had on the old textarea popover (Elements / Cast /
 * Locations), with thumbnails and the canonical tag in monospace on the
 * trailing edge.
 *
 * Exposes an imperative `onKeyDown` handle so the editor can hand off
 * Arrow/Enter/Tab while focus is still in the editor (the suggestion plugin
 * intercepts the keystroke before ProseMirror does).
 */

import {
  SECTION_LABELS,
  SECTION_ORDER,
  type MentionItem,
  type MentionSection,
} from '@/components/scenes/prompt-mention/mention-items';
import { cn } from '@/shared/utils';
import { AppImage } from '@/components/ui/app-image';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from 'react';

export type MentionListRef = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
};

export type MentionListProps = {
  items: MentionItem[];
  command: (item: MentionItem) => void;
  /** Overrides the standalone-popup chrome when embedded in another surface. */
  className?: string;
};

export const MentionList = forwardRef<MentionListRef, MentionListProps>(
  ({ items, command, className }, ref) => {
    const [selectedIdx, setSelectedIdx] = useState(0);

    useEffect(() => {
      if (selectedIdx >= items.length) setSelectedIdx(0);
    }, [items.length, selectedIdx]);

    const selectByIdx = (idx: number) => {
      const item = items[idx];
      if (item) command(item);
    };

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (items.length === 0) return false;
        if (event.key === 'ArrowDown') {
          setSelectedIdx((i) => (i + 1) % items.length);
          return true;
        }
        if (event.key === 'ArrowUp') {
          setSelectedIdx((i) => (i === 0 ? items.length - 1 : i - 1));
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          selectByIdx(selectedIdx);
          return true;
        }
        return false;
      },
    }));

    const sections = useMemo(() => {
      const out: Array<{ section: MentionSection; entries: MentionItem[] }> =
        [];
      for (const section of SECTION_ORDER) {
        const entries = items.filter((it) => it.section === section);
        if (entries.length > 0) out.push({ section, entries });
      }
      return out;
    }, [items]);

    if (items.length === 0) {
      return (
        <div
          role="listbox"
          aria-label="Mention suggestions"
          className={cn(
            'w-72 rounded-md border bg-popover p-2 text-sm text-muted-foreground shadow-md',
            className
          )}
        >
          No matches
        </div>
      );
    }

    let runningIdx = 0;
    return (
      <div
        role="listbox"
        aria-label="Mention suggestions"
        className={cn(
          'flex max-h-72 w-80 flex-col overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
          className
        )}
      >
        {sections.map(({ section, entries }) => (
          <div key={section} className="py-1 first:pt-0 last:pb-0">
            <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {SECTION_LABELS[section]}
            </div>
            {entries.map((item) => {
              const idx = runningIdx++;
              const isActive = idx === selectedIdx;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onMouseEnter={() => setSelectedIdx(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    command(item);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                    isActive
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/50'
                  )}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                    {item.thumbnailUrl ? (
                      <AppImage
                        src={item.thumbnailUrl}
                        alt=""
                        width={32}
                        height={32}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-[10px] text-muted-foreground">
                        {item.section === 'elements'
                          ? '◇'
                          : item.section === 'cast'
                            ? '☻'
                            : '⌖'}
                      </span>
                    )}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">{item.label}</span>
                    {item.sublabel && (
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {item.sublabel}
                      </span>
                    )}
                  </span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {item.tag}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    );
  }
);
MentionList.displayName = 'MentionList';
