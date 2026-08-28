/**
 * Mention extension configured for character/element/location pills.
 *
 * Storage roundtrip: the markdown serializer writes the bare canonical tag
 * (`JACK`, `BONDI_SCREEN`, or a location's `office-modern-steel` slug), with
 * no leading `@`. That keeps the persisted prompt/script identical to what
 * `extract-continuity-from-prompt.ts` recognises today — the `@` is purely a
 * render concern.
 *
 * The mention's `id` attr IS the canonical tag. `section` drives the chip
 * colour. `label` is the display name (Jack, INT. OFFICE) used in the
 * dropdown — never serialised back out (only the slug is).
 *
 * Render prefix: cast names (`SCARLETT`) and element tokens (`BONDI_SCREEN`)
 * are the canonical identifiers as they already read in the script/prompt, so
 * they're highlighted in place with NO `@`. Locations have no UPPERCASE token —
 * they use the kebab consistencyTag, shown as `@slug` (a render-only flourish
 * over the bare stored slug).
 */

import {
  mentionShowsAt,
  type MentionSection,
} from '@/components/scenes/prompt-mention/mention-items';
import { Mention } from '@tiptap/extension-mention';
import type { MarkdownNodeSpec } from 'tiptap-markdown';
import {
  MENTION_PILL_BASE_CLASS as BASE_PILL_CLASS,
  MENTION_SECTION_CLASS as SECTION_CLASS,
} from './mention-styles';

/**
 * All attrs are nullable because Tiptap defaults them to null at the schema
 * level — a half-typed mention can briefly exist between user keystroke and
 * `command()` firing. Renderers must guard.
 */
export type PromptMentionAttrs = {
  id: string | null;
  section: MentionSection | null;
  label: string | null;
};

function readPromptAttrs(attrs: Record<string, unknown>): PromptMentionAttrs {
  const idRaw = attrs.id;
  const sectionRaw = attrs.section;
  const labelRaw = attrs.label;
  return {
    id: typeof idRaw === 'string' ? idRaw : null,
    section:
      typeof sectionRaw === 'string' && isMentionSection(sectionRaw)
        ? sectionRaw
        : null,
    label: typeof labelRaw === 'string' ? labelRaw : null,
  };
}

function isMentionSection(value: string): value is MentionSection {
  return (
    value === 'cast' ||
    value === 'elements' ||
    value === 'locations' ||
    value === 'references' ||
    value === 'images'
  );
}

export const PromptMention = Mention.extend({
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-id'),
        renderHTML: (attrs: { id?: string | null }) =>
          attrs.id ? { 'data-id': attrs.id } : {},
      },
      section: {
        default: null,
        parseHTML: (el) => {
          const raw = el.getAttribute('data-section');
          return raw && isMentionSection(raw) ? raw : null;
        },
        renderHTML: (attrs: { section?: MentionSection | null }) =>
          attrs.section ? { 'data-section': attrs.section } : {},
      },
      label: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-label'),
        renderHTML: (attrs: { label?: string | null }) =>
          attrs.label ? { 'data-label': attrs.label } : {},
      },
    };
  },

  addStorage() {
    const markdown: MarkdownNodeSpec = {
      serialize(state, node) {
        // Bare slug. The `@` is a render-only flourish, never stored.
        const id = readPromptAttrs(node.attrs).id;
        if (id) state.write(id);
      },
    };
    return {
      ...this.parent?.(),
      markdown,
    };
  },
}).configure({
  HTMLAttributes: {
    class: BASE_PILL_CLASS,
    spellcheck: 'false',
  },
  renderHTML: ({ node, options }) => {
    const attrs = readPromptAttrs(node.attrs);
    const sectionClass = attrs.section ? SECTION_CLASS[attrs.section] : '';
    const baseClass =
      (options.HTMLAttributes as { class?: string }).class ?? '';
    const className = `${baseClass} ${sectionClass}`.trim();
    return [
      'span',
      {
        ...options.HTMLAttributes,
        class: className,
        'data-type': 'mention',
        ...(attrs.id ? { 'data-id': attrs.id } : {}),
        ...(attrs.section ? { 'data-section': attrs.section } : {}),
        ...(attrs.label ? { 'data-label': attrs.label } : {}),
      },
      attrs.section && mentionShowsAt(attrs.section)
        ? `@${attrs.id ?? ''}`
        : (attrs.id ?? ''),
    ];
  },
  renderText: ({ node }) => {
    // ProseMirror falls back to `renderText` when a node is copied to plain
    // text. Emit the bare slug so paste-into-another-app round-trips through
    // the server-side parser without leaking the `@`.
    return readPromptAttrs(node.attrs).id ?? '';
  },
  deleteTriggerWithBackspace: true,
});
