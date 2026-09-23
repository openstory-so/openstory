/**
 * Did a Seed take say the script, and where (#1765)?
 *
 * Seed Audio sometimes speaks invented words: 5–15 s of plausible nonsense
 * before the script, or a burst mid-read, most often where a reference
 * changes. So every take is transcribed and compared here. Nonsense BEFORE
 * the script is trimmed off (`scriptStartSeconds`); anything else fails the
 * take and it is recorded again.
 *
 * Matching is loose on purpose: a broad accent is transcribed as a
 * neighbouring word ("rights" for "rates"), and a transcript spells
 * "runnin'" as "running".
 */

import type { HeardWord } from './elevenlabs-voice';

const normWords = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

const loose = (a: string, b: string): boolean =>
  a === b ||
  (a.length >= 3 && b.length >= 3 && a.slice(0, 3) === b.slice(0, 3)) ||
  levenshtein(a, b) <= 1;

type Heard = HeardWord & { n: string };

const heardWords = (words: readonly HeardWord[]): Heard[] =>
  words.flatMap((word) => normWords(word.text).map((n) => ({ ...word, n })));

/** First heard index at or after `from` that starts `want` in order. */
function runAt(got: readonly Heard[], want: readonly string[], from: number) {
  for (let i = from; i < got.length; i++) {
    if (
      want.every((w, k) => {
        const heard = got[i + k];
        return heard !== undefined && loose(heard.n, w);
      })
    ) {
      return i;
    }
  }
  return -1;
}

export type TakeCheck = {
  ok: boolean;
  /** Heard words before the script's first words. */
  extraBefore: number;
  /** Where the script starts, seconds — trim before it. */
  scriptStartSeconds: number | undefined;
  /** Heard words that match nothing in the script. */
  extraText: string;
  /** Script words never heard. */
  missing: string[];
};

/**
 * `ok`: nothing before the script, and at most one stray or missing word per
 * 30 (a mishearing, not an insertion).
 */
export function checkTake(
  script: string,
  heard: readonly HeardWord[]
): TakeCheck {
  const want = normWords(script);
  const got = heardWords(heard);
  const heardJoined = got.map((g) => g.n).join('');
  const wantJoined = want.join('');
  // Compounds: "blowout" heard for "blow out", and the reverse.
  const missing = want.filter(
    (w) => !got.some((g) => loose(g.n, w)) && !heardJoined.includes(w)
  );
  const extra = got.filter(
    (g) => !want.some((w) => loose(g.n, w)) && !wantJoined.includes(g.n)
  );
  // Three in a row, not two: a lead-in can open with the script's own words.
  const start = runAt(got, want.slice(0, Math.min(3, want.length)), 0);
  const extraBefore = start < 0 ? got.length : start;
  // Nonsense before the script is trimmable, so it does not count against
  // the take here — the caller decides whether it trims or retakes.
  const extraAfterStart = extra.filter((g) => got.indexOf(g) >= start);
  const allow = 1 + Math.floor(want.length / 30);
  return {
    ok:
      start >= 0 && extraAfterStart.length <= allow && missing.length <= allow,
    extraBefore,
    scriptStartSeconds: got[start]?.start,
    extraText: extra.map((g) => g.text).join(' '),
    missing,
  };
}

/**
 * Where each part of a script was spoken, in order: from its first words to
 * its last words, each part searched for after the previous one ended.
 * `undefined` for a part that cannot be found — the take is unusable.
 */
export function locateParts(
  heard: readonly HeardWord[],
  parts: readonly string[]
): Array<{ start: number; end: number } | undefined> {
  const got = heardWords(heard);
  let from = 0;
  return parts.map((part) => {
    const want = normWords(part);
    if (want.length === 0) return undefined;
    const head = want.slice(0, Math.min(3, want.length));
    const tail = want.slice(-Math.min(3, want.length));
    const i = runAt(got, head, from);
    const j = i < 0 ? -1 : runAt(got, tail, i);
    const first = got[i];
    const last = got[j + tail.length - 1];
    if (j < 0 || !first || !last) return undefined;
    from = j + tail.length;
    return { start: first.start, end: last.end };
  });
}

function levenshtein(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next.push(
        Math.min(
          (row[j] ?? 0) + 1,
          (next[j - 1] ?? 0) + 1,
          (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
        )
      );
    }
    row = next;
  }
  return row[b.length] ?? 0;
}
