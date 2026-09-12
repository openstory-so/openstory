/**
 * Rights gate for studio reference stills (#1581).
 *
 * Two halves, both keyed by the SHA-256 of the stored URL under the
 * `studio_reference` subject type so a still signed off once never
 * re-prompts:
 *
 *  - {@link attestStudioReferences} records the user's sign-off (Confirm in
 *    the composer) — portrait statement + basis for a real person, asset
 *    statement otherwise. Same shape as the talent gate.
 *  - {@link requireReferenceRights} is what `createStudioAssets` asks before
 *    any credit hold or row: every gated still must already be on record, so
 *    a direct server-fn call cannot skip the checkbox.
 */

import {
  recordPortraitAttestation,
  requireUploadAttestation,
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
    const attestation = requireUploadAttestation({
      depictsRealPerson: claim.depictsRealPerson,
      attestation: claim,
    });
    await recordPortraitAttestation({
      scopedDb,
      subjectType: 'studio_reference',
      subjectId: await sha256Hex(claim.url),
      attestation,
      request,
      depictsRealPerson: claim.depictsRealPerson,
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
