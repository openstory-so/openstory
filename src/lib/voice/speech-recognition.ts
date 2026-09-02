/**
 * Typed access to the Web Speech API's `SpeechRecognition`.
 *
 * `lib.dom` ships the event and result types but not the constructor — it is
 * still vendor-prefixed in Chromium (`webkitSpeechRecognition`) and absent in
 * Firefox — so the interface and the two globals are declared here rather
 * than reached through a cast.
 */

export interface SpeechRecognition extends EventTarget {
  /** BCP-47 tag. Unset means the document/browser language. */
  lang: string;
  /** Keep recognising past the first phrase instead of stopping. */
  continuous: boolean;
  /** Emit unstable partial results, which is what makes dictation stream. */
  interimResults: boolean;
  maxAlternatives: number;
  onresult:
    | ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void)
    | null;
  onerror:
    | ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void)
    | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  start(): void;
  /** Finish the current phrase, then fire `end`. */
  stop(): void;
  /** Drop the current phrase without a final result, then fire `end`. */
  abort(): void;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

/** The constructor for this browser, or undefined where the API is absent. */
export function getSpeechRecognition():
  | SpeechRecognitionConstructor
  | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition;
}

/**
 * The slice of `SpeechRecognitionResultList` that `splitResults` reads. Spelled
 * structurally so a test can hand it plain objects — the DOM type satisfies it.
 */
export type RecognitionResults = ArrayLike<
  ArrayLike<{ readonly transcript: string }> & { readonly isFinal: boolean }
>;

/**
 * The final and still-unstable halves of a recognition session. The API hands
 * back every result for the session on each event, so both are rebuilt from
 * scratch rather than accumulated.
 */
export function splitResults(results: RecognitionResults): {
  final: string;
  interim: string;
} {
  let final = '';
  let interim = '';
  for (let i = 0; i < results.length; i++) {
    const alternative = results[i]?.[0];
    if (!alternative) continue;
    if (results[i]?.isFinal) final += alternative.transcript;
    else interim += alternative.transcript;
  }
  return { final, interim };
}

/** Join transcript fragments with exactly one space between them. */
export function joinSpeech(...parts: Array<string>): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
}
