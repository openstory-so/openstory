/**
 * Server-side likeness attach gate (#1180).
 *
 * Gate for any talent-library image write: portrait statement + basis for
 * humans, asset statement for animated/other. Create, add-media, and the
 * public API all go through here so a server-fn call cannot skip the UI
 * checkbox.
 */

import { statementFor, statementHash } from '@/lib/compliance/attestations';
import type { ScopedDb } from '@/lib/db/scoped';
import { AttestationRequiredError, ValidationError } from '@/lib/errors';
import { z } from 'zod';

/** Portrait path: basis is required. */
export const portraitAttestationSchema = z.object({
  statementVersion: z.string().min(1).max(60),
  authorizationBasis: z.string().min(1).max(500),
});

/**
 * Create-talent path: portrait (human) or asset (animated/other). Basis is
 * required only for the portrait statement — enforced in
 * {@link requireUploadAttestation}, not here, so the same field can carry
 * either statement version.
 */
export const uploadAttestationSchema = z.object({
  statementVersion: z.string().min(1).max(60),
  authorizationBasis: z.string().max(500).optional(),
});

export type PortraitAttestationInput = z.infer<
  typeof portraitAttestationSchema
>;
export type UploadAttestationInput = z.infer<typeof uploadAttestationSchema>;

export type LikenessRequestContext = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * Gate for talent uploads. Human likeness needs the portrait statement
 * plus a basis; animated/other needs the asset statement (no basis).
 */
export function requireUploadAttestation(opts: {
  depictsRealPerson: boolean;
  attestation: UploadAttestationInput | undefined;
}): PortraitAttestationInput {
  const statement = statementFor({
    subjectType: 'talent',
    depictsRealPerson: opts.depictsRealPerson,
  });
  if (!opts.attestation) {
    throw new AttestationRequiredError(
      'A rights attestation is required for this upload'
    );
  }
  if (opts.attestation.statementVersion !== statement.version) {
    throw new ValidationError(
      `Attestation version mismatch: expected ${statement.version}`
    );
  }
  if (statement.requiresBasis && !opts.attestation.authorizationBasis?.trim()) {
    throw new AttestationRequiredError(
      'A rights attestation is required for this upload'
    );
  }
  return {
    statementVersion: statement.version,
    authorizationBasis: opts.attestation.authorizationBasis?.trim() ?? '',
  };
}

/** Persist the matching statement against a talent we just wrote. */
export async function recordPortraitAttestation(opts: {
  scopedDb: ScopedDb;
  subjectId: string;
  attestation: PortraitAttestationInput;
  request?: LikenessRequestContext;
  depictsRealPerson?: boolean;
}): Promise<void> {
  const depictsRealPerson = opts.depictsRealPerson ?? true;
  const statement = statementFor({
    subjectType: 'talent',
    depictsRealPerson,
  });
  if (statement.version !== opts.attestation.statementVersion) {
    throw new ValidationError(
      `Attestation version mismatch: expected ${statement.version}`
    );
  }
  await opts.scopedDb.compliance.attestations.record({
    subjectType: 'talent',
    subjectId: opts.subjectId,
    statementVersion: statement.version,
    statementSha256: await statementHash(statement),
    depictsRealPerson,
    authorizationBasis: opts.attestation.authorizationBasis,
    ipAddress: opts.request?.ipAddress ?? null,
    userAgent: opts.request?.userAgent ?? null,
  });
}
