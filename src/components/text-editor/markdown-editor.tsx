import HardBreak from '@tiptap/extension-hard-break';
import { Placeholder } from '@tiptap/extensions/placeholder';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import {
  Fragment,
  type Node as ProseMirrorNode,
  type Schema,
} from '@tiptap/pm/model';
import { AllSelection, Selection, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import {
  Markdown,
  type MarkdownNodeSpec,
  type MarkdownStorage,
} from 'tiptap-markdown';
import { cn } from '@/lib/utils';
import { spaceTranscript } from '@/lib/voice/transcript-insert';
import * as React from 'react';
import { useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import type { MentionOptions } from '@tiptap/extension-mention';
import type { MentionItem } from '@/components/scenes/prompt-mention/mention-items';
import { PromptMention } from './mention/mention-extension';
import { createMentionSuggestion } from './mention/mention-suggestion';
import { tagifyMarkdown } from './mention/tagify';

type MentionConfigure = Partial<MentionOptions>;

/**
 * Collapse every line-break form to `\n`. Web/Docs/Word often put U+2028
 * (LINE SEPARATOR) between lines — ProseMirror's default paste splitter only
 * matches `\n` / `\r`, so those pastes looked empty or run-on.
 */
export const normalizeScreenplayNewlines = (text: string): string =>
  text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u2028\u2029\u0085]/g, '\n');

/**
 * Playwright `.fill()` selects via `Range.selectNodeContents` on the
 * contenteditable, then CDP `Input.insertText`. ProseMirror keeps its own
 * selection and will still have a caret, so a naive insert appends onto the
 * style sample instead of replacing it. True when the DOM range already
 * covers the whole editor.
 */
const domSelectionCoversEditor = (view: EditorView): boolean => {
  const { dom } = view;
  const sel = dom.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  if (ancestor !== dom && !dom.contains(ancestor)) return false;
  const whole = dom.ownerDocument.createRange();
  whole.selectNodeContents(dom);
  try {
    return (
      range.compareBoundaryPoints(Range.START_TO_START, whole) <= 0 &&
      range.compareBoundaryPoints(Range.END_TO_END, whole) >= 0
    );
  } catch {
    return false;
  }
};

/**
 * Inline nodes for `text`, with every newline as a hard break — a ProseMirror
 * text node cannot hold a `\n`, and `getMarkdown()` round-trips a hard break
 * losslessly (see the HardBreak serializer below). Shared by the insertText
 * handler and streaming dictation.
 */
const screenplayNodes = (
  schema: Schema,
  text: string
): Array<ProseMirrorNode> => {
  const hardBreak = schema.nodes.hardBreak;
  if (!hardBreak) return [];
  return normalizeScreenplayNewlines(text)
    .split('\n')
    .flatMap((line, i, lines) => {
      const out: Array<ProseMirrorNode> = [];
      if (line.length > 0) out.push(schema.text(line));
      if (i < lines.length - 1) out.push(hardBreak.create());
      return out;
    });
};

/**
 * Playwright `.fill()` (and other `insertText` with embedded newlines) cannot
 * put `\n` in a ProseMirror text node. Map each newline to a hard break so
 * `getMarkdown()` round-trips the source script — including the recorded
 * aimock enhance body. Paste is not handled here; ProseMirror owns that.
 */
const insertTextWithNewlines = (view: EditorView, text: string): boolean => {
  const { schema } = view.state;
  if (!schema.nodes.hardBreak) return false;
  const nodes = screenplayNodes(schema, text);
  if (nodes.length === 0) return true;
  const { tr } = view.state;
  if (view.state.selection.empty && domSelectionCoversEditor(view)) {
    tr.setSelection(new AllSelection(tr.doc));
  }
  if (!tr.selection.empty) tr.deleteSelection();
  view.dispatch(tr.insert(tr.selection.from, nodes).scrollIntoView());
  return true;
};

declare module '@tiptap/core' {
  interface Storage {
    markdown: MarkdownStorage;
  }
}

// Override tiptap-markdown's HardBreak serializer to emit a naked `\n` instead
// of CommonMark's `\\\n`. We run with `breaks: true` on parse, so a plain `\n`
// round-trips losslessly as a hard break — and the LLM enhance request body
// then matches single-newline screenplay input verbatim (no `\\` injected),
// which keeps recorded aimock fixtures matching.
const HardBreakAsNewline = HardBreak.extend({
  addStorage() {
    const spec: MarkdownNodeSpec = {
      serialize(state, node, parent, index) {
        for (let i = index + 1; i < parent.childCount; i++) {
          if (parent.child(i).type !== node.type) {
            state.write('\n');
            return;
          }
        }
      },
    };
    return { markdown: spec };
  },
});

type MarkdownEditorProps = {
  value: string;
  onValueChange: (markdown: string) => void;
  /**
   * Fired when the user focuses the editor. Lets callers distinguish a genuine
   * user edit from the editor's own on-mount normalization emit (TipTap can
   * re-serialize the initial content — e.g. mention tagification — and fire
   * `onValueChange` before the user has touched anything).
   */
  onFocus?: () => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;
  onKeyDown?: (event: KeyboardEvent) => boolean | void;
  scrollRef?: React.Ref<HTMLDivElement | null>;
  id?: string;
  name?: string;
  'aria-label'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  'data-testid'?: string;
  /**
   * When provided, enables @-mention autocomplete. Tags found in the incoming
   * markdown (by canonical slug match against the items list) are rendered as
   * coloured pills via the Mention extension. Pass `undefined` (default) on
   * surfaces where mentions don't apply. Enablement is captured at editor
   * init — pass an (empty) array from the first render, not `undefined` that
   * later becomes a list, or the extension never registers.
   */
  mentionItems?: MentionItem[];
  /** Map the chosen @ row to the item to insert (see `createMentionSuggestion`). */
  onMentionSelect?: (item: MentionItem) => MentionItem;
  /** Imperative handle for streaming dictation in from a toolbar mic. */
  ref?: React.Ref<MarkdownEditorHandle>;
};

/**
 * Lets a `VoiceInputButton` rendered outside the editor stream a dictation
 * take into it. The take occupies one range that is rewritten on every interim
 * update, so revised words replace themselves instead of stacking up.
 */
export type MarkdownEditorHandle = {
  /** Anchor a take at the caret — or the end of the document if none is placed. */
  beginDictation: () => void;
  /** Rewrite the live take as `text`. */
  setDictation: (text: string) => void;
  /** Release the take's range; the text stays. */
  endDictation: () => void;
};

/** Marks our own dictation transactions so the range mapper skips them. */
const DICTATION_META = 'markdownEditorDictation';

const containerBaseClasses =
  'flex w-full min-h-16 rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40';

const disabledClasses =
  'cursor-not-allowed bg-input/50 opacity-50 dark:bg-input/80';

// 16px base below md (prose-sm only from md up): an editable surface under
// 16px makes iOS Safari auto-zoom on focus, and the zoomed page then pans
// left/right on every tap. Mirrors the container's `text-base md:text-sm`.
const proseClasses =
  'prose md:prose-sm dark:prose-invert max-w-none w-full flex-1 focus:outline-none [&_p]:my-0 [&_p+p]:mt-2 [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:mt-2 [&_h3]:mb-1 [&_ul]:my-1 [&_ol]:my-1 [&_blockquote]:my-1 [&_pre]:my-1';

const placeholderClasses =
  '[&_.is-editor-empty:first-child::before]:text-muted-foreground [&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:h-0 [&_.is-editor-empty:first-child::before]:pointer-events-none';

export const MarkdownEditor: React.FC<MarkdownEditorProps> = ({
  value,
  onValueChange,
  onFocus,
  placeholder,
  disabled = false,
  className,
  autoFocus = false,
  onKeyDown,
  scrollRef,
  id,
  name,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
  'data-testid': dataTestId,
  mentionItems,
  onMentionSelect,
  ref,
}) => {
  // useEditor captures props at init. Bag the live onKeyDown in a ref so the
  // handler reads the freshest callback without needing to recreate the editor.
  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;

  // Same ref pattern as onKeyDown — useEditor captures callbacks at init.
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;

  // The suggestion plugin fires on every `@` keystroke; the items it pulls
  // must reflect the parent's latest list (it grows as the user adds cast /
  // elements / locations to the sequence) even though the editor's extensions
  // are captured once at init. A ref synced every render gives us that.
  const mentionItemsRef = useRef<MentionItem[]>(mentionItems ?? []);
  mentionItemsRef.current = mentionItems ?? [];
  const hasMentions = mentionItems !== undefined;
  const onMentionSelectRef = useRef(onMentionSelect);
  onMentionSelectRef.current = onMentionSelect;

  // Signature changes when the set of available tags changes; drives the
  // "re-pill on items load" effect below.
  const mentionItemsKey = useMemo(
    () => (mentionItems ?? []).map((it) => it.tag).join('|'),
    [mentionItems]
  );

  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    autofocus: autoFocus,
    extensions: [
      StarterKit.configure({ hardBreak: false }),
      HardBreakAsNewline,
      Markdown.configure({
        // `html: true` is required for inline mention spans (produced by
        // `tagifyMarkdown`) to survive the markdown-it parse on `setContent`.
        // Tiptap's schema enforces that only nodes registered by the active
        // extensions (StarterKit's block/inline set plus `mention`) survive the
        // parse, so unrelated/raw HTML can't leak in.
        html: hasMentions,
        linkify: true,
        breaks: true,
        // Off: tiptap-markdown's clipboard parser uses `{ inline: true }`,
        // which drops multi-line paste. Default ProseMirror paste is enough.
        transformPastedText: false,
        transformCopiedText: true,
      }),
      Placeholder.configure({
        // Real HTML placeholder is rendered below so first paint (and LCP)
        // does not wait for TipTap to hydrate a ::before (#1182).
        placeholder: '',
        emptyEditorClass: 'is-editor-empty',
      }),
      // The Mention extension is generically typed for `MentionNodeAttrs`
      // (id, label), but our `section` attr is added via `addAttributes` —
      // structurally present, not visible in the configure() option types.
      // The ProseMirror schema is the actual enforcer at runtime.
      ...(hasMentions
        ? [
            PromptMention.configure({
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              suggestion: createMentionSuggestion(
                () => mentionItemsRef.current,
                () => onMentionSelectRef.current
              ) as MentionConfigure['suggestion'],
            }),
          ]
        : []),
    ],
    content: hasMentions
      ? tagifyMarkdown(value, mentionItemsRef.current).content
      : value,
    editorProps: {
      attributes: {
        ...(id ? { id } : {}),
        ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
        ...(name ? { 'data-name': name } : {}),
        class: cn(proseClasses, placeholderClasses),
      },
      handleKeyDown: (_view, event) => onKeyDownRef.current?.(event) === true,
      handleDOMEvents: {
        beforeinput: (view, event) => {
          if (!(event instanceof InputEvent)) return false;
          const newlineInput =
            event.inputType === 'insertLineBreak' ||
            event.inputType === 'insertParagraph';
          const data = newlineInput ? `\n${event.data ?? ''}` : event.data;
          if (
            (event.inputType !== 'insertText' &&
              event.inputType !== 'insertReplacementText' &&
              !newlineInput) ||
            !data?.includes('\n')
          ) {
            return false;
          }
          event.preventDefault();
          return insertTextWithNewlines(view, data);
        },
      },
      transformPastedText: (text) => normalizeScreenplayNewlines(text),
    },
    onUpdate: ({ editor: e }) => {
      onValueChange(e.storage.markdown.getMarkdown());
    },
    onFocus: () => onFocusRef.current?.(),
  });

  // Whether the user has put a caret in this editor since its content was
  // last replaced from outside. ProseMirror's initial selection sits at the
  // start of the document, so a dictated take must not land there just
  // because the user has never clicked in — it goes to the end instead.
  const caretPlacedRef = useRef(false);

  // Canonical Tiptap external-value sync (mirrors the Vue v-model example in
  // their docs): only setContent if the editor's current markdown differs
  // from the incoming value. When mentions are on, we tagify the value first
  // so bare slugs in the incoming string land as mention nodes.
  //
  // Defer the write to the next shot so a burst of value changes (LLM
  // streaming the script chunk-by-chunk) collapses to one setContent with
  // the latest value. Each setContent is a full markdown re-parse + doc
  // rebuild and freezes the renderer if applied per-chunk at ~30Hz+.
  useEffect(() => {
    if (!editor) return;
    if (editor.storage.markdown.getMarkdown() === value) return;
    const rafId = requestAnimationFrame(() => {
      if (editor.storage.markdown.getMarkdown() === value) return;
      const content = hasMentions
        ? tagifyMarkdown(value, mentionItemsRef.current).content
        : value;
      editor.commands.setContent(content, { emitUpdate: false });
      // A replaced document (enhance output, a loaded sample) leaves any old
      // caret position meaningless; dictation appends until the user clicks.
      if (!editor.isFocused) caretPlacedRef.current = false;
    });
    return () => cancelAnimationFrame(rafId);
  }, [editor, value, hasMentions]);

  // When the items list changes (e.g. characters/elements load async after
  // mount, or the user adds a new one to the sequence), re-tagify the current
  // value so existing bare slugs in the prompt light up as pills. The
  // value-sync effect above won't catch this on its own — the stored value
  // hasn't changed, so its `getMarkdown() === value` guard returns true.
  useEffect(() => {
    if (!editor || !hasMentions) return;
    const { content, matched } = tagifyMarkdown(value, mentionItemsRef.current);
    if (!matched) return;
    const rafId = requestAnimationFrame(() => {
      editor.commands.setContent(content, { emitUpdate: false });
    });
    return () => cancelAnimationFrame(rafId);
    // value intentionally omitted — the sibling effect handles value changes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, mentionItemsKey, hasMentions]);

  useEffect(() => {
    if (!editor) return;
    const placed = () => {
      if (editor.isFocused) caretPlacedRef.current = true;
    };
    editor.on('focus', placed);
    editor.on('selectionUpdate', placed);
    return () => {
      editor.off('focus', placed);
      editor.off('selectionUpdate', placed);
    };
  }, [editor]);

  // The range the live dictation take occupies, or null between takes.
  const dictationRef = useRef<{ from: number; to: number } | null>(null);

  // The user may keep typing (or an enhance may stream in) mid-take, so carry
  // the take's range through everyone else's transactions. Our own already
  // set the range explicitly.
  useEffect(() => {
    if (!editor) return;
    const remap = ({ transaction }: { transaction: Transaction }) => {
      const range = dictationRef.current;
      if (!range || !transaction.docChanged) return;
      if (transaction.getMeta(DICTATION_META)) return;
      dictationRef.current = {
        from: transaction.mapping.map(range.from),
        to: transaction.mapping.map(range.to),
      };
    };
    editor.on('transaction', remap);
    return () => {
      editor.off('transaction', remap);
    };
  }, [editor]);

  useImperativeHandle(
    ref,
    (): MarkdownEditorHandle => ({
      beginDictation: () => {
        if (!editor?.isEditable) return;
        const { view } = editor;
        const { tr } = view.state;
        // The caret survives the blur that clicking the mic causes, so the
        // take lands where the user left it — but an untouched editor's
        // selection sits at position 0, which is not where dictation belongs.
        if (!caretPlacedRef.current) tr.setSelection(Selection.atEnd(tr.doc));
        if (!tr.selection.empty) tr.deleteSelection();
        view.dispatch(tr.setMeta(DICTATION_META, true));
        const { from } = view.state.selection;
        dictationRef.current = { from, to: from };
      },
      setDictation: (text: string) => {
        const range = dictationRef.current;
        if (!editor?.isEditable || !range) return;
        const { view } = editor;
        const { doc, schema } = view.state;
        const preceding =
          range.from > 0
            ? doc.textBetween(range.from - 1, range.from, '\n')
            : '';
        const fragment = Fragment.fromArray(
          screenplayNodes(schema, spaceTranscript(preceding, text))
        );
        const tr = view.state.tr
          .replaceWith(range.from, range.to, fragment)
          .setMeta(DICTATION_META, true);
        // Dispatching emits onUpdate, so the new markdown reaches onValueChange.
        view.dispatch(tr.scrollIntoView());
        dictationRef.current = {
          from: range.from,
          to: range.from + fragment.size,
        };
      },
      endDictation: () => {
        dictationRef.current = null;
      },
    }),
    [editor]
  );

  // Emptiness must be transaction-reactive, not read off `editor` at render
  // time: the value-sync effects above apply external content (seeded sample
  // script, enhance output) with `emitUpdate: false` inside a rAF, which
  // re-renders nothing — a render-time `editor.isEmpty` then stays stale and
  // leaves the placeholder overlaid on the script (#1230).
  const editorIsEmpty = useEditorState({
    editor,
    selector: (ctx) => ctx.editor?.isEmpty ?? null,
  });

  // editable is captured at init; mirror prop changes through to the editor.
  useEffect(() => {
    if (!editor) return;
    if (editor.isEditable === !disabled) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  return (
    // Click-forwarder only: the editable ProseMirror surface inside carries
    // the interaction semantics, and this div must keep aria-invalid for its
    // error styling (so role="presentation" is not an option).
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={scrollRef}
      className={cn(
        containerBaseClasses,
        'relative',
        disabled && disabledClasses,
        // No overflow rule here: the editor grows with its content. A caller
        // that bounds its height (the composer's ScriptEditor) makes it the
        // scroller. Chrome stops wheel chaining at a scroll container with
        // overscroll-contain even when it has nothing to scroll, so an
        // unconditional `overflow-y-auto overscroll-contain` froze the panel
        // behind every prompt editor on desktop (#1281).
        className
      )}
      aria-invalid={ariaInvalid}
      data-testid={dataTestId}
      data-slot="markdown-editor"
      // Chrome auto-translate rewriting a contenteditable desyncs
      // ProseMirror's view (#1283); the script is the user's own text anyway.
      translate="no"
      data-markdown={value}
      // The ProseMirror node only spans its text, so the empty area below the
      // last line (the box's min-height) is otherwise a dead zone — clicking
      // it should place the caret at the end, like a textarea. Scrollbar
      // clicks (offsetX past clientWidth) must keep their native behaviour.
      onMouseDown={(e) => {
        if (!editor || disabled) return;
        if (e.target instanceof Element && e.target.closest('.ProseMirror')) {
          return;
        }
        if (e.nativeEvent.offsetX > e.currentTarget.clientWidth) return;
        e.preventDefault();
        editor.commands.focus('end');
      }}
    >
      {placeholder && (editorIsEmpty ?? !value) ? (
        <p className="pointer-events-none absolute inset-x-0 top-0 px-2.5 py-2 text-base text-muted-foreground md:text-sm">
          {placeholder}
        </p>
      ) : null}
      {/* First-paint stand-in for seeded content (#1187): the editor only
          renders after hydration (immediatelyRender: false), so a value
          present at mount — the composer's sample script — would otherwise
          pop in late and shift the page. Rendered in flow with the editor's
          prose typography so the swap to the live editor holds height. */}
      {!editor && value ? (
        <div className={cn(proseClasses, 'whitespace-pre-wrap')}>{value}</div>
      ) : null}
      {/* Hidden while the stand-in shows — the container is a flex row, so an
          empty pre-hydration EditorContent would otherwise share its width
          and double the stand-in's wrapped lines. */}
      <EditorContent
        editor={editor}
        className={cn('relative w-full', !editor && value && 'hidden')}
      />
    </div>
  );
};
