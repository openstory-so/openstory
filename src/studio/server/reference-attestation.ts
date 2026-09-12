/**
 * Rights gate for studio reference stills (#1581).
 *
 * Every gated still ends up with one ledger row, keyed by the SHA-256 of
 * the stored URL under the `studio_reference` subject type, so a still
 * handled once never re-prompts:
 *
 *  - a real person → the user's portrait sign-off + basis
 *    ({@link attestStudioReferences}, Confirm in the composer);
 *  - anything else → the classifier's own "no person detected" finding,
 *    written by the check itself (`classifyStudioReferenceFn`). Nothing is
 *    asked of the user.
 *
 * {@link requireReferenceRights} is what `createStudioAssets` asks before
 * any credit hold or row: a row must exist, so a direct server-fn call
 * cannot skip the checkbox and Generate never re-runs vision.
 */

import {
  recordPortraitAttestation,
  requirePortraitAttestation,
  type LikenessRequestContext,
} from '@/cast/server/likeness-upload';
import { sha256Hex } from '@/platform/compliance/hash';
import { AttestationRequiredError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import {
  needsReferenceAttestation,
  studioReferenceImages,
} from '@/studio/reference-rights';
import type {
  StudioCreateInput,
  StudioReferenceAttestation,
} from '@/studio/schema';

async function isAttested(scopedDb: ScopedDb, url: string): Promise<boolean> {
  const rows = await scopedDb.compliance.attestations.listForSubject(
    'studio_reference',
    await sha256Hex(url)
  );
  return rows.length > 0;
}

export async function attestStudioReferences(
  scopedDb: ScopedDb,
  attestations: StudioReferenceAttestation[],
  request: LikenessRequestContext
): Promise<void> {
  for (const claim of attestations) {
    if (!needsReferenceAttestation(claim.url)) {
      throw new Error('This reference needs no rights check');
    }
    if (await isAttested(scopedDb, claim.url)) continue;
    await recordPortraitAttestation({
      scopedDb,
      subjectType: 'studio_reference',
      subjectId: await sha256Hex(claim.url),
      attestation: requirePortraitAttestation(claim),
      request,
    });
  }
}

export async function requireReferenceRights(
  scopedDb: ScopedDb,
  input: StudioCreateInput
): Promise<void> {
  const gated = new Set(
    studioReferenceImages(input).filter(needsReferenceAttestation)
  );
  for (const url of gated) {
    if (!(await isAttested(scopedDb, url))) {
      throw new AttestationRequiredError(
        'Confirm the rights to your reference images before generating'
      );
    }
  }
}
