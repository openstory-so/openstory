/**
 * The Worker streams an upload at the video-export container and requires a
 * content-length on the WAV so R2 can take the stream (#2265).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const env: {
  VIDEO_EXPORT_DEV_URL?: string;
  VIDEO_EXPORT_CONTAINER?: object;
} = {};
const fetchContainer = vi.fn();
const getContainer = vi.fn(() => ({ fetch: fetchContainer }));

vi.doMock('#env', () => ({ getEnv: () => env }));
vi.doMock('@cloudflare/containers', () => ({ getContainer }));

const { transcodeAudioUpload } = await import('./transcode-audio');

function source() {
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    }),
    byteLength: 4,
    contentType: 'audio/mp4',
  };
}

describe('transcodeAudioUpload', () => {
  beforeEach(() => {
    delete env.VIDEO_EXPORT_DEV_URL;
    delete env.VIDEO_EXPORT_CONTAINER;
    fetchContainer.mockReset();
    getContainer.mockClear();
    vi.restoreAllMocks();
  });

  it('refuses to run when neither the dev URL nor the binding is set', async () => {
    await expect(transcodeAudioUpload(source())).rejects.toThrow(
      'VIDEO_EXPORT_CONTAINER binding unavailable - audio transcode runs in production only'
    );
    expect(fetchContainer).not.toHaveBeenCalled();
  });

  it('posts the stream to bun dev:bunny with a known length', async () => {
    env.VIDEO_EXPORT_DEV_URL = 'http://127.0.0.1:8080/';
    const wav = new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-length': '3' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(wav);

    const result = await transcodeAudioUpload(source());

    expect(result.byteLength).toBe(3);
    expect(result.response).toBe(wav);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/transcode-audio',
      expect.objectContaining({
        method: 'POST',
        duplex: 'half',
        headers: {
          'content-type': 'audio/mp4',
          'content-length': '4',
        },
      })
    );
  });

  it('posts to the shared container instance when the binding is present', async () => {
    env.VIDEO_EXPORT_CONTAINER = { idFromName() {} };
    const wav = new Response(new Uint8Array([1, 2]), {
      headers: { 'content-length': '2' },
    });
    fetchContainer.mockResolvedValue(wav);

    const result = await transcodeAudioUpload(source());

    expect(result.byteLength).toBe(2);
    expect(getContainer).toHaveBeenCalledWith(
      env.VIDEO_EXPORT_CONTAINER,
      'audio-transcode'
    );
    const request = fetchContainer.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    if (!(request instanceof Request)) throw new Error('expected a Request');
    expect(request.url).toBe('http://video-export/transcode-audio');
    expect(request.headers.get('content-length')).toBe('4');
  });

  it('turns a 4xx from the container into a validation error', async () => {
    env.VIDEO_EXPORT_CONTAINER = {};
    fetchContainer.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'That audio format could not be read' }),
        { status: 400 }
      )
    );
    await expect(transcodeAudioUpload(source())).rejects.toThrow(
      'That audio format could not be read'
    );
  });

  it('keeps a 5xx as a container failure', async () => {
    env.VIDEO_EXPORT_CONTAINER = {};
    fetchContainer.mockResolvedValue(new Response('boom', { status: 502 }));
    await expect(transcodeAudioUpload(source())).rejects.toThrow(
      'Audio transcode failed (502): boom'
    );
  });

  it('refuses a WAV that has no content-length', async () => {
    env.VIDEO_EXPORT_CONTAINER = {};
    fetchContainer.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        })
      )
    );
    await expect(transcodeAudioUpload(source())).rejects.toThrow(
      'Audio transcode returned no content-length - cannot stream the WAV to R2'
    );
  });
});
