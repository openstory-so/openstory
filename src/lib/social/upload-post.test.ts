import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseProfiles,
  parsePublishStatus,
  publishUploadPostVideo,
  validateUploadPostKey,
} from './upload-post';

describe('parseProfiles', () => {
  it('keeps only connected, dialog-supported platforms in a stable order', () => {
    const profiles = parseProfiles({
      success: true,
      profiles: [
        {
          username: 'brand',
          social_accounts: {
            x: { display_name: 'Brand', social_images: '' },
            tiktok: '', // added but never linked
            instagram: { display_name: 'Brand IG' },
            pinterest: { display_name: 'needs a board id' },
            youtube: null,
          },
        },
        { username: 'empty' },
        { not: 'a profile' },
      ],
    });
    expect(profiles).toEqual([
      { username: 'brand', platforms: ['instagram', 'x'] },
      { username: 'empty', platforms: [] },
    ]);
  });

  it('returns no profiles for an unexpected payload', () => {
    expect(parseProfiles(null)).toEqual([]);
    expect(parseProfiles({ profiles: 'nope' })).toEqual([]);
  });
});

describe('parsePublishStatus', () => {
  it('maps the per-platform result rows', () => {
    const status = parsePublishStatus({
      request_id: 'r1',
      status: 'in_progress',
      results: [
        {
          platform: 'x',
          success: true,
          post_url: 'https://x.com/brand/status/1',
        },
        {
          platform: 'tiktok',
          success: true,
          fallback_to_inbox: true,
          post_url: 'Video sent to Inbox (No Public URL)',
        },
        {
          platform: 'instagram',
          success: false,
          error_message: 'Media not ready',
        },
      ],
    });
    expect(status).toEqual({
      status: 'in_progress',
      message: null,
      results: [
        {
          platform: 'x',
          success: true,
          postUrl: 'https://x.com/brand/status/1',
          error: null,
        },
        { platform: 'tiktok', success: true, postUrl: null, error: null },
        {
          platform: 'instagram',
          success: false,
          postUrl: null,
          error: 'Media not ready',
        },
      ],
    });
  });

  it('surfaces the top-level failure message and tolerates unknown statuses', () => {
    expect(
      parsePublishStatus({
        status: 'failed',
        message: 'no activity',
        results: [],
      })
    ).toEqual({ status: 'failed', message: 'no activity', results: [] });
    expect(parsePublishStatus({ status: 'weird' }).status).toBe('pending');
    expect(parsePublishStatus(undefined).status).toBe('failed');
  });
});

type CapturedFetch = { url: string; init: RequestInit | undefined };

/** Stub `fetch` with a fixed response and capture what it was called with. */
function stubFetch(response: Response): CapturedFetch[] {
  const calls: CapturedFetch[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push({ url, init });
      return Promise.resolve(response);
    })
  );
  return calls;
}

describe('HTTP layer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('validates a key with the Apikey scheme (never Bearer)', async () => {
    const calls = stubFetch(new Response('{}', { status: 200 }));
    await expect(validateUploadPostKey('k1')).resolves.toEqual({ valid: true });
    expect(calls[0]?.url).toBe(
      'https://api.upload-post.com/api/uploadposts/users'
    );
    expect(calls[0]?.init?.headers).toEqual({ Authorization: 'Apikey k1' });
  });

  it('reports a rejected key', async () => {
    stubFetch(new Response('', { status: 401 }));
    await expect(validateUploadPostKey('bad')).resolves.toEqual({
      valid: false,
      error: 'Upload-Post returned 401',
    });
  });

  it('posts the video by URL, async, with the AI-generated label', async () => {
    const calls = stubFetch(
      new Response(JSON.stringify({ success: true, request_id: 'req-1' }), {
        status: 200,
      })
    );

    await expect(
      publishUploadPostVideo('k1', {
        profile: 'brand',
        platforms: ['tiktok', 'x'],
        videoUrl: 'https://cdn.example.com/exports/a.mp4',
        title: 'Hello',
        externalId: 'exp1',
      })
    ).resolves.toEqual({ requestId: 'req-1' });

    const call = calls[0];
    expect(call?.url).toBe('https://api.upload-post.com/api/upload');
    expect(call?.init?.method).toBe('POST');
    const form = call?.init?.body;
    if (!(form instanceof FormData)) {
      throw new Error('Expected a multipart body');
    }
    expect(form.get('user')).toBe('brand');
    expect(form.getAll('platform[]')).toEqual(['tiktok', 'x']);
    expect(form.get('video')).toBe('https://cdn.example.com/exports/a.mp4');
    expect(form.get('title')).toBe('Hello');
    expect(form.get('external_id')).toBe('exp1');
    expect(form.get('is_ai_generated')).toBe('true');
    expect(form.get('async_upload')).toBe('true');
    expect(form.has('description')).toBe(false);
  });

  it('surfaces the API error message on a rejected publish', async () => {
    stubFetch(
      new Response(JSON.stringify({ message: 'Profile not found' }), {
        status: 404,
      })
    );
    await expect(
      publishUploadPostVideo('k1', {
        profile: 'ghost',
        platforms: ['x'],
        videoUrl: 'https://cdn.example.com/a.mp4',
        title: 'Hello',
        externalId: 'exp1',
      })
    ).rejects.toThrow('Publish failed: Profile not found');
  });
});
