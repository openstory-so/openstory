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
 * neighbouring word ("rights" for "rates"), a transcript spells "runnin'" as
 * "running", writes "15" for "fifteen" and "all right" for "alright" (#1803).
 */

import type { HeardWord } from './elevenlabs-voice';

/** Room kept before a heard word, so a cut never opens on it. */
export const WORD_LEAD_SECONDS = 0.15;

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];

/** "1985" → "one thousand nine hundred eighty five". */
function numberWords(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  if (n < 100) {
    return `${TENS[Math.floor(n / 10)]} ${n % 10 ? ONES[n % 10] : ''}`;
  }
  for (const [size, name] of [
    [1_000_000, 'million'],
    [1000, 'thousand'],
    [100, 'hundred'],
  ] as const) {
    if (n >= size) {
      const rest = n % size;
      return `${numberWords(Math.floor(n / size))} ${name} ${rest ? numberWords(rest) : ''}`;
    }
  }
  return '';
}

/** One spelling for what a transcript and a script write differently. */
const SAME_WORDS: Record<string, string> = {
  alright: 'all right',
  ok: 'okay',
  percent: 'per cent',
};

const normWords = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/(\d),(?=\d{3})/g, '$1')
    .replace(/%/g, ' percent ')
    .replace(/\d{1,9}/g, (digits) => ` ${numberWords(Number(digits))} `)
    .replace(/[^a-z ]/g, ' ')
    .split(/\s+/)
    .flatMap((word) => (SAME_WORDS[word] ?? word).split(' '))
    .filter(Boolean);

const loose = (a: string, b: string): boolean =>
  a === b ||
  (a.length >= 3 && b.length >= 3 && a.slice(0, 3) === b.slice(0, 3)) ||
  levenshtein(a, b) <= 1;

type Heard = HeardWord & { n: string };

const heardWords = (words: readonly HeardWord[]): Heard[] =>
  words.flatMap((word) => normWords(word.text).map((n) => ({ ...word, n })));

/**
 * First heard index at or after `from` that starts `want` in order, with at
 * most `misses` of its words heard as something else.
 */
function runAt(
  got: readonly Heard[],
  want: readonly string[],
  from: number,
  misses = 0
) {
  for (let i = from; i + want.length <= got.length; i++) {
    const missed = want.filter((w, k) => {
      const heard = got[i + k];
      return heard === undefined || !loose(heard.n, w);
    }).length;
    if (missed <= misses) return i;
  }
  return -1;
}

export type TakeCheck = {
  ok: boolean;
  /** Where the script starts, seconds — trim before it. */
  scriptStartSeconds: number | undefined;
  /** Heard words that match nothing in the script. */
  extraText: string;
  /** Script words never heard. */
  missing: string[];
};

/** Invented words come in bursts; a mishearing is one word at a time. */
const BURST_WORDS = 3;

/**
 * `ok`: the script is found, no burst of {@link BURST_WORDS} or more heard
 * words that match nothing in it after it starts (#1803: stray single words
 * are transcription, not nonsense), and at most one missing word per 10.
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
  const isExtra = got.map(
    (g) => !want.some((w) => loose(g.n, w)) && !wantJoined.includes(g.n)
  );
  // Three in a row, not two: a lead-in can open with the script's own words.
  // Exact first; one misheard word only if that finds nothing.
  const head = want.slice(0, Math.min(3, want.length));
  const exact = runAt(got, head, 0);
  const start = exact >= 0 || head.length < 3 ? exact : runAt(got, head, 0, 1);
  // Nonsense before the script is trimmable, so it does not count against
  // the take here — the caller decides whether it trims or retakes.
  let run = 0;
  let burst = false;
  for (let i = Math.max(start, 0); i < got.length; i++) {
    run = isExtra[i] ? run + 1 : 0;
    if (run >= BURST_WORDS) burst = true;
  }
  const allow = 1 + Math.floor(want.length / 10);
  return {
    ok: start >= 0 && !burst && missing.length <= allow,
    scriptStartSeconds: got[start]?.start,
    extraText: got
      .filter((_, i) => isExtra[i])
      .map((g) => g.text)
      .join(' '),
    missing,
  };
}

type Span = { start: number; end: number };

/**
 * Where each part of a script was spoken, in order: from its first words to
 * its last words, each part searched for after the previous one ended.
 * `undefined` for a part that cannot be found — the take is unusable.
 */
export function locateParts(
  heard: readonly HeardWord[],
  parts: readonly string[]
): Array<Span | undefined> {
  const got = heardWords(heard);
  let from = 0;
  return parts.map((part) => {
    const want = normWords(part);
    if (want.length === 0) return undefined;
    const head = want.slice(0, Math.min(3, want.length));
    const tail = want.slice(-Math.min(3, want.length));
    // A three-word end may have one word misheard; a shorter one may not.
    const misses = head.length === 3 ? 1 : 0;
    const i = runAt(got, head, from, misses);
    const j = i < 0 ? -1 : runAt(got, tail, i, misses);
    const first = got[i];
    const last = got[j + tail.length - 1];
    if (j < 0 || !first || !last) return undefined;
    from = j + tail.length;
    return { start: first.start, end: last.end };
  });
}

export type PartsCheck =
  | { ok: true; spans: Span[]; scriptStartSeconds: number | undefined }
  | { ok: false; problem: string };

/**
 * Did a take say `parts`, in order, and where is each? The parts are checked
 * as one script (`checkTake`), then located (`locateParts`).
 */
export function checkParts(
  heard: readonly HeardWord[],
  parts: readonly string[]
): PartsCheck {
  const check = checkTake(parts.join(' '), heard);
  const located = locateParts(heard, parts);
  const spans = located.filter((span): span is Span => span !== undefined);
  if (check.ok && spans.length === parts.length) {
    return { ok: true, spans, scriptStartSeconds: check.scriptStartSeconds };
  }
  const lost = located.findIndex((span) => span === undefined);
  const problem =
    [
      check.extraText && `heard "${check.extraText.slice(0, 120)}"`,
      check.missing.length > 0 &&
        `missing ${check.missing.slice(0, 8).join(' ')}`,
      lost >= 0 &&
        `line ${lost + 1} ("${parts[lost]?.slice(0, 60)}") not found in order`,
    ]
      .filter(Boolean)
      .join('; ') || 'the take did not match the lines';
  return { ok: false, problem };
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
