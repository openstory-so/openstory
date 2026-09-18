import { describe, expect, it, vi } from 'vitest';
import { NonRetryableError } from 'cloudflare:workflows';

vi.doMock('#env', () => ({
  getEnv: () => ({}),
}));

const readStorageObject = vi.fn();
vi.doMock('#storage', () => ({ readStorageObject }));

const { assertArkCreateAssetSize, stillFitsArkCreateAsset } =
  await import('./byteplus-asset-size');

function makePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

describe('stillFitsArkCreateAsset', () => {
  it('accepts 300px and above', () => {
    expect(stillFitsArkCreateAsset(300, 300)).toBe(true);
    expect(stillFitsArkCreateAsset(1024, 576)).toBe(true);
  });

  it('rejects a 256px thumbnail', () => {
    expect(stillFitsArkCreateAsset(256, 256)).toBe(false);
  });
});

describe('assertArkCreateAssetSize', () => {
  it('allows a still that already fits', async () => {
    readStorageObject.mockResolvedValue({
      bytes: makePng(1024, 576),
      contentType: 'image/png',
    });
    await expect(
      assertArkCreateAssetSize('/r2/thumbnails/still.png')
    ).resolves.toBeUndefined();
  });

  it('refuses a sub-300px still with the measured size', async () => {
    readStorageObject.mockResolvedValue({
      bytes: makePng(256, 256),
      contentType: 'image/png',
    });
    await expect(
      assertArkCreateAssetSize('/r2/thumbnails/tiny.png')
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof NonRetryableError &&
        error.message.includes('256×256px') &&
        error.message.includes('300×300px')
    );
  });
});
