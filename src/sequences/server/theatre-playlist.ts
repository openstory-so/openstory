/**
 * The theatre's playlist (#1623): an HLS list that points straight at the
 * cut's own clips, one after another. Nothing is rendered — the player has the
 * first frame, the full length and every seek target the moment the list
 * loads, with no container and no encode in the way.
 *
 * HLS cannot point at a plain MP4 (`moov` + one `mdat`), which is how every
 * generated clip is stored. So each clip gets a fragmented copy beside it,
 * made once at ingest (`writeFragmentedCopy`): the same encoded packets,
 * repackaged — nothing is decoded. A sidecar JSON next to the copy records
 * what the playlist needs (init length, size, duration), and its presence is
 * what says the copy is complete. The playlist route only reads sidecars.
 *
 * Music is not in here: HLS cannot mix two audio tracks. The theatre plays it
 * alongside (`use-theatre-music.ts`).
 */

import { readStorageObject, storageObjectSize, uploadFile } from '#storage';
import {
  ALL_FORMATS,
  AppendOnlyStreamTarget,
  CustomSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  type EncodedPacket,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  type InputTrack,
} from 'mediabunny';
import { z } from 'zod';
import { ValidationError } from '@/platform/errors';
import {
  STORAGE_BUCKETS,
  getPublicUrl,
  r2KeyFromUrl,
  toShareableUrl,
  type StorageBucket,
} from '@/platform/server/storage/buckets';
import { uploadResponse } from '@/platform/server/storage/upload-response';

const FRAGMENTED_SUFFIX = '.frag.mp4';
const SIDECAR_SUFFIX = '.frag.json';
/** Demuxer cache ceiling — ranged reads, never the whole clip. */
const SOURCE_CACHE_BYTES = 2 * 1024 * 1024;

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

/** Every packet of `track` from time zero on, flagging the first. */
async function copyPackets(
  track: InputTrack,
  add: (packet: EncodedPacket, first: boolean) => Promise<void>
): Promise<void> {
  let first = true;
  for await (const packet of new EncodedPacketSink(track).packets()) {
    if (packet.timestamp < 0) continue;
    await add(packet, first);
    first = false;
  }
}

function clipSource(key: string, size: number): CustomSource {
  return new CustomSource({
    getSize: () => size,
    maxCacheSize: SOURCE_CACHE_BYTES,
    read: async (start, end) => {
      const object = await readStorageObject(key, {
        offset: start,
        length: end - start,
      });
      if (!object) throw new Error(`Storage object disappeared: ${key}`);
      return object.bytes;
    },
  });
}

/**
 * Packet-copy the clip into `target` as fragmented MP4. No `Conversion`: an
 * AAC track starts a frame before zero (encoder priming), and trimming that
 * the library's way means a re-encode, which workerd has no codec for. The
 * early packets are dropped instead; both tracks stay on the clip's own
 * clock. Side by side, because the muxer closes a fragment only once every
 * track covers it.
 */
async function remuxFragmented(
  key: string,
  size: number,
  target: AppendOnlyStreamTarget,
  onFirstMoof?: (position: number) => void
): Promise<{
  durationSeconds: number;
  videoCodec: string;
  hasAudio: boolean;
}> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: clipSource(key, size),
  });
  let sawMoof = false;
  const output = new Output({
    format: new Mp4OutputFormat({
      fastStart: 'fragmented',
      onMoof: onFirstMoof
        ? (_data, position) => {
            if (sawMoof) return;
            sawMoof = true;
            onFirstMoof(position);
          }
        : undefined,
    }),
    target,
  });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new ValidationError(`Clip has no video: ${key}`);
    const audioTrack = await input.getPrimaryAudioTrack();
    const videoCodec = await videoTrack.getCodec();
    const audioCodec = audioTrack ? await audioTrack.getCodec() : null;
    if (!videoCodec || (audioTrack && !audioCodec)) {
      throw new ValidationError(`Clip has an unknown codec: ${key}`);
    }

    const videoSource = new EncodedVideoPacketSource(videoCodec);
    output.addVideoTrack(videoSource);
    const audioSource = audioCodec
      ? new EncodedAudioPacketSource(audioCodec)
      : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();

    const videoConfig = await videoTrack.getDecoderConfig();
    const audioConfig = (await audioTrack?.getDecoderConfig()) ?? null;
    await Promise.all([
      copyPackets(videoTrack, (packet, first) =>
        videoSource.add(
          packet,
          first && videoConfig ? { decoderConfig: videoConfig } : undefined
        )
      ),
      audioTrack && audioSource
        ? copyPackets(audioTrack, (packet, first) =>
            audioSource.add(
              packet,
              first && audioConfig ? { decoderConfig: audioConfig } : undefined
            )
          )
        : null,
    ]);
    await output.finalize();
    return {
      durationSeconds: await input.computeDuration(),
      videoCodec,
      hasAudio: audioSource !== null,
    };
  } catch (error) {
    await output.cancel().catch(() => undefined);
    throw error;
  } finally {
    input.dispose();
  }
}

/** First pass: size the copy and find the init section, discarding the bytes. */
async function measureFragmentedCopy(
  key: string,
  size: number
): Promise<FragmentedClipInfo> {
  let bytes = 0;
  let initBytes: number | undefined;
  const meta = await remuxFragmented(
    key,
    size,
    new AppendOnlyStreamTarget(
      new WritableStream({
        write(chunk) {
          bytes += chunk.byteLength;
        },
      })
    ),
    (position) => {
      initBytes = position;
    }
  );
  if (initBytes == null || bytes === 0) {
    throw new Error(`Repackage wrote nothing: ${key}`);
  }
  return { ...meta, initBytes, size: bytes };
}

/**
 * Second pass: the same packets, streamed into R2 at a known length so
 * `uploadResponse` can wrap a FixedLengthStream and never buffer the clip.
 */
async function streamFragmentedCopy(
  key: string,
  sourceSize: number,
  copySize: number,
  bucket: StorageBucket,
  path: string
): Promise<void> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const upload = uploadResponse(
    new Response(readable, {
      headers: { 'content-length': String(copySize) },
    }),
    bucket,
    `${path}${FRAGMENTED_SUFFIX}`,
    { contentType: 'video/mp4' }
  );
  try {
    await Promise.all([
      remuxFragmented(key, sourceSize, new AppendOnlyStreamTarget(writable)),
      upload,
    ]);
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

async function repackage(key: string): Promise<FragmentedClipInfo> {
  const sourceSize = await storageObjectSize(key);
  if (!sourceSize) throw new ValidationError(`Clip is missing: ${key}`);

  const info = await measureFragmentedCopy(key, sourceSize);
  const { bucket, path } = splitKey(key);
  // The copy first, the sidecar second: a sidecar is the claim that the copy
  // is whole.
  await streamFragmentedCopy(key, sourceSize, info.size, bucket, path);
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
  const parsed = sidecarSchema.safeParse(
    JSON.parse(new TextDecoder().decode(object.bytes))
  );
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
