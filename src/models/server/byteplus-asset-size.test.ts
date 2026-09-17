import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';

vi.doMock('#env', () => ({
  getEnv: () => ({}),
}));

const readStorageObject = vi.fn();
const uploadFile = vi.fn();
vi.doMock('#storage', () => ({ readStorageObject, uploadFile }));

const toArkFetchableUrl = vi.fn(async (url: string) => `fetchable:${url}`);
vi.doMock('./byteplus-asset-ingest', () => ({
  toArkFetchableUrl,
}));

const free = vi.fn();
const get_bytes = vi.fn(() => new Uint8Array([9, 9, 9]));
const resize = vi.fn(() => ({ get_bytes, free }));
vi.doMock('@cf-wasm/photon', () => ({
  PhotonImage: {
    new_from_byteslice: () => ({ free }),
  },
  SamplingFilter: { CatmullRom: 3 },
  resize,
}));

const { arkCreateAssetUpscaleSize, fitUrlForArkCreateAsset } =
  await import('./byteplus-asset-size');

function makePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

describe('arkCreateAssetUpscaleSize', () => {
  it('is a no-op at or above 300px', () => {
    expect(arkCreateAssetUpscaleSize(1024, 576)).toBeNull();
    expect(arkCreateAssetUpscaleSize(300, 300)).toBeNull();
  });

  it('scales a 256px thumbnail to 300px', () => {
    expect(arkCreateAssetUpscaleSize(256, 256)).toEqual({
      width: 300,
      height: 300,
    });
  });
});

describe('fitUrlForArkCreateAsset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resize.mockReturnValue({ get_bytes, free });
  });

  it('passes through a still that already fits', async () => {
    readStorageObject.mockResolvedValue({
      bytes: makePng(1024, 576),
      contentType: 'image/png',
    });

    await expect(
      fitUrlForArkCreateAsset(
        '/r2/thumbnails/still.png',
        'https://cdn/still.png'
      )
    ).resolves.toBe('https://cdn/still.png');
    expect(resize).not.toHaveBeenCalled();
  });

  it('upscales a sub-300px still before CreateAsset', async () => {
    readStorageObject.mockResolvedValue({
      bytes: makePng(200, 200),
      contentType: 'image/png',
    });
    uploadFile.mockResolvedValue({
      publicUrl: '/r2/thumbnails/ark-fit/abc.png',
      path: 'thumbnails/ark-fit/abc.png',
      fullPath: 'thumbnails/ark-fit/abc.png',
    });

    await expect(
      fitUrlForArkCreateAsset(
        '/r2/thumbnails/tiny.png',
        'https://cdn/tiny.png',
        'fal-key'
      )
    ).resolves.toBe('fetchable:/r2/thumbnails/ark-fit/abc.png');
    expect(resize).toHaveBeenCalledWith(expect.anything(), 300, 300, 3);
    expect(uploadFile).toHaveBeenCalledWith(
      STORAGE_BUCKETS.THUMBNAILS,
      expect.stringMatching(/^ark-fit\/[0-9a-f]{64}\.png$/),
      expect.any(Uint8Array),
      { contentType: 'image/png' }
    );
  });
});
