/** A large stored still reaches native Gemini through the Files API, never whole in memory; a small one stays inline (#2400). */

import { describe, expect, it, vi } from 'vitest';
import type { GeminiFile } from './gemini-files';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
let size = 0;
const inline = vi.fn(async () => ({
  type: 'data' as const,
  value: 'b64',
  mimeType: 'image/png',
}));

vi.doMock('#env', () => ({ getEnv: () => ({}) }));
vi.doMock('#storage', () => ({
  storageObjectSize: async () => size,
  storageObjectContentType: async () => 'image/jpeg',
  readStorageStream: async () => ({ body: new Blob([PNG]).stream() }),
}));
vi.doMock('@/platform/server/storage/external-url', () => ({
  isReplayMode: () => false,
  toVisionImageSource: inline,
}));
vi.doMock('@/platform/server/storage/buckets', () => ({
  r2KeyFromUrl: (url: string) =>
    url.startsWith('/r2/') ? url.slice('/r2/'.length) : null,
}));

const { GEMINI_INLINE_STILL_MAX_BYTES, geminiStillSource } =
  await import('./gemini-files');

describe('geminiStillSource', () => {
  it('inlines a still at the threshold', async () => {
    size = GEMINI_INLINE_STILL_MAX_BYTES;
    const uploaded: GeminiFile[] = [];
    await expect(
      geminiStillSource('/r2/stills/a.png', 'k', uploaded)
    ).resolves.toMatchObject({ type: 'data' });
    expect(uploaded).toEqual([]);
  });

  it('uploads a larger still and returns the file reference with its sniffed type', async () => {
    size = GEMINI_INLINE_STILL_MAX_BYTES + 1;
    let declaredType = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith('/upload/v1beta/files')) {
          declaredType =
            new Headers(init.headers).get(
              'x-goog-upload-header-content-type'
            ) ?? '';
          return new Response('{}', {
            headers: { 'x-goog-upload-url': 'https://upload.example/1' },
          });
        }
        return Response.json({
          file: {
            name: 'files/s',
            uri: 'https://files.example/s',
            mimeType: declaredType,
            state: 'ACTIVE',
          },
        });
      })
    );
    const uploaded: GeminiFile[] = [];
    inline.mockClear();
    await expect(
      geminiStillSource('/r2/stills/big.png', 'k', uploaded)
    ).resolves.toEqual({
      type: 'url',
      value: 'https://files.example/s',
      mimeType: 'image/png',
    });
    expect(declaredType).toBe('image/png');
    expect(uploaded.map((f) => f.name)).toEqual(['files/s']);
    expect(inline).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
