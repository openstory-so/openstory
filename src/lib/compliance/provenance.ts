/**
 * Content provenance helpers (#1180).
 *
 * A provenance row answers, for any asset that ever left the platform: which
 * account made it, with which model, from which prompt, and when. This module
 * holds the pure parts — trace-id formatting and building the row payload — so
 * the workflow call sites stay one line and the DB layer stays dumb.
 *
 * Recording runs inside a workflow `step.do`. A throw lets Cloudflare retry a
 * transient D1 blip; after retries are exhausted the run fails rather than
 * leaving a silent hole in the audit trail. Callers must not swallow that
 * throw inside the step.
 */

import { sha256Hex } from '@/lib/compliance/hash';
import type {
  NewContentProvenance,
  ProvenanceAssetKind,
} from '@/lib/db/schema/compliance';
import { getLogger } from '@/lib/observability/logger';
import { r2KeyFromUrl, STORAGE_BUCKETS } from '@/lib/storage/buckets';

const logger = getLogger(['openstory', 'compliance', 'provenance']);

/**
 * Prefix for trace ids quoted in takedown correspondence.
 *
 * The bare ULID is what the DB stores; the prefixed form is what goes in an
 * email, because an unlabelled 26-character string in a complaint thread is
 * indistinguishable from every other id and comes back to us unusable.
 */
const TRACE_PREFIX = 'OS';
const REPORT_PREFIX = 'OR';

/** Public trace id for a provenance row, e.g. `OS-01JAV…`. */
export function formatTraceId(provenanceId: string): string {
  return `${TRACE_PREFIX}-${provenanceId}`;
}

/** Public reference for a content report, e.g. `OR-01JAV…`. */
export function formatReportReference(reportId: string): string {
  return `${REPORT_PREFIX}-${reportId}`;
}

/**
 * Reduce a pasted asset reference to the R2 key provenance stores.
 *
 * `/r2/<key>` and legacy absolute `/r2/` URLs go through `r2KeyFromUrl`. A
 * CDN shareable URL (`https://<cdn>/<bucket>/…`) or a bare bucket-prefixed
 * key is accepted only when the path starts with a known bucket — a fal URL
 * must not become a storage-key lookup.
 */
export function extractStorageKey(input: string): string | null {
  const withoutQuery = input.split('?')[0] ?? input;
  const fromUrl = r2KeyFromUrl(withoutQuery);
  if (fromUrl) return fromUrl;

  let candidate = withoutQuery;
  if (/^https?:\/\//i.test(withoutQuery)) {
    try {
      candidate = new URL(withoutQuery).pathname.replace(/^\/+/, '');
    } catch {
      return null;
    }
  }

  if (!candidate.includes('/') || !/\.[a-z0-9]{2,5}$/i.test(candidate)) {
    return null;
  }
  const knownBucket = Object.values(STORAGE_BUCKETS).some((bucket) =>
    candidate.startsWith(`${bucket}/`)
  );
  return knownBucket ? candidate : null;
}

/**
 * Parse a user-supplied trace id back to a provenance id.
 *
 * Forgiving on input because it arrives retyped out of email: accepts the
 * prefixed form, the bare id, lowercase, and surrounding whitespace. Returns
 * null for anything that cannot be a ULID, so a malformed id fails as "not
 * found" rather than as a database error.
 */
export function parseTraceId(input: string): string | null {
  const trimmed = input.trim().toUpperCase();
  const withoutPrefix = trimmed.startsWith(`${TRACE_PREFIX}-`)
    ? trimmed.slice(TRACE_PREFIX.length + 1)
    : trimmed;
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(withoutPrefix) ? withoutPrefix : null;
}

/**
 * Everything a call site knows about an asset it just produced. Loose on
 * purpose — different workflows have different subsets in scope, and a
 * provenance row with a null prompt hash is far better than no row.
 */
export type ProvenanceFacts = {
  teamId: string;
  userId?: string | null;
  assetKind: ProvenanceAssetKind;
  assetId: string;
  /** Bucket-prefixed R2 key (`thumbnails/…`, `videos/…`). */
  storageKey?: string | null;
  contentSha256?: string | null;
  provider: string;
  model: string;
  providerRequestId?: string | null;
  workflowRunId?: string | null;
  /** Resolved prompt text. Hashed here; never stored verbatim. */
  prompt?: string | null;
  sequenceId?: string | null;
  shotId?: string | null;
  referenceImageCount?: number;
};

/** Build the insert payload, hashing the prompt. */
async function buildProvenanceRow(
  facts: ProvenanceFacts
): Promise<NewContentProvenance> {
  const referenceImageCount = facts.referenceImageCount ?? 0;
  return {
    teamId: facts.teamId,
    userId: facts.userId ?? null,
    assetKind: facts.assetKind,
    assetId: facts.assetId,
    storageKey: facts.storageKey ?? null,
    contentSha256: facts.contentSha256 ?? null,
    provider: facts.provider,
    model: facts.model,
    providerRequestId: facts.providerRequestId ?? null,
    workflowRunId: facts.workflowRunId ?? null,
    promptSha256: facts.prompt ? await sha256Hex(facts.prompt) : null,
    sequenceId: facts.sequenceId ?? null,
    shotId: facts.shotId ?? null,
    usedReferenceImages: referenceImageCount > 0,
    referenceImageCount,
  };
}

/**
 * Pull the prompt out of an arbitrary provider input payload.
 *
 * Direct model access (#458) submits whatever the endpoint's own JSON Schema
 * accepts, so there is no single prompt field across the ~1,350 endpoints in
 * fal's catalogue. Checks the conventional keys in order and returns the first
 * non-empty string; returns null rather than guessing when none match, because
 * a provenance row with no prompt hash is honest and a wrong one is not.
 */
export function extractPromptForProvenance(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;

  for (const key of ['prompt', 'text', 'input_text', 'text_prompt', 'query']) {
    // Reflect.get on the narrowed object — no assertion about a payload whose
    // shape varies per endpoint.
    const value: unknown = Reflect.get(input, key);
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

/**
 * The minimal write surface a recorder needs. Structural so workflows can pass
 * `scopedDb.provenance` (write-only by construction — see
 * `src/lib/db/scoped-workflow.ts`) and tests can pass a stub.
 */
export type ProvenanceRecorder = {
  record(row: NewContentProvenance): Promise<{ id: string } | undefined>;
};

/**
 * Record provenance, throwing on insert failure so the surrounding
 * `step.do` retries.
 *
 * Returns the public trace id. An empty `.returning()` is treated as failure
 * and logged before the throw — that is the difference between a silent hole
 * and a known, retryable one.
 */
export async function recordProvenance(
  recorder: ProvenanceRecorder,
  facts: ProvenanceFacts
): Promise<string> {
  const row = await buildProvenanceRow(facts);
  const inserted = await recorder.record(row);
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- insert may return nothing at runtime
  if (!inserted?.id) {
    logger.error('provenance insert returned no id for {assetKind} {assetId}', {
      assetKind: facts.assetKind,
      assetId: facts.assetId,
      teamId: facts.teamId,
      model: facts.model,
    });
    throw new Error(
      `provenance insert returned no id for ${facts.assetKind} ${facts.assetId}`
    );
  }
  return formatTraceId(inserted.id);
}
