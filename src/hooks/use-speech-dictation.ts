/**
 * Live dictation for script, prompt, and other text fields.
 *
 * Wraps the browser's `SpeechRecognition` so text streams in while the user
 * speaks: `onTranscript` fires on every interim update with the take *so far*,
 * and the caller replaces whatever it rendered last time. OpenStory never
 * records or POSTs audio; the browser vendor's recogniser typically does.
 *
 * Chromium ends a recognition session on its own after a stretch of silence,
 * so a take spans several sessions — see `createDictationSession`.
 */

import {
  createDictationSession,
  DictationError,
  type DictationSession,
} from '@/lib/voice/dictation-session';
import {
  getSpeechRecognition,
  type SpeechRecognition,
} from '@/lib/voice/speech-recognition';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAsRef } from './use-as-ref';
import { useHydrated } from './use-hydrated';

export type DictationStatus = 'idle' | 'listening';
export { DictationError };

/**
 * A silent recogniser restarts indefinitely, so a forgotten open mic would
 * hold the browser's recording indicator forever. Bound one take to five
 * minutes.
 */
const MAX_DICTATION_MS = 5 * 60 * 1000;

export type UseSpeechDictationOptions = {
  /**
   * The take so far, on every interim update. Replaces the previous emission
   * rather than appending to it — interim words are revised as they settle.
   */
  onTranscript: (text: string) => void;
  /**
   * A take is starting; no transcript has been emitted for it yet.
   * Return `false` to abort before the recogniser starts (editor not ready).
   */
  onStart?: () => boolean | void;
  /** The take ended. The last `onTranscript` text stands. */
  onEnd?: () => void;
  onError?: (error: DictationError) => void;
  /** BCP-47 tag. Omitted = the browser's own language. */
  language?: string;
  maxDurationMs?: number;
};

export function useSpeechDictation({
  onTranscript,
  onStart,
  onEnd,
  onError,
  language,
  maxDurationMs = MAX_DICTATION_MS,
}: UseSpeechDictationOptions) {
  const hydrated = useHydrated();
  const [status, setStatus] = useState<DictationStatus>('idle');
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const onTranscriptRef = useAsRef(onTranscript);
  const onStartRef = useAsRef(onStart);
  const onEndRef = useAsRef(onEnd);
  const onErrorRef = useAsRef(onError);
  const languageRef = useAsRef(language);

  const sessionRef = useRef<DictationSession | null>(null);
  const listeningRef = useRef(false);

  const finish = useCallback(() => {
    const wasLive = listeningRef.current || sessionRef.current !== null;
    listeningRef.current = false;
    sessionRef.current = null;
    setStatus('idle');
    setStartedAt(null);
    if (wasLive) onEndRef.current?.();
  }, [onEndRef]);

  const stop = useCallback(() => {
    if (!listeningRef.current) return;
    // Keep the phrase in flight; `onend` then runs `finish`. If `stop()`
    // throws (engine already inactive), the session calls `onEnd` itself.
    sessionRef.current?.stop();
  }, []);

  const abort = useCallback(() => {
    if (!listeningRef.current) return;
    const session = sessionRef.current;
    // Drop `dictationActive` now — do not wait for `onend`, or enhance /
    // a shot switch stays locked behind the setContent skip.
    finish();
    session?.abort();
  }, [finish]);

  const start = useCallback(() => {
    const SpeechRecognitionCtor = getSpeechRecognition();
    if (!SpeechRecognitionCtor || listeningRef.current) return;

    // Anchor the target before opening the mic so a missing editor does not
    // leave the recording indicator on with nowhere to put the words.
    if (onStartRef.current?.() === false) {
      onErrorRef.current?.(new DictationError('start-failed'));
      return;
    }

    const recognition: SpeechRecognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    const lang = languageRef.current;
    if (lang) recognition.lang = lang;

    const session = createDictationSession(
      {
        start: () => recognition.start(),
        stop: () => recognition.stop(),
        abort: () => recognition.abort(),
      },
      {
        onTranscript: (text) => onTranscriptRef.current(text),
        onError: (error) => onErrorRef.current?.(error),
        onEnd: finish,
      }
    );
    recognition.onresult = (event) => session.feedResults(event.results);
    recognition.onerror = (event) => session.feedError(event.error);
    recognition.onend = () => session.feedEnd();

    sessionRef.current = session;
    if (!session.start()) {
      // failStart already fired `onError` and `onEnd` (`finish`).
      return;
    }
    listeningRef.current = true;
    setStatus('listening');
    setStartedAt(Date.now());
  }, [finish, languageRef, onErrorRef, onStartRef, onTranscriptRef]);

  // Release the mic if the surface unmounts mid-take.
  useEffect(
    () => () => {
      listeningRef.current = false;
      sessionRef.current?.abort();
    },
    []
  );

  useEffect(() => {
    if (status !== 'listening') return;
    const timer = setTimeout(stop, maxDurationMs);
    return () => clearTimeout(timer);
  }, [status, maxDurationMs, stop]);

  const toggle = useCallback(() => {
    if (status === 'listening') stop();
    else start();
  }, [status, start, stop]);

  return {
    status,
    /** False during SSR/hydration and in browsers without the Web Speech API. */
    isSupported: hydrated && getSpeechRecognition() !== undefined,
    /** Epoch ms the current take began, for an elapsed-time readout. */
    startedAt,
    start,
    stop,
    abort,
    toggle,
  };
}
