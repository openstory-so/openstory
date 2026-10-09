import type { PlaybackClip, PlaybackCue } from '@openstory/stitch-player';

import type { ShotView } from '@/shots/shot-view';
import {
  packedClipWindows,
  shotIdAtTime,
  type PackedClipShot,
} from '@/shots/packed-clip-window';
import {
  aspectRatioToDimensions,
  type AspectRatio,
} from '@/models/aspect-ratios';

type PlaybackShot = Pick<
  ShotView,
  | 'id'
  | 'shotNumber'
  | 'previewThumbnailUrl'
  | 'durationMs'
  | 'audioClips'
  | 'dialogue'
  | 'dialogueTiming'
> & {
  video: { url: string | null } | null;
  image: { url: string | null } | null;
};

/**
 * Shots per playback clip, in order. Adjacent shots that share a rendered
 * clip (a packed render, #1510) are one clip; every other shot is its own.
 */
export function groupPlaybackShots<
  S extends { video: { url: string | null } | null },
>(shots: readonly S[]): S[][] {
  const groups: S[][] = [];
  for (const shot of shots) {
    const url = shot.video?.url;
    const previous = groups.at(-1);
    if (url && previous?.[0]?.video?.url === url) previous.push(shot);
    else groups.push([shot]);
  }
  return groups;
}

/**
 * The subtitles for one shot, placed from `offsetSeconds` — where the shot
 * starts inside its clip. A line runs for the time its reading spoke it
 * (`dialogueTiming`, derived from the speech on read); lines the reading
 * did not time — every line of a shot with no reading yet, or a line added
 * after the reading — show together for the whole shot. The wording is what
 * was spoken (`spokenLines`), else what was written.
 */
export function shotCues(
  shot: Pick<PlaybackShot, 'dialogue' | 'audioClips' | 'dialogueTiming'>,
  offsetSeconds: number,
  shotSeconds: number
): PlaybackCue[] {
  const lines = shot.dialogue?.presence ? shot.dialogue.lines : [];
  if (lines.length === 0) return [];
  const spoken = new Map(
    (shot.audioClips?.[0]?.spokenLines ?? []).map((line) => [
      line.index,
      line.text,
    ])
  );
  const textOf = (index: number): string | null => {
    const line = lines[index];
    if (!line) return null;
    const said = spoken.get(index) ?? line.line;
    return line.character ? `${line.character}: ${said}` : said;
  };
  const windowEnd = offsetSeconds + shotSeconds;
  const timed = (shot.dialogueTiming ?? []).flatMap((line) => {
    const text = textOf(line.index);
    if (!text) return [];
    const startSeconds = offsetSeconds + line.startSeconds;
    const endSeconds = Math.min(windowEnd, offsetSeconds + line.endSeconds);
    // A reading that runs past this shot must not paint the next packed shot.
    if (!(startSeconds < endSeconds) || startSeconds >= windowEnd) return [];
    return [{ startSeconds, endSeconds, text }];
  });
  const timedIndexes = new Set(
    (shot.dialogueTiming ?? []).map((line) => line.index)
  );
  const untimed = lines
    .map((_, index) => (timedIndexes.has(index) ? null : textOf(index)))
    .filter((text) => text !== null);
  if (untimed.length === 0) return timed;
  return [
    ...timed,
    {
      startSeconds: offsetSeconds,
      endSeconds: offsetSeconds + shotSeconds,
      text: untimed.join('\n'),
    },
  ];
}

/** One continuous timeline: rendered clips where available, stills elsewhere. Clips play in array order. */
export function toPlaybackClips(
  shots: readonly PlaybackShot[],
  aspectRatio: AspectRatio
): PlaybackClip[] {
  const clips: PlaybackClip[] = [];
  for (const group of groupPlaybackShots(shots)) {
    const shot = group[0];
    if (!shot) continue;
    const videoUrl = shot.video?.url;
    const stillUrl = shot.image?.url ?? null;
    const previewUrl = shot.previewThumbnailUrl ?? null;
    if (videoUrl) {
      clips.push({
        videoUrl,
        posterUrl: stillUrl ?? previewUrl,
        cues: packedClipWindows(group).flatMap((window, i) => {
          const member = group[i];
          return member
            ? shotCues(member, window.startSeconds, window.durationSeconds)
            : [];
        }),
      });
    } else {
      const audioClips = shot.audioClips ?? [];
      // Legacy shots with no stored duration hold for 3 s (see
      // docs/architecture/elevenlabs.md, "Mixed previews").
      const durationSeconds =
        shot.durationMs != null && shot.durationMs > 0
          ? shot.durationMs / 1000
          : 3;
      // A still with sound runs as long as all its sound, played back to back.
      const soundSeconds = audioClips.reduce(
        (sum, clip) => sum + (clip.durationSeconds ?? 0),
        0
      );
      clips.push({
        imageUrl: stillUrl ?? previewUrl,
        fallbackImageUrl:
          stillUrl && previewUrl && previewUrl !== stillUrl ? previewUrl : null,
        durationSeconds,
        audioUrls: audioClips.map((clip) => clip.url),
        ...aspectRatioToDimensions(aspectRatio),
        cues: shotCues(shot, 0, soundSeconds || durationSeconds),
      });
    }
  }
  return clips;
}

/**
 * Packed in-clip renders (#1510) share one video URL across every covered
 * shot. Consecutive copies would play the clip twice; collapse them so the
 * stitch is one generation, not N.
 */
export function collapseConsecutiveUrls(urls: readonly string[]): string[] {
  const out: string[] = [];
  for (const url of urls) {
    if (out[out.length - 1] !== url) out.push(url);
  }
  return out;
}

/**
 * Which shot the sequence player is on at `time` (#1771). Clip boundaries
 * are the stitcher's measured offsets when it has them. Inside a packed
 * clip, shots split the clip in their own `durationMs` proportions, so a clip that came back a little
 * longer than asked still lands on the right shot.
 */
export function shotIdAtSequenceTime<
  S extends PackedClipShot & { video: { url: string | null } | null },
>(
  shots: readonly S[],
  time: number,
  /** The measured start of each playback clip, when known. */
  clipOffsetsSeconds?: readonly number[]
): string | undefined {
  const clips = groupPlaybackShots(shots).map((group) =>
    packedClipWindows(group)
  );
  let cursor = 0;
  for (const [index, windows] of clips.entries()) {
    const estimated = windows.at(-1)?.endSeconds ?? 0;
    const start = clipOffsetsSeconds?.[index] ?? cursor;
    const end = clipOffsetsSeconds?.[index + 1] ?? start + estimated;
    if (time < end) {
      const local =
        end > start ? ((time - start) / (end - start)) * estimated : 0;
      return shotIdAtTime(windows, local);
    }
    cursor = end;
  }
  return shots.at(-1)?.id;
}
