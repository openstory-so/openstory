/**
 * Record one line at the mic (#1802). Record → hear it back → Use take or
 * Discard. The take goes to the server only on Use: converting it into the
 * character's voice is what costs.
 */

import { Button } from '@/ui/shadcn/button';
import { Mic, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { MIC_TAKE_MAX_SECONDS } from './mic-take';

export type RecordableLine = {
  index: number;
  character: string;
  text: string;
};

type TakeState =
  | { kind: 'idle' }
  | { kind: 'recording'; index: number }
  | { kind: 'review'; index: number; blob: Blob; url: string };

/** One MediaRecorder at a time; the take is a Blob until the user uses it. */
function useMicTake() {
  const [state, setState] = useState<TakeState>({ kind: 'idle' });
  const recorder = useRef<MediaRecorder | null>(null);
  const reviewUrl = state.kind === 'review' ? state.url : null;
  useEffect(
    () => () => {
      if (reviewUrl) URL.revokeObjectURL(reviewUrl);
    },
    [reviewUrl]
  );
  useEffect(() => () => recorder.current?.stop(), []);

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

  return {
    state,
    start: (index: number) => void start(index),
    stop: () => recorder.current?.stop(),
    discard: () => setState({ kind: 'idle' }),
  };
}

export const LineTakeRecorder: React.FC<{
  lines: readonly RecordableLine[];
  /** Why no line can be recorded now, or null. */
  blockedBecause: string | null;
  onUse: (lineIndex: number, take: Blob) => Promise<void>;
}> = ({ lines, blockedBecause, onUse }) => {
  const { state, start, stop, discard } = useMicTake();
  const [sending, setSending] = useState(false);
  if (lines.length === 0) return null;
  const busy = state.kind !== 'idle' || sending;
  return (
    <section
      aria-label="Record a line"
      className="flex flex-col gap-2 rounded-md border p-3"
    >
      <span className="text-xs font-medium">Record a line</span>
      {blockedBecause ? (
        <p className="text-xs text-muted-foreground">{blockedBecause}</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {lines.map((line) => {
          const name = line.character || 'Narrator';
          const mine = state.kind !== 'idle' && state.index === line.index;
          return (
            <li key={line.index} className="flex flex-col gap-1">
              <div className="flex min-h-8 items-center justify-between gap-2">
                <span className="text-sm">
                  <span className="font-medium">{name}</span> — {line.text}
                </span>
                {mine && state.kind === 'recording' ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={stop}
                    aria-label={`Stop recording ${name}'s line`}
                  >
                    <Square className="h-3 w-3" aria-hidden />
                    Stop
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || blockedBecause !== null}
                    onClick={() => start(line.index)}
                    aria-label={`Record ${name}'s line`}
                  >
                    <Mic className="h-3 w-3" aria-hidden />
                    Record
                  </Button>
                )}
              </div>
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
              {mine && state.kind === 'review' ? (
                <div className="flex flex-col gap-2">
                  {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- the user's own take of the line shown above */}
                  <audio
                    controls
                    src={state.url}
                    className="w-full"
                    aria-label={`Your take of ${name}'s line`}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={sending}
                      onClick={() => {
                        setSending(true);
                        onUse(line.index, state.blob)
                          .then(discard)
                          .catch(() => undefined)
                          .finally(() => setSending(false));
                      }}
                    >
                      {sending ? 'Sending…' : `Use in ${name}'s voice`}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={sending}
                      onClick={discard}
                    >
                      Discard
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
