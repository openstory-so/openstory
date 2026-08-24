/**
 * Upload-Post client (#1267) — the thin HTTP layer behind "Publish to social"
 * in the theatre. Upload-Post (https://www.upload-post.com) fans one video out
 * to TikTok, Instagram, YouTube, X, LinkedIn, … from a single request, so the
 * app never talks to the platforms' own APIs.
 *
 * Server-only: the caller resolves the team's `upload_post` key via
 * `scopedDb.apiKeys` and passes it in. Nothing here touches D1.
 */

const UPLOAD_POST_API_URL = 'https://api.upload-post.com';

/**
 * Video platforms the publish dialog offers. Upload-Post supports more
 * (Pinterest, Reddit, Discord, Telegram, …) but those need extra per-platform
 * parameters (board id, subreddit, channel) that the first cut doesn't collect.
 * The key is Upload-Post's `platform[]` value and doubles as the key of a
 * profile's `social_accounts` map.
 */
export const SOCIAL_PLATFORMS = [
  { id: 'tiktok', label: 'TikTok' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'x', label: 'X' },
  { id: 'threads', label: 'Threads' },
  { id: 'bluesky', label: 'Bluesky' },
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number]['id'];
export const SOCIAL_PLATFORM_IDS = SOCIAL_PLATFORMS.map((p) => p.id);

export type SocialProfile = {
  username: string;
  /** Platforms with a connected account, filtered to `SOCIAL_PLATFORMS`. */
  platforms: SocialPlatform[];
};

export type PublishResult = {
  requestId: string;
};

type PlatformPublishResult = {
  platform: string;
  success: boolean;
  postUrl: string | null;
  error: string | null;
};

export type PublishStatus = {
  status:
    | 'pending'
    | 'queued'
    | 'processing'
    | 'in_progress'
    | 'completed'
    | 'failed'
    | 'not_found';
  /** Top-level message (e.g. why a job was marked failed). */
  message: string | null;
  results: PlatformPublishResult[];
};

function authHeaders(apiKey: string): HeadersInit {
  // Upload-Post keys are sent with the `Apikey` scheme, never `Bearer`.
  return { Authorization: `Apikey ${apiKey}` };
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'message' in parsed &&
      typeof parsed.message === 'string'
    ) {
      return parsed.message;
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'error' in parsed &&
      typeof parsed.error === 'string'
    ) {
      return parsed.error;
    }
  } catch {
    // not JSON — fall through to the raw body
  }
  return text.slice(0, 300) || `Upload-Post returned ${response.status}`;
}

/** Key check used by `validateKey('upload_post', …)` — 200 = live key. */
export async function validateUploadPostKey(
  apiKey: string
): Promise<{ valid: boolean; error?: string }> {
  const response = await fetch(`${UPLOAD_POST_API_URL}/api/uploadposts/users`, {
    headers: authHeaders(apiKey),
  });
  if (response.ok) return { valid: true };
  return { valid: false, error: `Upload-Post returned ${response.status}` };
}

function isSocialPlatform(value: string): value is SocialPlatform {
  return (SOCIAL_PLATFORM_IDS as readonly string[]).includes(value);
}

/**
 * Parse `GET /api/uploadposts/users`. A platform counts as connected when its
 * entry is a non-null object — Upload-Post returns `""`/`null` for a platform
 * that was added to the profile but never linked.
 */
export function parseProfiles(payload: unknown): SocialProfile[] {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('profiles' in payload) ||
    !Array.isArray(payload.profiles)
  ) {
    return [];
  }
  const profiles: SocialProfile[] = [];
  for (const entry of payload.profiles) {
    if (typeof entry !== 'object' || entry === null) continue;
    if (!('username' in entry) || typeof entry.username !== 'string') continue;
    const accounts =
      'social_accounts' in entry &&
      typeof entry.social_accounts === 'object' &&
      entry.social_accounts !== null
        ? entry.social_accounts
        : {};
    const platforms = Object.entries(accounts)
      .filter(
        ([platform, account]) =>
          isSocialPlatform(platform) &&
          typeof account === 'object' &&
          account !== null
      )
      .map(([platform]) => platform)
      .filter(isSocialPlatform)
      // Keep the dialog's order stable regardless of the API's map order.
      .sort(
        (a, b) =>
          SOCIAL_PLATFORM_IDS.indexOf(a) - SOCIAL_PLATFORM_IDS.indexOf(b)
      );
    profiles.push({ username: entry.username, platforms });
  }
  return profiles;
}

export async function listUploadPostProfiles(
  apiKey: string
): Promise<SocialProfile[]> {
  const response = await fetch(`${UPLOAD_POST_API_URL}/api/uploadposts/users`, {
    headers: authHeaders(apiKey),
  });
  if (!response.ok) {
    throw new Error(
      `Could not load Upload-Post profiles: ${await readErrorMessage(response)}`
    );
  }
  return parseProfiles(await response.json());
}

export type PublishVideoInput = {
  /** Upload-Post profile username. */
  profile: string;
  platforms: SocialPlatform[];
  /** Publicly fetchable MP4 URL — Upload-Post downloads it server-side. */
  videoUrl: string;
  title: string;
  description?: string;
  /** Echoed back by status/history so a post maps to its export row. */
  externalId: string;
};

/**
 * `POST /api/upload` with `async_upload=true`: returns as soon as the job is
 * accepted; the per-platform outcome comes from `getUploadPostStatus`.
 * `is_ai_generated` is always on — every frame OpenStory exports is AI
 * generated, and TikTok/Instagram require the label.
 */
export async function publishUploadPostVideo(
  apiKey: string,
  input: PublishVideoInput
): Promise<PublishResult> {
  const form = new FormData();
  form.set('user', input.profile);
  for (const platform of input.platforms) form.append('platform[]', platform);
  form.set('video', input.videoUrl);
  form.set('title', input.title);
  if (input.description) form.set('description', input.description);
  form.set('external_id', input.externalId);
  form.set('is_ai_generated', 'true');
  form.set('async_upload', 'true');

  const response = await fetch(`${UPLOAD_POST_API_URL}/api/upload`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Publish failed: ${await readErrorMessage(response)}`);
  }
  const payload: unknown = await response.json();
  const requestId =
    typeof payload === 'object' &&
    payload !== null &&
    'request_id' in payload &&
    typeof payload.request_id === 'string'
      ? payload.request_id
      : null;
  if (!requestId) {
    throw new Error(
      'Upload-Post accepted the upload but returned no request_id'
    );
  }
  return { requestId };
}

const TOP_LEVEL_STATUSES: readonly PublishStatus['status'][] = [
  'pending',
  'queued',
  'processing',
  'in_progress',
  'completed',
  'failed',
  'not_found',
];

function readString(obj: object, key: string): string | null {
  if (!(key in obj)) return null;
  const value: unknown = Reflect.get(obj, key);
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Parse `GET /api/uploadposts/status`. `results` is an array with one entry
 * per platform that has finished (`success`, `post_url`, `error_message`);
 * platforms still in flight simply aren't listed yet. A TikTok upload that
 * fell back to the inbox (daily active-user cap) is a success with a
 * placeholder instead of a link — surfaced as `postUrl: null`.
 */
export function parsePublishStatus(payload: unknown): PublishStatus {
  if (typeof payload !== 'object' || payload === null) {
    return { status: 'failed', message: null, results: [] };
  }
  const rawStatus = readString(payload, 'status');
  const status = TOP_LEVEL_STATUSES.find((s) => s === rawStatus) ?? 'pending';

  const results: PlatformPublishResult[] = [];
  const rawResults =
    'results' in payload && Array.isArray(payload.results)
      ? payload.results
      : [];
  for (const entry of rawResults) {
    if (typeof entry !== 'object' || entry === null) continue;
    const platform = readString(entry, 'platform');
    if (!platform) continue;
    const postUrl = readString(entry, 'post_url');
    results.push({
      platform,
      success: Reflect.get(entry, 'success') === true,
      postUrl: postUrl && /^https?:\/\//.test(postUrl) ? postUrl : null,
      error: readString(entry, 'error_message') ?? readString(entry, 'error'),
    });
  }
  return { status, message: readString(payload, 'message'), results };
}

export async function getUploadPostStatus(
  apiKey: string,
  requestId: string
): Promise<PublishStatus> {
  const url = new URL(`${UPLOAD_POST_API_URL}/api/uploadposts/status`);
  url.searchParams.set('request_id', requestId);
  const response = await fetch(url, { headers: authHeaders(apiKey) });
  if (response.status === 404) {
    return { status: 'not_found', message: null, results: [] };
  }
  if (!response.ok) {
    throw new Error(
      `Could not read publish status: ${await readErrorMessage(response)}`
    );
  }
  return parsePublishStatus(await response.json());
}
