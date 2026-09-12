/**
 * Server-side likeness attach gate (#1180).
 *
 * Gate for any talent-library image write: portrait statement + basis for
 * humans, asset statement for animated/other. Create, add-media, and the
 * public API all go through here so a server-fn call cannot skip the UI
 * checkbox.
 */

import {
  statementFor,
  statementHash,
} from '@/platform/compliance/attestations';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { AttestationSubjectType } from '@/platform/server/db/schema/compliance';
import { AttestationRequiredError, ValidationError } from '@/platform/errors';
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
 * Gate for a real person's likeness: the portrait statement plus a basis.
 */
export function requirePortraitAttestation(
  attestation: UploadAttestationInput | undefined
): PortraitAttestationInput {
  const statement = statementFor({
    subjectType: 'talent',
    depictsRealPerson: true,
  });
  if (!attestation) {
    throw new AttestationRequiredError(
      'A rights attestation is required for this upload'
    );
  }
  if (attestation.statementVersion !== statement.version) {
    throw new ValidationError(
      `Attestation version mismatch: expected ${statement.version}`
    );
  }
  if (statement.requiresBasis && !attestation.authorizationBasis?.trim()) {
    throw new AttestationRequiredError(
      'A rights attestation is required for this upload'
    );
  }
  return {
    statementVersion: statement.version,
    authorizationBasis: attestation.authorizationBasis?.trim() ?? '',
  };
}

/**
 * Gate for talent uploads. Only a human likeness is signed for (#1581);
 * animated/other uploads need nothing and get no row.
 */
export function requireUploadAttestation(opts: {
  depictsRealPerson: boolean;
  attestation: UploadAttestationInput | undefined;
}): PortraitAttestationInput | null {
  return opts.depictsRealPerson
    ? requirePortraitAttestation(opts.attestation)
    : null;
}

/** Persist the matching statement against the upload we just accepted. */
export async function recordPortraitAttestation(opts: {
  scopedDb: ScopedDb;
  /** @default 'talent' */
  subjectType?: AttestationSubjectType;
  subjectId: string;
  attestation: PortraitAttestationInput;
  request?: LikenessRequestContext;
  depictsRealPerson?: boolean;
}): Promise<void> {
  const depictsRealPerson = opts.depictsRealPerson ?? true;
  const subjectType = opts.subjectType ?? 'talent';
  const statement = statementFor({ subjectType, depictsRealPerson });
  if (statement.version !== opts.attestation.statementVersion) {
    throw new ValidationError(
      `Attestation version mismatch: expected ${statement.version}`
    );
  }
  await opts.scopedDb.compliance.attestations.record({
    subjectType,
    subjectId: opts.subjectId,
    statementVersion: statement.version,
    statementSha256: await statementHash(statement),
    depictsRealPerson,
    authorizationBasis: opts.attestation.authorizationBasis,
    ipAddress: opts.request?.ipAddress ?? null,
    userAgent: opts.request?.userAgent ?? null,
  });
}
