import { createRoot } from 'react-dom/client';
import '@videojs/react/video/neutral-skin.css';
import { StitchedPlayer } from '../src/react';
import type { PlaybackClip, PlaybackCue } from '../src/playback-clip';

type Cut = {
  clips: PlaybackClip[];
  frameWidth: number;
  frameHeight: number;
  musicUrl: string | null;
  musicGainDb: number;
};

const stage = document.getElementById('stage');
if (!stage) throw new Error('missing #stage');

const response = await fetch('/cut.json');
if (!response.ok) throw new Error(`cut.json returned ${response.status}`);
const cut = readCut(await response.json());
stage.style.setProperty('--ar', String(cut.frameWidth / cut.frameHeight));

createRoot(stage).render(<Preview cut={cut} />);

function Preview({ cut }: { cut: Cut }) {
  return (
    <StitchedPlayer
      clips={cut.clips}
      musicUrl={cut.musicUrl}
      musicGainDb={cut.musicGainDb}
      musicEnabled={cut.musicUrl !== null}
      subtitles
      download={{ filename: 'cut.mp4' }}
    />
  );
}

function readCut(value: unknown): Cut {
  const record = recordOf(value, 'cut.json');
  const clips = record.clips;
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error('cut.json has no clips');
  }
  return {
    clips: clips.map((clip) => readClip(clip)),
    frameWidth: positive(record.frameWidth, 'frameWidth'),
    frameHeight: positive(record.frameHeight, 'frameHeight'),
    musicUrl: stringOrNull(record.musicUrl, 'musicUrl'),
    musicGainDb: numberOf(record.musicGainDb, 'musicGainDb'),
  };
}

function readClip(value: unknown): PlaybackClip {
  const record = recordOf(value, 'clip');
  const cues = readCues(record.cues);
  if (typeof record.videoUrl === 'string') {
    return {
      videoUrl: record.videoUrl,
      posterUrl: stringOrNull(record.posterUrl, 'posterUrl'),
      cues,
    };
  }
  return {
    imageUrl: stringOrNull(record.imageUrl, 'imageUrl'),
    fallbackImageUrl: stringOrNull(record.fallbackImageUrl, 'fallbackImageUrl'),
    durationSeconds: numberOf(record.durationSeconds, 'durationSeconds'),
    audioUrls: stringsOf(record.audioUrls, 'audioUrls'),
    width: numberOf(record.width, 'width'),
    height: numberOf(record.height, 'height'),
    cues,
  };
}

function readCues(value: unknown): PlaybackCue[] {
  if (!Array.isArray(value)) throw new Error('cues is not a list');
  return value.map((cue) => {
    const record = recordOf(cue, 'cue');
    return {
      startSeconds: numberOf(record.startSeconds, 'startSeconds'),
      endSeconds: numberOf(record.endSeconds, 'endSeconds'),
      text: stringOf(record.text, 'text'),
    };
  });
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value));
  }
  throw new Error(`${label} is not an object`);
}

function stringOf(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`${label} is not text`);
}

function stringOrNull(value: unknown, label: string): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new Error(`${label} is not text`);
}

function numberOf(value: unknown, label: string): number {
  if (typeof value === 'number') return value;
  throw new Error(`${label} is not a number`);
}

function positive(value: unknown, label: string): number {
  const number = numberOf(value, label);
  if (!(number > 0)) throw new Error(`${label} needs a positive number`);
  return number;
}

function stringsOf(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not a list of text`);
  return value.map((item) => stringOf(item, label));
}
