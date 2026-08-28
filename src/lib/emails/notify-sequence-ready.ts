/**
 * Send the "your video is ready" email once per sequence (#1276).
 *
 * Dedup key is `${sequenceId}:ready`, stored as `sequences.readyEmailSentAt`
 * via a CAS claim so workflow step retries and smart-retry re-completes
 * cannot double-send.
 */

import { TYPICAL_SHORT_COST_USD } from '@/lib/billing/constants';
import { microsToDisplayUsd } from '@/lib/billing/money';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { SITE_CONFIG } from '@/lib/marketing/constants';
import { captureProductEvent } from '@/lib/observability/product-events';
import { sumShotDurationsSeconds } from '@/lib/sequences/shot-durations';
import { sendSequenceReadyEmail } from '@/lib/services/email-service';
import { toShareableUrl } from '@/lib/storage/buckets';

export function sequenceReadyDedupKey(sequenceId: string): string {
  return `${sequenceId}:ready`;
}

export function sequenceScenesUrl(sequenceId: string): string {
  return `${SITE_CONFIG.url.replace(/\/$/, '')}/sequences/${sequenceId}/scenes`;
}

function withReadyUtm(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('utm_source', 'email');
  parsed.searchParams.set('utm_campaign', 'ready');
  return parsed.toString();
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function formatClipMeta(
  clipCount: number,
  durationSeconds: number
): string | undefined {
  if (clipCount <= 0) return undefined;
  const clips = clipCount === 1 ? '1 clip' : `${clipCount} clips`;
  const duration = formatDuration(durationSeconds);
  return duration ? `${clips} · ${duration}` : clips;
}

export type NotifySequenceReadyOpts = {
  scopedDb: WorkflowScopedDb;
  sequenceId: string;
  ownerEmail: string | null | undefined;
  title: string;
  sequenceUrl: string;
  posterUrl?: string | null;
  /** When false, skip (API-key `/api/v1` callers poll). */
  notify?: boolean;
  userId: string;
};

export async function notifySequenceReady(
  opts: NotifySequenceReadyOpts
): Promise<'sent' | 'skipped'> {
  if (opts.notify === false) return 'skipped';
  if (!opts.ownerEmail) return 'skipped';

  const claimed = await opts.scopedDb.sequences.claimReadyEmailSend(
    opts.sequenceId
  );
  if (!claimed) return 'skipped';

  try {
    const shots = await opts.scopedDb.liveRead.shots.listBySequence(
      opts.sequenceId
    );
    const balance = await opts.scopedDb.liveRead.billing.getBalance();
    const origin = SITE_CONFIG.url.replace(/\/$/, '');
    const posterUrl = opts.posterUrl
      ? toShareableUrl(opts.posterUrl, origin)
      : undefined;

    const result = await sendSequenceReadyEmail({
      to: opts.ownerEmail,
      title: opts.title,
      watchUrl: withReadyUtm(opts.sequenceUrl),
      creditsUrl: withReadyUtm(`${origin}/credits`),
      posterUrl,
      clipMeta: formatClipMeta(shots.length, sumShotDurationsSeconds(shots)),
      balanceDisplay: microsToDisplayUsd(balance),
      typicalShortCostDisplay: `~$${TYPICAL_SHORT_COST_USD}`,
    });

    if (!result.success) {
      throw new Error(result.error ?? 'Failed to send ready email');
    }

    captureProductEvent({
      distinctId: opts.userId,
      event: 'sequence_ready_email_sent',
      properties: { sequence_id: opts.sequenceId },
    });
    return 'sent';
  } catch (error) {
    await opts.scopedDb.sequences.releaseReadyEmailSend(opts.sequenceId);
    throw error;
  }
}
