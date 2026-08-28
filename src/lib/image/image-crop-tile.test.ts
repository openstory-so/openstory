import { beforeEach, describe, expect, it, vi } from 'vitest';

const envValues: Record<string, string | undefined> = {};
vi.doMock('#env', () => ({
  getEnv: () => envValues,
}));

const readStorageObject = vi.fn();
const uploadFile = vi.fn();
vi.doMock('#storage', () => ({ readStorageObject, uploadFile }));

const crop = vi.fn();
const free = vi.fn();
const get_bytes = vi.fn(() => new Uint8Array([1, 2, 3]));
const get_width = vi.fn(() => 3000);
const get_height = vi.fn(() => 3000);
const new_from_byteslice = vi.fn(() => ({
  get_width,
  get_height,
  free,
}));
vi.doMock('@cf-wasm/photon', () => ({
  PhotonImage: { new_from_byteslice },
  crop,
}));

const { cropTileFromGrid } = await import('./image-crop');

function setEnv(values: Record<string, string | undefined>) {
  for (const key of Object.keys(envValues)) delete envValues[key];
  Object.assign(envValues, values);
}

/** Minimal PNG IHDR — enough for getImageDimensions. */
function makePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

const ids = {
  teamId: 'team_1',
  sequenceId: 'seq_1',
  shotId: 'shot_1',
};

beforeEach(() => {
  setEnv({});
  readStorageObject.mockReset();
  uploadFile.mockReset();
  crop.mockReset();
  free.mockReset();
  get_bytes.mockClear();
  get_width.mockClear();
  get_height.mockClear();
  new_from_byteslice.mockClear();
  crop.mockReturnValue({ get_bytes, free });
});

describe('cropTileFromGrid', () => {
  it('returns an inset cdn-cgi trim URL when a CDN domain is configured', async () => {
    setEnv({ R2_PUBLIC_STORAGE_DOMAIN: 'storage.example.com' });
    readStorageObject.mockResolvedValue({
      bytes: makePng(3000, 3000),
      contentType: 'image/png',
    });

    const result = await cropTileFromGrid({
      gridImageUrl: '/r2/thumbnails/sheet.png',
      row: 2,
      col: 2,
      ...ids,
    });

    expect(result.path).toBe('');
    expect(result.url).toBe(
      'https://storage.example.com/cdn-cgi/image/trim=1050;1050;1050;1050/thumbnails/sheet.png'
    );
    expect(new_from_byteslice).not.toHaveBeenCalled();
  });

  it('keeps a trim URL in e2e replay (aimock never fetches)', async () => {
    setEnv({ E2E_TEST: 'true' });
    readStorageObject.mockResolvedValue({
      bytes: makePng(3000, 3000),
      contentType: 'image/png',
    });

    const result = await cropTileFromGrid({
      gridImageUrl: '/r2/thumbnails/sheet.png',
      row: 1,
      col: 1,
      ...ids,
    });

    expect(result.url).toBe(
      '/cdn-cgi/image/trim=50;2050;2050;50/r2/thumbnails/sheet.png'
    );
    expect(new_from_byteslice).not.toHaveBeenCalled();
  });

  it('crops in-process during e2e record so fal can fetch the tile', async () => {
    setEnv({ E2E_TEST: 'true', E2E_RECORD: '1' });
    readStorageObject.mockResolvedValue({
      bytes: makePng(3000, 3000),
      contentType: 'image/png',
    });
    uploadFile.mockResolvedValue({
      publicUrl: '/r2/thumbnails/tile.png',
      path: 'thumbnails/tile.png',
      fullPath: 'thumbnails/tile.png',
    });

    await cropTileFromGrid({
      gridImageUrl: '/r2/thumbnails/sheet.png',
      row: 1,
      col: 1,
      ...ids,
    });

    expect(new_from_byteslice).toHaveBeenCalled();
  });

  it('crops with photon and uploads to R2 when storage is local', async () => {
    setEnv({});
    readStorageObject.mockResolvedValue({
      bytes: makePng(3000, 3000),
      contentType: 'image/png',
    });
    uploadFile.mockResolvedValue({
      publicUrl: '/r2/thumbnails/teams/team_1/tile.png',
      path: 'thumbnails/teams/team_1/tile.png',
      fullPath: 'thumbnails/teams/team_1/tile.png',
    });

    const result = await cropTileFromGrid({
      gridImageUrl: '/r2/thumbnails/sheet.png',
      row: 1,
      col: 1,
      ...ids,
    });

    expect(new_from_byteslice).toHaveBeenCalled();
    expect(crop).toHaveBeenCalledWith(expect.anything(), 50, 50, 950, 950);
    expect(uploadFile).toHaveBeenCalledWith(
      'thumbnails',
      expect.stringMatching(
        /^teams\/team_1\/sequences\/seq_1\/frames\/shot_1\/variant-tile-.*\.png$/
      ),
      expect.any(Uint8Array),
      { contentType: 'image/png' }
    );
    expect(result).toEqual({
      url: '/r2/thumbnails/teams/team_1/tile.png',
      path: 'thumbnails/teams/team_1/tile.png',
    });
    expect(free).toHaveBeenCalledTimes(2);
  });
});
