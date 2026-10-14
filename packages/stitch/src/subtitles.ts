/** One subtitle on the whole cut, in seconds from the start of the first clip. */
export type TimelineCue = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};

const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/;

/**
 * Cues from an `.srt` or `.vtt` file. Times stay on the whole cut.
 * A cue id, a `WEBVTT` header, and `NOTE` / `STYLE` / `REGION` blocks are skipped.
 */
export function parseSubtitles(text: string, file: string): TimelineCue[] {
  const body = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const cues: TimelineCue[] = [];
  // A separator line may hold spaces, as hand-edited files often do.
  for (const block of body.split(/\n[ \t]*\n/)) {
    const lines = block.split('\n');
    let start = 0;
    while (start < lines.length && lines[start]?.trim() === '') start += 1;
    const content = lines.slice(start);
    const first = content[0]?.trim() ?? '';
    if (content.length === 0 || headerBlock(first)) continue;
    let timingAt = 0;
    if (!cueTiming(content[0] ?? '') && cueTiming(content[1] ?? '')) {
      timingAt = 1;
    }
    const timing = cueTiming(content[timingAt] ?? '');
    if (!timing) {
      const shown =
        content.slice(0, 2).find((line) => line.includes('-->')) ??
        content[timingAt];
      throw new Error(`${file}: expected a cue time, got "${shown?.trim()}"`);
    }
    const cueText = content
      .slice(timingAt + 1)
      .join('\n')
      .trim();
    if (cueText === '') throw new Error(`${file}: a cue needs text`);
    if (!(timing.startSeconds < timing.endSeconds)) {
      throw new Error(
        `${file}: cue needs start < end, got ${timing.startSeconds}–${timing.endSeconds}`
      );
    }
    cues.push({ ...timing, text: cueText });
  }
  if (cues.length === 0) throw new Error(`${file} has no cues`);
  return cues;
}

function headerBlock(line: string): boolean {
  return /^(?:WEBVTT|NOTE|STYLE|REGION)\b/.test(line);
}

function cueTiming(
  line: string
): { startSeconds: number; endSeconds: number } | null {
  const parts = line.trim().split(/\s*-->\s*/);
  if (parts.length !== 2) return null;
  const start = timestamp(parts[0] ?? '');
  const endToken = (parts[1] ?? '').trim().split(/\s+/)[0] ?? '';
  const end = timestamp(endToken);
  if (start === null || end === null) return null;
  return { startSeconds: start, endSeconds: end };
}

function timestamp(value: string): number | null {
  const match = TIMESTAMP.exec(value.trim());
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) return null;
  const fraction = (match[4] ?? '0').padEnd(3, '0');
  return hours * 3600 + minutes * 60 + seconds + Number(fraction) / 1000;
}
