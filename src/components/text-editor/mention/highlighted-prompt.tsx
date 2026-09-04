/**
 * Read-only renderer that highlights element / cast / location mentions in a
 * block of prompt or script text — the non-editable counterpart to the Tiptap
 * editor's pills. Used where prompts are displayed but not edited (e.g. the
 * eval cell dialog). Renders the same matched segments as `tagifyMarkdown`, so
 * the two surfaces pill identically.
 */

import type { MentionItem } from '@/components/scenes/prompt-mention/mention-items';
import { cn } from '@/shared/utils';
import { Fragment } from 'react';
import type React from 'react';
import { splitMentions } from './mention-match';
import { mentionPillClass } from './mention-styles';

export const HighlightedPrompt: React.FC<{
  text: string;
  items: MentionItem[];
  className?: string;
}> = ({ text, items, className }) => {
  const segments = splitMentions(text, items);
  return (
    <p className={cn('whitespace-pre-wrap', className)}>
      {segments.map((seg, i) =>
        seg.type === 'text' ? (
          <Fragment key={i}>{seg.value}</Fragment>
        ) : (
          <span key={i} className={mentionPillClass(seg.item.section)}>
            {seg.display}
          </span>
        )
      )}
    </p>
  );
};
