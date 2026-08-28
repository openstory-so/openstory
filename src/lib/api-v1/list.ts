/**
 * The list document for `GET /api/v1/sequences` — a cursor-paginated, most-
 * recent-first page of the team's sequences.
 *
 * Each entry is a compact *summary* (the same scalar fields as the single-
 * sequence status document, minus the per-shot array) plus a `counts` block
 * and a HAL `self` link to its full status document. Counts are derived from a
 * single batched shot query across the whole page, so listing N sequences
 * costs one shots round-trip rather than N (see `listShotsByIds`).
 */

import type { ScopedDb } from '@/lib/db/scoped';
import type { Style } from '@/lib/db/schema/libraries';
import { ValidationError } from '@/lib/errors';
import type { ShotReadiness } from '@/lib/shots/shot-view';
import type { Sequence } from '@/types/database';
import { createSequenceLink } from './discovery';
import { API_V1_BASE, getLink, type HalResource, withLinks } from './hal';
import {
  buildSequenceSummary,
  type SequenceSummary,
  summarizeShotCounts,
} from './state';

/** A compact list entry — the status-document scalars without the shot array. */
type SequenceListItem = SequenceSummary;

export type SequenceListPage = HalResource<{
  sequences: HalResource<SequenceListItem>[];
}>;

/** Keyset position: a sequence's `(updatedAt, id)`, encoded into the cursor. */
export type SequenceCursor = { updatedAt: Date; id: string };

// URL-safe base64 so the cursor drops straight into a `?cursor=` value with no
// percent-encoding. The encoded payload is `<updatedAtMs>:<ulid>` — an opaque
// token to callers, who only ever echo back the `next` link we hand them.
function toBase64Url(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(input: string): string {
  const padded = input.padEnd(
    input.length + ((4 - (input.length % 4)) % 4),
    '='
  );
  return atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
}

export function encodeCursor(cursor: SequenceCursor): string {
  return toBase64Url(`${cursor.updatedAt.getTime()}:${cursor.id}`);
}

/**
 * Decode a `?cursor=` token, throwing a 400 `ValidationError` if it's malformed
 * (rather than silently restarting from the first page, which would loop an
 * agent forever). Only ever called with a token this API minted.
 */
export function decodeCursor(raw: string): SequenceCursor {
  let decoded: string;
  try {
    decoded = fromBase64Url(raw);
  } catch {
    throw new ValidationError('Invalid "cursor" parameter.');
  }
  const sep = decoded.indexOf(':');
  if (sep <= 0) {
    throw new ValidationError('Invalid "cursor" parameter.');
  }
  const ms = Number(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (!Number.isSafeInteger(ms) || id === '') {
    throw new ValidationError('Invalid "cursor" parameter.');
  }
  return { updatedAt: new Date(ms), id };
}

function buildListItem(
  sequence: Sequence,
  shots: ShotReadiness[],
  style: Style | null,
  origin: string
): HalResource<SequenceListItem> {
  const item = buildSequenceSummary({
    sequence,
    style,
    counts: summarizeShotCounts(shots),
    origin,
  });
  return withLinks(item, {
    self: getLink(`${API_V1_BASE}/sequences/${item.id}`, 'Sequence status'),
  });
}

/**
 * Build the `GET /api/v1/sequences` page document for the already-fetched page
 * of `sequences` (most recent first). `hasMore` reflects whether a further page
 * exists — when true, a `next` HAL link carries the keyset cursor of the last
 * entry. `origin` absolutizes stored media URLs (see `buildSequenceState`).
 */
export async function buildSequenceListPage(params: {
  scopedDb: {
    sequences: Pick<ScopedDb['sequences'], 'listShotReadinessByIds'>;
    styles: Pick<ScopedDb['styles'], 'listByIds'>;
  };
  sequences: Sequence[];
  hasMore: boolean;
  limit: number;
  origin: string;
}): Promise<SequenceListPage> {
  const { scopedDb, sequences, hasMore, limit, origin } = params;

  // One batched shot fetch and one batched style fetch across the whole page,
  // rather than N round-trips per sequence.
  const [allShots, allStyles] = await Promise.all([
    // Readiness only, NOT the full `ShotView`: this document reports four
    // integers per sequence, and materialising every shot's metadata and
    // prompts to get them is what let a page of 100 sequences approach the
    // 128 MB isolate ceiling (#1161).
    scopedDb.sequences.listShotReadinessByIds(sequences.map((s) => s.id)),
    scopedDb.styles.listByIds(sequences.map((s) => s.styleId)),
  ]);

  // Frameless shots are deliberately kept by the batch read (as they are by
  // `shotViewMissingFrame` on the full path) — they still count as shots.
  const shotsById = new Map<string, ShotReadiness[]>();
  for (const shot of allShots) {
    const bucket = shotsById.get(shot.sequenceId);
    if (bucket) bucket.push(shot);
    else shotsById.set(shot.sequenceId, [shot]);
  }
  const styleById = new Map(allStyles.map((style) => [style.id, style]));

  const items = sequences.map((sequence) =>
    buildListItem(
      sequence,
      shotsById.get(sequence.id) ?? [],
      styleById.get(sequence.styleId) ?? null,
      origin
    )
  );

  const last = sequences.at(-1);
  const nextHref =
    hasMore && last
      ? `${API_V1_BASE}/sequences?limit=${limit}&cursor=${encodeCursor({
          updatedAt: last.updatedAt,
          id: last.id,
        })}`
      : null;

  return withLinks(
    { sequences: items },
    {
      self: getLink(
        `${API_V1_BASE}/sequences?limit=${limit}`,
        'List sequences'
      ),
      'create-sequence': createSequenceLink(),
      ...(nextHref
        ? { next: getLink(nextHref, 'Next page of sequences') }
        : {}),
    }
  );
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Parse the `?limit` query param: absent → 20; clamped to [1, 100]; present but
 * non-integer → 400 (so a mistyped value fails loudly rather than silently
 * snapping to a default).
 */
export function parseLimitParam(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new ValidationError(
      'Invalid "limit" parameter. Use an integer between 1 and 100.'
    );
  }
  return Math.min(Math.max(value, 1), MAX_LIMIT);
}
