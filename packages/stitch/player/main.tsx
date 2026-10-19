import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@videojs/react/video/neutral-skin.css';
import { playbackGapMessage } from '../src/playback-gap';
import type { SequencePlayerMeta } from '../src/playback';
import { StitchedPlayer } from '../src/react';
import type { PlaybackClip, PlaybackCue } from '../src/playback-clip';

type Cut = {
  clips: PlaybackClip[];
  frameWidth: number;
  frameHeight: number;
  musicUrl: string | null;
  musicGainDb: number;
};

const stage = document.getElementById('stage') ?? document.body;

try {
  const cut = readCut(await fetchCut());
  stage.style.setProperty('--ar', String(cut.frameWidth / cut.frameHeight));
  createRoot(stage).render(<Preview cut={cut} />);
} catch (error) {
  createRoot(stage).render(
    <div className="error">
      <p>{error instanceof Error ? error.message : 'The cut could not load'}</p>
    </div>
  );
}

async function fetchCut(): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch('cut.json');
  } catch {
    throw new Error(
      location.hostname === '127.0.0.1' || location.hostname === 'localhost'
        ? 'The stitch server is not running. Run stitch again.'
        : 'Could not load cut.json next to this page.'
    );
  }
  if (!response.ok) throw new Error(`cut.json returned ${response.status}`);
  return response.json();
}

function Preview({ cut }: { cut: Cut }) {
  const [musicOn, setMusicOn] = useState(cut.musicUrl !== null);
  const [meta, setMeta] = useState<SequencePlayerMeta | null>(null);
  const [loaded, setLoaded] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pipError, setPipError] = useState<string | null>(null);
  const opening = cut.clips[0];
  const openingUrl =
    opening && 'videoUrl' in opening ? opening.posterUrl : opening?.imageUrl;
  const opened = Math.min(loaded, cut.clips.length);

  if (error) {
    return (
      <div className="error">
        <p>{error}</p>
        <button
          type="button"
          onClick={() => {
            setMeta(null);
            setLoaded(0);
            setError(null);
            setPipError(null);
            setAttempt((n) => n + 1);
          }}
        >
          Retry playback
        </button>
      </div>
    );
  }

  const gap = meta ? playbackGapMessage(meta) : null;
  const mixed = meta ? mixedResolutionMessage(meta) : null;
  const notices = [gap, mixed, pipError].filter((item) => item !== null);

  return (
    <>
      <StitchedPlayer
        key={attempt}
        clips={cut.clips}
        musicUrl={cut.musicUrl}
        musicGainDb={cut.musicGainDb}
        musicEnabled={musicOn}
        subtitles
        download={{ filename: 'cut.mp4' }}
        onLoadProgress={(count) => setLoaded(count)}
        onMeta={setMeta}
        onError={(failure) => setError(failure.message)}
        onPictureInPictureError={(failure) => setPipError(failure.message)}
      />
      {meta === null && (
        <div className="loading">
          {openingUrl && <img src={openingUrl} alt="" />}
          <div>
            <p>
              {opened < cut.clips.length
                ? `Loading clip ${opened + 1} of ${cut.clips.length}…`
                : 'Preparing playback…'}
            </p>
            <progress
              aria-label="Loading sequence"
              max={cut.clips.length}
              value={opened}
            />
          </div>
        </div>
      )}
      <div className="hud">
        <div>
          {notices.map((notice) => (
            <p key={notice} className="note">
              {notice}
            </p>
          ))}
        </div>
        {cut.musicUrl !== null && (
          <button
            type="button"
            className="icon"
            aria-pressed={musicOn}
            aria-label={musicOn ? 'Turn music off' : 'Turn music on'}
            title={musicOn ? 'Music on' : 'Music off'}
            onClick={() => setMusicOn((on) => !on)}
          >
            <span className={musicOn ? 'mark' : 'mark off'}>
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
            </span>
          </button>
        )}
      </div>
    </>
  );
}

function mixedResolutionMessage(meta: SequencePlayerMeta): string | null {
  if (!meta.hasMixedResolutions) return null;
  const fit = meta.hasMixedAspectRatios
    ? 'Playback letterboxes them into a common frame'
    : 'Smaller clips are upscaled to match';
  return `Clips use different resolutions (${meta.resolutionsLabel}). ${fit}; a rendered MP4 normalizes them the same way.`;
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
