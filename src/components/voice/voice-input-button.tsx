/**
 * Mic button for dictating into a script or prompt field. Click to start, click
 * again (or press Escape) to stop. Words stream into the target as they are
 * spoken: `onTranscript` fires on every interim update with the take so far,
 * and the target replaces what it rendered for the previous update.
 *
 * Recognition is the browser's own — nothing is recorded or uploaded by us —
 * so the button hides itself where the Web Speech API is missing (Firefox).
 */

import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useHydrated } from '@/hooks/use-hydrated';
import {
  DictationError,
  useSpeechDictation,
} from '@/hooks/use-speech-dictation';
import { Mic, Square } from 'lucide-react';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

type VoiceInputButtonProps = {
  /** The take so far, on every interim update — replaces the previous emission. */
  onTranscript: (text: string) => void;
  /** A take is starting: anchor wherever the next `onTranscript` should land. */
  onStart?: () => void;
  /** The take ended; the last `onTranscript` text stands. */
  onEnd?: () => void;
  /** What is being dictated, for the tooltip and screen readers ("script", "prompt"). */
  label?: string;
  variant?: 'ghost' | 'outline';
  size?: 'icon' | 'icon-sm' | 'icon-xs';
  disabled?: boolean;
  className?: string;
  /** BCP-47 tag; omitted = the browser's own language. */
  language?: string;
};

function reportDictationError(error: DictationError) {
  toast.error('Dictation stopped', {
    description:
      error.code === 'not-allowed' || error.code === 'service-not-allowed'
        ? 'Allow microphone access for this site in your browser settings, then try again.'
        : error.message,
  });
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

/** Elapsed-time readout, re-rendered once a second while a take is live. */
const Elapsed: React.FC<{ startedAt: number }> = ({ startedAt }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="tabular-nums text-xs" data-testid="voice-input-elapsed">
      {formatElapsed(now - startedAt)}
    </span>
  );
};

export const VoiceInputButton: React.FC<VoiceInputButtonProps> = ({
  onTranscript,
  onStart,
  onEnd,
  label = 'text',
  variant = 'ghost',
  size = 'icon-sm',
  disabled = false,
  className,
  language,
}) => {
  const { status, isSupported, startedAt, toggle, stop } = useSpeechDictation({
    onTranscript,
    onStart,
    onEnd,
    onError: reportDictationError,
    language,
  });
  const hydrated = useHydrated();

  // Pre-hydration the button renders disabled so the row does not reflow when
  // it becomes live; only a browser that cannot dictate hides it.
  if (hydrated && !isSupported) return null;

  const listening = status === 'listening';
  const actionLabel = listening ? 'Stop dictating' : `Dictate ${label}`;

  return (
    <div
      className="flex items-center gap-1"
      data-slot="voice-input"
      data-status={status}
    >
      {listening && startedAt !== null ? (
        <Elapsed startedAt={startedAt} />
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant={listening ? 'destructive' : variant}
            size={size}
            className={className}
            aria-label={actionLabel}
            aria-pressed={listening}
            disabled={disabled || !hydrated}
            data-testid="voice-input-button"
            onClick={toggle}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && listening) {
                event.preventDefault();
                event.stopPropagation();
                stop();
              }
            }}
          >
            {listening ? (
              <Square className="size-3.5 fill-current motion-safe:animate-pulse" />
            ) : (
              <Mic className="size-3.5" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{actionLabel}</TooltipContent>
      </Tooltip>
      {/* One text fiber whose value changes — never mounted/unmounted (#1283). */}
      <span className="sr-only" aria-live="polite">
        {listening
          ? 'Listening. Your words appear as you speak. Click again to stop.'
          : 'Dictation ready.'}
      </span>
    </div>
  );
};
