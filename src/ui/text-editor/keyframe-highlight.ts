/** Tints keyframe lines (#2386) in a prompt editor. Decoration only: the text is untouched. */

import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { isKeyframeLine } from '@/shots/keyframe-lines';

export const KEYFRAME_LINE_CLASS = 'rounded-sm bg-primary/10';

/** One decoration per keyframe line; a line ends at a hard break or its block. */
function keyframeDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    let lineStart = blockPos + 1;
    let lineText = '';
    const flush = (end: number) => {
      if (isKeyframeLine(lineText)) {
        decorations.push(
          Decoration.inline(lineStart, end, { class: KEYFRAME_LINE_CLASS })
        );
      }
    };
    block.forEach((child, offset) => {
      const pos = blockPos + 1 + offset;
      if (child.type.name === 'hardBreak') {
        flush(pos);
        lineStart = pos + child.nodeSize;
        lineText = '';
      } else {
        lineText += child.isText ? (child.text ?? '') : ' ';
      }
    });
    flush(blockPos + 1 + block.content.size);
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

export const KeyframeHighlight = Extension.create({
  name: 'keyframeHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: { decorations: (state) => keyframeDecorations(state.doc) },
      }),
    ];
  },
});
