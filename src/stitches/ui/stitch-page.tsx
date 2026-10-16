import { StitchedPlayer } from '@openstory/stitch/react';
import { useState } from 'react';
import type { StitchCut } from '@/stitches/cut';
import { MusicToggle } from '@/sequences/ui/theatre/sequence-player';

/**
 * The public page for a shared stitch (#2127): the cut's box fitted to the
 * window, the player, a music switch and Download. Same shape as the CLI's
 * page, which is where the viewer's sender was looking.
 */
export function StitchPage({ cut }: { cut: StitchCut }) {
  const [musicOn, setMusicOn] = useState(cut.musicUrl !== null);
  return (
    <main className="flex h-dvh items-center justify-center bg-neutral-950 p-4 text-neutral-50 sm:p-8">
      <div
        className="relative overflow-hidden rounded-xl bg-black shadow-2xl"
        style={{
          aspectRatio: `${cut.frameWidth} / ${cut.frameHeight}`,
          width: `min(100%, calc((100dvh - 4rem) * ${cut.frameWidth / cut.frameHeight}))`,
        }}
      >
        <StitchedPlayer
          clips={cut.clips}
          musicUrl={cut.musicUrl}
          musicGainDb={cut.musicGainDb}
          musicEnabled={musicOn}
          subtitles
          download={{ filename: 'cut.mp4' }}
          className="h-full w-full"
        />
        {cut.musicUrl !== null && (
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
