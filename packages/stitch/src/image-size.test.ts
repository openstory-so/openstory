import { describe, expect, it } from 'vitest';
import { readImageSize } from './image-size.js';

describe('readImageSize', () => {
  it('reads a png header', () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    expect(readImageSize(png)).toEqual({ width: 1, height: 1 });
  });

  it('reads a jpeg start-of-frame after an app segment', () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11,
      0x08, 0x00, 0x02, 0x00, 0x03,
    ]);
    expect(readImageSize(jpeg)).toEqual({ width: 3, height: 2 });
  });

  it('reads a webp extended header', () => {
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0);
    webp.write('WEBP', 8);
    webp.write('VP8X', 12);
    webp.writeUIntLE(1919, 24, 3);
    webp.writeUIntLE(1079, 27, 3);
    expect(readImageSize(webp)).toEqual({ width: 1920, height: 1080 });
  });

  it('reads a webp lossy header', () => {
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0);
    webp.write('WEBP', 8);
    webp.write('VP8 ', 12);
    webp.set([0x9d, 0x01, 0x2a], 23);
    webp.writeUInt16LE(640, 26);
    webp.writeUInt16LE(360, 28);
    expect(readImageSize(webp)).toEqual({ width: 640, height: 360 });
  });

  it('reads a webp lossless header', () => {
    const webp = Buffer.alloc(25);
    webp.write('RIFF', 0);
    webp.write('WEBP', 8);
    webp.write('VP8L', 12);
    webp[20] = 0x2f;
    webp.writeUInt32LE((640 - 1) | ((360 - 1) << 14), 21);
    expect(readImageSize(webp)).toEqual({ width: 640, height: 360 });
  });

  it('swaps the sides of a jpeg its EXIF turns a quarter', () => {
    // APP1 Exif, little-endian TIFF, IFD0 with one entry: orientation 6.
    const tiff = Buffer.alloc(26);
    tiff.write('II', 0);
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x0112, 10);
    tiff.writeUInt16LE(3, 12);
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt16LE(6, 18);
    const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(app1.length + 2);
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
      length,
      app1,
      Buffer.from([
        0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00,
      ]),
    ]);
    expect(readImageSize(jpeg)).toEqual({ width: 2, height: 3 });
  });

  it('says a png whose header is cut off is unreadable', () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(() => readImageSize(png)).toThrow('the png header is unreadable');
  });

  it('rejects a file that is not a still', () => {
    expect(() => readImageSize(Buffer.from('not an image'))).toThrow(
      /png, jpeg, or webp/
    );
  });
});
