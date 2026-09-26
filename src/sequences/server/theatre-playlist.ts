/**
 * The theatre's playlist (#1623): an HLS list that points straight at the
 * cut's own clips, one after another. Nothing is rendered — the player has the
 * first frame, the full length and every seek target the moment the list
 * loads, with no container and no encode in the way.
 *
 * HLS cannot point at a plain MP4 (`moov` + one `mdat`), which is how every
 * generated clip is stored. So each clip gets a fragmented copy beside it,
 * made once at ingest (`writeFragmentedCopy`): the same encoded packets,
 * repackaged — nothing is decoded (`fragment-mp4.ts`). The header comes from
 * the source's `moov`; the sample bytes are copied range by range, so a clip
 * is never held in Worker memory. A sidecar JSON next to the copy records
 * what the playlist needs (init length, size, duration), and its presence is
 * what says the copy is complete. The playlist route only reads sidecars.
 *
 * Music is not in here: HLS cannot mix two audio tracks. The theatre plays it
 * alongside (`use-theatre-music.ts`).
 */

import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  readStorageObject,
  storageObjectSize,
  uploadFile,
  uploadPart,
} from '#storage';
import { z } from 'zod';
import { ValidationError } from '@/platform/errors';
import { planFragment, readBoxHeader } from './fragment-mp4';
import {
  STORAGE_BUCKETS,
  getPublicUrl,
  r2KeyFromUrl,
  toShareableUrl,
  type MultipartPart,
  type StorageBucket,
} from '@/platform/server/storage/buckets';

const FRAGMENTED_SUFFIX = '.frag.mp4';
const SIDECAR_SUFFIX = '.frag.json';
/** Largest single ranged read of the source clip. */
const READ_BYTES = 4 * 1024 * 1024;
/** R2 multipart: every part but the last the same size, at least 5 MiB. */
const PART_BYTES = 8 * 1024 * 1024;

const sidecarSchema = z.object({
  /** Bytes of `ftyp` + `moov` at the head of the copy — the HLS init section. */
  initBytes: z.int().positive(),
  /** Whole size of the copy. */
  size: z.int().positive(),
  durationSeconds: z.number().positive(),
  videoCodec: z.string(),
  hasAudio: z.boolean(),
});
type FragmentedClipInfo = z.infer<typeof sidecarSchema>;

const sidecarJson = z.codec(z.string(), sidecarSchema, {
  decode: (text, payload) => {
    try {
      return JSON.parse(text);
    } catch {
      payload.issues.push({
        code: 'invalid_format',
        format: 'json',
        input: text,
      });
      return z.NEVER;
    }
  },
  encode: (value) => JSON.stringify(value),
});

export type PlaylistClip = FragmentedClipInfo & { url: string };

function splitKey(key: string): { bucket: StorageBucket; path: string } {
  const slash = key.indexOf('/');
  const bucket = Object.values(STORAGE_BUCKETS).find(
    (b) => b === key.slice(0, slash)
  );
  if (slash < 1 || !bucket) {
    throw new ValidationError(`Clip is not in storage: ${key}`);
  }
  return { bucket, path: key.slice(slash + 1) };
}

/** Offset of the first `moof` — everything before it is the init section. */
export function initSectionLength(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0
    );
    if (type === 'moof') return offset;
    // 0 = "to end of file", 1 = 64-bit size: neither precedes a moof in what
    // the muxer writes, and a size under 8 would loop forever.
    if (size < 8) break;
    offset += size;
  }
  throw new Error('Fragmented copy has no moof box');
}

async function readRange(
  key: string,
  offset: number,
  length: number
): Promise<Uint8Array> {
  const object = await readStorageObject(key, { offset, length });
  if (object?.bytes.byteLength !== length) {
    throw new Error(`Short read of ${key} at ${offset}`);
  }
  return object.bytes;
}

/** The source's `moov`, found by walking top-level box headers. */
async function readMoov(key: string, size: number): Promise<Uint8Array> {
  let at = 0;
  while (at + 8 <= size) {
    const head = await readRange(key, at, Math.min(16, size - at));
    const box = readBoxHeader(head, size - at);
    if (box.type === 'moov') return readRange(key, at, box.size);
    at += box.size;
  }
  throw new ValidationError(`Clip has no moov: ${key}`);
}

/**
 * The copy goes up as fixed-size multipart parts, each sent whole once full,
 * so memory is one part and no upload sits open waiting for bytes (an idle
 * `r2.put` is dropped by R2: "Network connection lost").
 */
function multipartSink(bucket: StorageBucket, path: string) {
  let uploadId: string | undefined;
  const parts: MultipartPart[] = [];
  const pending = new Uint8Array(PART_BYTES);
  let filled = 0;
  let total = 0;

  const sendPart = async () => {
    uploadId ??= (await createMultipartUpload(bucket, path, 'video/mp4'))
      .uploadId;
    parts.push(
      await uploadPart(
        bucket,
        path,
        uploadId,
        parts.length + 1,
        pending.slice(0, filled)
      )
    );
    filled = 0;
  };

  return {
    async write(chunk: Uint8Array): Promise<void> {
      total += chunk.byteLength;
      let offset = 0;
      while (offset < chunk.byteLength) {
        const n = Math.min(PART_BYTES - filled, chunk.byteLength - offset);
        pending.set(chunk.subarray(offset, offset + n), filled);
        filled += n;
        offset += n;
        if (filled === PART_BYTES) await sendPart();
      }
    },
    bytesWritten: () => total,
    async complete(): Promise<void> {
      if (filled > 0) await sendPart();
      if (!uploadId) throw new Error(`Repackage wrote nothing: ${path}`);
      await completeMultipartUpload(bucket, path, uploadId, parts);
    },
    async abort(): Promise<void> {
      if (!uploadId) return;
      await abortMultipartUpload(bucket, path, uploadId).catch(() => undefined);
    },
  };
}

async function repackage(key: string): Promise<FragmentedClipInfo> {
  const sourceSize = await storageObjectSize(key);
  if (!sourceSize) throw new ValidationError(`Clip is missing: ${key}`);

  const plan = planFragment(await readMoov(key, sourceSize));
  const { bucket, path } = splitKey(key);
  const sink = multipartSink(bucket, `${path}${FRAGMENTED_SUFFIX}`);
  try {
    await sink.write(plan.init);
    await sink.write(plan.fragmentHead);
    for (const range of plan.ranges) {
      for (let at = 0; at < range.length; at += READ_BYTES) {
        const length = Math.min(READ_BYTES, range.length - at);
        await sink.write(await readRange(key, range.offset + at, length));
      }
    }
    if (sink.bytesWritten() !== plan.size) {
      throw new Error(`Repackage wrote ${sink.bytesWritten()} of ${plan.size}`);
    }
    await sink.complete();
  } catch (error) {
    await sink.abort();
    throw error;
  }

  const info: FragmentedClipInfo = {
    initBytes: plan.init.byteLength,
    size: plan.size,
    durationSeconds: plan.durationSeconds,
    videoCodec: plan.videoCodec,
    hasAudio: plan.hasAudio,
  };
  // The copy first, the sidecar second: a sidecar is the claim that the copy
  // is whole.
  await uploadFile(
    bucket,
    `${path}${SIDECAR_SUFFIX}`,
    new TextEncoder().encode(JSON.stringify(info)),
    { contentType: 'application/json', upsert: true }
  );
  return info;
}

/**
 * Fragmented HLS copy of a stored clip, made once at ingest. A sidecar that
 * is already there means the copy is whole — this is a no-op then.
 */
export async function writeFragmentedCopy(key: string): Promise<void> {
  if (!key.toLowerCase().endsWith('.mp4')) return;
  if (await readSidecar(key)) return;
  await repackage(key);
}

async function readSidecar(key: string): Promise<FragmentedClipInfo | null> {
  const object = await readStorageObject(`${key}${SIDECAR_SUFFIX}`);
  if (!object) return null;
  const parsed = sidecarJson.safeParse(new TextDecoder().decode(object.bytes));
  return parsed.success ? parsed.data : null;
}

/**
 * The fragmented copy of every clip, in order. Copies are written at ingest;
 * a missing sidecar means this cut was never fragmented and the theatre
 * stitches instead. `origin` absolutizes the URLs (the CDN when there is one)
 * so the player fetches byte ranges without a redirect per request.
 */
export async function ensureFragmentedClips(
  clipUrls: readonly string[],
  origin: string
): Promise<PlaylistClip[]> {
  const keys = clipUrls.map((url) => {
    const key = r2KeyFromUrl(url);
    if (key === null)
      throw new ValidationError(`Clip is not in storage: ${url}`);
    return key;
  });
  const infos = await Promise.all(keys.map(readSidecar));

  return keys.map((key, i) => {
    const info = infos[i];
    if (!info) throw new ValidationError(`No fragmented copy for ${key}`);
    const { bucket, path } = splitKey(key);
    return {
      ...info,
      url: toShareableUrl(
        getPublicUrl(bucket, `${path}${FRAGMENTED_SUFFIX}`),
        origin
      ),
    };
  });
}

/**
 * The playlist text. Each clip is one segment behind its own init section,
 * with a discontinuity between clips: their timelines each start at 0 and
 * their resolutions may differ.
 *
 * ponytail: one segment per clip, so the first frame waits for the whole first
 * clip. Generated clips usually carry a single key frame, which allows nothing
 * finer; list each `moof` as its own byte range if clips start arriving with
 * more.
 */
export function buildTheatrePlaylist(clips: readonly PlaylistClip[]): string {
  if (clips.length === 0) throw new ValidationError('No clips to play yet');
  const first = clips[0];
  // One player, one set of source buffers: a clip that switches codec or drops
  // its audio track mid-list breaks the append. The theatre stitches instead.
  if (
    clips.some(
      (c) => c.videoCodec !== first?.videoCodec || c.hasAudio !== first.hasAudio
    )
  ) {
    throw new ValidationError('Clips differ in codec or audio track');
  }

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...clips.map((c) => c.durationSeconds)))}`,
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  clips.forEach((clip, i) => {
    if (i > 0) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(
      `#EXT-X-MAP:URI="${clip.url}",BYTERANGE="${clip.initBytes}@0"`,
      `#EXTINF:${clip.durationSeconds.toFixed(3)},`,
      `#EXT-X-BYTERANGE:${clip.size - clip.initBytes}@${clip.initBytes}`,
      clip.url
    );
  });
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}
