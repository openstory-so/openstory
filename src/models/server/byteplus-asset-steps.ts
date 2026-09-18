/**
 * Register stills in the BytePlus virtual portrait library as durable
 * workflow steps (#1519).
 *
 * `CreateAsset` is allowed THREE times a minute per account. The wait for a
 * turn is therefore minutes, not milliseconds, and it must not hold a Worker
 * open or eat a step's 10-minute budget. Per still:
 *
 *   url     step.do   the URL CreateAsset can fetch (fal key, upload)
 *   claim   step.do   lease the still; a hit is done (no create needed).
 *                     Retries while another run is creating the same still
 *   evict   step.do   DeleteAsset the slot's previous asset, if it had one
 *   slot    step.do   reserve a CreateAsset token in the governor DO
 *   wait    step.sleep  the token's delay — durable, free while idle
 *   create  step.do   CreateAsset + poll Active + finalize the slot
 *
 * Every lease and reservation is held by `owner` (the workflow run), and the
 * run releases them all by owner on both exits (#1531).
 *
 * `step.sleep` rather than an event: with a token bucket the delay is known
 * at reservation time, so an alarm that later sent an event could only tell
 * the workflow what it was already told. No alarm, no race with a wait that
 * has not been reached yet.
 *
 * Nothing here falls back. A still another run is creating waits out the
 * claim step's retries; a full leased pool, a refused token, or a failed
 * create fails the shot immediately.
 */

import type { WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import type { CredentialScopedDb } from '@/platform/server/db/scoped-workflow';
import type { BytePlusAssetSlot } from '@/platform/server/db/schema/byteplus-assets';
import { isHttpUrl, toArkFetchableUrl } from './byteplus-asset-ingest';
import { assertArkCreateAssetSize } from './byteplus-asset-size';
import {
  claimPooledAsset,
  createPooledAsset,
  evictPooledAsset,
  type AssetPoolLedger,
  type PooledAssetClaim,
} from './byteplus-asset-pool';
import type { BytePlusAssetKind } from './byteplus-assets';
import { bytePlusOpenApiConfig } from './byteplus-config';
import { reserveBytePlusCreateSlot } from './byteplus-governor';

export type ArkStill = {
  /** The stored URL — the pool's identity and the map's key. */
  storedUrl: string;
  slot: BytePlusAssetSlot;
  kind?: BytePlusAssetKind;
  /**
   * Known to show no person: map it to a fetchable URL and spend no
   * CreateAsset on it (#1674). Only a still with a face needs the portrait
   * library.
   */
  plain?: boolean;
};

/** Stored URL → the URL Ark receives (`asset://…`, or a plain fetchable URL). */
export type ArkAssetMap = Record<string, string>;

/**
 * The claim throws while another run is creating the same still. Wait out
 * that create: up to the governor's 15-minute CreateAsset queue plus the
 * create itself. A full leased pool is `NonRetryableError` and does not
 * sit here. Nothing else runs in this step, so a permanent error elsewhere
 * (a bad fal key, an upload) never waits this long. The motion batch's
 * child timeout budgets for the pending wait.
 */
const CLAIM_RETRIES: WorkflowStepConfig = {
  retries: { limit: 40, delay: '30 seconds', backoff: 'constant' },
};

function requireConfig() {
  const config = bytePlusOpenApiConfig();
  if (!config) throw new Error('BytePlus IAM keys were removed mid-run');
  return config;
}

type ClaimOutcome =
  | { ready: string }
  | {
      pending: {
        claim: Extract<PooledAssetClaim, { kind: 'reserved' }>;
        publicUrl: string;
      };
    };

export async function ingestArkAssets(
  step: WorkflowStep,
  args: {
    /** Unique per call site AND attempt — step names must not repeat. */
    prefix: string;
    stills: ArkStill[];
    ledger: AssetPoolLedger;
    /** The run holding the leases — see `assetLeaseOwner`. */
    owner: string;
    credentials: CredentialScopedDb;
  }
): Promise<ArkAssetMap> {
  const map: ArkAssetMap = {};
  // Sequential on purpose: the batch already fans shots out, and the token
  // bucket orders callers by arrival.
  for (const [index, still] of args.stills.entries()) {
    if (map[still.storedUrl]) continue;
    const name = `${args.prefix}-ark-${index}`;

    if (still.plain) {
      map[still.storedUrl] = await step.do(`${name}-plain-url`, async () => {
        const falKey = await args.credentials.resolveOptionalKey('fal');
        return toArkFetchableUrl(still.storedUrl, falKey?.key);
      });
      continue;
    }

    const publicUrl = await step.do(`${name}-url`, async () => {
      const falKey = await args.credentials.resolveOptionalKey('fal');
      await assertArkCreateAssetSize(still.storedUrl);
      return toArkFetchableUrl(still.storedUrl, falKey?.key);
    });

    // Same name and result shape as before the url step split off, so a run
    // in flight across the deploy replays its cached claim.
    const claim = await step.do(
      `${name}-claim`,
      CLAIM_RETRIES,
      async (): Promise<ClaimOutcome> => {
        // No IAM keys, or a data URI CreateAsset cannot fetch: Ark gets the
        // URL as is and decides. That is the documented no-ACR path, not a
        // fallback from a failed ingest.
        if (!bytePlusOpenApiConfig() || !isHttpUrl(publicUrl)) {
          return { ready: publicUrl };
        }
        const pooled = await claimPooledAsset(args.ledger, {
          identity: still.storedUrl,
          slot: still.slot,
          owner: args.owner,
        });
        if (pooled.kind === 'hit') return { ready: pooled.uri };
        return { pending: { claim: pooled, publicUrl } };
      }
    );

    if ('ready' in claim) {
      map[still.storedUrl] = claim.ready;
      continue;
    }

    const { evictedAssetId } = claim.pending.claim;
    if (evictedAssetId) {
      await step.do(`${name}-evict`, async () => {
        const config = requireConfig();
        await evictPooledAsset(config, {
          assetId: evictedAssetId,
          slot: still.slot,
          groupId: config.groupId,
        });
      });
    }

    const delayMs = await step.do(`${name}-slot`, () =>
      reserveBytePlusCreateSlot()
    );
    if (delayMs > 0) await step.sleep(`${name}-wait`, delayMs);

    map[still.storedUrl] = await step.do(`${name}-create`, async () => {
      const config = requireConfig();
      return createPooledAsset(config, args.ledger, {
        claim: claim.pending.claim,
        owner: args.owner,
        storedUrl: still.storedUrl,
        publicUrl: claim.pending.publicUrl,
        assetType: still.kind ?? 'Image',
        slot: still.slot,
        groupId: config.groupId,
      });
    });
  }
  return map;
}

/**
 * The URL Ark receives for a still the workflow registered. Throws when the
 * map does not cover it — the submit path never re-derives or degrades.
 */
export function arkUrlFor(map: ArkAssetMap, storedUrl: string): string {
  const url = map[storedUrl];
  if (!url) {
    throw new Error(
      `Still was not registered for BytePlus before submit: ${storedUrl}`
    );
  }
  return url;
}
