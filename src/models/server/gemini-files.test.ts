/**
 * Once a clip is on Google, every failure deletes it (#1930): a person's
 * clip must not sit in Gemini Files for 48 hours because a poll failed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.doMock('#env', () => ({ getEnv: () => ({}) }));
vi.doMock('#storage', () => ({
  storageObjectSize: async () => 3,
  readStorageStream: async () => ({
    body: new Blob([new Uint8Array([1, 2, 3])]).stream(),
  }),
}));

const { uploadClipToGemini } = await import('./gemini-files');

const FILE = {
  name: 'files/abc',
  uri: 'https://files.example/abc',
  mimeType: 'video/mp4',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadClipToGemini', () => {
  it('deletes the uploaded file when polling fails, and keeps the poll error', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const method = init.method ?? 'GET';
        calls.push({ url, method });
        if (url.endsWith('/upload/v1beta/files')) {
          return new Response('{}', {
            headers: { 'x-goog-upload-url': 'https://upload.example/1' },
          });
        }
        if (url === 'https://upload.example/1') {
          return Response.json({ file: { ...FILE, state: 'PROCESSING' } });
        }
        if (method === 'DELETE') return new Response('{}');
        return new Response('backend down', { status: 503 });
      })
    );
    vi.useFakeTimers();
    const upload = uploadClipToGemini('talent/t/clip.mp4', 'video/mp4', 'k');
    const settled = expect(upload).rejects.toThrow('Gemini Files 503');
    await vi.runAllTimersAsync();
    await settled;
    vi.useRealTimers();

    expect(calls).toContainEqual({
      url: expect.stringContaining('/v1beta/files/abc'),
      method: 'DELETE',
    });
  });

  it('streams one clip at a time, so parallel calls cannot fill the isolate (#2370)', async () => {
    let open = 0;
    let most = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/upload/v1beta/files')) {
          open += 1;
          most = Math.max(most, open);
          return new Response('{}', {
            headers: { 'x-goog-upload-url': 'https://upload.example/1' },
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        open -= 1;
        return Response.json({ file: { ...FILE, state: 'ACTIVE' } });
      })
    );
    await Promise.all(
      [1, 2, 3].map(() => uploadClipToGemini('c.mp4', 'video/mp4', 'k'))
    );
    expect(most).toBe(1);
  });

  it('frees the slot when an upload fails', async () => {
    let starts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/upload/v1beta/files')) {
          starts += 1;
          if (starts === 1) return new Response('down', { status: 503 });
          return new Response('{}', {
            headers: { 'x-goog-upload-url': 'https://upload.example/1' },
          });
        }
        return Response.json({ file: { ...FILE, state: 'ACTIVE' } });
      })
    );
    const [failed, ok] = await Promise.allSettled([
      uploadClipToGemini('a.mp4', 'video/mp4', 'k'),
      uploadClipToGemini('b.mp4', 'video/mp4', 'k'),
    ]);
    expect(failed.status).toBe('rejected');
    expect(ok.status).toBe('fulfilled');
  });
});
