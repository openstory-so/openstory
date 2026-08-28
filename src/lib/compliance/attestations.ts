/**
 * Rights attestations for user uploads (#1180).
 *
 * When someone uploads an image of a real person, or an avatar asset, or a
 * brand logo, we require them to state on the record that they hold the rights
 * to it. This module is the single source of truth for that wording: the UI
 * renders these exact strings, and `upload_attestations` stores a hash of the
 * same string. One definition, so the text a user agreed to and the text we
 * later claim they agreed to cannot drift apart.
 *
 * Versioning rule: **never edit a statement's text in place.** Add a new
 * version and point the active constant at it. Editing v1's wording silently
 * invalidates every stored v1 hash, which turns a shelf of evidence into a
 * shelf of mismatches — the exact failure this design exists to prevent.
 */

import { sha256Hex } from '@/lib/compliance/hash';
import type { AttestationSubjectType } from '@/lib/db/schema/compliance';

export type AttestationStatement = {
  version: string;
  /** Short label for the checkbox / UI heading. */
  label: string;
  /** The full text the user must affirm. Hashed verbatim — never reformat. */
  text: string;
  /** Whether affirming this requires naming an authorization basis. */
  requiresBasis: boolean;
};

/**
 * Portrait / likeness rights — the statement shown when an upload depicts a
 * real, identifiable person.
 *
 * Wording covers the three things a rights-holder complaint turns on: that
 * authorization exists, that it covers AI generation specifically (a modelling
 * release for stills does not automatically cover synthesizing new footage of
 * someone), and that the uploader accepts liability if it does not.
 */
export const PORTRAIT_RIGHTS_V1: AttestationStatement = {
  version: 'portrait-rights-v1',
  label: 'I have authorization to use this person’s likeness',
  text: [
    'I confirm that this upload depicts a real, identifiable person and that I hold',
    'written authorization from that person (or their legal guardian or authorized',
    'representative) to upload their likeness and to use it to generate',
    'AI-generated images and video.',
    'I confirm the authorization specifically permits AI generation, that it has not',
    'been withdrawn, and that I can produce it on request.',
    'I accept full legal responsibility for this upload and for any content',
    'generated from it, including any claim relating to portrait, personality,',
    'privacy, or publicity rights.',
  ].join(' '),
  requiresBasis: true,
};

/**
 * Original-work / IP rights — the statement for uploads that are not a real
 * person: logos, product shots, synthetic avatars, style references.
 *
 * Mirrors the substance of the ownership declaration a model provider requires
 * of us for custom asset uploads, so what our users warrant to us is at least
 * as strong as what we warrant upstream. Notably includes the "not similar to
 * any real person" clause, which is what makes a synthetic-avatar upload
 * distinguishable from an unlicensed likeness.
 */
export const ASSET_RIGHTS_V1: AttestationStatement = {
  version: 'asset-rights-v1',
  label: 'I hold the rights to this asset',
  text: [
    'I confirm that I own or am licensed to use this asset and everything in it,',
    'that uploading and generating from it infringes no copyright, trademark,',
    'portrait, personality, or other right of any third party, and that it is not',
    'identical or similar to the likeness of any real person.',
    'I accept full legal responsibility for this upload and for any content',
    'generated from it.',
  ].join(' '),
  requiresBasis: false,
};

const STATEMENTS: readonly AttestationStatement[] = [
  PORTRAIT_RIGHTS_V1,
  ASSET_RIGHTS_V1,
];

/**
 * Which statement applies to an upload.
 *
 * Driven by what the upload *depicts*, not by which table it lands in: a
 * `talent` row is usually a real actor but can be a synthetic character, and a
 * `sequence_element` is usually a logo but can be a headshot. The caller passes
 * what the user told us, and the stronger statement applies whenever a real
 * person is involved.
 */
export function statementFor(opts: {
  subjectType: AttestationSubjectType;
  depictsRealPerson: boolean;
}): AttestationStatement {
  return opts.depictsRealPerson ? PORTRAIT_RIGHTS_V1 : ASSET_RIGHTS_V1;
}

/** Look up a statement by stored version, for rendering historical evidence. */
function statementByVersion(version: string): AttestationStatement | undefined {
  return STATEMENTS.find((statement) => statement.version === version);
}

/** Hash of a statement's text, as stored in `upload_attestations`. */
export function statementHash(
  statement: AttestationStatement
): Promise<string> {
  return sha256Hex(statement.text);
}

/**
 * Verify a stored attestation still matches the wording we ship.
 *
 * A mismatch means someone edited a statement in place after it was agreed to,
 * violating the versioning rule above. Surfaced in the admin evidence view
 * rather than thrown: the stored hash is still the truth of what was shown, and
 * the defect is in the code, not the record.
 */
export async function attestationMatchesShippedText(stored: {
  statementVersion: string;
  statementSha256: string;
}): Promise<boolean> {
  const statement = statementByVersion(stored.statementVersion);
  if (!statement) return false;
  return (await statementHash(statement)) === stored.statementSha256;
}
