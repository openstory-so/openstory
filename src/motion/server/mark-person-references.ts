import { realPersonUrls } from '@/cast/server/upload-rights';
import type { ReferenceImageDescription } from '@/stills/reference-image-prompt';

/**
 * Stamp `isPerson: true` on every location/element still the likeness ledger
 * saw a real person in (#2238): an uploaded element can be a portrait, and
 * Ark refuses a lifelike face sent as a plain URL whatever the sign-off.
 * Runs in the workflow through `scopedDb.liveRead`, so every trigger gets it.
 * No row, or a cleared row, leaves the ref as it was (a plain URL).
 */
export async function markPersonReferences<T extends ReferenceImageDescription>(
  scopedDb: Parameters<typeof realPersonUrls>[0],
  refs: readonly T[]
): Promise<T[]> {
  const urls = refs
    .filter(
      (ref) =>
        (ref.kind ?? 'image') === 'image' &&
        (ref.role === 'location' || ref.role === 'element')
    )
    .map((ref) => ref.referenceImageUrl);
  if (urls.length === 0) return [...refs];
  const real = await realPersonUrls(scopedDb, urls);
  return refs.map((ref) =>
    real.has(ref.referenceImageUrl) ? { ...ref, isPerson: true } : ref
  );
}
