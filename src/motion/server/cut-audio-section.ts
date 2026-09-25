/**
 * Cut one section of a dialogue recording to its own file (#1657).
 *
 * A shot's reading is a time range of a recording (`shot_dialogue_sections`),
 * but a video model needs a file URL — so the selected section is materialised
 * here. The file is a CACHE: its key is derived from the recording and the
 * range, so cutting the same section twice is a 4 KiB ranged header read plus
 * a `head`, and nothing but `shots.audioClips` ever holds its URL.
 *
 * It never loads the recording. The header comes from a 4 KiB ranged read,
 * the byte range is arithmetic, and the samples go from one R2 object to the
 * other as a stream — a fresh 44-byte header, the ranged body, then silence
 * up to the provider's floor in small blocks. Peak memory is the header plus
 * one block, whatever the recording weighs.
 */

import {
  AUDIO_MIN_PAD_SLACK_SECONDS,
  parseWavHeader,
  wavFrameMath,
  wavHeader,
} from '@/motion/server/pad-dialogue-audio';
import {
  buildR2Key,
  getPublicUrl,
  STORAGE_BUCKETS,
} from '@/platform/server/storage/buckets';
import { fileExists, readStorageObject, readStorageStream } from '#storage';
import { uploadResponse } from '@/platform/server/storage/upload-response';
import type { MotionAudioClip } from '@/platform/server/db/schema';

/** Enough for any header ElevenLabs writes (`fmt `, optional `LIST`, `data`). */
const HEADER_PROBE_BYTES = 4096;
/** Silence is written in blocks this size, never as one buffer. */
const PAD_BLOCK_BYTES = 16 * 1024;

export type CutAudioSectionInput = {
  /** `<bucket>/<path>` of the whole recording (`dialogue_recordings.storageKey`). */
  storageKey: string;
  recordingId: string;
  teamId: string;
  sequenceId: string;
  fromSeconds: number;
  /** Already tail-trimmed (`shot_dialogue_sections.toSeconds`). */
  toSeconds: number;
  /** Provider per-file floor — a short section is padded with silence up to it. */
  minDurationSeconds?: number;
};

export type CutAudioSection = {
  url: string;
  path: string;
  /** Length of the FILE: the section plus any padding. */
  durationSeconds: number;
};

export async function cutAudioSection(
  input: CutAudioSectionInput
): Promise<CutAudioSection> {
  const ms = (seconds: number) => Math.round(seconds * 1000);
  const path = `${input.teamId}/${input.sequenceId}/dialogue-sections/${input.recordingId}_${ms(input.fromSeconds)}_${ms(input.toSeconds)}_${ms(input.minDurationSeconds ?? 0)}.wav`;

  const probe = await readStorageObject(input.storageKey, {
    offset: 0,
    length: HEADER_PROBE_BYTES,
  });
  if (!probe) {
    throw new Error(
      `Dialogue recording ${input.storageKey} is missing from storage`
    );
  }
  const fmt = parseWavHeader(probe.bytes);
  if (!fmt) throw new Error('Dialogue audio expected a PCM WAV');

  // Offsets are snapped DOWN to a whole frame, so a section never starts or
  // ends mid-sample, and clamped to the samples the header says exist.
  const { frame, bytesPerSecond, usable, snap } = wavFrameMath(
    fmt,
    fmt.dataSize
  );
  const from = snap(input.fromSeconds);
  const to = Math.max(from, snap(input.toSeconds));
  if (to === from) {
    throw new Error(
      `Dialogue section ${input.fromSeconds.toFixed(2)}–${input.toSeconds.toFixed(2)}s of a ${(usable / bytesPerSecond).toFixed(2)}s recording is empty`
    );
  }
  const sectionBytes = to - from;
  const floorBytes =
    input.minDurationSeconds == null
      ? 0
      : Math.ceil(
          ((input.minDurationSeconds + AUDIO_MIN_PAD_SLACK_SECONDS) *
            bytesPerSecond) /
            frame
        ) * frame;
  const padBytes = Math.max(0, floorBytes - sectionBytes);
  const dataBytes = sectionBytes + padBytes;

  const cut = {
    url: getPublicUrl(STORAGE_BUCKETS.AUDIO, path),
    path: buildR2Key(STORAGE_BUCKETS.AUDIO, path),
    durationSeconds: dataBytes / bytesPerSecond,
  };
  // The key names the recording and the range, so a file that is there IS
  // this cut — and its length is the arithmetic above, no read needed.
  if (await fileExists(STORAGE_BUCKETS.AUDIO, path)) return cut;

  const source = await readStorageStream(input.storageKey, {
    offset: fmt.dataStart + from,
    length: sectionBytes,
  });
  if (!source) {
    throw new Error(
      `Dialogue recording ${input.storageKey} is missing from storage`
    );
  }
  if (source.size !== sectionBytes) {
    throw new Error(
      `Dialogue recording ${input.storageKey} is shorter than its header says (${source.size} of ${sectionBytes} bytes)`
    );
  }

  // The header is rebuilt rather than copied: the source may carry chunks
  // around `data` that describe bytes this file does not have.
  const header = wavHeader(dataBytes, fmt);
  // workerd's r2.put() rejects a stream of unknown length (#738) — ours is
  // known exactly, and `uploadResponse` sizes the stream from the header.
  await uploadResponse(
    new Response(composeWav(header, source.body, padBytes), {
      headers: { 'content-length': String(header.length + dataBytes) },
    }),
    STORAGE_BUCKETS.AUDIO,
    path,
    { contentType: 'audio/wav' }
  );
  return cut;
}

/** `header`, then `samples` as they arrive, then `padBytes` of silence. */
function composeWav(
  header: Uint8Array,
  samples: ReadableStream<Uint8Array>,
  padBytes: number
): ReadableStream<Uint8Array> {
  const reader = samples.getReader();
  let stage: 'header' | 'samples' | 'pad' = 'header';
  let padLeft = padBytes;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (stage === 'header') {
        controller.enqueue(header);
        stage = 'samples';
        return;
      }
      if (stage === 'samples') {
        const { done, value } = await reader.read();
        if (!done) {
          controller.enqueue(value);
          return;
        }
        stage = 'pad';
      }
      if (padLeft === 0) {
        controller.close();
        return;
      }
      const block = Math.min(padLeft, PAD_BLOCK_BYTES);
      controller.enqueue(new Uint8Array(block));
      padLeft -= block;
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/**
 * A packed clip's dialogue is one longer section of the scene's recording
 * (#1794): from the first member's start to the last member's end. Sending
 * each member's own section instead plays the overlap between neighbours
 * twice, and counts it twice against the model's combined cap. The longer
 * section is never longer than the recording, which was fit to the cap.
 *
 * Only the wire changes — each shot keeps its own clip. Consecutive clips
 * from one recording are spanned; a run whose sections cannot be read, or
 * are not in recording order, is sent as it was.
 */
export async function cutSpanningSection(
  clips: readonly MotionAudioClip[],
  input: {
    teamId: string;
    sequenceId: string;
    minDurationSeconds?: number;
    getSection: (id: string) => Promise<{
      fromSeconds: number;
      toSeconds: number;
      recording: { storageKey: string };
    } | null>;
  }
): Promise<MotionAudioClip[]> {
  const out: MotionAudioClip[] = [];
  for (const run of sharedRecordingRuns(clips)) {
    const first = run[0];
    if (run.length < 2 || !first?.recordingId) {
      out.push(...run);
      continue;
    }
    const sections = await Promise.all(
      run.map((clip) => input.getSection(clip.id))
    );
    const ordered = sections.every(
      (section, at) =>
        section &&
        (at === 0 ||
          section.fromSeconds >= (sections[at - 1]?.fromSeconds ?? 0))
    );
    const head = sections[0];
    const tail = sections.at(-1);
    if (!ordered || !head || !tail) {
      out.push(...run);
      continue;
    }
    const cut = await cutAudioSection({
      storageKey: head.recording.storageKey,
      recordingId: first.recordingId,
      teamId: input.teamId,
      sequenceId: input.sequenceId,
      fromSeconds: head.fromSeconds,
      toSeconds: tail.toSeconds,
      minDurationSeconds: input.minDurationSeconds,
    });
    out.push({
      id: run.map((clip) => clip.id).join('+'),
      url: cut.url,
      token: first.token,
      durationSeconds: cut.durationSeconds,
      recordingId: first.recordingId,
    });
  }
  return out;
}

/** Consecutive clips cut from the same recording, in order. */
function sharedRecordingRuns(
  clips: readonly MotionAudioClip[]
): MotionAudioClip[][] {
  const runs: MotionAudioClip[][] = [];
  for (const clip of clips) {
    const last = runs.at(-1);
    if (last && clip.recordingId && last[0]?.recordingId === clip.recordingId) {
      last.push(clip);
    } else {
      runs.push([clip]);
    }
  }
  return runs;
}
