/**
 * The BytePlus ACR asset pool (#1361) — least-recently-used reuse of a fixed number
 * of account-wide slots.
 *
 * #1157 registers a still as `asset://` and reuses an Active asset with the
 * same identity, but never deletes: the pool only grows until `CreateAsset`
 * refuses. BytePlus's own guidance for tool vendors is that ACR is a working
 * set, not a permanent library, so this module makes it one.
 *
 * Three rules, in the order they decide:
 *
 *   1. **Hit** — the identity is already resident. Lease it, return the
 *      existing `asset://`. No Ark call at all.
 *   2. **Miss with room** — reserve the slot, `CreateAsset`, wait Active,
 *      finalize the slot.
 *   3. **Miss when full** — hand the *unleased* slot with the oldest use to
 *      this still, frames before library sheets, delete its asset, then
 *      create. Nothing evictable means every slot is pinned by an in-flight
 *      job: refuse.
 *
 * The lease is the load-bearing part. Slots are per BytePlus ACCOUNT, shared
 * by every team, and an in-flight Seedance job pins every `asset://` it
 * submitted — deleting one mid-poll 400s that job. Workers hold nothing
 * between requests, so each run's lease is a D1 row keyed by (still, run) and
 * released by run (#1531); every statement lives in `scopedDb.bytePlusAssets`.
 * This module owns only the policy: how many slots, how long a lease lasts,
 * and what to do when the answer is "none".
 */

import { NonRetryableError } from 'cloudflare:workflows';
import { getEnv } from '#env';
import type { BytePlusAssetSlot } from '@/platform/server/db/schema/byteplus-assets';
import type { createBytePlusAssetsMethods } from '@/models/server/db/byteplus-assets';
import { getLogger } from '@/platform/logger';
import { reportBytePlusAssetPool } from './byteplus-observability';
import {
  deleteAsset,
  hashAssetIdentity,
  ingestAigcAsset,
  listAssetsInGroup,
  resolveAigcGroupId,
  type BytePlusAssetKind,
} from './byteplus-assets';
import type { BytePlusOpenApiConfig } from './byteplus-openapi';

const logger = getLogger(['openstory', 'ai', 'byteplus-asset-pool']);

type Ledger = ReturnType<typeof createBytePlusAssetsMethods>;

/** Reserve + finalize, as `scopedDb.bytePlusAssets` — both writes, no hatch. */
export type AssetPoolLedger = Pick<Ledger, 'claimSlot' | 'finalizeSlot'>;

/**
 * Resident asset slots on the BytePlus account.
 *
 * Entry Advanced Creation Rights is 50 slots per ACCOUNT (not per project,
 * not per team, and shared with the real-human library) — the same shape as
 * the Ark RPM quotas. Transcribed 2026-09-06 from the ACR purchase guide as
 * relayed in #1361; NOT verified against a live 429, so `BYTEPLUS_ASSET_SLOTS`
 * overrides it without a code change when the tier moves. Under-setting it is
 * safe (we evict early); over-setting it just means `CreateAsset` refuses and
 * the shot fails with Ark's error.
 *
 * Not to be confused with Seedance 2.5's 50 references, which is per REQUEST.
 */
const DEFAULT_BYTEPLUS_ASSET_SLOTS = 50;

/**
 * How long a submitted still stays pinned when nobody releases it.
 *
 * Motion and studio runs release by owner on both exits, so this only covers
 * runs that died mid-flight. Every claim and finalize renews ALL of the run's
 * leases, so it is measured from the run's last ingest step: it must outlast
 * submit plus a poll budget (30 minutes of batches) and the governor's
 * longest CreateAsset wait (15 minutes), or the backstop would free a slot
 * under a job that is still running — the exact 400 the lease exists to
 * prevent. It is also how long a reservation may wait for its create before
 * another run can take it over.
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
 * The ledger's key for each distinct stored URL. Exported so the batch can
 * spell its pool call as `scopedDb.liveRead.bytePlusAssets.getAdmission(...)`
 * at the call site — handing the domain object to a helper instead would hide
 * the read from the `no-mid-run-reads` audit.
 */
export async function arkAssetIdentities(
  storedUrls: readonly string[]
): Promise<string[]> {
  const unique = [...new Set(storedUrls.filter((url) => url.length > 0))];
  return Promise.all(unique.map((url) => hashAssetIdentity(url)));
}

/**
 * The lease owner for one workflow run. Prefixed by workflow so an owner
 * string in the ledger says which kind of run to look for.
 */
export function assetLeaseOwner(
  workflow: 'motion' | 'studio',
  instanceId: string
): string {
  return `${workflow}:${instanceId}`;
}

const ASSET_POOL_EXHAUSTED_MESSAGE =
  'BytePlus asset pool is full: every slot is held by a running shot. Retry once they finish.';

/** Thrown while another run is creating the same still; the step retries. */
const ASSET_PENDING_MESSAGE =
  'BytePlus is still registering this image for another shot. Retry in a few minutes.';

export type PooledAssetClaim =
  | { kind: 'hit'; uri: string }
  | { kind: 'reserved'; identity: string; evictedAssetId: string | null };

/**
 * Lease a pool slot for one still. `identity` is the STORED url — a one-off
 * fal scratch URL would burn a fresh slot on every submit. A hit is the
 * `asset://` to send; a reservation is the go-ahead to create (the workflow
 * waits for a CreateAsset token first, #1519). A still another run is
 * creating throws a retryable error so the claim step waits for that create
 * (40 × 30s). A full pool with nothing evictable throws `NonRetryableError`
 * — admission already waited, and the 20-minute claim budget cannot outlast
 * a 45-minute lease. There is no public-URL fallback.
 */
export async function claimPooledAsset(
  ledger: AssetPoolLedger,
  input: { identity: string; slot: BytePlusAssetSlot; owner: string }
): Promise<PooledAssetClaim> {
  const identity = await hashAssetIdentity(input.identity);
  const claim = await ledger.claimSlot({
    identity,
    slot: input.slot,
    owner: input.owner,
    capacity: bytePlusAssetSlots(),
    leaseMs: LEASE_TTL_MS,
  });
  switch (claim.kind) {
    case 'hit':
      reportBytePlusAssetPool({ outcome: 'hit', slot: input.slot });
      return { kind: 'hit', uri: `asset://${claim.assetId}` };
    case 'pending':
      throw new Error(ASSET_PENDING_MESSAGE);
    case 'exhausted':
      reportBytePlusAssetPool({ outcome: 'exhausted' });
      throw new NonRetryableError(ASSET_POOL_EXHAUSTED_MESSAGE);
    case 'reserved':
      return {
        kind: 'reserved',
        identity,
        evictedAssetId: claim.evictedAssetId,
      };
  }
}

/**
 * Delete the asset a reservation evicted. Its own step, so a failure retries
 * the delete and never moves on to create; once it has succeeded, a retried
 * create never deletes twice. A run that exhausts the retries leaves the asset
 * on Ark with no ledger row, which the hourly sweep deletes.
 *
 * An asset that is already gone is done, not a failure: the delete landed on
 * an attempt whose result was lost, or the sweep got there first. Ark's
 * not-found code is not documented, so a failed delete is settled by looking
 * for the asset in the group rather than by matching the error.
 */
export async function evictPooledAsset(
  config: BytePlusOpenApiConfig,
  input: { assetId: string; slot: BytePlusAssetSlot; groupId?: string }
): Promise<void> {
  try {
    await deleteAsset(config, input.assetId);
  } catch (error) {
    const groupId = await resolveAigcGroupId(config, input.groupId);
    const assets = await listAssetsInGroup(config, groupId);
    if (assets.some((asset) => asset.Id === input.assetId)) throw error;
    logger.info('BytePlus evicted asset was already deleted', {
      assetId: input.assetId,
    });
  }
  reportBytePlusAssetPool({ outcome: 'evicted', slot: input.slot });
}

/**
 * Create the asset a reservation from {@link claimPooledAsset} made room
 * for, and finalize the slot. Runs after the governor's CreateAsset token.
 */
export async function createPooledAsset(
  config: BytePlusOpenApiConfig,
  ledger: AssetPoolLedger,
  input: {
    claim: Extract<PooledAssetClaim, { kind: 'reserved' }>;
    owner: string;
    storedUrl: string;
    publicUrl: string;
    assetType: BytePlusAssetKind;
    slot: BytePlusAssetSlot;
    groupId?: string;
  }
): Promise<string> {
  // `ingestAigcAsset` checks Ark by name first, which is what makes a retried
  // create (lost response, crash before finalize) reuse the asset instead of
  // making a second one, and what heals a ledger that lost rows.
  const uri = await ingestAigcAsset(config, {
    identity: input.storedUrl,
    publicUrl: input.publicUrl,
    assetType: input.assetType,
    ...(input.groupId && { groupId: input.groupId }),
  });

  if (!uri.startsWith('asset://')) {
    throw new Error(`BytePlus CreateAsset returned an unexpected id: ${uri}`);
  }
  const assetId = uri.slice('asset://'.length);
  const finalized = await ledger.finalizeSlot({
    identity: input.claim.identity,
    owner: input.owner,
    assetId,
    slot: input.slot,
    leaseMs: LEASE_TTL_MS,
  });
  if (!finalized) {
    // Retrying would find the same other asset on the row every time.
    logger.warn('BytePlus slot already holds a different asset', {
      identity: input.claim.identity,
      owner: input.owner,
      assetId,
    });
    throw new NonRetryableError(
      'BytePlus registered this image twice at once. Retry the shot.'
    );
  }
  reportBytePlusAssetPool({ outcome: 'created', slot: input.slot });
  return uri;
}
