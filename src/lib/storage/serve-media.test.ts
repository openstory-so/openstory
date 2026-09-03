import { beforeEach, describe, expect, it, vi } from 'vitest';

const envValues: Record<string, string | undefined> = {};
vi.doMock('#env', () => ({
  getEnv: () => envValues,
}));

const serveFile = vi.fn();
vi.doMock('#storage', () => ({ serveFile }));

// Dynamic import so the mocks apply (vi.doMock is not hoisted).
const { serveStoredMedia } = await import('./serve-media');

function setEnv(values: Record<string, string | undefined>) {
  for (const key of Object.keys(envValues)) delete envValues[key];
  Object.assign(envValues, values);
}

beforeEach(() => {
  setEnv({});
  serveFile.mockReset();
});

describe('serveStoredMedia', () => {
  it('302-redirects to the CDN domain when configured (production path)', async () => {
    setEnv({ R2_PUBLIC_STORAGE_DOMAIN: 'storage.example.com' });

    const response = await serveStoredMedia(
      'videos/team/v.mp4',
      new Request('https://app.example.com/r2/videos/team/v.mp4')
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://storage.example.com/videos/team/v.mp4'
    );
    expect(serveFile).not.toHaveBeenCalled();
  });

  it('streams from the R2 binding when no CDN domain is configured', async () => {
    const expected = new Response('bytes');
    serveFile.mockResolvedValue(expected);
    const request = new Request('http://localhost:3000/r2/videos/v.mp4');

    await expect(serveStoredMedia('videos/v.mp4', request)).resolves.toBe(
      expected
    );
    expect(serveFile).toHaveBeenCalledWith('videos/v.mp4', request);
  });

  it('streams locally in e2e even with a CDN domain configured', async () => {
    setEnv({
      R2_PUBLIC_STORAGE_DOMAIN: 'storage.example.com',
      E2E_TEST: 'true',
    });
    serveFile.mockResolvedValue(new Response('bytes'));
    const request = new Request('http://localhost:3001/r2/audio/a.wav');

    const response = await serveStoredMedia('audio/a.wav', request);

    expect(response.status).toBe(200);
    expect(serveFile).toHaveBeenCalledWith('audio/a.wav', request);
  });
});

describe('serveStoredMedia ?download', () => {
  it('streams with content-disposition instead of redirecting to the CDN', async () => {
    setEnv({ R2_PUBLIC_STORAGE_DOMAIN: 'storage.example.com' });
    serveFile.mockResolvedValue(new Response('bytes'));

    const response = await serveStoredMedia(
      'videos/team/v.mp4',
      new Request('https://app.example.com/r2/videos/team/v.mp4?download')
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment');
  });

  it('passes a 404 through untouched', async () => {
    setEnv({ R2_PUBLIC_STORAGE_DOMAIN: 'storage.example.com' });
    serveFile.mockResolvedValue(new Response('Not found', { status: 404 }));

    const response = await serveStoredMedia(
      'videos/gone.mp4',
      new Request('https://app.example.com/r2/videos/gone.mp4?download')
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('content-disposition')).toBeNull();
  });
});
