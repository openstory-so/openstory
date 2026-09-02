/**
 * One SpeechRecognition take: fold finals across Chromium silence-restarts,
 * surface real errors, and restart until the user stops.
 *
 * OpenStory never records or POSTs audio. The browser vendor's recogniser
 * typically does (Chromium → Google, Safari → Apple), which is why a
 * `network` error exists and why `start()` can throw.
 */

import {
  joinSpeech,
  splitResults,
  type RecognitionResults,
} from './speech-recognition';

type DictationErrorCode =
  | Exclude<SpeechRecognitionErrorCode, 'no-speech'>
  | 'start-failed';

/** A recogniser failure the caller should surface. `no-speech` never gets here. */
export class DictationError extends Error {
  constructor(readonly code: DictationErrorCode) {
    super(DICTATION_ERROR_MESSAGES[code]);
    this.name = 'DictationError';
  }
}

const DICTATION_ERROR_MESSAGES: Record<DictationErrorCode, string> = {
  aborted: 'Dictation stopped.',
  'audio-capture': 'No microphone was found.',
  'language-not-supported': 'Dictation is not available in this language.',
  network: 'Dictation needs a network connection.',
  'not-allowed': 'Microphone access is blocked.',
  'phrases-not-supported': 'Dictation is not available in this browser.',
  'service-not-allowed': 'Microphone access is blocked.',
  'start-failed': 'Dictation could not start. Try again.',
};

type DictationSessionCallbacks = {
  onTranscript: (text: string) => void;
  onError: (error: DictationError) => void;
  onEnd: () => void;
};

type RecognitionControls = {
  start: () => void;
  stop: () => void;
  abort: () => void;
};

export type DictationSession = {
  /** Feed a `result` event. */
  feedResults: (results: RecognitionResults) => void;
  /** Feed an `error` event. */
  feedError: (error: SpeechRecognitionErrorCode) => void;
  /** Feed an `end` event. */
  feedEnd: () => void;
  start: () => boolean;
  stop: () => void;
  abort: () => void;
};

/**
 * Drive one take from recogniser events. `scheduleRestart` defaults to
 * `queueMicrotask` so Chromium's `end` → `start()` race (InvalidStateError)
 * is not hit on the same turn.
 */
export function createDictationSession(
  recognition: RecognitionControls,
  callbacks: DictationSessionCallbacks,
  scheduleRestart: (restart: () => void) => void = queueMicrotask
): DictationSession {
  let listening = false;
  let aborting = false;
  let committed = '';
  let sessionFinal = '';

  const tryStart = (): boolean => {
    try {
      recognition.start();
      return true;
    } catch {
      return false;
    }
  };

  const failStart = (): false => {
    listening = false;
    callbacks.onError(new DictationError('start-failed'));
    callbacks.onEnd();
    return false;
  };

  const feedResults = (results: RecognitionResults) => {
    const { final, interim } = splitResults(results);
    sessionFinal = final;
    callbacks.onTranscript(joinSpeech(committed, final, interim));
  };

  const feedError = (error: SpeechRecognitionErrorCode) => {
    // Silence is not a failure: `feedEnd` restarts the recogniser after it.
    if (error === 'no-speech') return;
    listening = false;
    // `aborted` from our own `abort()` (unmount) is not a user-facing error.
    // The UA also fires `aborted` when another recogniser starts or the tab
    // is backgrounded — those we toast.
    if (error === 'aborted' && aborting) return;
    callbacks.onError(new DictationError(error));
  };

  const feedEnd = () => {
    committed = joinSpeech(committed, sessionFinal);
    sessionFinal = '';
    if (!listening) {
      callbacks.onEnd();
      return;
    }
    // Chromium ends the session after a stretch of silence — pick it back up
    // on a later turn so `start()` is not called while the engine is stopping.
    scheduleRestart(() => {
      if (!listening) return;
      if (!tryStart()) failStart();
    });
  };

  return {
    feedResults,
    feedError,
    feedEnd,
    start: () => {
      if (listening) return true;
      committed = '';
      sessionFinal = '';
      aborting = false;
      listening = true;
      if (!tryStart()) return failStart();
      return true;
    },
    stop: () => {
      if (!listening) return;
      listening = false;
      recognition.stop();
    },
    abort: () => {
      listening = false;
      aborting = true;
      recognition.abort();
    },
  };
}
