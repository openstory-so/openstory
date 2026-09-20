/**
 * PostHog events that drive the #generated-content Slack feed (#1667).
 *
 * Fired when media is actually persisted — not on create/start clicks — with
 * public HTTPS URLs Slack can fetch. Failures never break the generation path.
 */

import { captureProductEvent } from './product-events';
import { toShareableUrl } from '@/platform/server/storage/buckets';
import { SITE_CONFIG } from '@/ui/marketing/constants';

const PROMPT_MAX = 280;

function appOrigin(): string {
  return SITE_CONFIG.url.replace(/\/$/, '');
}

function shareable(url: string): string {
  return toShareableUrl(url, appOrigin());
}

function truncatePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.length <= PROMPT_MAX) return trimmed;
  return `${trimmed.slice(0, PROMPT_MAX - 1)}…`;
}

export type StudioGenerationCompletedArgs = {
  distinctId: string;
  teamId: string;
  assetId: string;
  activity: 'image' | 'video';
  model: string;
  mediaUrl: string;
  contentType: string;
  prompt: string;
  aspectRatio: string;
  duration?: number;
};

export function captureStudioGenerationCompleted(
  args: StudioGenerationCompletedArgs
): void {
  const origin = appOrigin();
  const mediaUrl = shareable(args.mediaUrl);
  captureProductEvent({
    distinctId: args.distinctId,
    event: 'studio_generation_completed',
    properties: {
      team_id: args.teamId,
      activity: args.activity,
      asset_id: args.assetId,
      model: args.model,
      media_url: mediaUrl,
      ...(args.activity === 'image' && { preview_url: mediaUrl }),
      watch_url: `${origin}/${args.activity === 'image' ? 'images' : 'videos'}`,
      prompt: truncatePrompt(args.prompt),
      aspect_ratio: args.aspectRatio,
      content_type: args.contentType,
      ...(args.duration != null && { duration: args.duration }),
    },
  });
}

export type SequenceContentReadyArgs = {
  distinctId: string;
  teamId: string;
  sequenceId: string;
  title: string;
  watchUrl: string;
  posterUrl?: string | null;
};

export function captureSequenceContentReady(
  args: SequenceContentReadyArgs
): void {
  const origin = appOrigin();
  const posterUrl = args.posterUrl ? shareable(args.posterUrl) : undefined;
  captureProductEvent({
    distinctId: args.distinctId,
    event: 'sequence_content_ready',
    properties: {
      team_id: args.teamId,
      sequence_id: args.sequenceId,
      title: args.title,
      watch_url: args.watchUrl,
      ...(posterUrl && { poster_url: posterUrl }),
      preview_url: posterUrl ?? `${origin}/og.jpg`,
    },
  });
}
