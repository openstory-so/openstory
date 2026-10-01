/**
 * The splice in `recordDialogueTake` (#1802), byte for byte: the new file is
 * the base section before the line, the converted take, and the base section
 * after it — and the turns point at those samples.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pcmToWav } from './pad-dialogue-audio';

const RATE = 8000;
const BYTES_PER_SECOND = RATE * 2;

const stored = new Map<string, Uint8Array<ArrayBuffer>>();
const uploaded: Uint8Array[] = [];
let converted: Uint8Array<ArrayBuffer> = new Uint8Array(0);

vi.doMock('#storage', () => ({
  readStorageObject: async (
    key: string,
    range?: { offset: number; length: number }
  ) => {
    const bytes = stored.get(key);
    if (!bytes) return null;
    return {
      bytes: range
        ? bytes.slice(range.offset, range.offset + range.length)
        : bytes,
      contentType: 'audio/wav',
    };
  },
  readStorageStream: async (
    key: string,
    range: { offset: number; length: number }
  ) => {
    const bytes = stored.get(key);
    if (!bytes) return null;
    const slice = bytes.slice(range.offset, range.offset + range.length);
    return { body: new Response(slice).body, size: slice.length };
  },
  // The splice streams its upload; collect it to compare bytes.
  uploadFile: async (
    _bucket: string,
    path: string,
    body: ReadableStream<Uint8Array>
  ) => {
    uploaded.push(new Uint8Array(await new Response(body).arrayBuffer()));
    return { fullPath: path, publicUrl: `/r2/${path}` };
  },
}));
vi.doMock('@/models/server/elevenlabs-config', () => ({
  createElevenLabsSdk: async () => ({
    speechToSpeech: { convert: async () => new Response(converted).body },
  }),
}));

const { recordDialogueTake } = await import('./record-dialogue-take');

/** `seconds` of 16-bit mono PCM at `value`, one value per second if an array. */
function pcm(values: number[], rate = RATE): Uint8Array {
  const out = new Uint8Array(values.length * rate * 2);
  const view = new DataView(out.buffer);
  values.forEach((value, second) => {
    for (let i = 0; i < rate; i++) {
      view.setInt16((second * rate + i) * 2, value, true);
    }
  });
  return out;
}

const turn = (index: number, startSeconds: number, endSeconds: number) => ({
  shotId: 'shot',
  index,
  voiceId: 'voice-a',
  ttsModel: 'eleven_v3',
  startSeconds,
  endSeconds,
});

const line = {
  index: 1,
  voiceId: 'voice-b',
  character: 'B',
  text: 'Hi',
  tone: '',
};

// Four seconds, each second its own level, so any slice is recognisable.
const basePcm = pcm([1000, 2000, 3000, 4000]);
const base = {
  storageKey: 'base.wav',
  fromSeconds: 0.5,
  toSeconds: 3.5,
  lineStartSeconds: 1.5,
  lineEndSeconds: 2.5,
  turns: [turn(0, 0.5, 1.4), turn(1, 1.5, 2.5), turn(2, 2.6, 3.4)],
};

const record = (overrides: { base?: typeof base | null } = {}) =>
  recordDialogueTake({
    elevenLabsKey: 'el-key',
    seedKey: null,
    teamId: 'team',
    sequenceId: 'seq',
    shotId: 'shot',
    line,
    takeStorageKey: 'take.wav',
    base: 'base' in overrides ? (overrides.base ?? null) : base,
  });

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;
const at = (seconds: number) => Math.round(seconds * BYTES_PER_SECOND);

beforeEach(() => {
  stored.clear();
  uploaded.length = 0;
  stored.set('base.wav', pcmToWav(basePcm, RATE));
  stored.set('take.wav', pcmToWav(pcm([500]), RATE));
  converted = pcmToWav(pcm([9000]), RATE);
});

describe('recordDialogueTake splice (#1802)', () => {
  it('replaces the line window with the take and keeps the rest', async () => {
    const take = await record();

    const file = uploaded[0];
    if (!file) throw new Error('nothing uploaded');
    const expected = new Uint8Array([
      ...basePcm.subarray(at(0.5), at(1.5)),
      ...pcm([9000]),
      ...basePcm.subarray(at(2.5), at(3.5)),
    ]);
    expect(file.subarray(44)).toEqual(expected);
    expect(take.durationSeconds).toBe(3);
    expect(
      take.turns.map((t) => [
        t.index,
        round(t.startSeconds),
        round(t.endSeconds),
      ])
    ).toEqual([
      [0, 0, 0.9],
      [1, 1, 2],
      [2, 2.1, 2.9],
    ]);
    expect(take.turns[1]?.voiceId).toBe('voice-b');
  });

  it('with no base, the take is the whole speech', async () => {
    const take = await record({ base: null });
    expect(uploaded[0]?.subarray(44)).toEqual(pcm([9000]));
    expect(take.turns).toEqual([
      expect.objectContaining({ index: 1, startSeconds: 0, endSeconds: 1 }),
    ]);
  });

  it('refuses a converted take with no sound in it', async () => {
    converted = pcmToWav(pcm([0]), RATE);
    await expect(record()).rejects.toThrow('No speech was heard');
    expect(uploaded).toHaveLength(0);
  });

  it('refuses a take whose format does not match the reading', async () => {
    converted = pcmToWav(pcm([9000], RATE * 2), RATE * 2);
    await expect(record()).rejects.toThrow('does not match the reading');
    expect(uploaded).toHaveLength(0);
  });

  it('refuses a line that does not sit in the section', async () => {
    await expect(
      record({ base: { ...base, lineStartSeconds: 3.6, lineEndSeconds: 3.9 } })
    ).rejects.toThrow('does not sit in the reading');
  });
});
