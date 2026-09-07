/**
 * A public URL (or data URI) Ark can fetch for a stored still/clip/audio.
 * Registering it in the virtual portrait library is a separate, paced
 * sequence of workflow steps — see `byteplus-asset-steps.ts` (#1519).
 */

import {
  ensureExternallyFetchableUrl,
  toDataOrCdnUrl,
} from '@/lib/storage/external-url';

export function isHttpUrl(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://');
}

/**
 * Public URL (or data URI) Ark can fetch. Does **not** register in the
 * asset library.
 */
export async function toArkFetchableUrl(
  storedUrl: string,
  falApiKey?: string
): Promise<string> {
  if (storedUrl.startsWith('asset://')) return storedUrl;
  const publicUrl = await ensureExternallyFetchableUrl(storedUrl, falApiKey);
  return isHttpUrl(publicUrl) ? publicUrl : toDataOrCdnUrl(storedUrl);
}
