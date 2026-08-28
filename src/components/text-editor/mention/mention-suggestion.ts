/**
 * Wires Tiptap's mention suggestion plugin to a React-rendered, portaled
 * dropdown. The dropdown is mounted at the suggestion's clientRect, flipped
 * above the caret if the bottom would clip the viewport.
 *
 * `getItems` is a thunk because the items list is React state in the host
 * component and we need the latest value at suggestion-fire time, not at
 * editor-init time.
 */

import {
  filterMentionItems,
  mentionInsertAttrs,
  SECTION_ORDER,
  type MentionItem,
} from '@/components/scenes/prompt-mention/mention-items';
import { ReactRenderer } from '@tiptap/react';
import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion';
import {
  MentionList,
  type MentionListProps,
  type MentionListRef,
} from './mention-list';

const MAX_ITEMS = 8;
const POPUP_GAP = 6;

type SuggestionConfig = Omit<
  SuggestionOptions<MentionItem, MentionItem>,
  'editor'
>;

/**
 * `getOnSelect` (optional) lets the host swap the chosen row for the item that
 * should actually be inserted — the studio composer turns a library pick into
 * an attached `@ImageN` reference.
 */
export function createMentionSuggestion(
  getItems: () => MentionItem[],
  getOnSelect?: () => ((item: MentionItem) => MentionItem) | undefined
): SuggestionConfig {
  return {
    char: '@',

    items: ({ query }) => {
      const filtered = filterMentionItems(getItems(), query);
      // Re-group so the dropdown shows Elements → Cast → Locations in order,
      // regardless of how `mention-items` happened to interleave them.
      const grouped: MentionItem[] = [];
      for (const section of SECTION_ORDER) {
        for (const item of filtered) {
          if (item.section === section) grouped.push(item);
        }
      }
      return grouped.slice(0, MAX_ITEMS);
    },

    command: ({ editor, range, props }) => {
      const attrs = mentionInsertAttrs(getOnSelect?.()?.(props) ?? props);
      // Same space-collapse as Tiptap's default mention command: if the node
      // after the query is already a space, extend the replace range over it
      // so we don't insert a double space.
      const nodeAfter = editor.view.state.selection.$to.nodeAfter;
      const overrideSpace = nodeAfter?.text?.startsWith(' ');
      const insertRange = overrideSpace
        ? { ...range, to: range.to + 1 }
        : range;
      editor
        .chain()
        .focus()
        .insertContentAt(insertRange, [
          {
            type: 'mention',
            attrs,
          },
          { type: 'text', text: ' ' },
        ])
        .run();
      editor.view.dom.ownerDocument.defaultView
        ?.getSelection()
        ?.collapseToEnd();
    },

    render: () => {
      let component: ReactRenderer<MentionListRef> | null = null;
      let popup: HTMLDivElement | null = null;
      let clientRect: (() => DOMRect | null) | null | undefined = null;
      // Thumbnails load after mount, so the popup grows after it was
      // positioned — re-run the flip-above check whenever its size changes
      // (matters most for editors pinned to the bottom of the viewport).
      let resize: ResizeObserver | null = null;

      const position = (
        el: HTMLDivElement,
        rect: DOMRect | undefined | null
      ): void => {
        if (!rect) return;
        const popupHeight = el.offsetHeight || 280;
        const popupWidth = el.offsetWidth || 320;
        const viewportH = window.innerHeight;
        const viewportW = window.innerWidth;
        const wouldClipBottom =
          rect.bottom + popupHeight + POPUP_GAP > viewportH;
        const top = wouldClipBottom
          ? Math.max(POPUP_GAP, rect.top - popupHeight - POPUP_GAP)
          : rect.bottom + POPUP_GAP;
        const left = Math.min(
          Math.max(POPUP_GAP, rect.left),
          viewportW - popupWidth - POPUP_GAP
        );
        el.style.top = `${top}px`;
        el.style.left = `${left}px`;
      };

      return {
        onStart: (props: SuggestionProps<MentionItem, MentionItem>) => {
          component = new ReactRenderer<MentionListRef, MentionListProps>(
            MentionList,
            {
              props: {
                items: props.items,
                command: (item: MentionItem) => {
                  props.command(item);
                },
              },
              editor: props.editor,
            }
          );

          popup = document.createElement('div');
          popup.style.position = 'fixed';
          popup.style.zIndex = '50';
          popup.style.top = '0';
          popup.style.left = '0';
          popup.appendChild(component.element);
          document.body.appendChild(popup);
          clientRect = props.clientRect;
          position(popup, clientRect?.());
          if (typeof ResizeObserver !== 'undefined') {
            resize = new ResizeObserver(() => {
              if (popup) position(popup, clientRect?.());
            });
            resize.observe(component.element);
          }
        },

        onUpdate: (props: SuggestionProps<MentionItem, MentionItem>) => {
          component?.updateProps({
            items: props.items,
            command: (item: MentionItem) => {
              props.command(item);
            },
          });
          clientRect = props.clientRect;
          if (popup) position(popup, clientRect?.());
        },

        onKeyDown: (props) => {
          if (props.event.key === 'Escape') {
            resize?.disconnect();
            resize = null;
            popup?.remove();
            popup = null;
            component?.destroy();
            component = null;
            return true;
          }
          const handler = component?.ref?.onKeyDown;
          if (!handler) return false;
          return handler({ event: props.event });
        },

        onExit: () => {
          resize?.disconnect();
          resize = null;
          popup?.remove();
          popup = null;
          component?.destroy();
          component = null;
        },
      };
    },
  };
}
