/**
 * Upload rights gate (#1180, #1581) — the server half.
 *
 * One ledger row per uploaded image, keyed by the SHA-256 of its stored URL
 * under the `uploaded_image` subject type:
 *
 *  - {@link classifyUpload} runs the likeness classifier once and records its
 *    verdict (`likeness-cleared-v1` / `likeness-detected-v1`);
 *  - {@link attestUploads} records the user's portrait sign-off
 *    (`portrait-rights-v1`), which supersedes a detected finding;
 *  - {@link requireUploadRights} is what every finalize / create / generate
 *    asks before a row, a move, a credit hold or a model call: the latest row
 *    must be cleared or signed. Nothing else counts, so a direct server-fn
 *    call cannot skip the check or the checkbox;
 *  - {@link carryUploadRights} re-keys the row when a finalize moves the
 *    object, so the library URL is covered by the same evidence.
 *
 * `depictsRealPerson` on a talent row is derived from this ledger, never taken
 * off the client.
 */

import { analyzeTalentMediaForTeam } from '@/cast/server/talent/analyze-talent-media';
import type { TalentSubjectKind } from '@/cast/subject-kind';
import type { PortraitAttestation, UploadRights } from '@/cast/upload-rights';
import {
  LIKENESS_CLEARED_V1,
  LIKENESS_DETECTED_V1,
  PORTRAIT_RIGHTS_V1,
  statementHash,
  type AttestationStatement,
} from '@/platform/compliance/attestations';
import { sha256Hex } from '@/platform/compliance/hash';
import { AttestationRequiredError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { UploadAttestation } from '@/platform/server/db/schema/compliance';

export type LikenessRequestContext = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

async function latestRow(
  scopedDb: ScopedDb,
  url: string
): Promise<UploadAttestation | undefined> {
  const [latest] = await scopedDb.compliance.attestations.listForSubject(
    'uploaded_image',
    await sha256Hex(url)
  );
  return latest;
}

function rightsFromRow(row: UploadAttestation): UploadRights {
  switch (row.statementVersion) {
    case LIKENESS_CLEARED_V1.version:
      return { status: 'cleared' };
    case LIKENESS_DETECTED_V1.version:
      return { status: 'needs_portrait' };
    case PORTRAIT_RIGHTS_V1.version:
      return { status: 'signed' };
    default:
      // A statement this code no longer writes (the retired asset warranty).
      // Treat it as unchecked rather than guess what it meant.
      throw new AttestationRequiredError(
        'This upload was recorded under a retired statement; check it again'
      );
  }
}

async function record(
  scopedDb: ScopedDb,
  url: string,
  statement: AttestationStatement,
  authorizationBasis: string | null,
  request: LikenessRequestContext
): Promise<void> {
  await scopedDb.compliance.attestations.record({
    subjectType: 'uploaded_image',
    subjectId: await sha256Hex(url),
    statementVersion: statement.version,
    statementSha256: await statementHash(statement),
    depictsRealPerson: statement !== LIKENESS_CLEARED_V1,
    authorizationBasis,
    ipAddress: request.ipAddress ?? null,
    userAgent: request.userAgent ?? null,
  });
}

/**
 * Write the classifier's verdict for each URL it looked at, unless the URL
 * already has a row (a re-check never downgrades a sign-off).
 */
export async function recordLikenessFinding(
  scopedDb: ScopedDb,
  urls: string[],
  subjectKind: TalentSubjectKind,
  request: LikenessRequestContext
): Promise<void> {
  let statement: AttestationStatement;
  switch (subjectKind) {
    case 'human':
      statement = LIKENESS_DETECTED_V1;
      break;
    case 'animated':
    case 'other':
      statement = LIKENESS_CLEARED_V1;
      break;
    default:
      subjectKind satisfies never;
      throw new Error(`Unknown subject kind ${String(subjectKind)}`);
  }
  for (const url of new Set(urls)) {
    if (await latestRow(scopedDb, url)) continue;
    await record(scopedDb, url, statement, null, request);
  }
}

/**
 * The rights for one upload: what the ledger already says, or one vision
 * call whose verdict is written so the next ask is free. Never defaults to
 * human, never defaults to cleared: a classifier failure throws and leaves
 * no row, so the gate keeps refusing.
 */
export async function classifyUpload(opts: {
  scopedDb: ScopedDb;
  userId: string;
  url: string;
  /** Original filename, appended to the vision prompt as a hint. */
  filename?: string;
  request: LikenessRequestContext;
}): Promise<UploadRights> {
  const existing = await latestRow(opts.scopedDb, opts.url);
  if (existing) return rightsFromRow(existing);
  const analysis = await analyzeTalentMediaForTeam({
    scopedDb: opts.scopedDb,
    userId: opts.userId,
    imageUrls: [opts.url],
    filenames: opts.filename ? [opts.filename] : undefined,
    idempotencyKey: `likeness:${opts.url}`,
  });
  await recordLikenessFinding(
    opts.scopedDb,
    [opts.url],
    analysis.subjectKind,
    opts.request
  );
  return analysis.subjectKind === 'human'
    ? { status: 'needs_portrait' }
    : { status: 'cleared' };
}

/** Record the portrait sign-off for each URL. Signing is always allowed. */
export async function attestUploads(
  scopedDb: ScopedDb,
  attestations: PortraitAttestation[],
  request: LikenessRequestContext
): Promise<void> {
  for (const claim of attestations) {
    const existing = await latestRow(scopedDb, claim.url);
    if (existing && rightsFromRow(existing).status === 'signed') continue;
    await record(
      scopedDb,
      claim.url,
      PORTRAIT_RIGHTS_V1,
      claim.authorizationBasis,
      request
    );
  }
}

/**
 * Refuse unless every URL is cleared or signed. Returns whether each depicts
 * a real person, so a caller can derive `isHuman` from the ledger.
 */
export async function requireUploadRights(
  scopedDb: ScopedDb,
  urls: string[]
): Promise<Map<string, { depictsRealPerson: boolean }>> {
  const result = new Map<string, { depictsRealPerson: boolean }>();
  for (const url of new Set(urls)) {
    const row = await latestRow(scopedDb, url);
    if (!row) {
      throw new AttestationRequiredError(
        'This image has not been checked for a real person yet'
      );
    }
    const rights = rightsFromRow(row);
    if (rights.status === 'needs_portrait') {
      throw new AttestationRequiredError(
        'Confirm the rights to this person’s likeness before using the image'
      );
    }
    result.set(url, { depictsRealPerson: rights.status === 'signed' });
  }
  return result;
}

/**
 * After a finalize moves an object, cover the new URL with the same row so
 * the library copy passes the gate without a second look.
 */
export async function carryUploadRights(
  scopedDb: ScopedDb,
  fromUrl: string,
  toUrl: string
): Promise<void> {
  const row = await latestRow(scopedDb, fromUrl);
  if (!row) {
    throw new AttestationRequiredError(
      'This image has not been checked for a real person yet'
    );
  }
  await scopedDb.compliance.attestations.record({
    subjectType: 'uploaded_image',
    subjectId: await sha256Hex(toUrl),
    statementVersion: row.statementVersion,
    statementSha256: row.statementSha256,
    depictsRealPerson: row.depictsRealPerson,
    authorizationBasis: row.authorizationBasis,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
  });
}
