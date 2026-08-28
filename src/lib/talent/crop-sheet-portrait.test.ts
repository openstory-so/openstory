import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';

const readStorageObject = vi.fn();
const uploadFile = vi.fn();
vi.doMock('#storage', () => ({ readStorageObject, uploadFile }));

const crop = vi.fn();
const free = vi.fn();
const get_bytes = vi.fn(() => new Uint8Array([9, 9, 9]));
const get_width = vi.fn(() => 1920);
const get_height = vi.fn(() => 1080);
const new_from_byteslice = vi.fn(() => ({
  get_width,
  get_height,
  free,
}));
vi.doMock('@cf-wasm/photon', () => ({
  PhotonImage: { new_from_byteslice },
  crop,
}));

const { cropTalentSheetPortrait, talentPortraitCropRect } =
  await import('./crop-sheet-portrait');

describe('talentPortraitCropRect', () => {
  it('takes a square from the top of panel 2 on a 16:9 4-panel', () => {
    const rect = talentPortraitCropRect(1920, 1080);
    expect(rect).not.toBe('copy');
    if (rect === 'copy') return;
    // tile = 480; inset = 24; panel 2 is x 504–936, square from y 24
    expect(rect).toEqual({ x1: 504, y1: 24, x2: 936, y2: 456 });
  });

  it('copies a square or tall image instead of slicing a grid', () => {
    expect(talentPortraitCropRect(1024, 1024)).toBe('copy');
    expect(talentPortraitCropRect(800, 1200)).toBe('copy');
  });
});

describe('cropTalentSheetPortrait', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get_width.mockReturnValue(1920);
    get_height.mockReturnValue(1080);
    crop.mockReturnValue({ get_bytes, free });
    readStorageObject.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
    });
    uploadFile.mockResolvedValue({
      publicUrl: '/r2/talent/team-1/tal-1/headshot.png',
      path: 'team-1/tal-1/headshot.png',
      fullPath: 'talent/team-1/tal-1/headshot.png',
    });
  });

  it('crops panel 2 and uploads a PNG', async () => {
    const result = await cropTalentSheetPortrait({
      sheetUrl: '/r2/talent/team-1/tal-1/sheet.png',
      destPath: 'team-1/tal-1/headshot.png',
    });
    expect(crop).toHaveBeenCalledWith(expect.anything(), 504, 24, 936, 456);
    expect(uploadFile).toHaveBeenCalledWith(
      STORAGE_BUCKETS.TALENT,
      'team-1/tal-1/headshot.png',
      expect.any(Uint8Array),
      { contentType: 'image/png' }
    );
    expect(result.publicUrl).toBe('/r2/talent/team-1/tal-1/headshot.png');
  });

  it('copies the whole image when it is not a landscape grid', async () => {
    get_width.mockReturnValue(800);
    get_height.mockReturnValue(800);
    const bytes = new Uint8Array([4, 5, 6]);
    readStorageObject.mockResolvedValue({
      bytes,
      contentType: 'image/jpeg',
    });
    await cropTalentSheetPortrait({
      sheetUrl: '/r2/talent/team-1/tal-1/sheet.png',
      destPath: 'team-1/tal-1/headshot.png',
    });
    expect(crop).not.toHaveBeenCalled();
    expect(uploadFile).toHaveBeenCalledWith(
      STORAGE_BUCKETS.TALENT,
      'team-1/tal-1/headshot.png',
      bytes,
      { contentType: 'image/jpeg' }
    );
  });
});
