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

  it('rejects a file that is not a still', () => {
    expect(() => readImageSize(Buffer.from('not an image'))).toThrow(
      /png, jpeg, or webp/
    );
  });
});
