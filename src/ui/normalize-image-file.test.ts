import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  needsImageConversion,
  normalizeImageFile,
} from './normalize-image-file';

const file = (name: string, type = '') => new File(['x'], name, { type });

describe('needsImageConversion', () => {
  it.each(['logo.avif', 'IMG_4990.HEIC', 'scan.tiff', 'old.bmp'])(
    'converts %s',
    (name) => {
      expect(needsImageConversion(file(name))).toBe(true);
    }
  );

  it.each(['a.jpg', 'a.JPEG', 'a.png', 'a.webp', 'a.gif', 'a.mp4', 'a.wav'])(
    'leaves %s',
    (name) => {
      expect(needsImageConversion(file(name))).toBe(false);
    }
  );

  it('goes by the type when the name has no known extension', () => {
    expect(needsImageConversion(file('pasted', 'image/avif'))).toBe(true);
    expect(needsImageConversion(file('pasted', 'image/png'))).toBe(false);
  });

  it('goes by the type when the name is wrong', () => {
    expect(needsImageConversion(file('photo.png', 'image/heic'))).toBe(true);
  });
});

describe('normalizeImageFile', () => {
  it('hands back a file it does not convert', async () => {
    const png = file('a.png', 'image/png');
    expect(await normalizeImageFile(png)).toBe(png);
  });

  /** A browser whose decoder answers with `decode`. */
  const stubBrowser = (decode: () => Promise<unknown>) => {
    vi.stubGlobal('createImageBitmap', decode);
    vi.stubGlobal('document', {
      createElement: () => ({
        getContext: () => ({ drawImage: () => {} }),
        toBlob: (done: (blob: Blob) => void) =>
          done(new Blob(['png'], { type: 'image/png' })),
      }),
    });
  };
  afterEach(() => vi.unstubAllGlobals());

  it('stores a converted image as a PNG under the same name', async () => {
    stubBrowser(async () => ({ width: 2, height: 2, close: () => {} }));
    const heic = new File(['x'], 'IMG_1.heic', { lastModified: 5 });
    const png = await normalizeImageFile(heic);
    expect(png.name).toBe('IMG_1.png');
    expect(png.type).toBe('image/png');
    expect(png.lastModified).toBe(5);
    expect(await png.text()).toBe('png');
  });

  it('refuses an image the browser cannot decode, by name', async () => {
    stubBrowser(async () => {
      throw new Error('decode failed');
    });
    await expect(normalizeImageFile(file('IMG_1.heic'))).rejects.toThrow(
      'can’t convert IMG_1.heic'
    );
  });
});
