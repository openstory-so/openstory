import { describe, expect, it } from 'vitest';
import { floatToPcm16 } from './mic-take';

describe('floatToPcm16 (#1802)', () => {
  it('writes clamped 16-bit little-endian samples', () => {
    const view = new DataView(
      floatToPcm16(new Float32Array([0, 1, -1, 2])).buffer
    );
    expect([0, 2, 4, 6].map((at) => view.getInt16(at, true))).toEqual([
      0, 32767, -32768, 32767,
    ]);
  });
});
