import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALL_FORMATS,
  BufferSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { planFragment, readBoxHeader } from './fragment-mp4';

const FIXTURE = new Uint8Array(
  readFileSync(resolve(__dirname, '../../../e2e/fixtures/test-video.mp4'))
);

function moovOf(file: Uint8Array): Uint8Array {
  let at = 0;
  while (at < file.byteLength) {
    const box = readBoxHeader(file.subarray(at, at + 16), file.byteLength - at);
    if (box.type === 'moov') return file.slice(at, at + box.size);
    at += box.size;
  }
  throw new Error('no moov');
}

/** What `repackage` uploads, assembled in memory for the test. */
function fragmented(file: Uint8Array) {
  const plan = planFragment(moovOf(file));
  const out = new Uint8Array(plan.size);
  out.set(plan.init, 0);
  out.set(plan.fragmentHead, plan.init.byteLength);
  let at = plan.init.byteLength + plan.fragmentHead.byteLength;
  for (const r of plan.ranges) {
    out.set(file.subarray(r.offset, r.offset + r.length), at);
    at += r.length;
  }
  expect(at).toBe(plan.size);
  return { plan, bytes: out };
}

type Packet = {
  timestamp: number;
  duration: number;
  key: boolean;
  data: number[];
};

async function packetsOf(file: Uint8Array) {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BufferSource(file),
  });
  const read = async (kind: 'video' | 'audio') => {
    const track =
      kind === 'video'
        ? await input.getPrimaryVideoTrack()
        : await input.getPrimaryAudioTrack();
    if (!track) return null;
    const packets: Packet[] = [];
    for await (const p of new EncodedPacketSink(track).packets()) {
      packets.push({
        timestamp: Math.round(p.timestamp * 1e6),
        duration: Math.round(p.duration * 1e6),
        key: p.type === 'key',
        data: [...p.data],
      });
    }
    return { codec: await track.getCodec(), packets };
  };
  const result = {
    video: await read('video'),
    audio: await read('audio'),
    duration: await input.computeDuration(),
  };
  input.dispose();
  return result;
}

/** A plain (moov + mdat) MP4 with the fixture's video and a fake AAC track. */
async function avClip(
  audioStart = 0,
  fastStart: 'in-memory' | false = 'in-memory'
): Promise<Uint8Array> {
  const source = await packetsOf(FIXTURE);
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BufferSource(FIXTURE),
  });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack || !source.video) throw new Error('fixture has no video');
  const videoConfig = await videoTrack.getDecoderConfig();

  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart }),
    target,
  });
  const video = new EncodedVideoPacketSource('avc');
  const audio = new EncodedAudioPacketSource('aac');
  output.addVideoTrack(video);
  output.addAudioTrack(audio);
  await output.start();

  let first = true;
  for await (const p of new EncodedPacketSink(videoTrack).packets()) {
    await video.add(
      p,
      first && videoConfig ? { decoderConfig: videoConfig } : undefined
    );
    first = false;
  }
  const frame = 1024 / 44_100;
  for (let i = 0; i < 24; i++) {
    await audio.add(
      new EncodedPacket(
        Uint8Array.from({ length: 40 + i }, (_, j) => (i * 7 + j) & 0xff),
        'key',
        audioStart + i * frame,
        frame
      ),
      i === 0
        ? {
            decoderConfig: {
              codec: 'mp4a.40.2',
              sampleRate: 44_100,
              numberOfChannels: 2,
              description: Uint8Array.of(0x12, 0x10),
            },
          }
        : undefined
    );
  }
  await output.finalize();
  input.dispose();
  if (!target.buffer) throw new Error('mux wrote nothing');
  return new Uint8Array(target.buffer);
}

/**
 * Insert an edit list into the audio trak of a moov-last file: its media
 * starts `mediaTime` units in, like an AAC encoder's priming frame.
 */
function withAudioEdit(file: Uint8Array, mediaTime: number): Uint8Array {
  let at = 0;
  let moovAt = -1;
  while (at < file.byteLength) {
    const box = readBoxHeader(file.subarray(at, at + 16), file.byteLength - at);
    if (box.type === 'moov') moovAt = at;
    at += box.size;
  }
  const dv = new DataView(file.buffer, file.byteOffset);
  const moovSize = dv.getUint32(moovAt);
  let trakAt = moovAt + 8;
  let audioTrak = -1;
  const soun = new TextEncoder().encode('soun');
  const holds = (from: number, to: number) =>
    file
      .subarray(from, to)
      .some((_, i, a) => soun.every((b, j) => a[i + j] === b));
  while (trakAt < moovAt + moovSize) {
    const box = readBoxHeader(file.subarray(trakAt, trakAt + 16), 0);
    if (box.type === 'trak' && holds(trakAt, trakAt + box.size)) {
      audioTrak = trakAt;
    }
    trakAt += box.size;
  }
  const tkhdSize = dv.getUint32(audioTrak + 8);
  const insertAt = audioTrak + 8 + tkhdSize;

  const edts = new Uint8Array(36);
  const e = new DataView(edts.buffer);
  e.setUint32(0, 36);
  edts.set(new TextEncoder().encode('edts'), 4);
  e.setUint32(8, 28);
  edts.set(new TextEncoder().encode('elst'), 12);
  // 16: version 0, flags 0
  e.setUint32(20, 1); // entries
  e.setUint32(24, 1); // segment duration (non-zero, else ignored)
  e.setInt32(28, mediaTime);
  e.setUint32(32, 0x10000); // rate 1.0

  const out = new Uint8Array(file.byteLength + 36);
  out.set(file.subarray(0, insertAt), 0);
  out.set(edts, insertAt);
  out.set(file.subarray(insertAt), insertAt + 36);
  const o = new DataView(out.buffer);
  o.setUint32(moovAt, moovSize + 36);
  o.setUint32(audioTrak, o.getUint32(audioTrak) + 36);
  return out;
}

describe('planFragment', () => {
  it('copies every video packet unchanged, on the same clock', async () => {
    const { plan, bytes } = fragmented(FIXTURE);
    const before = await packetsOf(FIXTURE);
    const after = await packetsOf(bytes);

    expect(after.video).toEqual(before.video);
    expect(after.audio).toBeNull();
    expect(plan.videoCodec).toBe('avc');
    expect(plan.hasAudio).toBe(false);
    expect(plan.durationSeconds).toBeCloseTo(before.duration, 3);
  });

  it('copies video and audio, each on its own clock', async () => {
    const clip = await avClip();
    const { plan, bytes } = fragmented(clip);
    const before = await packetsOf(clip);
    const after = await packetsOf(bytes);

    expect(after.video).toEqual(before.video);
    expect(after.audio).toEqual(before.audio);
    expect(plan.hasAudio).toBe(true);
    expect(plan.durationSeconds).toBeCloseTo(before.duration, 3);
  });

  it('applies an edit list: audio that starts late keeps its delay', async () => {
    const clip = await avClip(0.1);
    const before = await packetsOf(clip);
    expect(before.audio?.packets[0]?.timestamp).toBe(100_000);
    const after = await packetsOf(fragmented(clip).bytes);
    expect(after.audio).toEqual(before.audio);
    expect(after.video).toEqual(before.video);
  });

  it('drops audio priming that lands before zero', async () => {
    // moov last, so growing it moves no sample offsets.
    const clip = withAudioEdit(await avClip(0, false), 1024);
    const before = await packetsOf(clip);
    expect(before.audio?.packets[0]?.timestamp).toBeLessThan(0);
    const after = await packetsOf(fragmented(clip).bytes);
    expect(after.audio?.packets).toEqual(
      before.audio?.packets.filter((p) => p.timestamp >= 0)
    );
    expect(after.video).toEqual(before.video);
  });

  it('puts ftyp + moov before the first moof', () => {
    const { plan, bytes } = fragmented(FIXTURE);
    const types: string[] = [];
    let at = 0;
    while (at < bytes.byteLength) {
      const box = readBoxHeader(
        bytes.subarray(at, at + 16),
        bytes.byteLength - at
      );
      types.push(box.type);
      at += box.size;
    }
    expect(types).toEqual(['ftyp', 'moov', 'moof', 'mdat']);
    expect(plan.init.byteLength).toBeGreaterThan(0);
  });

  it('reads the clip in a few coalesced ranges, not one per packet', async () => {
    const clip = await avClip();
    const { plan } = fragmented(clip);
    // One contiguous run per track chunk; the muxer interleaves ~0.5 s chunks.
    expect(plan.ranges.length).toBeLessThanOrEqual(4);
  });
});
