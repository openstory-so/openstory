/**
 * A plain MP4 (`moov` + `mdat`) rewritten as a one-fragment MP4 for HLS
 * (`ftyp` + `moov`/`mvex`, then `moof` + `mdat`) without holding the clip.
 *
 * Everything but the sample bytes comes from the source's `moov` — a few KB
 * even for a long clip. The sample bytes are copied from the source as byte
 * ranges, so the caller streams them from storage to storage and never has
 * more than one read buffer of the clip in memory. Nothing is decoded; the
 * codec boxes (`stsd`, `tkhd`, `mdhd`, `hdlr`, the media header, `dinf`) are
 * copied verbatim.
 *
 * Timing matches what the mediabunny remux wrote before (#1735): the edit
 * list is applied, samples that land before zero (AAC encoder priming) are
 * dropped, and each track keeps its own clock. The fragment's layout is the
 * one mediabunny writes: `tfhd` default-base-is-moof, `tfdt` v1, `trun` v1
 * with signed composition offsets.
 */

import { ValidationError } from '@/platform/errors';

type Box = { type: string; start: number; headerSize: number; end: number };

type Sample = {
  /** Byte offset in the source file. */
  offset: number;
  size: number;
  duration: number;
  /** Presentation time on the track's clock, edit list applied. */
  pts: number;
  /** Decode time on the track's clock. */
  dts: number;
  key: boolean;
};

type Track = {
  id: number;
  kind: 'video' | 'audio';
  timescale: number;
  codec: string;
  /** Verbatim `tkhd`, `mdhd`, `hdlr`, `vmhd`/`smhd`, `dinf`, `stsd` boxes. */
  boxes: {
    tkhd: Uint8Array;
    mdhd: Uint8Array;
    hdlr: Uint8Array;
    mediaHeader: Uint8Array;
    dinf: Uint8Array;
    stsd: Uint8Array;
  };
  samples: Sample[];
};

type ByteRange = { offset: number; length: number };

export type FragmentPlan = {
  /** `ftyp` + `moov` — the HLS init section. */
  init: Uint8Array;
  /** `moof` + the `mdat` header. The sample ranges follow it. */
  fragmentHead: Uint8Array;
  /** Source byte ranges, in output order, that make up the `mdat` payload. */
  ranges: ByteRange[];
  size: number;
  durationSeconds: number;
  videoCodec: string;
  hasAudio: boolean;
};

const VIDEO_CODECS: Record<string, string> = {
  avc1: 'avc',
  avc3: 'avc',
  hvc1: 'hevc',
  hev1: 'hevc',
  vp09: 'vp9',
  av01: 'av1',
};
const AUDIO_CODECS: Record<string, string> = {
  mp4a: 'aac',
  Opus: 'opus',
  'ac-3': 'ac3',
  'ec-3': 'eac3',
  fLaC: 'flac',
};

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(
    bytes[at] ?? 0,
    bytes[at + 1] ?? 0,
    bytes[at + 2] ?? 0,
    bytes[at + 3] ?? 0
  );
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(dv: DataView, at: number): number {
  return dv.getUint32(at) * 2 ** 32 + dv.getUint32(at + 4);
}

/** Size of a box header whose first 16 bytes are `head`, and the box's size. */
export function readBoxHeader(
  head: Uint8Array,
  remaining: number
): { type: string; headerSize: number; size: number } {
  const dv = view(head);
  const size32 = dv.getUint32(0);
  const type = fourcc(head, 4);
  if (size32 === 1) return { type, headerSize: 16, size: u64(dv, 8) };
  if (size32 === 0) return { type, headerSize: 8, size: remaining };
  if (size32 < 8) throw new ValidationError(`Corrupt MP4 box ${type}`);
  return { type, headerSize: 8, size: size32 };
}

function children(bytes: Uint8Array, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    const { type, headerSize, size } = readBoxHeader(
      bytes.subarray(at, Math.min(at + 16, end)),
      end - at
    );
    if (at + size > end) throw new ValidationError(`Corrupt MP4 box ${type}`);
    boxes.push({ type, start: at, headerSize, end: at + size });
    at += size;
  }
  return boxes;
}

function child(bytes: Uint8Array, parent: Box, type: string): Box | undefined {
  return children(bytes, parent.start + parent.headerSize, parent.end).find(
    (b) => b.type === type
  );
}

function need(bytes: Uint8Array, parent: Box, type: string): Box {
  const found = child(bytes, parent, type);
  if (!found) throw new ValidationError(`MP4 is missing ${type}`);
  return found;
}

function raw(bytes: Uint8Array, box: Box): Uint8Array {
  return bytes.slice(box.start, box.end);
}

/** Body of a full box (after version + flags), and its version. */
function fullBody(bytes: Uint8Array, box: Box) {
  const at = box.start + box.headerSize;
  return {
    version: bytes[at] ?? 0,
    dv: view(bytes.subarray(at + 4, box.end)),
  };
}

function timescaleOf(bytes: Uint8Array, box: Box): number {
  const { version, dv } = fullBody(bytes, box);
  return dv.getUint32(version === 1 ? 16 : 8);
}

function trackIdOf(bytes: Uint8Array, tkhd: Box): number {
  const { version, dv } = fullBody(bytes, tkhd);
  return dv.getUint32(version === 1 ? 16 : 8);
}

/**
 * Where the track's media starts, and how long it waits first (an empty edit),
 * both on the track's clock. Zero-length edits are skipped and only the first
 * media edit counts, as in mediabunny.
 */
function editOf(
  bytes: Uint8Array,
  trak: Box,
  movieTimescale: number,
  timescale: number
): { mediaTime: number; delay: number } {
  const edts = child(bytes, trak, 'edts');
  const elst = edts && child(bytes, edts, 'elst');
  if (!elst) return { mediaTime: 0, delay: 0 };
  const { version, dv } = fullBody(bytes, elst);
  const count = dv.getUint32(0);
  let at = 4;
  let delay = 0;
  for (let i = 0; i < count; i++) {
    const segmentDuration = version === 1 ? u64(dv, at) : dv.getUint32(at);
    const mediaTime =
      version === 1 ? Number(dv.getBigInt64(at + 8)) : dv.getInt32(at + 4);
    at += version === 1 ? 20 : 12;
    if (segmentDuration === 0) continue;
    if (mediaTime === -1) {
      delay += Math.round((segmentDuration * timescale) / movieTimescale);
      continue;
    }
    return { mediaTime, delay };
  }
  return { mediaTime: 0, delay };
}

function readSamples(
  bytes: Uint8Array,
  stbl: Box,
  edit: { mediaTime: number; delay: number }
): Sample[] {
  const table = (type: string) => {
    const box = child(bytes, stbl, type);
    return box ? fullBody(bytes, box) : undefined;
  };

  const stsz = table('stsz');
  const stz2 = table('stz2');
  const sizes: number[] = [];
  if (stsz) {
    const uniform = stsz.dv.getUint32(0);
    const count = stsz.dv.getUint32(4);
    for (let i = 0; i < count; i++) {
      sizes.push(uniform || stsz.dv.getUint32(8 + i * 4));
    }
  } else if (stz2) {
    throw new ValidationError('MP4 uses compact sample sizes (stz2)');
  } else {
    throw new ValidationError('MP4 is missing stsz');
  }
  const count = sizes.length;

  const stts = table('stts');
  if (!stts) throw new ValidationError('MP4 is missing stts');
  const durations: number[] = [];
  for (let e = 0, n = stts.dv.getUint32(0); e < n; e++) {
    const runLength = stts.dv.getUint32(4 + e * 8);
    const delta = stts.dv.getUint32(8 + e * 8);
    for (let i = 0; i < runLength; i++) durations.push(delta);
  }

  const ctts = table('ctts');
  const compositionOffsets: number[] = [];
  if (ctts) {
    for (let e = 0, n = ctts.dv.getUint32(0); e < n; e++) {
      const runLength = ctts.dv.getUint32(4 + e * 8);
      const offset = ctts.dv.getInt32(8 + e * 8);
      for (let i = 0; i < runLength; i++) compositionOffsets.push(offset);
    }
  }

  const stss = table('stss');
  const keys = stss ? new Set<number>() : null;
  if (stss && keys) {
    for (let e = 0, n = stss.dv.getUint32(0); e < n; e++) {
      keys.add(stss.dv.getUint32(4 + e * 4) - 1);
    }
  }

  const stco = table('stco');
  const co64 = table('co64');
  const chunkOffsets: number[] = [];
  if (stco) {
    for (let e = 0, n = stco.dv.getUint32(0); e < n; e++) {
      chunkOffsets.push(stco.dv.getUint32(4 + e * 4));
    }
  } else if (co64) {
    for (let e = 0, n = co64.dv.getUint32(0); e < n; e++) {
      chunkOffsets.push(u64(co64.dv, 4 + e * 8));
    }
  } else {
    throw new ValidationError('MP4 is missing stco');
  }

  const stsc = table('stsc');
  if (!stsc) throw new ValidationError('MP4 is missing stsc');
  const runs: { firstChunk: number; perChunk: number }[] = [];
  for (let e = 0, n = stsc.dv.getUint32(0); e < n; e++) {
    runs.push({
      firstChunk: stsc.dv.getUint32(4 + e * 12) - 1,
      perChunk: stsc.dv.getUint32(8 + e * 12),
    });
  }

  if (durations.length < count) {
    throw new ValidationError('MP4 stts is shorter than stsz');
  }

  const samples: Sample[] = [];
  let sample = 0;
  let dts = 0;
  for (let r = 0; r < runs.length && sample < count; r++) {
    const run = runs[r];
    if (!run) break;
    const lastChunk = runs[r + 1]?.firstChunk ?? chunkOffsets.length;
    for (let c = run.firstChunk; c < lastChunk && sample < count; c++) {
      let offset = chunkOffsets[c];
      if (offset === undefined) {
        throw new ValidationError('MP4 stsc points past stco');
      }
      for (let i = 0; i < run.perChunk && sample < count; i++) {
        const size = sizes[sample] ?? 0;
        const duration = durations[sample] ?? 0;
        const cts = dts + (compositionOffsets[sample] ?? 0);
        samples.push({
          offset,
          size,
          duration,
          pts: cts - edit.mediaTime + edit.delay,
          dts,
          key: keys ? keys.has(sample) : true,
        });
        offset += size;
        dts += duration;
        sample++;
      }
    }
  }
  if (samples.length !== count) {
    throw new ValidationError('MP4 sample tables disagree');
  }
  return samples;
}

function readTrack(
  bytes: Uint8Array,
  trak: Box,
  movieTimescale: number
): Track | null {
  const mdia = need(bytes, trak, 'mdia');
  const hdlr = need(bytes, mdia, 'hdlr');
  const handler = fourcc(bytes, hdlr.start + hdlr.headerSize + 8);
  const kind =
    handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : null;
  if (!kind) return null;

  const tkhd = need(bytes, trak, 'tkhd');
  const mdhd = need(bytes, mdia, 'mdhd');
  const minf = need(bytes, mdia, 'minf');
  const stbl = need(bytes, minf, 'stbl');
  const stsd = need(bytes, stbl, 'stsd');
  const mediaHeader = need(bytes, minf, kind === 'video' ? 'vmhd' : 'smhd');
  const dinf = need(bytes, minf, 'dinf');

  const entries = children(bytes, stsd.start + stsd.headerSize + 8, stsd.end);
  const entry = entries[0]?.type ?? '';
  const codec = (kind === 'video' ? VIDEO_CODECS : AUDIO_CODECS)[entry];
  if (!codec) throw new ValidationError(`Unsupported ${kind} codec: ${entry}`);

  const timescale = timescaleOf(bytes, mdhd);
  const edit = editOf(bytes, trak, movieTimescale, timescale);
  return {
    id: trackIdOf(bytes, tkhd),
    kind,
    timescale,
    codec,
    boxes: {
      tkhd: raw(bytes, tkhd),
      mdhd: raw(bytes, mdhd),
      hdlr: raw(bytes, hdlr),
      mediaHeader: raw(bytes, mediaHeader),
      dinf: raw(bytes, dinf),
      stsd: raw(bytes, stsd),
    },
    samples: readSamples(bytes, stbl, edit),
  };
}

// ── writing ────────────────────────────────────────────────────────────────

class Writer {
  private parts: Uint8Array[] = [];
  private length = 0;

  u8(n: number) {
    this.push(Uint8Array.of(n));
  }
  u24(n: number) {
    this.push(Uint8Array.of((n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff));
  }
  u32(n: number) {
    const b = new Uint8Array(4);
    view(b).setUint32(0, n);
    this.push(b);
  }
  i32(n: number) {
    const b = new Uint8Array(4);
    view(b).setInt32(0, n);
    this.push(b);
  }
  u64(n: number) {
    const b = new Uint8Array(8);
    view(b).setUint32(0, Math.floor(n / 2 ** 32));
    view(b).setUint32(4, n >>> 0);
    this.push(b);
  }
  ascii(s: string) {
    this.push(new TextEncoder().encode(s));
  }
  push(b: Uint8Array) {
    this.parts.push(b);
    this.length += b.byteLength;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  }
}

function box(type: string, body: (w: Writer) => void): Uint8Array {
  const w = new Writer();
  body(w);
  const payload = w.bytes();
  const out = new Writer();
  out.u32(8 + payload.byteLength);
  out.ascii(type);
  out.push(payload);
  return out.bytes();
}

function fullBox(
  type: string,
  version: number,
  flags: number,
  body: (w: Writer) => void
): Uint8Array {
  return box(type, (w) => {
    w.u8(version);
    w.u24(flags);
    body(w);
  });
}

function emptyTable(type: string, extra = 0): Uint8Array {
  return fullBox(type, 0, 0, (w) => {
    for (let i = 0; i < extra; i++) w.u32(0);
    w.u32(0);
  });
}

function sampleFlags(sample: Sample): number {
  // Same bits mediabunny writes: depends-on / non-sync for deltas.
  return sample.key ? 0x02000000 : 0x01010000;
}

function initSegment(movieHeader: Uint8Array, tracks: Track[]): Uint8Array {
  const ftyp = box('ftyp', (w) => {
    w.ascii('iso5');
    w.u32(0x200);
    w.ascii('iso5');
    w.ascii('iso6');
    w.ascii('mp41');
  });
  const moov = box('moov', (w) => {
    w.push(movieHeader);
    for (const t of tracks) {
      w.push(
        box('trak', (trak) => {
          trak.push(t.boxes.tkhd);
          trak.push(
            box('mdia', (mdia) => {
              mdia.push(t.boxes.mdhd);
              mdia.push(t.boxes.hdlr);
              mdia.push(
                box('minf', (minf) => {
                  minf.push(t.boxes.mediaHeader);
                  minf.push(t.boxes.dinf);
                  minf.push(
                    box('stbl', (stbl) => {
                      stbl.push(t.boxes.stsd);
                      stbl.push(emptyTable('stts'));
                      stbl.push(emptyTable('stsc'));
                      stbl.push(emptyTable('stsz', 1));
                      stbl.push(emptyTable('stco'));
                    })
                  );
                })
              );
            })
          );
        })
      );
    }
    w.push(
      box('mvex', (mvex) => {
        for (const t of tracks) {
          mvex.push(
            fullBox('trex', 0, 0, (trex) => {
              trex.u32(t.id);
              trex.u32(1);
              trex.u32(0);
              trex.u32(0);
              trex.u32(0);
            })
          );
        }
      })
    );
  });
  const out = new Writer();
  out.push(ftyp);
  out.push(moov);
  return out.bytes();
}

type KeptTrack = { track: Track; samples: Sample[]; baseDecodeTime: number };

function moofBox(kept: KeptTrack[], dataOffsets: number[]): Uint8Array {
  return box('moof', (w) => {
    w.push(fullBox('mfhd', 0, 0, (m) => m.u32(1)));
    kept.forEach(({ track, samples, baseDecodeTime }, i) => {
      w.push(
        box('traf', (traf) => {
          traf.push(
            fullBox('tfhd', 0, 0x20000, (t) => {
              t.u32(track.id);
            })
          );
          traf.push(fullBox('tfdt', 1, 0, (t) => t.u64(baseDecodeTime)));
          // Data offset + per-sample duration, size, flags, composition offset.
          traf.push(
            fullBox('trun', 1, 0x000f01, (t) => {
              t.u32(samples.length);
              t.i32(dataOffsets[i] ?? 0);
              for (const s of samples) {
                t.u32(s.duration);
                t.u32(s.size);
                t.u32(sampleFlags(s));
                t.i32(s.pts - s.dts);
              }
            })
          );
        })
      );
    });
  });
}

/** Merge touching source ranges; the copy is then a few large reads. */
function coalesce(samples: Sample[]): ByteRange[] {
  const ranges: ByteRange[] = [];
  for (const s of samples) {
    const last = ranges.at(-1);
    if (last && last.offset + last.length === s.offset) {
      last.length += s.size;
    } else {
      ranges.push({ offset: s.offset, length: s.size });
    }
  }
  return ranges;
}

/**
 * Plan the fragmented copy from the source's `moov` bytes. The primary
 * (first) video track is required, the first audio track is optional; other
 * tracks are left out, as before.
 */
export function planFragment(moov: Uint8Array): FragmentPlan {
  const root: Box = { type: 'moov', start: 0, headerSize: 8, end: moov.length };
  const header = readBoxHeader(moov.subarray(0, 16), moov.length);
  if (header.type !== 'moov') throw new ValidationError('Not a moov box');
  root.headerSize = header.headerSize;

  const mvhd = need(moov, root, 'mvhd');
  const movieTimescale = timescaleOf(moov, mvhd);
  const tracks = children(moov, root.headerSize, moov.length)
    .filter((b) => b.type === 'trak')
    .map((trak) => readTrack(moov, trak, movieTimescale))
    .filter((t): t is Track => t !== null);

  const video = tracks.find((t) => t.kind === 'video');
  if (!video) throw new ValidationError('Clip has no video');
  const audio = tracks.find((t) => t.kind === 'audio');
  const chosen = audio ? [video, audio] : [video];

  const kept: KeptTrack[] = chosen.map((track) => {
    const samples = track.samples.filter((s) => s.pts >= 0);
    const first = samples[0];
    if (!first) throw new ValidationError(`Clip has an empty ${track.kind}`);
    if (!first.key) {
      throw new ValidationError(
        `Clip ${track.kind} does not start on a key frame`
      );
    }
    // Source decode times start at 0 and only grow, so tfdt (unsigned) is
    // the first kept sample's; signed composition offsets carry each pts.
    return { track, samples, baseDecodeTime: first.dts };
  });

  const init = initSegment(raw(moov, mvhd), chosen);
  const payload = kept.reduce(
    (n, k) => n + k.samples.reduce((m, s) => m + s.size, 0),
    0
  );
  if (payload + 8 > 0xffffffff) throw new ValidationError('Clip is too large');

  // The moof's size does not depend on the offsets it holds.
  const moofSize = moofBox(
    kept,
    kept.map(() => 0)
  ).byteLength;
  const dataOffsets: number[] = [];
  let at = moofSize + 8;
  for (const k of kept) {
    dataOffsets.push(at);
    at += k.samples.reduce((m, s) => m + s.size, 0);
  }
  const head = new Writer();
  head.push(moofBox(kept, dataOffsets));
  head.u32(payload + 8);
  head.ascii('mdat');
  const fragmentHead = head.bytes();

  const durationSeconds = Math.max(
    ...kept.map(
      ({ track, samples }) =>
        Math.max(...samples.map((s) => s.pts + s.duration)) / track.timescale
    )
  );

  return {
    init,
    fragmentHead,
    ranges: kept.flatMap((k) => coalesce(k.samples)),
    size: init.byteLength + fragmentHead.byteLength + payload,
    durationSeconds,
    videoCodec: video.codec,
    hasAudio: audio !== undefined,
  };
}
