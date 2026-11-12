import { describe, expect, it } from 'vitest';
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
});

describe('normalizeImageFile', () => {
  it('hands back a file it does not convert', async () => {
    const png = file('a.png', 'image/png');
    expect(await normalizeImageFile(png)).toBe(png);
  });

  it('refuses an image the browser cannot decode', async () => {
    await expect(normalizeImageFile(file('IMG_1.heic'))).rejects.toThrow(
      'can’t read a .heic image'
    );
  });
});
