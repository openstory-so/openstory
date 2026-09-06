/**
 * Pure helpers for splicing a dictated transcript into existing text. Used by
 * the MarkdownEditor (caret-aware insert) and the plain textarea surfaces
 * (append), so both join a new take onto old text the same way.
 */

/** Punctuation that attaches to the preceding word — never space before it. */
const ATTACHES_TO_PREVIOUS = /^[,.;:!?)\]}]/;

/**
 * The transcript, prefixed with a single space when it would otherwise run
 * straight into the character before the caret. No space after whitespace, a
 * newline, an empty document, or when the transcript itself opens with
 * attaching punctuation.
 */
export function spaceTranscript(preceding: string, transcript: string): string {
  const text = transcript.trim();
  if (!text) return '';
  const last = preceding.at(-1);
  if (last === undefined || /\s/.test(last)) return text;
  if (ATTACHES_TO_PREVIOUS.test(text)) return text;
  return ` ${text}`;
}

/** Append a take to a textarea's current value. */
export function appendTranscript(existing: string, transcript: string): string {
  return existing + spaceTranscript(existing, transcript);
}
