/**
 * Publish to social (#1267) — the client-safe half: which platforms the dialog
 * offers, the input schema, the request id, and the shapes the server fns
 * return. The HTTP client lives in `server/social/upload-post.ts`; the server
 * fns in `social-publish.fn.ts`.
 *
 * Publishing is opt-in per team: the menu item and the server fns are inert
 * until the team has saved an Upload-Post key in Settings → API Keys.
 */

import { z } from 'zod';
import { sha256Hex } from '@/shots/input-hash';

/**
 * Video platforms the dialog offers. Upload-Post supports more (Pinterest,
 * Reddit, …) but those need extra per-platform fields this first cut doesn't
 * collect. The id is Upload-Post's `platform[]` value and doubles as the key
 * of a profile's `social_accounts` map. `captionMax` is the platform's limit
 * on the caption (the YouTube title, the X post, …), capped at 2200 where the
 * platform allows more.
 */
export const SOCIAL_PLATFORMS = [
  { id: 'tiktok', label: 'TikTok', captionMax: 2200 },
  { id: 'instagram', label: 'Instagram', captionMax: 2200 },
  { id: 'youtube', label: 'YouTube', captionMax: 100 },
  { id: 'facebook', label: 'Facebook', captionMax: 2200 },
  { id: 'linkedin', label: 'LinkedIn', captionMax: 2200 },
  { id: 'x', label: 'X', captionMax: 280 },
  { id: 'threads', label: 'Threads', captionMax: 500 },
  { id: 'bluesky', label: 'Bluesky', captionMax: 300 },
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number]['id'];
const SOCIAL_PLATFORM_IDS = SOCIAL_PLATFORMS.map((p) => p.id);

export function socialPlatformLabel(id: string): string {
  return SOCIAL_PLATFORMS.find((p) => p.id === id)?.label ?? id;
}

/** The tightest caption limit among `platforms`, and whose it is. */
export function captionLimit(
  platforms: readonly SocialPlatform[]
): { max: number; label: string } | null {
  let limit: { max: number; label: string } | null = null;
  for (const p of SOCIAL_PLATFORMS) {
    if (!platforms.includes(p.id)) continue;
    if (!limit || p.captionMax < limit.max) {
      limit = { max: p.captionMax, label: p.label };
    }
  }
  return limit;
}

export const YOUTUBE_PRIVACY = ['private', 'unlisted', 'public'] as const;
export type YoutubePrivacy = (typeof YOUTUBE_PRIVACY)[number];
export const YOUTUBE_PRIVACY_LABELS: Record<YoutubePrivacy, string> = {
  private: 'Private',
  unlisted: 'Unlisted',
  public: 'Public',
};

/**
 * TikTok decides per account which visibilities exist, so the only choices
 * offered are the account's own default and "only me" (always available).
 */
export const TIKTOK_PRIVACY = ['account_default', 'SELF_ONLY'] as const;
export type TiktokPrivacy = (typeof TIKTOK_PRIVACY)[number];
export const TIKTOK_PRIVACY_LABELS: Record<TiktokPrivacy, string> = {
  account_default: "Account's default",
  SELF_ONLY: 'Only me',
};

const DESCRIPTION_MAX = 5000;

export const publishInputSchema = z
  .object({
    sequenceId: z.string(),
    exportId: z.string(),
    profile: z.string().trim().min(1, 'Pick an Upload-Post profile'),
    platforms: z
      .array(z.enum(SOCIAL_PLATFORM_IDS))
      .min(1, 'Pick at least one platform'),
    title: z.string().trim().min(1, 'A caption is required'),
    /** `''` means no description. */
    description: z.string().trim().max(DESCRIPTION_MAX),
    youtubePrivacy: z.enum(YOUTUBE_PRIVACY),
    tiktokPrivacy: z.enum(TIKTOK_PRIVACY),
  })
  .superRefine((input, ctx) => {
    const limit = captionLimit(input.platforms);
    if (limit && input.title.length > limit.max) {
      ctx.addIssue({
        code: 'custom',
        message: `${limit.label} captions are limited to ${limit.max} characters`,
        path: ['title'],
      });
    }
  });
export type PublishInput = z.output<typeof publishInputSchema>;

export const PUBLISH_REQUEST_ID_RE = /^openstory-[0-9a-f]{32}$/;

/**
 * Stable id for one publish, derived from every value the user reviewed:
 * team, export, profile, platforms, caption, description and the visibility
 * of the platforms that use one. The same post always yields the same id, so
 * a double click, a retry or a re-opened dialog finds the earlier request
 * instead of posting again; anything changed yields a new, separately
 * reviewed publish. Shared by the server (which sends it) and the dialog
 * (which tracks it when the server's reply is lost).
 */
export async function derivePublishRequestId(
  input: PublishInput & { teamId: string }
): Promise<string> {
  const hex = await sha256Hex({
    v: 1,
    teamId: input.teamId,
    exportId: input.exportId,
    profile: input.profile,
    platforms: [...input.platforms].sort(),
    title: input.title,
    description: input.description,
    youtubePrivacy: input.platforms.includes('youtube')
      ? input.youtubePrivacy
      : null,
    tiktokPrivacy: input.platforms.includes('tiktok')
      ? input.tiktokPrivacy
      : null,
  });
  return `openstory-${hex.slice(0, 32)}`;
}

export type SocialProfile = {
  username: string;
  /** Platforms with a connected account, in `SOCIAL_PLATFORMS` order. */
  platforms: SocialPlatform[];
};

/**
 * Outcome of the publish call itself (not of each platform):
 *   - `submitted`   Upload-Post accepted the request.
 *   - `resumed`     Upload-Post already has this exact post; nothing was sent.
 *   - `unconfirmed` the call ended in a way that doesn't say whether
 *                   Upload-Post got it (5xx, 408/409, timeout, dropped
 *                   connection). Nothing is re-sent automatically; the dialog
 *                   keeps polling the same request id.
 *   - `not_sent`    nothing was sent, for certain: refused before sending, or
 *                   a 4xx that proves Upload-Post refused it. The user may fix
 *                   it and try again.
 */
export type PublishOutcome =
  | { state: 'submitted' | 'resumed' | 'unconfirmed'; requestId: string }
  | { state: 'not_sent'; message: string };

export type PlatformPublishResult = {
  /** Upload-Post's platform id; may be one the dialog doesn't offer. */
  platform: string;
  state: 'published' | 'failed' | 'skipped' | 'pending';
  /** Public post URL, when the platform returned one. */
  url: string | null;
  /** Why there is no URL (e.g. a private post, a TikTok inbox draft). */
  note: string | null;
  error: string | null;
};

export type PublishStatus = {
  /**
   * Upload-Post's top-level status: `running` while it is pending, queued or
   * processing; `done` once completed; `failed` when the request failed.
   */
  state: 'running' | 'done' | 'failed' | 'not_found';
  message: string | null;
  results: PlatformPublishResult[];
};
