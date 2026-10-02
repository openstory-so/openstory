/**
 * Upload-Post client (#1267) — the HTTP layer behind "Publish to social".
 * Upload-Post (https://www.upload-post.com) fans one video out to TikTok,
 * Instagram, YouTube, X, LinkedIn, … from a single request, so the app never
 * talks to the platforms' own APIs.
 *
 * The video is handed over by URL with `async_upload=true`: Upload-Post
 * fetches the rendered MP4 itself and answers within seconds, so the Worker
 * never streams the file and never waits on the platforms.
 *
 * A publish must not happen twice. The request id is derived from every value
 * the user reviewed (`derivePublishRequestId`), is sent as the
 * `Idempotency-Key`, and is looked up before anything is sent — and if that
 * lookup cannot answer, nothing is sent. Only a 4xx that proves the request
 * was refused is reported as `not_sent`; a 5xx, a dropped connection or a
 * timeout says nothing about whether the post was created, so it is reported
 * as `unconfirmed` and never re-sent automatically.
 *
 * Status replies follow https://docs.upload-post.com/api/upload-status/. A
 * reply in any other shape throws rather than being guessed at.
 *
 * Server-only: the caller resolves the team's `upload_post` key and passes it
 * in. Nothing here touches D1.
 */

import { getLogger } from '@/platform/logger';
import {
  SOCIAL_PLATFORMS,
  type PlatformPublishResult,
  type PublishInput,
  type PublishOutcome,
  type PublishStatus,
  type SocialProfile,
} from '@/sequences/social-publish';

const logger = getLogger(['openstory', 'social', 'upload-post']);

const UPLOAD_POST_API_URL = 'https://api.upload-post.com';

// The publish call hands over a URL, so Upload-Post answers in seconds; a
// call still open after this is treated as unconfirmed rather than failed.
const PUBLISH_TIMEOUT_MS = 25_000;
const READ_TIMEOUT_MS = 15_000;

/**
 * Statuses that prove Upload-Post refused the request before creating
 * anything. Everything else non-2xx (5xx, 408, 409, …) is ambiguous.
 */
const DEFINITIVE_REJECTIONS = new Set([400, 401, 402, 403, 404, 413, 422, 429]);

const RUNNING_STATUSES = new Set([
  'pending',
  'queued',
  'processing',
  'in_progress',
]);
// Per platform; Upload-Post retries `retryable` ones itself.
const PENDING_PLATFORM_STATUSES = new Set([
  'queued',
  'processing',
  'retryable',
]);

function authHeaders(apiKey: string): Record<string, string> {
  // Upload-Post keys use the `Apikey` scheme, never `Bearer`.
  return { Authorization: `Apikey ${apiKey}` };
}

function readString(obj: object, key: string): string | null {
  const value: unknown = Reflect.get(obj, key);
  return typeof value === 'string' && value !== '' ? value : null;
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      const message =
        readString(parsed, 'message') ?? readString(parsed, 'error');
      if (message) return message;
    }
  } catch {
    // not JSON — fall through to the raw body
  }
  return text.slice(0, 300) || `Upload-Post returned ${response.status}`;
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
    throw new Error('Unexpected reply from Upload-Post: no profiles list');
  }
  const profiles: SocialProfile[] = [];
  for (const entry of payload.profiles) {
    if (typeof entry !== 'object' || entry === null) continue;
    const username = readString(entry, 'username');
    if (!username) continue;
    const accounts: unknown = Reflect.get(entry, 'social_accounts');
    const platforms =
      typeof accounts === 'object' && accounts !== null
        ? SOCIAL_PLATFORMS.map((p) => p.id).filter((id) => {
            const account: unknown = Reflect.get(accounts, id);
            return typeof account === 'object' && account !== null;
          })
        : [];
    profiles.push({ username, platforms });
  }
  return profiles;
}

export async function listUploadPostProfiles(
  apiKey: string
): Promise<SocialProfile[]> {
  const response = await fetch(`${UPLOAD_POST_API_URL}/api/uploadposts/users`, {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Could not load Upload-Post profiles (${response.status}): ${await readErrorMessage(response)}`
    );
  }
  return parseProfiles(await response.json());
}

function platformState(entry: object): PlatformPublishResult['state'] {
  const status = readString(entry, 'status');
  if (Reflect.get(entry, 'skipped') === true || status === 'skipped') {
    return 'skipped';
  }
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'published';
  if (status !== null) {
    // Queued, processing, retryable — or a status this client doesn't know
    // yet, which is not proof of failure.
    if (!PENDING_PLATFORM_STATUSES.has(status)) {
      logger.warn('Unknown Upload-Post platform status', { status });
    }
    return 'pending';
  }
  return Reflect.get(entry, 'success') === true ? 'published' : 'failed';
}

function parsePlatformResult(entry: object): PlatformPublishResult | null {
  const platform = readString(entry, 'platform');
  if (!platform) {
    logger.warn('Upload-Post platform result without a platform');
    return null;
  }
  const state = platformState(entry);
  const rawUrl = readString(entry, 'post_url') ?? readString(entry, 'url');
  const url = rawUrl && /^https?:\/\//.test(rawUrl) ? rawUrl : null;

  let note: string | null = url ? null : rawUrl;
  if (state === 'skipped') {
    note = readString(entry, 'skip_reason') ?? 'Skipped by Upload-Post.';
  } else if (Reflect.get(entry, 'fallback_to_inbox') === true) {
    note =
      'Sent to the TikTok inbox as a draft — publish it from the TikTok app.';
  }

  const error =
    readString(entry, 'error_message') ??
    readString(entry, 'error') ??
    readString(entry, 'message');
  return {
    platform,
    state,
    url,
    note,
    error: state === 'failed' ? (error ?? 'Publishing failed') : null,
  };
}

/**
 * Parse `GET /api/uploadposts/status`. Platforms still in flight may not be
 * listed yet; the top-level status says whether more are coming. Throws on a
 * status it doesn't recognise, so nothing downstream mistakes an unreadable
 * reply for "already sent".
 */
export function parsePublishStatus(payload: unknown): PublishStatus {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Unexpected Upload-Post status reply');
  }
  const raw = readString(payload, 'status');
  let state: PublishStatus['state'];
  if (raw === 'not_found') state = 'not_found';
  else if (raw === 'completed') state = 'done';
  else if (raw === 'failed') state = 'failed';
  else if (raw !== null && RUNNING_STATUSES.has(raw)) state = 'running';
  else throw new Error(`Unexpected Upload-Post status: ${raw ?? 'none'}`);

  const results: PlatformPublishResult[] = [];
  const rawResults: unknown = Reflect.get(payload, 'results');
  if (Array.isArray(rawResults)) {
    for (const entry of rawResults) {
      if (typeof entry !== 'object' || entry === null) continue;
      const parsed = parsePlatformResult(entry);
      if (parsed) results.push(parsed);
    }
  }
  return { state, message: readString(payload, 'message'), results };
}

export async function getUploadPostStatus(
  apiKey: string,
  requestId: string
): Promise<PublishStatus> {
  const url = new URL(`${UPLOAD_POST_API_URL}/api/uploadposts/status`);
  url.searchParams.set('request_id', requestId);
  const response = await fetch(url, {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (response.status === 404) {
    return { state: 'not_found', message: null, results: [] };
  }
  if (!response.ok) {
    throw new Error(
      `Could not read publish status (${response.status}): ${await readErrorMessage(response)}`
    );
  }
  return parsePublishStatus(await response.json());
}

export type PublishVideoInput = Pick<
  PublishInput,
  | 'profile'
  | 'platforms'
  | 'title'
  | 'description'
  | 'youtubePrivacy'
  | 'tiktokPrivacy'
> & {
  /** From `derivePublishRequestId` over the same values. */
  requestId: string;
  /** Publicly fetchable MP4 URL — Upload-Post downloads it itself. */
  videoUrl: string;
  /** Echoed back by Upload-Post's status and history. */
  externalId: string;
};

/**
 * Hand the export to Upload-Post, at most once per request id.
 *
 * 1. Look the request id up first: if Upload-Post already has it, report
 *    `resumed` and send nothing. If the lookup fails, send nothing either —
 *    after the 24-hour `Idempotency-Key` window it is the only guard.
 * 2. Otherwise POST with the same id as `request_id` and `Idempotency-Key`.
 * 3. A definitive 4xx is `not_sent`. A 5xx, a timeout or a dropped
 *    connection is `unconfirmed` — the caller keeps polling the id and never
 *    re-sends it automatically.
 */
export async function publishUploadPostVideo(
  apiKey: string,
  input: PublishVideoInput
): Promise<PublishOutcome> {
  const { requestId } = input;
  const log = { requestId, externalId: input.externalId };

  let existing: PublishStatus;
  try {
    existing = await getUploadPostStatus(apiKey, requestId);
  } catch (error) {
    logger.warn('Upload-Post lookup failed; not sending', {
      ...log,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      state: 'not_sent',
      message:
        "Couldn't check with Upload-Post whether this was already posted, so nothing was sent. Try again.",
    };
  }
  if (existing.state !== 'not_found') {
    return { requestId, state: 'resumed' };
  }

  const form = new FormData();
  form.set('user', input.profile);
  for (const platform of input.platforms) form.append('platform[]', platform);
  form.set('video', input.videoUrl);
  form.set('title', input.title);
  if (input.description) form.set('description', input.description);
  if (input.platforms.includes('youtube')) {
    form.set('privacyStatus', input.youtubePrivacy);
  }
  if (
    input.platforms.includes('tiktok') &&
    input.tiktokPrivacy !== 'account_default'
  ) {
    form.set('privacy_level', input.tiktokPrivacy);
  }
  form.set('external_id', input.externalId);
  form.set('request_id', requestId);
  // Every OpenStory export is AI-generated; Upload-Post applies the AI label
  // on the platforms that support one.
  form.set('is_ai_generated', 'true');
  form.set('async_upload', 'true');

  let response: Response;
  try {
    response = await fetch(`${UPLOAD_POST_API_URL}/api/upload`, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), 'Idempotency-Key': requestId },
      body: form,
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
  } catch (error) {
    // The request may have reached Upload-Post before the connection dropped.
    logger.warn('Upload-Post publish unconfirmed: no response', {
      ...log,
      error: error instanceof Error ? error.name : String(error),
    });
    return { requestId, state: 'unconfirmed' };
  }

  // Any 2xx means accepted, even with an empty or non-JSON body.
  if (response.ok) return { requestId, state: 'submitted' };

  const message = await readErrorMessage(response);
  if (DEFINITIVE_REJECTIONS.has(response.status)) {
    logger.info('Upload-Post refused the publish', {
      ...log,
      status: response.status,
      message,
    });
    return {
      state: 'not_sent',
      message: `Upload-Post refused the post (${response.status}): ${message}`,
    };
  }
  logger.warn('Upload-Post publish unconfirmed', {
    ...log,
    status: response.status,
    message,
  });
  return { requestId, state: 'unconfirmed' };
}
