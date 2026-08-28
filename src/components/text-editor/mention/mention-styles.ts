/**
 * Shared mention-pill styling, so the Tiptap render (mention-extension) and the
 * read-only renderer (highlighted-prompt) pill identically. Kept separate from
 * the Tiptap extension so read-only consumers (eval views) don't pull in Tiptap.
 */

import type { MentionSection } from '@/components/scenes/prompt-mention/mention-items';

export const MENTION_SECTION_CLASS: Record<MentionSection, string> = {
  references:
    'bg-violet-500/10 text-violet-800 ring-violet-500/30 dark:text-violet-300',
  images:
    'bg-violet-500/10 text-violet-800 ring-violet-500/30 dark:text-violet-300',
  cast: 'bg-sky-500/10 text-sky-700 ring-sky-500/30 dark:text-sky-300',
  elements:
    'bg-amber-500/10 text-amber-800 ring-amber-500/30 dark:text-amber-300',
  locations:
    'bg-emerald-500/10 text-emerald-800 ring-emerald-500/30 dark:text-emerald-300',
};

export const MENTION_PILL_BASE_CLASS =
  'inline rounded px-1.5 py-0.5 text-[0.95em] font-medium leading-tight align-baseline ring-1 ring-inset whitespace-nowrap';

export function mentionPillClass(section: MentionSection): string {
  return `${MENTION_PILL_BASE_CLASS} ${MENTION_SECTION_CLASS[section]}`;
}
