/**
 * Where was each line of a Seed take spoken (#1765, #1803)?
 *
 * Seed returns one file for the whole script, so the take is transcribed and
 * each line is found in what was heard. Lines are compared as LETTERS, not
 * words: a transcript writes "before you rent" for "BeforeYouRent", "all
 * right" for "alright", "B.Y.R." for "BYR", and letters make those the same
 * string. What still differs ("15" for "fifteen", "rights" for "rates") is a
 * few letters in a line, so a line is found when most of its letters are.
 *
 * The script is aligned against the transcript in order, with free text
 * before and after it: whatever Seed says before the script is cut off, and
 * whatever it says between lines is left out of both of them.
 */

import type { HeardWord } from './elevenlabs-voice';

/** Room kept before a heard word, so a cut never opens on it. */
export const WORD_LEAD_SECONDS = 0.15;

/**
 * Share of a line's letters that must be heard for the line to be found. Low
 * on purpose: "fifteen" heard as "15" is 7 letters of a short line. It only
 * has to tell a line that was said from one that was not.
 */
const LINE_FOUND_SCORE = 0.5;

/**
 * Alignment costs. A wrong or dropped script letter costs 10. Skipping heard
 * letters costs 20 to start and 1 a letter after that, so a burst of extra
 * speech between lines costs about two wrong letters, far less than dropping
 * a line to get past it.
 */
const WRONG = 10;
const DROP = 10;
const SKIP_OPEN = 20;
const SKIP_EXTEND = 1;

const letters = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]/g, '');

type Span = { start: number; end: number };

export type PartsCheck =
  | { ok: true; spans: Span[]; scriptStartSeconds: number }
  | { ok: false; problem: string };

/**
 * Did a take say `parts`, in order, and where is each? Every part must have
 * {@link LINE_FOUND_SCORE} of its letters heard, in order.
 */
export function checkParts(
  heard: readonly HeardWord[],
  parts: readonly string[]
): PartsCheck {
  // The transcript as letters, each knowing which heard word it came from.
  let got = '';
  const wordOf: number[] = [];
  heard.forEach((word, w) => {
    const l = letters(word.text);
    got += l;
    for (let k = 0; k < l.length; k++) wordOf.push(w);
  });
  const lines = parts.map(letters);
  const want = lines.join('');
  const lineOf: number[] = lines.flatMap((line, i) =>
    Array.from({ length: line.length }, () => i)
  );

  // Alignment with affine skips (Gotoh): `on` holds the best cost of a
  // cell whose last move placed a script letter, `off` of one whose last
  // move skipped a heard letter. Heard letters before the script and after
  // it are free.
  const rows = want.length + 1;
  const cols = got.length + 1;
  // Per cell: how `on` was reached (bit 0: dropped a script letter rather
  // than placing it on a heard one; bit 1: from `off`) and how `off` was
  // (bit 2: from `off`).
  const how = new Uint8Array(rows * cols);
  let prevOn = new Uint32Array(cols);
  let prevOff = new Uint32Array(cols);
  for (let i = 1; i < rows; i++) {
    const on = new Uint32Array(cols);
    const off = new Uint32Array(cols).fill(0xffffffff);
    on[0] = i * DROP;
    how[i * cols] = 1;
    for (let j = 1; j < cols; j++) {
      const skipFromOn = (on[j - 1] ?? 0) + SKIP_OPEN;
      const skipFromOff = (off[j - 1] ?? 0) + SKIP_EXTEND;
      off[j] = Math.min(skipFromOn, skipFromOff);
      let bits = skipFromOff < skipFromOn ? 4 : 0;

      const diagOn = prevOn[j - 1] ?? 0;
      const diagOff = prevOff[j - 1] ?? 0;
      const diag =
        Math.min(diagOn, diagOff) + (want[i - 1] === got[j - 1] ? 0 : WRONG);
      const upOn = prevOn[j] ?? 0;
      const upOff = prevOff[j] ?? 0;
      const up = Math.min(upOn, upOff) + DROP;
      if (up < diag) {
        on[j] = up;
        bits |= 1 | (upOff < upOn ? 2 : 0);
      } else {
        on[j] = diag;
        bits |= diagOff < diagOn ? 2 : 0;
      }
      how[i * cols + j] = bits;
    }
    prevOn = on;
    prevOff = off;
  }
  let j = 0;
  for (let k = 0; k < cols; k++) {
    const best = Math.min(prevOn[k] ?? 0, prevOff[k] ?? 0);
    if (best < Math.min(prevOn[j] ?? 0, prevOff[j] ?? 0)) j = k;
  }
  let inOff = (prevOff[j] ?? 0) < (prevOn[j] ?? 0);

  // Walk back, keeping for each line the heard letters that matched it.
  const matched = lines.map(() => 0);
  const first: Array<number | undefined> = lines.map(() => undefined);
  const last: Array<number | undefined> = lines.map(() => undefined);
  for (let i = want.length; i > 0 && j >= 0;) {
    const bits = how[i * cols + j] ?? 0;
    if (inOff) {
      inOff = (bits & 4) !== 0;
      j--;
      continue;
    }
    inOff = (bits & 2) !== 0;
    if (bits & 1) {
      i--;
      continue;
    }
    if (want[i - 1] === got[j - 1]) {
      const line = lineOf[i - 1] ?? 0;
      matched[line] = (matched[line] ?? 0) + 1;
      first[line] = j - 1;
      last[line] ??= j - 1;
    }
    i--;
    j--;
  }

  const spans: Span[] = [];
  for (const [i, line] of lines.entries()) {
    const from = first[i];
    const to = last[i];
    const score = line.length === 0 ? 0 : (matched[i] ?? 0) / line.length;
    const startWord =
      from === undefined ? undefined : heard[wordOf[from] ?? -1];
    const endWord = to === undefined ? undefined : heard[wordOf[to] ?? -1];
    if (score < LINE_FOUND_SCORE || !startWord || !endWord) {
      return {
        ok: false,
        problem: `line ${i + 1} ("${parts[i]?.slice(0, 60)}") was not heard (${Math.round(score * 100)}% of it matched)`,
      };
    }
    spans.push({ start: startWord.start, end: endWord.end });
  }
  return { ok: true, spans, scriptStartSeconds: spans[0]?.start ?? 0 };
}
