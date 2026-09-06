/**
 * Turn a stored still/clip/audio URL into an Ark `asset://` URI when Advanced
 * Creation Rights (IAM AK/SK) are configured. Photorealistic **generated**
 * faces still trip Seedance's "may contain a real person" check on a public
 * URL; the virtual (AIGC) library is the documented route for those.
 *
 * Identity is the *stored* URL (R2 key / CDN path), not the one-off fal
 * scratch URL we may mint so CreateAsset can fetch the bytes — otherwise
 * every submit would burn a new slot in the Entry asset quota.
 *
 * Slots are finite and account-wide, so every ingest goes through the pool
 * (`byteplus-asset-pool.ts`): reuse, lease, evict-LRU. A full pool with
 * nothing evictable is not fatal — it returns the public URL, which either
 * works (no face in the still) or trips the portrait filter and takes the
 * existing fal fallback.
 */

import { getLogger } from '@/lib/observability/logger';
import type { BytePlusAssetSlot } from '@/lib/db/schema/byteplus-assets';
import {
  ensureExternallyFetchableUrl,
  toDataOrCdnUrl,
} from '@/lib/storage/external-url';
import { ingestPooledAsset, type AssetPoolLedger } from './byteplus-asset-pool';
import type { BytePlusAssetKind } from './byteplus-assets';
import { bytePlusOpenApiConfig } from './byteplus-config';

const logger = getLogger(['openstory', 'ai', 'byteplus-assets']);

function isHttpUrl(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://');
}

/**
 * `slot` is the eviction class, not the media type: a start frame is
 * regenerated constantly and is cheap to re-ingest, a cast/location sheet is
 * bound by every shot that matched it.
 */
export type ArkMediaOptions = {
  /** `scopedDb.bytePlusAssets` — the slot ledger this ingest leases from. */
  ledger: AssetPoolLedger;
  slot: BytePlusAssetSlot;
  kind?: BytePlusAssetKind;
  falApiKey?: string;
};

async function resolveBytePlusMediaUrl(
  identityUrl: string,
  publicUrl: string,
  options: ArkMediaOptions
): Promise<string> {
  if (publicUrl.startsWith('asset://') || identityUrl.startsWith('asset://')) {
    return publicUrl.startsWith('asset://') ? publicUrl : identityUrl;
  }
  const config = bytePlusOpenApiConfig();
  if (!config || !isHttpUrl(publicUrl)) return publicUrl;
  const kind = options.kind ?? 'Image';
  try {
    return await ingestPooledAsset(
      {
        accessKey: config.accessKey,
        secretKey: config.secretKey,
        host: config.host,
      },
      options.ledger,
      {
        identity: identityUrl,
        publicUrl,
        assetType: kind,
        slot: options.slot,
        groupId: config.groupId,
      }
    );
  } catch (error) {
    logger.warn('BytePlus asset ingest failed; sending the public URL', {
      error: error instanceof Error ? error.message : String(error),
      kind,
      slot: options.slot,
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
  options: ArkMediaOptions
): Promise<string> {
  const fetchable = await toArkFetchableUrl(storedUrl, options.falApiKey);
  return resolveBytePlusMediaUrl(storedUrl, fetchable, options);
}
