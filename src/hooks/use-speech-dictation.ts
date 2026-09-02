/**
 * Live dictation for the script and prompt editors.
 *
 * Wraps the browser's `SpeechRecognition` so text streams in while the user
 * speaks: `onTranscript` fires on every interim update with the take *so far*,
 * and the caller replaces whatever it rendered last time. Nothing is recorded
 * and nothing is uploaded by us — the browser owns the mic and the recogniser.
 *
 * Chromium ends a recognition session on its own after a stretch of silence,
 * so a take spans several sessions: finals are folded into `committedRef` as
 * each one ends and the recogniser is restarted until the user stops.
 */

import {
  getSpeechRecognition,
  joinSpeech,
  splitResults,
  type SpeechRecognition,
} from '@/lib/voice/speech-recognition';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAsRef } from './use-as-ref';
import { useHydrated } from './use-hydrated';

export type DictationStatus = 'idle' | 'listening';

/** A recogniser failure the caller should surface. `no-speech` never gets here. */
export class DictationError extends Error {
  constructor(readonly code: SpeechRecognitionErrorCode) {
    super(DICTATION_ERROR_MESSAGES[code]);
    this.name = 'DictationError';
  }
}

const DICTATION_ERROR_MESSAGES: Record<SpeechRecognitionErrorCode, string> = {
  aborted: 'Dictation stopped.',
  'audio-capture': 'No microphone was found.',
  'language-not-supported': 'Dictation is not available in this language.',
  network: 'Dictation needs a network connection.',
  'no-speech': 'No speech detected.',
  'not-allowed': 'Microphone access is blocked.',
  'phrases-not-supported': 'Dictation is not available in this browser.',
  'service-not-allowed': 'Microphone access is blocked.',
};

/**
 * A silent recogniser restarts indefinitely, so a forgotten open mic would
 * hold the browser's recording indicator forever. Bound one take.
 */
const MAX_DICTATION_MS = 5 * 60 * 1000;

export type UseSpeechDictationOptions = {
  /**
   * The take so far, on every interim update. Replaces the previous emission
   * rather than appending to it — interim words are revised as they settle.
   */
  onTranscript: (text: string) => void;
  /** A take is starting; no transcript has been emitted for it yet. */
  onStart?: () => void;
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

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  /** Finals from earlier recognition sessions within the current take. */
  const committedRef = useRef('');
  /** Finals from the session that is running now, folded in when it ends. */
  const sessionFinalRef = useRef('');
  /** The user wants to keep dictating — drives the restart in `end`. */
  const listeningRef = useRef(false);

  const finish = useCallback(() => {
    listeningRef.current = false;
    setStatus('idle');
    setStartedAt(null);
    onEndRef.current?.();
  }, [onEndRef]);

  const stop = useCallback(() => {
    if (!listeningRef.current) return;
    listeningRef.current = false;
    // `stop` keeps the phrase in flight; `end` then runs `finish`.
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const SpeechRecognitionCtor = getSpeechRecognition();
    if (!SpeechRecognitionCtor || listeningRef.current) return;

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    const lang = languageRef.current;
    if (lang) recognition.lang = lang;

    recognition.onresult = (event) => {
      const { final, interim } = splitResults(event.results);
      sessionFinalRef.current = final;
      onTranscriptRef.current(joinSpeech(committedRef.current, final, interim));
    };

    recognition.onerror = (event) => {
      // Silence is not a failure: `end` restarts the recogniser after it.
      if (event.error === 'no-speech') return;
      listeningRef.current = false;
      // 'aborted' is our own `abort()` from cancel/unmount.
      if (event.error !== 'aborted') {
        onErrorRef.current?.(new DictationError(event.error));
      }
    };

    recognition.onend = () => {
      committedRef.current = joinSpeech(
        committedRef.current,
        sessionFinalRef.current
      );
      sessionFinalRef.current = '';
      if (!listeningRef.current) {
        recognitionRef.current = null;
        finish();
        return;
      }
      // Chromium ends the session after a stretch of silence — pick it back up.
      recognition.start();
    };

    recognitionRef.current = recognition;
    committedRef.current = '';
    sessionFinalRef.current = '';
    listeningRef.current = true;
    recognition.start();
    setStatus('listening');
    setStartedAt(Date.now());
    onStartRef.current?.();
  }, [finish, languageRef, onErrorRef, onStartRef, onTranscriptRef]);

  // Release the mic if the surface unmounts mid-take.
  useEffect(
    () => () => {
      listeningRef.current = false;
      recognitionRef.current?.abort();
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
    toggle,
  };
}
