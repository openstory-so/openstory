/**
 * Seedance 2.5 / 2.0 reject a public URL or data URI that *may contain a
 * real person* (`InputImageSensitiveContentDetected.PrivacyInformation`)
 * before a task is created. Photorealistic **generated** faces trip this
 * too — "may contain" is a classifier, not a legal finding.
 *
 * Advanced Creation Rights do not lift the check on a URL. They unlock the
 * **virtual** portrait library (AIGC groups). Submit registers the still
 * via the Assets API (`BYTEPLUS_ACCESS_KEY` / `BYTEPLUS_SECRET_KEY`) and
 * sends `asset://<id>`. If ingest is not configured or still 400s, we
 * resubmit on fal. Do not fold this into the content-flag re-roll.
 */

/** Exact Ark code on the 400 the user sees. */
const PORTRAIT_FILTER_CODE =
  'InputImageSensitiveContentDetected.PrivacyInformation';

/** Human half of the same 400, in case a wrapper drops the dotted code. */
const PORTRAIT_FILTER_MESSAGE = /may contain real person/i;

/**
 * Thrown when Ark blocks the still and there is no fal key to fall back to.
 * Surfaces on `sequence.statusError` / studio failure banners.
 */
export const BYTEPLUS_PORTRAIT_FILTER_NO_FAL_MESSAGE =
  'BytePlus Ark blocked this still as a possible real person (photorealistic generated faces trip this too). Seedance 2.5 only accepts those faces as asset:// IDs from the virtual portrait library. Set BYTEPLUS_ACCESS_KEY and BYTEPLUS_SECRET_KEY so we can register the still, or configure FAL_KEY to fall back to fal.';

/** True when Ark refused the still as a possible real person. */
export function isBytePlusPortraitFilterError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(PORTRAIT_FILTER_CODE) ||
    PORTRAIT_FILTER_MESSAGE.test(message)
  );
}
