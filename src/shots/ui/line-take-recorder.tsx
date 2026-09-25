/**
 * Record one line at the mic (#1802), from the line itself: Record beside
 * it, then hear the take back under it and Use it or Discard it. The take
 * goes to the server only on Use: turning it into the character's voice is
 * what costs.
 */

import { Button } from '@/ui/shadcn/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/shadcn/tooltip';
import { Mic, Square } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { MIC_TAKE_MAX_SECONDS } from './mic-take';

type TakeState =
  | { kind: 'idle' }
  | { kind: 'recording'; index: number }
  | { kind: 'review'; index: number; blob: Blob; url: string }
  | { kind: 'sending'; index: number; blob: Blob; url: string };

/**
 * One take at a time across the shot's lines: a Blob until the user uses it.
 * `onUse` resolves once the run is triggered; a rejection keeps the take so
 * it can be sent again.
 */
export function useMicTake(
  onUse: (index: number, take: Blob) => Promise<void>
) {
  const [state, setState] = useState<TakeState>({ kind: 'idle' });
  const recorder = useRef<MediaRecorder | null>(null);
  const start = async (index: number) => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      toast.error('Microphone not available', {
        description: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const chunks: Blob[] = [];
    const media = new MediaRecorder(stream);
    media.ondataavailable = (event) => chunks.push(event.data);
    media.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      recorder.current = null;
      const blob = new Blob(chunks, { type: media.mimeType });
      setState({ kind: 'review', index, blob, url: URL.createObjectURL(blob) });
    };
    recorder.current = media;
    media.start();
    setState({ kind: 'recording', index });
    setTimeout(() => {
      if (media.state === 'recording') media.stop();
    }, MIC_TAKE_MAX_SECONDS * 1000);
  };

  // The take's object URL is freed where the take is dropped, in the handler
  // that drops it — there is nothing to sync, so no effect.
  const drop = () => {
    if (state.kind === 'review' || state.kind === 'sending') {
      URL.revokeObjectURL(state.url);
    }
    setState({ kind: 'idle' });
  };

  const use = () => {
    if (state.kind !== 'review') return;
    setState({ ...state, kind: 'sending' });
    onUse(state.index, state.blob).then(
      () => {
        URL.revokeObjectURL(state.url);
        setState({ kind: 'idle' });
      },
      () => setState(state)
    );
  };

  return {
    state,
    start: (index: number) => void start(index),
    stop: () => recorder.current?.stop(),
    use,
    discard: drop,
  };
}

export type MicTake = ReturnType<typeof useMicTake>;

/** Record / Stop, beside the line. */
export const LineTakeButton: React.FC<{
  take: MicTake;
  index: number;
  name: string;
  /** Why this line cannot be recorded now, or null. */
  blockedBecause: string | null;
}> = ({ take, index, name, blockedBecause }) => {
  const { state } = take;
  if (state.kind === 'recording' && state.index === index) {
    return (
      <Button
        size="sm"
        variant="destructive"
        onClick={take.stop}
        aria-label={`Stop recording ${name}'s line`}
      >
        <Square className="h-3 w-3" aria-hidden />
        Stop
      </Button>
    );
  }
  const button = (
    <Button
      size="sm"
      variant="ghost"
      disabled={state.kind !== 'idle' || blockedBecause !== null}
      onClick={() => take.start(index)}
      // The reason rides the label too: a disabled button gets no focus, so
      // a keyboard user never sees the tooltip.
      aria-label={
        blockedBecause
          ? `Record ${name}'s line — ${blockedBecause}`
          : `Record ${name}'s line`
      }
    >
      <Mic className="h-3 w-3" aria-hidden />
      Record
    </Button>
  );
  if (!blockedBecause) return button;
  // A disabled button gets no pointer events; the span carries the tooltip.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{button}</span>
      </TooltipTrigger>
      <TooltipContent>{blockedBecause}</TooltipContent>
    </Tooltip>
  );
};

/** Under the line: "Recording…", or the take to hear and Use / Discard. */
export const LineTakeReview: React.FC<{
  take: MicTake;
  index: number;
  name: string;
}> = ({ take, index, name }) => {
  const { state } = take;
  const mine = state.kind !== 'idle' && state.index === index;
  return (
    <>
      <p
        aria-live="polite"
        className={
          mine && state.kind === 'recording'
            ? 'text-xs text-muted-foreground'
            : 'hidden'
        }
      >
        Recording… up to {MIC_TAKE_MAX_SECONDS}s
      </p>
      {mine && (state.kind === 'review' || state.kind === 'sending') ? (
        <div className="flex flex-col gap-2">
          {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- the user's own take of the line above */}
          <audio
            controls
            src={state.url}
            className="w-full"
            aria-label={`Your take of ${name}'s line`}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={state.kind === 'sending'}
              onClick={take.use}
            >
              {state.kind === 'sending' ? 'Sending…' : `Use in ${name}'s voice`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={state.kind === 'sending'}
              onClick={take.discard}
            >
              Discard
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
};
