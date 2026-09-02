/**
 * Wiring between a toolbar `VoiceInputButton` and the field it dictates into.
 *
 * Both bindings work the same way: the mic re-emits the whole take on every
 * interim update, so each one rewrites the take's text in place rather than
 * appending — that is what lets the recogniser revise words as they settle.
 */

import type { MarkdownEditorHandle } from '@/components/text-editor/markdown-editor';
import { appendTranscript } from '@/lib/voice/transcript-insert';
import { useMemo, useRef } from 'react';
import { useAsRef } from './use-as-ref';

/**
 * Dictate into a `MarkdownEditor`. Spread `voice` onto the button and put
 * `ref` on the editor; the take lands at the caret the user last placed.
 */
export function useEditorDictation() {
  const ref = useRef<MarkdownEditorHandle>(null);
  const voice = useMemo(
    () => ({
      onStart: () => ref.current?.beginDictation(),
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
