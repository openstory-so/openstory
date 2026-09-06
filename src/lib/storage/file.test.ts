import { describe, expect, test } from 'vitest';
import { getExtensionFromMimeType, sniffImageMimeType } from './file';

describe('sniffImageMimeType', () => {
  test('detects PNG from the 8-byte signature', () => {
    expect(
      sniffImageMimeType(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
    ).toBe('image/png');
  });

  test('detects JPEG from SOI + marker', () => {
    expect(sniffImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      'image/jpeg'
    );
  });

  test('detects GIF', () => {
    expect(sniffImageMimeType(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe(
      'image/gif'
    );
  });

  test('detects WebP (RIFF....WEBP)', () => {
    const bytes = new Uint8Array(12);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniffImageMimeType(bytes)).toBe('image/webp');
  });

  test('returns null for unrecognised or truncated bytes', () => {
    expect(sniffImageMimeType(new Uint8Array([]))).toBeNull();
    expect(sniffImageMimeType(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(sniffImageMimeType(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

describe('getExtensionFromMimeType', () => {
  test('maps image types and strips a charset parameter', () => {
    expect(getExtensionFromMimeType('image/png')).toBe('png');
    expect(getExtensionFromMimeType('image/jpeg; charset=binary')).toBe('jpg');
  });

  test('returns null for missing or unknown types', () => {
    expect(getExtensionFromMimeType(null)).toBeNull();
    expect(getExtensionFromMimeType('application/octet-stream')).toBeNull();
  });
});
