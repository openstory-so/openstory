/**
 * Turn a stored still/clip/audio URL into an Ark `asset://` URI when Advanced
 * Creation Rights (IAM AK/SK) are configured. Photorealistic **generated**
 * faces still trip Seedance's "may contain a real person" check on a public
 * URL; the virtual (AIGC) library is the documented route for those.
 *
 * Identity is the *stored* URL (R2 key / CDN path), not the one-off fal
 * scratch URL we may mint so CreateAsset can fetch the bytes — otherwise
 * every submit would burn a new slot in the 50-asset Entry quota.
 */

import { getLogger } from '@/lib/observability/logger';
import {
  ensureExternallyFetchableUrl,
  toDataOrCdnUrl,
} from '@/lib/storage/external-url';
import { ingestAigcAsset, type BytePlusAssetKind } from './byteplus-assets';
import { bytePlusOpenApiConfig } from './byteplus-config';

const logger = getLogger(['openstory', 'ai', 'byteplus-assets']);

function isHttpUrl(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://');
}

async function resolveBytePlusMediaUrl(
  identityUrl: string,
  publicUrl: string,
  kind: BytePlusAssetKind = 'Image',
  options?: { sleep?: (ms: number) => Promise<void> }
): Promise<string> {
  if (publicUrl.startsWith('asset://') || identityUrl.startsWith('asset://')) {
    return publicUrl.startsWith('asset://') ? publicUrl : identityUrl;
  }
  const config = bytePlusOpenApiConfig();
  if (!config || !isHttpUrl(publicUrl)) return publicUrl;
  try {
    return await ingestAigcAsset(
      {
        accessKey: config.accessKey,
        secretKey: config.secretKey,
        host: config.host,
      },
      {
        identity: identityUrl,
        publicUrl,
        assetType: kind,
        groupId: config.groupId,
        sleep: options?.sleep,
      }
    );
  } catch (error) {
    logger.warn('BytePlus asset ingest failed; sending the public URL', {
      error: error instanceof Error ? error.message : String(error),
      kind,
    });
    return publicUrl;
  }
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

/**
 * Fetchable URL, then register in the virtual portrait library when we can.
 * Data URIs skip ingest (CreateAsset only accepts HTTP URLs).
 */
export async function toArkMediaUrl(
  storedUrl: string,
  kind: BytePlusAssetKind = 'Image',
  falApiKey?: string
): Promise<string> {
  const fetchable = await toArkFetchableUrl(storedUrl, falApiKey);
  return resolveBytePlusMediaUrl(storedUrl, fetchable, kind);
}
