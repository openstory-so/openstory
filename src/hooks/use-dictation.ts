/**
 * Wiring between a toolbar `VoiceInputButton` and the field it dictates into.
 *
 * Shared contract is take-rewrite: the mic re-emits the whole take on every
 * interim update. The editor inserts at a live ProseMirror range (other
 * keystrokes are remapped); a textarea freezes a prefix on start and rebuilds
 * `prefix + take` (keystrokes during the take are overwritten).
 */

import type { MarkdownEditorHandle } from '@/components/text-editor/markdown-editor';
import { appendTranscript } from '@/lib/voice/transcript-insert';
import { useMemo, useRef } from 'react';
import { useAsRef } from './use-as-ref';

/**
 * Dictate into a `MarkdownEditor`. Spread `voice` onto the button and put
 * `ref` on the editor; the take lands at the caret if one was placed, else
 * at the end of the document. Returns `false` from `onStart` when the editor
 * is not ready so the mic does not open.
 */
export function useEditorDictation() {
  const ref = useRef<MarkdownEditorHandle>(null);
  const voice = useMemo(
    () => ({
      onStart: () => ref.current?.beginDictation() ?? false,
      onTranscript: (text: string) => ref.current?.setDictation(text),
      onEnd: () => ref.current?.endDictation(),
    }),
    []
  );
  return { ref, voice };
}

/**
 * Dictate into a controlled text field (a `Textarea`, a schema-form widget).
 * The take is appended to whatever the value was when the mic started.
 */
export function useTextDictation(
  value: string,
  onChange: (next: string) => void
) {
  const valueRef = useAsRef(value);
  const onChangeRef = useAsRef(onChange);
  const baseRef = useRef('');
  return useMemo(
    () => ({
      onStart: () => {
        baseRef.current = valueRef.current;
      },
      onTranscript: (text: string) =>
        onChangeRef.current(appendTranscript(baseRef.current, text)),
    }),
    [onChangeRef, valueRef]
  );
}
