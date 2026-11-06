/**
 * storeUpload sends M4A, OGG and FLAC through the container when one is
 * available, and keeps today's refusal when it is not (#2265).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';

let transcoder = false;
const uploadFile = vi.fn(
  async (bucket: string, path: string, _body: unknown) => ({
    path,
    publicUrl: `/r2/${bucket}/${path}`,
    fullPath: `${bucket}/${path}`,
  })
);
const transcodeAudioUpload = vi.fn();

vi.doMock('#storage', () => ({ uploadFile }));
vi.doMock('@/sequences/server/server-export-available', () => ({
  isServerExportAvailable: () => transcoder,
}));
vi.doMock('@/sequences/server/transcode-audio', () => ({
  transcodeAudioUpload,
}));

const { storeUpload } = await import('./media-upload');

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- storeUpload reads organizationId for the key
const scopedDb = { organizationId: '01ORG' } as unknown as ScopedDb;
const data = Buffer.from('abcd').toString('base64');

function store(
  use: 'element' | 'music' | 'studio' | 'stitch',
  mimeType: string
) {
  return storeUpload({
    scopedDb,
    userId: '01USER',
    sequenceId: use === 'studio' || use === 'stitch' ? null : '01SEQ',
    ...(use === 'stitch' ? { use: 'stitch', stitchId: '01STITCH' } : { use }),
    source: { data, mimeType },
    request: {},
  });
}

describe('storeUpload audio', () => {
  beforeEach(() => {
    transcoder = false;
    uploadFile.mockClear();
    transcodeAudioUpload.mockReset();
  });

  it('refuses an element M4A with the current message when no container is up', async () => {
    await expect(store('element', 'audio/mp4')).rejects.toThrow(
      'A element upload must be jpg, jpeg, png, webp, gif, mp3, wav, mp4, mov; got audio/mp4.'
    );
    expect(transcodeAudioUpload).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('stores an element M4A as WAV when a container is up', async () => {
    transcoder = true;
    const wav = new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-length': '3', 'content-type': 'audio/wav' },
    });
    transcodeAudioUpload.mockResolvedValue({ response: wav, byteLength: 3 });

    const stored = await store('element', 'audio/mp4');

    expect(transcodeAudioUpload).toHaveBeenCalledOnce();
    expect(transcodeAudioUpload.mock.calls[0]?.[0]).toMatchObject({
      byteLength: 4,
      contentType: 'audio/mp4',
    });
    expect(stored.mediaType).toBe('audio/wav');
    expect(stored.bytes).toBe(3);
    expect(stored.url).toMatch(/\.wav$/);
    expect(uploadFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(/\.wav$/),
      wav.body,
      expect.objectContaining({ contentType: 'audio/wav' })
    );
  });

  it('stores music M4A as M4A without a container and as WAV with one', async () => {
    const plain = await store('music', 'audio/mp4');
    expect(plain.mediaType).toBe('audio/mp4');
    expect(plain.url).toMatch(/\.m4a$/);
    expect(transcodeAudioUpload).not.toHaveBeenCalled();

    transcoder = true;
    uploadFile.mockClear();
    const wav = new Response(new Uint8Array([1]), {
      headers: { 'content-length': '1' },
    });
    transcodeAudioUpload.mockResolvedValue({ response: wav, byteLength: 1 });
    const stored = await store('music', 'audio/mp4');
    expect(stored.mediaType).toBe('audio/wav');
    expect(stored.url).toMatch(/\.wav$/);
  });

  it('streams a hosted M4A into the container without buffering it first', async () => {
    transcoder = true;
    const payload = new Uint8Array([1, 2, 3, 4]);
    const sourceResponse = new Response(payload, {
      headers: {
        'content-type': 'audio/mp4',
        'content-length': '4',
      },
    });
    const sourceBody = sourceResponse.body;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sourceResponse)
    );
    const wav = new Response(new Uint8Array([9, 9, 9]), {
      headers: { 'content-length': '3', 'content-type': 'audio/wav' },
    });
    transcodeAudioUpload.mockImplementation(
      async (source: {
        body: ReadableStream<Uint8Array>;
        byteLength: number;
        contentType: string;
      }) => {
        expect(source.body).toBe(sourceBody);
        expect(source.byteLength).toBe(4);
        expect(source.contentType).toBe('audio/mp4');
        return { response: wav, byteLength: 3 };
      }
    );

    try {
      const stored = await storeUpload({
        scopedDb,
        userId: '01USER',
        sequenceId: '01SEQ',
        use: 'element',
        source: { url: 'https://cdn.example.com/a.m4a' },
        request: {},
      });
      expect(stored.mediaType).toBe('audio/wav');
      expect(stored.url).toMatch(/\.wav$/);
      expect(uploadFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringMatching(/\.wav$/),
        wav.body,
        expect.objectContaining({ contentType: 'audio/wav' })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stores a stitch M4A as M4A even when a container is up', async () => {
    transcoder = true;
    const stored = await store('stitch', 'audio/mp4');
    expect(stored.mediaType).toBe('audio/mp4');
    expect(stored.url).toMatch(/\.m4a$/);
    expect(transcodeAudioUpload).not.toHaveBeenCalled();
  });
});
