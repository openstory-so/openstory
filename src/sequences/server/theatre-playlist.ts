/**
 * The theatre's playlist (#1623): an HLS list that points straight at the
 * cut's own clips, one after another. Nothing is rendered — the player has the
 * first frame, the full length and every seek target the moment the list
 * loads, with no container and no encode in the way.
 *
 * HLS cannot point at a plain MP4 (`moov` + one `mdat`), which is how every
 * generated clip is stored. So each clip gets a fragmented copy beside it, made
 * once, the first time a playlist names it: the same encoded packets,
 * repackaged — nothing is decoded. A sidecar JSON next to the copy records what
 * the playlist needs (init length, size, duration), and its presence is what
 * says the copy is complete.
 *
 * Music is not in here: HLS cannot mix two audio tracks. The theatre plays it
 * alongside (`use-theatre-music.ts`).
 */

import { readStorageObject, uploadFile } from '#storage';
import {
  ALL_FORMATS,
  BufferSource,
  BufferTarget,
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

const FRAGMENTED_SUFFIX = '.frag.mp4';
const SIDECAR_SUFFIX = '.frag.json';
/** Copies made at once on a cold playlist: each holds a clip in and out. */
const REPACKAGE_CONCURRENCY = 2;

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

async function repackage(key: string): Promise<FragmentedClipInfo> {
  const source = await readStorageObject(key);
  if (!source) throw new ValidationError(`Clip is missing: ${key}`);

  const input = new Input({
    formats: ALL_FORMATS,
    source: new BufferSource(source.bytes),
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

    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
      target,
    });
    const videoSource = new EncodedVideoPacketSource(videoCodec);
    output.addVideoTrack(videoSource);
    const audioSource = audioCodec
      ? new EncodedAudioPacketSource(audioCodec)
      : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();

    // The packets as they are — no `Conversion`: an AAC track starts a frame
    // before zero (encoder priming), and trimming that the library's way means
    // a re-encode, which workerd has no codec for. The early packets are
    // dropped instead; both tracks stay on the clip's own clock. Side by side,
    // because the muxer closes a fragment only once every track covers it.
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
    if (!target.buffer) throw new Error(`Repackage wrote nothing: ${key}`);
    const bytes = new Uint8Array(target.buffer);

    const info: FragmentedClipInfo = {
      initBytes: initSectionLength(bytes),
      size: bytes.byteLength,
      durationSeconds: await input.computeDuration(),
      videoCodec,
      hasAudio: audioSource !== null,
    };

    // The copy first, the sidecar second: a sidecar is the claim that the copy
    // is whole.
    const { bucket, path } = splitKey(key);
    await uploadFile(bucket, `${path}${FRAGMENTED_SUFFIX}`, bytes, {
      contentType: 'video/mp4',
      upsert: true,
    });
    await uploadFile(
      bucket,
      `${path}${SIDECAR_SUFFIX}`,
      new TextEncoder().encode(JSON.stringify(info)),
      { contentType: 'application/json', upsert: true }
    );
    return info;
  } finally {
    input.dispose();
  }
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
 * The fragmented copy of every clip, in order, made where missing. `origin`
 * absolutizes the URLs (the CDN when there is one) so the player fetches byte
 * ranges without a redirect per request.
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

  const missing = keys.flatMap((key, i) => (infos[i] ? [] : [{ key, i }]));
  for (let at = 0; at < missing.length; at += REPACKAGE_CONCURRENCY) {
    await Promise.all(
      missing.slice(at, at + REPACKAGE_CONCURRENCY).map(async ({ key, i }) => {
        infos[i] = await repackage(key);
      })
    );
  }

  return keys.map((key, i) => {
    const info = infos[i];
    if (!info) throw new Error(`No fragmented copy for ${key}`);
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
