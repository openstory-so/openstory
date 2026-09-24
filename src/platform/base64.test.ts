import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from './base64';

// Over one slice either way, with every padding shape.
const LENGTHS = [0, 1, 2, 3, 24_575, 24_576, 24_577, 70_001];
const bytesOf = (length: number) =>
  new Uint8Array(length).map((_, i) => (i * 31 + 7) % 256);

describe('base64ToBytes', () => {
  it('decodes to exactly the bytes a whole-file decode gives', () => {
    for (const length of LENGTHS) {
      const bytes = bytesOf(length);
      expect(base64ToBytes(Buffer.from(bytes).toString('base64'))).toEqual(
        bytes
      );
    }
  });

  it('skips whitespace the way a whole-file decode would', () => {
    const bytes = bytesOf(100);
    const base64 = Buffer.from(bytes).toString('base64');
    expect(
      base64ToBytes(`${base64.slice(0, 41)}\n${base64.slice(41)}`)
    ).toEqual(bytes);
  });
});

describe('bytesToBase64', () => {
  it('encodes to exactly what a whole-file encode gives', () => {
    for (const length of LENGTHS) {
      const bytes = bytesOf(length);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
});
