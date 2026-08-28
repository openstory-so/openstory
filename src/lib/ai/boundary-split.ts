/**
 * Boundary-annotation scene split (#1035): pure anchor resolution + slicing.
 *
 * The scenes LLM call never authors script text. It returns boundary
 * annotations — `{ hintLine, quote }` per scene — against a script we sent
 * with a numbered line gutter. This module resolves each quote to a raw
 * character offset with a monotonic cursor and slices the ORIGINAL script
 * into adjacent substrings, so scene extracts are byte-verbatim by
 * construction: `concat(slices) === script`, gaps/overlaps impossible.
 *
 * Resolution ladder per boundary (each rung past the first counts as a
 * "repair"): exact substring search → normalization-tolerant compare
 * (comparison-only; mapped back to raw offsets) → fuzzy prefix scan windowed
 * around `hintLine`. The first boundary is always kept and pinned to offset 0
 * (leading text belongs to scene 1) — that pin is not a repair. Later
 * unresolvable or non-monotonic boundaries are dropped and merge into their
 * predecessor.
 */

export type BoundaryAnnotation = {
  /** 1-based line number from the gutter the model saw. Windows the fuzzy scan only. */
  hintLine: number;
  /** Verbatim first ~40-80 chars of the scene. Ground truth for the anchor. */
  quote: string;
};

export type ResolvedBoundaries = {
  /**
   * Raw-script start offset of each kept scene. `offsets[0] === 0` always
   * (leading text belongs to scene 1); strictly increasing.
   */
  offsets: number[];
  /**
   * For each kept scene, the index of the boundary it came from.
   * `kept[0] === 0`.
   */
  kept: number[];
  /** Input boundary indices that were dropped (merged into their predecessor). */
  dropped: number[];
  /** Boundaries that needed the normalized or fuzzy rung (exact matches excluded). */
  repairs: number;
};

/** Prefix the script with a 1-based line gutter for the scenes call. */
export function addLineGutter(script: string): string {
  return script
    .split('\n')
    .map((line, i) => `${i + 1}: ${line}`)
    .join('\n');
}

/** Raw offset of the start of each 1-based line (index 0 = line 1). */
function lineStartOffsets(script: string): number[] {
  const offsets = [0];
  for (let i = 0; i < script.length; i++) {
    if (script[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

const NORMALIZE_CHAR: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  ' ': ' ',
};

/**
 * Comparison-only normal form: smart quotes/dashes folded to ASCII, any
 * whitespace run collapsed to one space. `map[i]` is the raw offset of the
 * source char behind normalized char `i`, so a normalized match position maps
 * back to an exact raw offset.
 */
function normalizeWithMap(raw: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let pendingSpace = false;
  let pendingSpaceOffset = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (/\s/.test(ch)) {
      if (!pendingSpace) {
        pendingSpace = true;
        pendingSpaceOffset = i;
      }
      continue;
    }
    if (pendingSpace) {
      if (text.length > 0) {
        text += ' ';
        map.push(pendingSpaceOffset);
      }
      pendingSpace = false;
    }
    text += NORMALIZE_CHAR[ch] ?? ch;
    map.push(i);
  }
  return { text, map };
}

/** Shortest normalized-quote prefix the fuzzy rung will accept. */
const MIN_FUZZY_PREFIX = 12;
/** Lines either side of `hintLine` the fuzzy rung searches. */
const FUZZY_WINDOW_LINES = 20;

type NormalizedScript = {
  text: string;
  map: number[];
  lower: string;
  lineStarts: number[];
};

function prepareScript(script: string): NormalizedScript {
  const { text, map } = normalizeWithMap(script);
  return {
    text,
    map,
    lower: text.toLowerCase(),
    lineStarts: lineStartOffsets(script),
  };
}

/** Raw offset behind normalized index `i` (0 for an out-of-range index). */
function rawOffsetAt(norm: NormalizedScript, i: number): number {
  return norm.map[i] ?? 0;
}

/** First normalized index whose raw offset is >= `rawCursor`. */
function normIndexAtOrAfter(norm: NormalizedScript, rawCursor: number): number {
  // map is sorted; binary search.
  let lo = 0;
  let hi = norm.map.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((norm.map[mid] ?? Infinity) < rawCursor) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type Match = { rawOffset: number; repaired: boolean };

function resolveOne(
  script: string,
  norm: NormalizedScript,
  boundary: BoundaryAnnotation,
  rawCursor: number
): Match | null {
  const quote = boundary.quote;
  if (quote.trim().length === 0) return null;

  // Rung 1: exact raw substring from the cursor.
  const exact = script.indexOf(quote, rawCursor);
  if (exact !== -1) return { rawOffset: exact, repaired: false };

  // Rung 2: normalized compare from the cursor, mapped back to raw offsets.
  const normQuote = normalizeWithMap(quote).text;
  if (normQuote.length > 0) {
    const from = normIndexAtOrAfter(norm, rawCursor);
    const hit = norm.text.indexOf(normQuote, from);
    if (hit !== -1) {
      return { rawOffset: rawOffsetAt(norm, hit), repaired: true };
    }
  }

  // Rung 3: fuzzy — case-insensitive, progressively shorter normalized
  // prefixes, windowed around hintLine so a mangled tail or odd casing still
  // anchors near where the model said the scene starts.
  const lineIdx = Math.max(0, Math.floor(boundary.hintLine) - 1);
  const winStartLine = Math.max(0, lineIdx - FUZZY_WINDOW_LINES);
  const winEndLine = Math.min(
    norm.lineStarts.length - 1,
    lineIdx + FUZZY_WINDOW_LINES
  );
  const winRawStart = Math.max(
    rawCursor,
    norm.lineStarts[winStartLine] ?? rawCursor
  );
  const winRawEnd = norm.lineStarts[winEndLine + 1] ?? script.length;
  if (winRawStart >= winRawEnd) return null;
  const winNormStart = normIndexAtOrAfter(norm, winRawStart);
  const winNormEnd = normIndexAtOrAfter(norm, winRawEnd);
  const window = norm.lower.slice(winNormStart, winNormEnd);
  const lowerQuote = normQuote.toLowerCase();
  for (
    let len = lowerQuote.length;
    len >= MIN_FUZZY_PREFIX;
    len = Math.floor(len / 2)
  ) {
    const hit = window.indexOf(lowerQuote.slice(0, len));
    if (hit !== -1) {
      return {
        rawOffset: rawOffsetAt(norm, winNormStart + hit),
        repaired: true,
      };
    }
  }
  return null;
}

/**
 * Resolve boundary annotations to raw offsets with a monotonic cursor.
 *
 * The first boundary is always kept and pinned to offset 0 — leading text
 * belongs to scene 1 regardless of where its quote matched. Later boundaries
 * must resolve strictly after the previous kept offset; anything else is
 * dropped (the scene merges into its predecessor). Pure and deterministic, so
 * incremental (mid-stream) and final resolution agree.
 */
export function resolveBoundaries(
  script: string,
  boundaries: BoundaryAnnotation[]
): ResolvedBoundaries {
  const norm = prepareScript(script);
  const offsets: number[] = [];
  const kept: number[] = [];
  const dropped: number[] = [];
  let repairs = 0;
  let cursor = 0;

  for (const [i, boundary] of boundaries.entries()) {
    if (i === 0) {
      offsets.push(0);
      kept.push(0);
      // Pin-to-0 is the product rule (leading text belongs to scene 1), not
      // a repair. Count a repair only when the quote itself needed the
      // normalized/fuzzy rung or did not resolve.
      const match = resolveOne(script, norm, boundary, 0);
      if (!match || match.repaired) repairs++;
      cursor = 1;
      continue;
    }
    const match = resolveOne(script, norm, boundary, cursor);
    if (!match || match.rawOffset < cursor) {
      dropped.push(i);
      continue;
    }
    offsets.push(match.rawOffset);
    kept.push(i);
    if (match.repaired) repairs++;
    cursor = match.rawOffset + 1;
  }

  return { offsets, kept, dropped, repairs };
}

/**
 * Slice the script at the resolved offsets. Adjacent substrings by
 * construction: `slices.join('') === script` always.
 */
export function sliceScenes(script: string, offsets: number[]): string[] {
  if (offsets.length === 0) return script.length > 0 ? [script] : [];
  return offsets.map((start, i) =>
    script.slice(start, offsets[i + 1] ?? script.length)
  );
}

/**
 * Which scene slice contains 1-based gutter line `lineNumber`. Used to derive
 * the owning scene for bible `firstMention`s (whose line numbers the bibles
 * call reports against the same gutter). Clamps out-of-range lines.
 */
export function sceneIndexForLine(
  script: string,
  offsets: number[],
  lineNumber: number
): number {
  if (offsets.length === 0) return 0;
  const lineStarts = lineStartOffsets(script);
  const lineIdx = Math.min(
    Math.max(0, Math.floor(lineNumber) - 1),
    lineStarts.length - 1
  );
  const lineOffset = lineStarts[lineIdx] ?? 0;
  let index = 0;
  for (const [i, offset] of offsets.entries()) {
    if (offset <= lineOffset) index = i;
    else break;
  }
  return index;
}

/**
 * Whether resolution degraded enough to warrant one retry with feedback.
 * More than a quarter of the boundaries dropped (always tolerates a single
 * drop), or more than half needed fuzzy/normalized repair. An empty
 * boundary list is treated as degraded. A second degraded result keeps the
 * first-pass LLM scenes rather than swapping in a heuristic split.
 */
export function isExcessivelyRepaired(
  resolution: ResolvedBoundaries,
  boundaryCount: number
): boolean {
  if (boundaryCount === 0) return true;
  return (
    resolution.dropped.length > Math.max(1, Math.floor(boundaryCount * 0.25)) ||
    resolution.repairs > boundaryCount / 2
  );
}
