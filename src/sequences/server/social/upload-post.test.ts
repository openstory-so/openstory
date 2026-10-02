import { afterEach, describe, expect, it, vi } from 'vitest';
import { derivePublishRequestId } from '@/sequences/social-publish';
import {
  getUploadPostStatus,
  parseProfiles,
  parsePublishStatus,
  publishUploadPostVideo,
  type PublishVideoInput,
} from './upload-post';

const KEY = 'test-key';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const NOT_FOUND = () => jsonResponse(404, { status: 'not_found' });

async function input(
  overrides: Partial<PublishVideoInput> = {}
): Promise<PublishVideoInput> {
  return {
    requestId: await derivePublishRequestId({
      teamId: '01TEAM',
      sequenceId: '01SEQUENCE',
      exportId: '01EXPORT',
      profile: 'creator',
      platforms: ['tiktok', 'youtube'],
      title: 'My film',
      description: '',
      youtubePrivacy: 'private',
      tiktokPrivacy: 'account_default',
    }),
    profile: 'creator',
    platforms: ['tiktok', 'youtube'],
    videoUrl: 'https://cdn.example.com/exports/film.mp4',
    title: 'My film',
    description: '',
    youtubePrivacy: 'private',
    tiktokPrivacy: 'account_default',
    externalId: '01EXPORT',
    ...overrides,
  };
}

/** Routes fetch by method: GET = status lookups, POST = the upload. */
function stubFetch(handlers: {
  status?: () => Response | Promise<Response>;
  upload?: () => Response | Promise<Response>;
}) {
  const calls = { status: 0, upload: 0, uploadInit: [] as RequestInit[] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.upload += 1;
        calls.uploadInit.push(init);
        if (!handlers.upload) throw new Error('unexpected upload');
        return handlers.upload();
      }
      calls.status += 1;
      return (handlers.status ?? NOT_FOUND)();
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('publishUploadPostVideo', () => {
  it('submits once with the request id as request_id and Idempotency-Key', async () => {
    const calls = stubFetch({
      upload: () => jsonResponse(200, { success: true, request_id: 'x' }),
    });
    const publish = await input();

    const outcome = await publishUploadPostVideo(KEY, publish);

    expect(outcome).toEqual({
      requestId: publish.requestId,
      state: 'submitted',
    });
    expect(calls.upload).toBe(1);
    const init = calls.uploadInit[0];
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe(`Apikey ${KEY}`);
    expect(headers.get('Idempotency-Key')).toBe(publish.requestId);
    const form = init?.body;
    if (!(form instanceof FormData))
      throw new Error('expected a FormData body');
    expect(form.get('request_id')).toBe(publish.requestId);
    expect(form.get('async_upload')).toBe('true');
    expect(form.get('video')).toBe(publish.videoUrl);
    expect(form.getAll('platform[]')).toEqual(['tiktok', 'youtube']);
    expect(form.get('privacyStatus')).toBe('private');
    expect(form.get('is_ai_generated')).toBe('true');
  });

  it('does not send again when Upload-Post already has the request', async () => {
    const calls = stubFetch({
      status: () => jsonResponse(200, { status: 'processing', results: [] }),
    });

    const outcome = await publishUploadPostVideo(KEY, await input());

    expect(outcome.state).toBe('resumed');
    expect(calls.upload).toBe(0);
  });

  it.each([500, 502, 503, 504])(
    'reports HTTP %i as unconfirmed, never as a failure to retry',
    async (status) => {
      const calls = stubFetch({
        upload: () => jsonResponse(status, { message: 'upstream' }),
      });

      const outcome = await publishUploadPostVideo(KEY, await input());

      expect(outcome.state).toBe('unconfirmed');
      expect(calls.upload).toBe(1);
    }
  );

  it('reports a dropped connection as unconfirmed', async () => {
    const calls = stubFetch({
      upload: () => {
        throw new TypeError('network connection lost');
      },
    });

    const outcome = await publishUploadPostVideo(KEY, await input());

    expect(outcome.state).toBe('unconfirmed');
    expect(calls.upload).toBe(1);
  });

  it('treats a 2xx with an empty body as accepted', async () => {
    stubFetch({ upload: () => new Response('', { status: 200 }) });

    const outcome = await publishUploadPostVideo(KEY, await input());

    expect(outcome.state).toBe('submitted');
  });

  it.each([400, 401, 403, 422, 429])(
    'reports a definitive HTTP %i as not sent, with the API message',
    async (status) => {
      stubFetch({
        upload: () => jsonResponse(status, { message: 'Profile not found' }),
      });

      expect(await publishUploadPostVideo(KEY, await input())).toEqual({
        state: 'not_sent',
        message: `Upload-Post refused the post (${status}): Profile not found`,
      });
    }
  );

  it.each([
    ['a 500', () => jsonResponse(500, { message: 'down' })],
    [
      'a timeout',
      () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    ],
    ['an unreadable reply', () => jsonResponse(200, { success: false })],
  ])(
    'sends nothing when the pre-send lookup fails with %s',
    async (_, status) => {
      const calls = stubFetch({
        status,
        upload: () => jsonResponse(200, {}),
      });

      const outcome = await publishUploadPostVideo(KEY, await input());

      expect(outcome.state).toBe('not_sent');
      expect(calls.upload).toBe(0);
    }
  );

  it('a repeat after an unconfirmed call finds the request instead of re-posting', async () => {
    // First call: the upload was created but the reply was a 502.
    let created = false;
    const calls = stubFetch({
      status: () =>
        created
          ? jsonResponse(200, { status: 'queued', results: [] })
          : NOT_FOUND(),
      upload: () => {
        created = true;
        return jsonResponse(502, { message: 'Bad Gateway' });
      },
    });
    const publish = await input();

    expect((await publishUploadPostVideo(KEY, publish)).state).toBe(
      'unconfirmed'
    );
    expect((await publishUploadPostVideo(KEY, publish)).state).toBe('resumed');
    expect(calls.upload).toBe(1);
  });

  it("sends TikTok's privacy only when it overrides the account default", async () => {
    const calls = stubFetch({ upload: () => jsonResponse(200, {}) });

    await publishUploadPostVideo(KEY, await input());
    await publishUploadPostVideo(
      KEY,
      await input({ requestId: 'openstory-other', tiktokPrivacy: 'SELF_ONLY' })
    );

    const [first, second] = calls.uploadInit.map((init) => init.body);
    if (!(first instanceof FormData) || !(second instanceof FormData)) {
      throw new Error('expected FormData bodies');
    }
    expect(first.has('privacy_level')).toBe(false);
    expect(second.get('privacy_level')).toBe('SELF_ONLY');
  });

  it('only sends the YouTube privacy when YouTube is a target', async () => {
    const calls = stubFetch({ upload: () => jsonResponse(200, {}) });

    await publishUploadPostVideo(KEY, await input({ platforms: ['tiktok'] }));

    const form = calls.uploadInit[0]?.body;
    if (!(form instanceof FormData))
      throw new Error('expected a FormData body');
    expect(form.has('privacyStatus')).toBe(false);
  });
});

describe('getUploadPostStatus', () => {
  it('maps a 404 to not_found', async () => {
    stubFetch({ status: NOT_FOUND });
    expect((await getUploadPostStatus(KEY, 'openstory-x')).state).toBe(
      'not_found'
    );
  });
});

describe('parsePublishStatus', () => {
  it('maps per-platform outcomes', () => {
    const status = parsePublishStatus({
      status: 'completed',
      results: [
        {
          platform: 'youtube',
          success: true,
          post_url: 'https://www.youtube.com/watch?v=abc',
        },
        {
          platform: 'instagram',
          success: true,
          post_url: 'Post uploaded as Private. No public URL available.',
        },
        { platform: 'x', success: false, error_message: 'Token expired' },
        {
          platform: 'linkedin',
          success: false,
          skipped: true,
          skip_reason: 'No LinkedIn account on this profile',
        },
        {
          platform: 'tiktok',
          success: true,
          fallback_to_inbox: true,
          post_url: 'Video sent to Inbox (No Public URL)',
        },
      ],
    });

    expect(status.state).toBe('done');
    expect(status.results).toEqual([
      {
        platform: 'youtube',
        state: 'published',
        url: 'https://www.youtube.com/watch?v=abc',
        note: null,
        error: null,
      },
      {
        platform: 'instagram',
        state: 'published',
        url: null,
        note: 'Post uploaded as Private. No public URL available.',
        error: null,
      },
      {
        platform: 'x',
        state: 'failed',
        url: null,
        note: null,
        error: 'Token expired',
      },
      {
        platform: 'linkedin',
        state: 'skipped',
        url: null,
        note: 'No LinkedIn account on this profile',
        error: null,
      },
      {
        platform: 'tiktok',
        state: 'published',
        url: null,
        note: 'Sent to the TikTok inbox as a draft — publish it from the TikTok app.',
        error: null,
      },
    ]);
  });

  it('maps a top-level failure to failed, not done', () => {
    expect(
      parsePublishStatus({ status: 'failed', message: 'Video not found' })
    ).toEqual({ state: 'failed', message: 'Video not found', results: [] });
  });

  it.each([{ success: false }, { status: 'mystery' }, 'oops', null])(
    'throws on a reply it does not recognise: %j',
    (payload) => {
      expect(() => parsePublishStatus(payload)).toThrow(/Unexpected/);
    }
  );

  it('keeps an unknown platform status pending, not failed', () => {
    const status = parsePublishStatus({
      status: 'processing',
      results: [{ platform: 'youtube', status: 'uploading', success: false }],
    });
    expect(status.results[0]?.state).toBe('pending');
  });

  it('keeps retryable and queued platforms pending while the request runs', () => {
    const status = parsePublishStatus({
      status: 'in_progress',
      results: [
        { platform: 'tiktok', status: 'retryable', success: false },
        { platform: 'youtube', status: 'queued', success: false },
      ],
    });
    expect(status.state).toBe('running');
    expect(status.results.map((r) => r.state)).toEqual(['pending', 'pending']);
  });
});

describe('parseProfiles', () => {
  it('keeps only linked accounts on offered platforms, in dialog order', () => {
    expect(
      parseProfiles({
        profiles: [
          {
            username: 'creator',
            social_accounts: {
              youtube: { handle: 'c' },
              tiktok: { handle: 'c' },
              instagram: '',
              reddit: { handle: 'c' },
              x: null,
            },
          },
          { social_accounts: {} },
        ],
      })
    ).toEqual([{ username: 'creator', platforms: ['tiktok', 'youtube'] }]);
  });

  it('throws on a reply without a profiles list rather than showing none', () => {
    expect(() => parseProfiles({ users: [] })).toThrow(/no profiles list/);
    expect(parseProfiles({ profiles: [] })).toEqual([]);
  });
});
