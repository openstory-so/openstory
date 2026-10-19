import { StitchedPlayer } from '@openstory/stitch/react';
import { useState } from 'react';
import type { StitchCut } from '@/stitches/cut';
import { MusicToggle } from '@/sequences/ui/theatre/sequence-player';
import { Button } from '@/ui/shadcn/button';

/**
 * The public page for a shared stitch (#2127): the cut's box fitted to the
 * window, the player, a music switch and Download. Same layout as the CLI's
 * local page, so the sender and the viewer see the same thing. A player
 * failure (a clip that will not load or decode) is shown in the box with a
 * retry, as the CLI's page does.
 */
export function StitchPage({ cut }: { cut: StitchCut }) {
  const [musicOn, setMusicOn] = useState(cut.musicUrl !== null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  return (
    <main className="flex h-dvh items-center justify-center bg-neutral-950 p-4 text-neutral-50 sm:p-8">
      <div
        className="relative overflow-hidden rounded-xl bg-black shadow-2xl"
        style={{
          aspectRatio: `${cut.frameWidth} / ${cut.frameHeight}`,
          width: `min(100%, calc((100dvh - 4rem) * ${cut.frameWidth / cut.frameHeight}))`,
        }}
      >
        {error === null ? (
          <StitchedPlayer
            key={attempt}
            clips={cut.clips}
            musicUrl={cut.musicUrl}
            musicGainDb={cut.musicGainDb}
            musicEnabled={musicOn}
            subtitles
            download={{ filename: 'cut.mp4' }}
            onError={(failure) => setError(failure.message)}
            className="h-full w-full"
          />
        ) : (
          <div
            role="alert"
            className="flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-center"
          >
            <p>{error}</p>
            <Button
              variant="secondary"
              onClick={() => {
                setError(null);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </div>
        )}
        {cut.musicUrl !== null && error === null && (
          <div className="absolute top-2 left-2 z-10">
            <MusicToggle
              enabled={musicOn}
              onToggle={() => setMusicOn((on) => !on)}
              className="bg-black/50 hover:bg-black/70"
            />
          </div>
        )}
      </div>
    </main>
  );
}
