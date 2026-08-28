/**
 * Compliance server functions — the user's own side (#1180).
 *
 * Rights attestations and the account restriction banner. Admin moderation
 * lives in `./moderation`; public report intake in `./content-reports`.
 */

import { authMiddleware, authWithTeamMiddleware } from './middleware';
import {
  loadComplianceState,
  summarizeCompliance,
} from '@/lib/compliance/generation-gate';
import { ATTESTATION_SUBJECT_TYPES } from '@/lib/db/schema/compliance';
import { statementFor, statementHash } from '@/lib/compliance/attestations';
import { AttestationRequiredError, ValidationError } from '@/lib/errors';
import { resolveUserTeam } from '@/lib/db/scoped';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

/** Client context for an attestation — evidence, not telemetry. */
function requestContext(): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  const request = getRequest();
  return {
    // Cloudflare's own header, not X-Forwarded-For: the latter is
    // client-supplied and trivially spoofed, which would put a forged address
    // into a record whose only purpose is to be relied on later.
    ipAddress: request.headers.get('cf-connecting-ip'),
    userAgent: request.headers.get('user-agent'),
  };
}

/**
 * The account's enforcement standing. Read by `ComplianceRestrictionBanner`,
 * and computed by the same code the generation gate uses so the two cannot
 * disagree.
 */
export const getComplianceStatusFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const team = await resolveUserTeam(context.user.id);
    const state = await loadComplianceState(context.user.id, team?.teamId);
    return summarizeCompliance(state);
  });

/**
 * Record a rights attestation for an upload.
 *
 * The client sends what it was shown (`statementVersion`) and what the user
 * declared; the hash is computed server-side from our own copy of the text, so
 * a client cannot attest to wording it invented. A version the server does not
 * recognize is rejected rather than stored.
 */
export const recordUploadAttestationFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        subjectType: z.enum(ATTESTATION_SUBJECT_TYPES),
        subjectId: z.string().min(1).max(200),
        statementVersion: z.string().min(1).max(60),
        depictsRealPerson: z.boolean(),
        authorizationBasis: z.string().max(500).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const statement = statementFor({
      subjectType: data.subjectType,
      depictsRealPerson: data.depictsRealPerson,
    });

    if (statement.version !== data.statementVersion) {
      throw new ValidationError(
        `Attestation version mismatch: expected ${statement.version}`
      );
    }
    if (statement.requiresBasis && !data.authorizationBasis?.trim()) {
      throw new AttestationRequiredError(
        'An authorization basis is required for likeness uploads'
      );
    }

    const { ipAddress, userAgent } = requestContext();
    const row = await context.scopedDb.compliance.attestations.record({
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      statementVersion: statement.version,
      statementSha256: await statementHash(statement),
      depictsRealPerson: data.depictsRealPerson,
      authorizationBasis: data.authorizationBasis?.trim() ?? null,
      ipAddress,
      userAgent,
    });

    return { id: row.id, attestedAt: row.attestedAt };
  });
