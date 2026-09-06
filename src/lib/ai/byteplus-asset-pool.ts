/**
 * The BytePlus ACR asset pool (#1361) — FIFO-by-use reuse of a fixed number
 * of account-wide slots.
 *
 * #1157 registers a still as `asset://` and reuses an Active asset with the
 * same identity, but never deletes: the pool only grows until `CreateAsset`
 * refuses. BytePlus's own guidance for tool vendors is that ACR is a working
 * set, not a permanent library, so this module makes it one.
 *
 * Three rules, in the order they decide:
 *
 *   1. **Hit** — the identity is already resident. Renew its lease, return the
 *      existing `asset://`. No Ark call at all.
 *   2. **Miss with room** — `CreateAsset`, wait Active, record the slot.
 *   3. **Miss when full** — evict the *unleased* slot with the oldest use,
 *      frames before library sheets, then create. Nothing evictable means
 *      every slot is pinned by an in-flight job: refuse, and let the caller
 *      fall back to fal.
 *
 * The lease is the load-bearing part. Slots are per BytePlus ACCOUNT, shared
 * by every team, and an in-flight Seedance job pins every `asset://` it
 * submitted — deleting one mid-poll 400s that job. Workers hold nothing
 * between requests, so the lease is a D1 row and the mutex is a CAS delete;
 * both live in `scopedDb.bytePlusAssets`, which owns every statement. This
 * module owns only the policy: how many slots, how long a lease lasts, and
 * what to do when the answer is "none".
 */

import { getEnv } from '#env';
import type { BytePlusAssetSlot } from '@/lib/db/schema/byteplus-assets';
import type { createBytePlusAssetsMethods } from '@/lib/db/scoped/byteplus-assets';
import { getLogger } from '@/lib/observability/logger';
import { reportBytePlusAssetPool } from './byteplus-observability';
import {
  deleteAsset,
  hashAssetIdentity,
  ingestAigcAsset,
  type BytePlusAssetKind,
} from './byteplus-assets';
import type { BytePlusOpenApiConfig } from './byteplus-openapi';

const logger = getLogger(['openstory', 'ai', 'byteplus-asset-pool']);

type Ledger = ReturnType<typeof createBytePlusAssetsMethods>;

/** Reserve + record, as `scopedDb.bytePlusAssets` — both writes, no hatch. */
export type AssetPoolLedger = Pick<Ledger, 'claimSlot' | 'recordSlot'>;

/**
 * Resident asset slots on the BytePlus account.
 *
 * Entry Advanced Creation Rights is 50 slots per ACCOUNT (not per project,
 * not per team, and shared with the real-human library) — the same shape as
 * the Ark RPM quotas. Transcribed 2026-09-06 from the ACR purchase guide as
 * relayed in #1361; NOT verified against a live 429, so `BYTEPLUS_ASSET_SLOTS`
 * overrides it without a code change when the tier moves. Under-setting it is
 * safe (we evict early); over-setting it just means `CreateAsset` refuses and
 * the shot falls back to fal.
 *
 * Not to be confused with Seedance 2.5's 50 references, which is per REQUEST.
 */
const DEFAULT_BYTEPLUS_ASSET_SLOTS = 50;

/**
 * How long a submitted still stays pinned when nobody releases it.
 *
 * The motion workflow releases explicitly on success, so this only covers
 * runs that died mid-flight. It must outlast a poll budget (30 minutes of
 * batches) or the backstop would free a slot under a job that is still
 * running — the exact 400 the lease exists to prevent.
 */
const LEASE_TTL_MS = 45 * 60 * 1000;

export function bytePlusAssetSlots(): number {
  const raw = Reflect.get(getEnv(), 'BYTEPLUS_ASSET_SLOTS');
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_BYTEPLUS_ASSET_SLOTS;
}

/**
 * For the one caller with no D1 at all (`scripts/generate-style-hover-videos`).
 * Refusing beats creating: a run that cannot record a slot could never release
 * one either, so it would burn the account's pool permanently. The ingest
 * catches this and sends the public URL, exactly as it did before the pool.
 */
export const unledgeredAssetPool: AssetPoolLedger = {
  claimSlot: async () => ({ kind: 'exhausted' }),
  recordSlot: async () => {},
};

/**
 * The ledger's key for each distinct stored URL. Exported so a workflow can
 * spell its pool call as `scopedDb.liveRead.bytePlusAssets.getAdmission(...)`
 * / `scopedDb.bytePlusAssets.releaseLeases(...)` at the call site — handing
 * the domain object to a helper instead would hide the read from the
 * `no-mid-run-reads` audit.
 */
export async function arkAssetIdentities(
  storedUrls: readonly string[]
): Promise<string[]> {
  const unique = [...new Set(storedUrls.filter((url) => url.length > 0))];
  return Promise.all(unique.map((url) => hashAssetIdentity(url)));
}

/**
 * Reuse-or-create one `asset://`, holding a lease on it for the job about to
 * submit it. `identity` is the STORED url — a one-off fal scratch URL would
 * burn a fresh slot on every submit.
 */
export async function ingestPooledAsset(
  config: BytePlusOpenApiConfig,
  ledger: AssetPoolLedger,
  input: {
    identity: string;
    publicUrl: string;
    assetType: BytePlusAssetKind;
    slot: BytePlusAssetSlot;
    groupId?: string;
  }
): Promise<string> {
  const identity = await hashAssetIdentity(input.identity);
  const claim = await ledger.claimSlot({
    identity,
    slot: input.slot,
    capacity: bytePlusAssetSlots(),
    leaseMs: LEASE_TTL_MS,
  });

  if (claim.kind === 'hit') {
    reportBytePlusAssetPool({ outcome: 'hit', slot: input.slot });
    return `asset://${claim.assetId}`;
  }
  if (claim.kind === 'exhausted') {
    reportBytePlusAssetPool({ outcome: 'exhausted' });
    throw new Error(
      'BytePlus asset pool is full and every slot is leased by an in-flight job'
    );
  }

  if (claim.evictedAssetId) {
    try {
      await deleteAsset(config, claim.evictedAssetId);
    } catch (error) {
      // ponytail: the Ark asset outlives our ledger row, so the account is one
      // slot tighter than we think until CreateAsset refuses and the shot
      // falls back to fal. Reconciling against ListAssets is the upgrade if
      // this shows up in the pool events.
      logger.warn('BytePlus DeleteAsset failed; slot may leak on Ark', {
        assetId: claim.evictedAssetId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    reportBytePlusAssetPool({ outcome: 'evicted', slot: input.slot });
  }

  // `ingestAigcAsset` still checks Ark by name first, which is what heals a
  // ledger that lost rows (a wiped preview DB) without duplicating the asset.
  const uri = await ingestAigcAsset(config, {
    identity: input.identity,
    publicUrl: input.publicUrl,
    assetType: input.assetType,
    ...(input.groupId && { groupId: input.groupId }),
  });

  await ledger.recordSlot({
    identity,
    assetId: uri.slice('asset://'.length),
    slot: input.slot,
    leaseMs: LEASE_TTL_MS,
  });
  reportBytePlusAssetPool({ outcome: 'created', slot: input.slot });
  return uri;
}
