import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { VideoPlayer } from '@/components/motion/video-player';
import { getAspectRatioClassName } from '@/lib/constants/aspect-ratios';
import {
  optimizedVideoUrl,
  videoPosterUrl,
} from '@/lib/media/cloudflare-video';
import { type SampleEntry } from '@/lib/style/sample-entries';
import { cn } from '@/lib/utils';
import { Link } from '@tanstack/react-router';
import { Wand2 } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

export const SampleVideoCard: React.FC<{
  entry: SampleEntry;
  /** First-viewport cards: eager poster + high fetch priority (#1182). */
  priority?: boolean;
}> = ({ entry, priority = false }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState(false);

  // Resting state is a cheap Cloudflare-extracted poster frame (~36KB jpg) and
  // `preload="none"`, so the page paints without fetching a single video byte.
  // The downscaled clip (Cloudflare `mode=video`, ~6× smaller than the master)
  // is only fetched + played on hover. Touch devices that fire no hover keep
  // showing the poster. Clicking the card opens a dialog with a full player
  // (controls + sound). The dialog uses a larger downscale so it's sharp at
  // size without paying for the full master clip.
  const poster = videoPosterUrl(entry.video.url);
  const src = optimizedVideoUrl(entry.video.url);
  const playerSrc = optimizedVideoUrl(entry.video.url, 1280);

  const play = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setPlaying(true);
    void el.play().catch(() => {});
  }, []);

  const stop = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    el.pause();
    el.currentTime = 0;
    setPlaying(false);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          'group relative w-full overflow-hidden rounded-lg border bg-muted',
          getAspectRatioClassName(entry.aspectRatio)
        )}
        onMouseEnter={play}
        onMouseLeave={stop}
      >
        {poster ? (
          <img
            src={poster}
            alt=""
            width={640}
            height={360}
            className="absolute inset-0 h-full w-full object-cover"
            fetchPriority={priority ? 'high' : 'low'}
            loading={priority ? 'eager' : 'lazy'}
            decoding="async"
          />
        ) : null}
        <video
          ref={videoRef}
          src={src}
          // Poster is a real <img> so LCP / preload hit one URL, not the
          // video element. Hover still swaps in the downscaled clip.
          className={cn(
            'absolute inset-0 h-full w-full object-cover',
            playing ? 'opacity-100' : 'opacity-0'
          )}
          muted
          loop
          playsInline
          preload="none"
          aria-hidden="true"
        />
        {/* Full-card click target that opens the player dialog. Layered over the
            preview video; the style label and Try button render after it so they
            stay on top and keep their own behaviour. */}
        <DialogTrigger asChild>
          <button
            type="button"
            aria-label={`Play the ${entry.styleName} sample video`}
            className="absolute inset-0 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        </DialogTrigger>
        <span className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-background/70 px-2 py-0.5 text-xs font-medium backdrop-blur-sm">
          {entry.styleName}
        </span>
        {entry.hasBrief && (
          <Button
            asChild
            size="sm"
            variant="secondary"
            className="absolute bottom-2 right-2 gap-1.5 opacity-90 backdrop-blur-sm transition-opacity group-hover:opacity-100"
          >
            <Link
              to="/"
              search={{ style: entry.slug }}
              hash="compose"
              aria-label={`Try the ${entry.styleName} style`}
            >
              <Wand2 className="size-3.5" />
              Try
            </Link>
          </Button>
        )}
      </div>
      <DialogContent className="max-w-3xl gap-3 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{entry.styleName}</DialogTitle>
        </DialogHeader>
        {/* Mounted only while open so no video bytes load until the dialog is
            actually shown, and playback resets on close. VideoPlayer forces a
            full-width aspect-ratio box, so cap the width per aspect ratio — a
            tall 9:16 clip would otherwise derive a height that overflows the
            viewport. The cap keeps the derived height within ~75vh. */}
        {open && (
          <VideoPlayer
            src={playerSrc}
            posterSrc={poster}
            aspectRatio={entry.aspectRatio}
            autoPlay
            playSource="modal"
            className={cn(
              'mx-auto overflow-hidden rounded-lg',
              entry.aspectRatio === '9:16' && 'max-w-[42vh]',
              entry.aspectRatio === '1:1' && 'max-w-[75vh]'
            )}
          />
        )}
        {entry.hasBrief && (
          <Button asChild className="gap-1.5">
            <Link to="/" search={{ style: entry.slug }} hash="compose">
              <Wand2 className="size-4" />
              Try the {entry.styleName} style
            </Link>
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
};
