/**
 * Register stills in the BytePlus virtual portrait library as durable
 * workflow steps (#1519).
 *
 * `CreateAsset` is allowed THREE times a minute per account. The wait for a
 * turn is therefore minutes, not milliseconds, and it must not hold a Worker
 * open or eat a step's 10-minute budget. Per still:
 *
 *   claim   step.do   lease a pool slot; a hit is done (no create needed)
 *   slot    step.do   reserve a CreateAsset token in the governor DO
 *   wait    step.sleep  the token's delay — durable, free while idle
 *   create  step.do   CreateAsset + poll Active + record the slot
 *
 * `step.sleep` rather than an event: with a token bucket the delay is known
 * at reservation time, so an alarm that later sent an event could only tell
 * the workflow what it was already told. No alarm, no race with a wait that
 * has not been reached yet.
 *
 * Nothing here falls back. A full pool, a refused token, a failed create —
 * each fails the shot with its own message.
 */

import type { WorkflowStep } from 'cloudflare:workers';
import type { CredentialScopedDb } from '@/lib/db/scoped-workflow';
import type { BytePlusAssetSlot } from '@/lib/db/schema/byteplus-assets';
import { isHttpUrl, toArkFetchableUrl } from './byteplus-asset-ingest';
import {
  claimPooledAsset,
  createPooledAsset,
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
};

/** Stored URL → the URL Ark receives (`asset://…`, or a plain fetchable URL). */
export type ArkAssetMap = Record<string, string>;

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
    credentials: CredentialScopedDb;
  }
): Promise<ArkAssetMap> {
  const map: ArkAssetMap = {};
  // Sequential on purpose: the batch already fans shots out, and the token
  // bucket orders callers by arrival.
  for (const [index, still] of args.stills.entries()) {
    if (map[still.storedUrl]) continue;
    const name = `${args.prefix}-ark-${index}`;

    const claim = await step.do(
      `${name}-claim`,
      async (): Promise<ClaimOutcome> => {
        const falKey = await args.credentials.resolveOptionalKey('fal');
        const publicUrl = await toArkFetchableUrl(still.storedUrl, falKey?.key);
        // No IAM keys, or a data URI CreateAsset cannot fetch: Ark gets the
        // URL as is and decides. That is the documented no-ACR path, not a
        // fallback from a failed ingest.
        if (!bytePlusOpenApiConfig() || !isHttpUrl(publicUrl)) {
          return { ready: publicUrl };
        }
        const pooled = await claimPooledAsset(args.ledger, {
          identity: still.storedUrl,
          slot: still.slot,
        });
        if (pooled.kind === 'hit') return { ready: pooled.uri };
        return { pending: { claim: pooled, publicUrl } };
      }
    );

    if ('ready' in claim) {
      map[still.storedUrl] = claim.ready;
      continue;
    }

    const delayMs = await step.do(`${name}-slot`, () =>
      reserveBytePlusCreateSlot()
    );
    if (delayMs > 0) await step.sleep(`${name}-wait`, delayMs);

    map[still.storedUrl] = await step.do(`${name}-create`, async () => {
      const config = bytePlusOpenApiConfig();
      if (!config) {
        throw new Error('BytePlus IAM keys were removed mid-run');
      }
      return createPooledAsset(
        {
          accessKey: config.accessKey,
          secretKey: config.secretKey,
          host: config.host,
        },
        args.ledger,
        {
          claim: claim.pending.claim,
          storedUrl: still.storedUrl,
          publicUrl: claim.pending.publicUrl,
          assetType: still.kind ?? 'Image',
          slot: still.slot,
          groupId: config.groupId,
        }
      );
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
