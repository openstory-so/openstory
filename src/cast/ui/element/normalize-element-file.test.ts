import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { encodeWav } from './normalize-element-file';

describe('encodeWav', () => {
  // #1559: uploads re-encode M4A / OGG to WAV because every model that
  // documents its formats takes only MP3 or WAV. Read the result back with a
  // real demuxer rather than asserting header bytes.
  it('writes a WAV a demuxer reads back at the right length', async () => {
    const sampleRate = 48_000;
    const oneSecond = () => new Float32Array(sampleRate).fill(0.25);
    const bytes = encodeWav([oneSecond(), oneSecond()], sampleRate);

    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(bytes),
    });
    expect((await input.getFormat()).name).toBe('WAVE');
    expect(await input.computeDuration()).toBeCloseTo(1, 3);
    const [track] = await input.getAudioTracks();
    expect(track?.numberOfChannels).toBe(2);
    expect(track?.sampleRate).toBe(sampleRate);
    input.dispose();
  });

  it('clamps samples outside [-1, 1] instead of wrapping', () => {
    const bytes = encodeWav([new Float32Array([2, -2])], 8000);
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
  });
});
