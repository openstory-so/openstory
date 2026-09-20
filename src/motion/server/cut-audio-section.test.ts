/**
 * `cutAudioSection` (#1657): the byte arithmetic, and that the file it writes
 * is header + the ranged samples + silence — composed as a stream, from a
 * recording it never loads.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_MIN_PAD_SLACK_SECONDS,
  parseWavHeader,
  pcmToWav,
} from '@/motion/server/pad-dialogue-audio';

const SAMPLE_RATE = 8000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;

/** Mono 16-bit recording whose sample N holds the value N — so a slice names its own offset. */
function recording(seconds: number): Uint8Array {
  const samples = seconds * SAMPLE_RATE;
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, i % 30_000, true);
  return pcmToWav(pcm, SAMPLE_RATE, 1, 16);
}

let stored: Uint8Array = recording(10);
let exists = false;

const readStorageObject = vi.fn(
  async (_key: string, range?: { offset: number; length: number }) => ({
    bytes: range
      ? stored.slice(range.offset, range.offset + range.length)
      : stored.slice(),
    contentType: 'audio/wav',
  })
);
const readStorageStream = vi.fn(
  async (_key: string, range?: { offset: number; length: number }) => {
    const bytes = range
      ? stored.slice(range.offset, range.offset + range.length)
      : stored.slice();
    // Delivered in uneven pieces, as R2 would.
    const pieces = [bytes.subarray(0, 1001), bytes.subarray(1001)];
    return {
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          const piece = pieces.shift();
          if (piece?.length) controller.enqueue(piece);
          if (pieces.length === 0) controller.close();
        },
      }),
      size: bytes.length,
    };
  }
);
const fileExists = vi.fn(async () => exists);
const uploaded: { path: string; chunks: Uint8Array[] }[] = [];
const uploadFile = vi.fn(
  async (bucket: string, path: string, file: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = [];
    const reader = file.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    uploaded.push({ path, chunks });
    return {
      path: `${bucket}/${path}`,
      publicUrl: `/r2/${bucket}/${path}`,
      fullPath: `${bucket}/${path}`,
    };
  }
);

vi.doMock('#storage', () => ({
  readStorageObject,
  readStorageStream,
  fileExists,
  uploadFile,
}));

const { cutAudioSection } = await import('./cut-audio-section');

const base = {
  storageKey: 'audio/team-1/seq-1/dialogue-recordings/rec-1.wav',
  recordingId: 'rec-1',
  teamId: 'team-1',
  sequenceId: 'seq-1',
};

function written(): Uint8Array {
  const chunks = uploaded.at(-1)?.chunks ?? [];
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

beforeEach(() => {
  stored = recording(10);
  exists = false;
  uploaded.length = 0;
  readStorageObject.mockClear();
  readStorageStream.mockClear();
  uploadFile.mockClear();
});

describe('cutAudioSection', () => {
  it('reads a 4 KiB header, then ranges exactly the section', async () => {
    const cut = await cutAudioSection({
      ...base,
      fromSeconds: 1,
      toSeconds: 2.5,
    });

    expect(readStorageObject).toHaveBeenCalledWith(base.storageKey, {
      offset: 0,
      length: 4096,
    });
    expect(readStorageStream).toHaveBeenCalledWith(base.storageKey, {
      offset: 44 + 1 * BYTES_PER_SECOND,
      length: 1.5 * BYTES_PER_SECOND,
    });
    expect(cut.durationSeconds).toBeCloseTo(1.5, 5);
  });

  it('writes header + the ranged samples, byte for byte', async () => {
    await cutAudioSection({ ...base, fromSeconds: 1, toSeconds: 2.5 });

    const file = written();
    const sectionBytes = 1.5 * BYTES_PER_SECOND;
    expect(file).toHaveLength(44 + sectionBytes);
    expect(parseWavHeader(file)).toEqual({
      sampleRate: SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
      dataStart: 44,
      dataSize: sectionBytes,
    });
    expect(file.subarray(44)).toEqual(
      stored.subarray(
        44 + BYTES_PER_SECOND,
        44 + BYTES_PER_SECOND + sectionBytes
      )
    );
    // First sample of the file is the recording's sample at 1s.
    expect(new DataView(file.buffer).getInt16(44, true)).toBe(SAMPLE_RATE);
  });

  it('snaps both offsets DOWN to a whole frame', async () => {
    // 1.00003s and 2.00009s land mid-sample at 8 kHz.
    await cutAudioSection({
      ...base,
      fromSeconds: 1.00003,
      toSeconds: 2.00009,
    });
    expect(readStorageStream).toHaveBeenCalledWith(base.storageKey, {
      offset: 44 + BYTES_PER_SECOND,
      length: BYTES_PER_SECOND,
    });
  });

  it('clamps a section that runs past the recording', async () => {
    const cut = await cutAudioSection({
      ...base,
      fromSeconds: 9.5,
      toSeconds: 99,
    });
    expect(readStorageStream).toHaveBeenCalledWith(base.storageKey, {
      offset: 44 + 9.5 * BYTES_PER_SECOND,
      length: 0.5 * BYTES_PER_SECOND,
    });
    expect(cut.durationSeconds).toBeCloseTo(0.5, 5);
  });

  it('refuses an empty section', async () => {
    await expect(
      cutAudioSection({ ...base, fromSeconds: 1, toSeconds: 1 })
    ).rejects.toThrow(/1\.00–1\.00s of a 10\.00s recording is empty/);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('pads a short section with silence past the floor, slack included', async () => {
    // H3 Max reported 1.959s on a clip we thought was 2 — hence the slack.
    const cut = await cutAudioSection({
      ...base,
      fromSeconds: 1,
      toSeconds: 2.25,
      minDurationSeconds: 2,
    });

    const floorBytes = (2 + AUDIO_MIN_PAD_SLACK_SECONDS) * BYTES_PER_SECOND;
    const sectionBytes = 1.25 * BYTES_PER_SECOND;
    expect(cut.durationSeconds).toBeCloseTo(2 + AUDIO_MIN_PAD_SLACK_SECONDS, 5);
    const file = written();
    expect(file).toHaveLength(44 + floorBytes);
    expect(parseWavHeader(file)?.dataSize).toBe(floorBytes);
    expect(file.subarray(44, 44 + sectionBytes)).toEqual(
      stored.subarray(
        44 + BYTES_PER_SECOND,
        44 + BYTES_PER_SECOND + sectionBytes
      )
    );
    expect(file.subarray(44 + sectionBytes).every((byte) => byte === 0)).toBe(
      true
    );
  });

  it('writes the silence in blocks of at most 16 KiB', async () => {
    await cutAudioSection({
      ...base,
      fromSeconds: 0,
      toSeconds: 0.5,
      minDurationSeconds: 8,
    });
    const chunks = uploaded.at(-1)?.chunks ?? [];
    expect(chunks.length).toBeGreaterThan(4);
    expect(
      Math.max(...chunks.map((chunk) => chunk.length))
    ).toBeLessThanOrEqual(16 * 1024);
  });

  it('leaves a section already over the floor unpadded', async () => {
    const cut = await cutAudioSection({
      ...base,
      fromSeconds: 1,
      toSeconds: 4,
      minDurationSeconds: 2,
    });
    expect(cut.durationSeconds).toBeCloseTo(3, 5);
    expect(written()).toHaveLength(44 + 3 * BYTES_PER_SECOND);
  });

  it('names the file by the recording and the range, so a cut is a cache', async () => {
    const cut = await cutAudioSection({
      ...base,
      fromSeconds: 1.2345,
      toSeconds: 2.5,
      minDurationSeconds: 1.8,
    });
    const path = 'team-1/seq-1/dialogue-sections/rec-1_1235_2500_1800.wav';
    expect(uploadFile.mock.calls[0]?.[1]).toBe(path);
    expect(cut.path).toBe(`audio/${path}`);
    expect(cut.url).toContain(path);

    const unfloored = await cutAudioSection({
      ...base,
      fromSeconds: 1,
      toSeconds: 2,
    });
    expect(unfloored.path).toBe(
      'audio/team-1/seq-1/dialogue-sections/rec-1_1000_2000_0.wav'
    );
  });

  it('answers a cache hit from arithmetic, without reading a sample', async () => {
    exists = true;
    const cut = await cutAudioSection({
      ...base,
      fromSeconds: 1,
      toSeconds: 2.25,
      minDurationSeconds: 2,
    });

    expect(cut.durationSeconds).toBeCloseTo(2 + AUDIO_MIN_PAD_SLACK_SECONDS, 5);
    expect(cut.path).toBe(
      'audio/team-1/seq-1/dialogue-sections/rec-1_1000_2250_2000.wav'
    );
    expect(readStorageStream).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('fails on a recording that is missing or is not a PCM WAV', async () => {
    readStorageObject.mockResolvedValueOnce(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the real signature's "no such key"
      null as unknown as Awaited<ReturnType<typeof readStorageObject>>
    );
    await expect(
      cutAudioSection({ ...base, fromSeconds: 0, toSeconds: 1 })
    ).rejects.toThrow(/missing from storage/);

    stored = new Uint8Array(200);
    await expect(
      cutAudioSection({ ...base, fromSeconds: 0, toSeconds: 1 })
    ).rejects.toThrow(/PCM WAV/);
  });

  it('fails when the file is shorter than its header says', async () => {
    stored = stored.subarray(0, 44 + 3 * BYTES_PER_SECOND);
    await expect(
      cutAudioSection({ ...base, fromSeconds: 2, toSeconds: 5 })
    ).rejects.toThrow(/shorter than its header says/);
  });
});
