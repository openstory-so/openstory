import type { Meta, StoryObj } from '@storybook/react';
import { SequencePlayer } from './sequence-player';
import type { PlaybackClip } from '@openstory/stitch-player';
import {
  exportSequence,
  type ExportSequenceResult,
} from '@openstory/stitch-player/export';
import { StitchedPlayer } from '@openstory/stitch-player/react';
import { Button } from '@/ui/shadcn/button';
import { useState } from 'react';
import videoUrl from '../../../../e2e/fixtures/test-video.mp4?url';

// A PCM WAV like the dialogue section files; no provider URLs or live calls.
function dialogueFixture() {
  const bytes = new Uint8Array(44 + 32000);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    value.split('').forEach((char, index) => {
      bytes[offset + index] = char.charCodeAt(0);
    });
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, 32000, true);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}
const still: PlaybackClip = {
  orderIndex: 0,
  imageUrl: '/icon-512.png',
  fallbackImageUrl: null,
  durationSeconds: 5,
  audioUrls: [],
  width: 1280,
  height: 720,
};
const meta = {
  title: 'Sequences/Sequence Player',
  component: SequencePlayer,
  args: {
    clips: [still],
    aspectRatio: '16:9',
    musicUrl: null,
    musicGainDb: null,
    musicEnabled: false,
    onMusicEnabledChange: () => {},
  },
  render: function PlayerStory(args) {
    return (
      <div className="max-w-3xl">
        <SequencePlayer {...args} />
      </div>
    );
  },
} satisfies Meta<typeof SequencePlayer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Still: Story = {};
const mixedClips: PlaybackClip[] = [
  still,
  { orderIndex: 1, videoUrl, posterUrl: null },
  {
    ...still,
    orderIndex: 2,
    durationSeconds: 7,
    audioUrls: [dialogueFixture()],
    cues: [
      { startSeconds: 0, endSeconds: 1, text: 'Ann: A line over a still.' },
      { startSeconds: 1, endSeconds: 2, text: 'Bob: And the reply.' },
    ],
  },
];
export const Mixed: Story = { args: { clips: mixedClips } };

/** In-browser export of the Mixed cut; the result plays back in a plain <video>. */
const ExportDemo: React.FC<{ burnIn: boolean }> = ({ burnIn }) => {
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<
    (ExportSequenceResult & { url: string; vttUrl: string }) | Error | null
  >(null);
  const run = async () => {
    setProgress(0);
    try {
      const done = await exportSequence({
        clips: mixedClips,
        musicUrl: null,
        musicGainDb: null,
        subtitles: burnIn ? 'burn-in' : 'sidecar',
        onProgress: setProgress,
      });
      setResult({
        ...done,
        url: done.blob ? URL.createObjectURL(done.blob) : '',
        vttUrl: URL.createObjectURL(
          new Blob([done.vtt ?? 'WEBVTT\n'], { type: 'text/vtt' })
        ),
      });
    } catch (error) {
      setResult(error instanceof Error ? error : new Error(String(error)));
    }
    setProgress(null);
  };
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <SequencePlayer
        clips={mixedClips}
        aspectRatio="16:9"
        musicUrl={null}
        musicGainDb={null}
        musicEnabled={false}
        onMusicEnabledChange={() => {}}
      />
      <div className="flex flex-col items-start gap-1">
        <Button onClick={() => void run()} disabled={progress !== null}>
          {progress === null
            ? 'Export MP4'
            : `Exporting… ${Math.round(progress * 100)}%`}
        </Button>
      </div>
      {result instanceof Error ? (
        <p role="alert" className="text-sm text-destructive">
          {result.message}
        </p>
      ) : result ? (
        <div className="flex flex-col gap-2" data-testid="export-result">
          <p className="text-sm text-muted-foreground">
            {`${result.width}×${result.height}, ${result.durationSeconds.toFixed(2)}s, ${((result.blob?.size ?? 0) / 1024).toFixed(0)} KB`}
          </p>
          <video src={result.url} controls className="w-full">
            <track kind="captions" src={result.vttUrl} default />
          </video>
          {result.vtt ? (
            <pre className="text-xs" data-testid="export-vtt">
              {result.vtt}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

/** The package player's own Download button: pauses, exports from its opened clips, saves. */
export const WithDownload: Story = {
  render: () => (
    <div className="aspect-video max-w-3xl bg-black">
      <StitchedPlayer
        clips={mixedClips}
        musicUrl={null}
        musicGainDb={null}
        musicEnabled={false}
        download={{ filename: 'mixed-cut.mp4' }}
      />
    </div>
  ),
};

export const ExportSidecar: Story = {
  render: () => <ExportDemo burnIn={false} />,
};
export const ExportBurnIn: Story = {
  render: () => <ExportDemo burnIn />,
};
export const MissingImages: Story = {
  args: {
    clips: [
      {
        ...still,
        imageUrl: '/missing.png',
        fallbackImageUrl: '/also-missing.png',
      },
    ],
  },
};
