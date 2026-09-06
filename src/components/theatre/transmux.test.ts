/**
 * Unit tests for the transmux-compatibility logic that gates the export's
 * fast path (packet concatenation) vs. slow path (decode→re-encode) (#791).
 * Pure logic; no Mediabunny surface needed.
 */

import { describe, expect, test } from 'vitest';
import {
  canTransmuxScenes,
  decoderConfigDescriptionHex,
  type SceneCodecProbe,
} from './transmux';

const avc = (descriptionHex: string): SceneCodecProbe => ({
  codec: 'avc',
  descriptionHex,
});

describe('canTransmuxScenes', () => {
  test('no probes is not transmuxable', () => {
    expect(canTransmuxScenes([])).toBe(false);
  });

  test('a single AVC scene with a decoder config is transmuxable', () => {
    expect(canTransmuxScenes([avc('0142')])).toBe(true);
  });

  test('identical AVC configs across scenes are transmuxable', () => {
    expect(canTransmuxScenes([avc('0142'), avc('0142'), avc('0142')])).toBe(
      true
    );
  });

  test('any non-AVC codec forces re-encode', () => {
    expect(
      canTransmuxScenes([avc('0142'), { codec: 'vp9', descriptionHex: '0142' }])
    ).toBe(false);
    expect(
      canTransmuxScenes([avc('0142'), { codec: null, descriptionHex: '0142' }])
    ).toBe(false);
  });

  test('a missing decoder config forces re-encode', () => {
    expect(canTransmuxScenes([avc('0142'), avc('')])).toBe(false);
    // Even when it's the only scene — no SPS/PPS means no safe concatenation.
    expect(canTransmuxScenes([avc('')])).toBe(false);
  });

  test('differing decoder configs force re-encode', () => {
    // The #791 case: same codec, different SPS (resolution baked in).
    expect(canTransmuxScenes([avc('0142'), avc('0143')])).toBe(false);
  });
});

describe('decoderConfigDescriptionHex', () => {
  const config = (
    description: AllowSharedBufferSource | undefined
  ): VideoDecoderConfig => ({ codec: 'avc1.42001f', description });

  test('hex-encodes an ArrayBuffer description', () => {
    const buf = new Uint8Array([0x01, 0x42, 0x00, 0xff]).buffer;
    expect(decoderConfigDescriptionHex(config(buf))).toBe('014200ff');
  });

  test('hex-encodes a typed-array view', () => {
    const view = new Uint8Array([0x01, 0x42, 0x00, 0xff]);
    expect(decoderConfigDescriptionHex(config(view))).toBe('014200ff');
  });

  test('respects byteOffset/byteLength on a view into a larger buffer', () => {
    // Regression guard: reading the whole underlying buffer instead of the
    // offset slice would make two distinct configs compare equal.
    const backing = new Uint8Array([
      0xaa, 0xbb, 0x01, 0x42, 0x00, 0xff, 0xcc, 0xdd,
    ]);
    const view = new Uint8Array(backing.buffer, 2, 4);
    expect(decoderConfigDescriptionHex(config(view))).toBe('014200ff');
  });

  test('returns empty string for a missing description', () => {
    expect(decoderConfigDescriptionHex(config(undefined))).toBe('');
  });

  test('returns empty string for an empty description', () => {
    expect(decoderConfigDescriptionHex(config(new ArrayBuffer(0)))).toBe('');
    expect(decoderConfigDescriptionHex(config(new Uint8Array(0)))).toBe('');
  });

  test('zero-pads single-digit bytes', () => {
    expect(
      decoderConfigDescriptionHex(config(new Uint8Array([0x00, 0x0a])))
    ).toBe('000a');
  });
});
