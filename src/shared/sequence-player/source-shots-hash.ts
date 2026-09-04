/**
 * Canonical `sourceShotsHash` for `sequence_exports` (#1253, #1406).
 *
 * Theatre lookup is strict equality on this hash, so both producers — the
 * browser hook and the v1 export route — must emit the same bytes for the
 * same cut. The stored digest is SHA-256 of
 * `JSON.stringify({ sceneUrls, musicUrl })`; key order is load-bearing.
 */

import { sha256Hex } from '@/lib/compliance/hash';

export type SequenceExportInputs = {
  sceneUrls: readonly string[];
  musicUrl: string | null;
};

/** Music URL that actually goes into the stitched MP4 (and therefore the hash). */
export function effectiveExportMusicUrl(
  includeMusic: boolean,
  musicUrl: string | null | undefined
): string | null {
  return includeMusic ? (musicUrl ?? null) : null;
}

/**
 * Canonical JSON payload. Do not reorder or rename fields — existing rows
 * were hashed against this exact shape.
 */
export function sequenceExportInputsKey(inputs: SequenceExportInputs): string {
  return JSON.stringify({
    sceneUrls: inputs.sceneUrls,
    musicUrl: inputs.musicUrl,
  });
}

export async function hashSequenceExportInputs(
  inputs: SequenceExportInputs
): Promise<string> {
  return sha256Hex(sequenceExportInputsKey(inputs));
}
