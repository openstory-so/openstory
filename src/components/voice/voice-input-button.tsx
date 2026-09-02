/**
 * Mic button for dictating into a script or prompt field. Click to start a
 * take, click again (or press Escape while focused) to stop; the transcript is
 * delivered through `onTranscript` once it comes back.
 *
 * Anonymous visitors get the login dialog on first click (transcription is a
 * billed server call); a browser without recording support renders nothing.
 */

import { useOptionalAuthGate } from '@/components/auth/auth-gate-provider';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { openBillingGate } from '@/hooks/use-billing-gate-dialog';
import { useHydrated } from '@/hooks/use-hydrated';
import { NoSpeechError, useVoiceInput } from '@/hooks/use-voice-input';
import { errorMessage, isInsufficientCreditsError } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { LoaderCircle, Mic, Square } from 'lucide-react';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

type VoiceInputButtonProps = {
  onTranscript: (text: string) => void;
  /** What is being dictated, for the tooltip and screen readers ("script", "prompt"). */
  label?: string;
  disabled?: boolean;
  size?: 'icon' | 'icon-sm' | 'icon-xs';
  className?: string;
  /** ISO-639-1 hint; omitted = auto-detect. */
  language?: string;
};

function reportVoiceError(error: unknown) {
  if (error instanceof NoSpeechError) {
    toast.info('No speech detected', {
      description: 'Try again a little closer to the microphone.',
    });
    return;
  }
  if (isInsufficientCreditsError(error)) {
    openBillingGate('insufficient');
    return;
  }
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    toast.error('Microphone access is blocked', {
      description:
        'Allow microphone access for this site in your browser settings, then try again.',
    });
    return;
  }
  toast.error('Voice input failed', {
    description: errorMessage(error, 'Please try again.'),
  });
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
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
  label = 'text',
  disabled = false,
  size = 'icon-sm',
  className,
  language,
}) => {
  // Optional: the mic ships inside every MarkdownEditor, including trees
  // rendered without the app shell. Without a gate the server fn still
  // rejects anonymous callers.
  const authGate = useOptionalAuthGate();
  const { status, isSupported, startedAt, toggle, cancel } = useVoiceInput({
    onTranscript,
    onError: reportVoiceError,
    language,
  });
  const hydrated = useHydrated();

  // Pre-hydration the button renders disabled so the layout does not shift
  // when it becomes live; only a browser that cannot record hides it.
  if (hydrated && !isSupported) return null;

  const recording = status === 'recording';
  const transcribing = status === 'transcribing';
  const actionLabel = recording
    ? 'Stop recording'
    : transcribing
      ? 'Transcribing…'
      : `Dictate ${label}`;

  return (
    <div
      className="flex items-center gap-1"
      data-slot="voice-input"
      data-status={status}
    >
      {recording && startedAt !== null ? (
        <Elapsed startedAt={startedAt} />
      ) : null}
      {/* Own provider: the mic renders inside every MarkdownEditor, including
          trees mounted outside the app shell (SSR test, bare stories). */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={recording ? 'destructive' : 'ghost'}
              size={size}
              aria-label={actionLabel}
              aria-pressed={recording}
              aria-busy={transcribing}
              disabled={disabled || !hydrated || transcribing}
              className={cn(
                'text-muted-foreground hover:text-foreground',
                recording && 'text-destructive hover:text-destructive',
                className
              )}
              data-testid="voice-input-button"
              onClick={() => {
                if (status === 'idle' && authGate && !authGate.requireAuth()) {
                  return;
                }
                void toggle();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && recording) {
                  event.preventDefault();
                  event.stopPropagation();
                  cancel();
                }
              }}
            >
              {transcribing ? (
                <LoaderCircle className="animate-spin" />
              ) : recording ? (
                <Square className="fill-current motion-safe:animate-pulse" />
              ) : (
                <Mic />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{actionLabel}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {/* One text fiber whose value changes — never mounted/unmounted (#1283). */}
      <span className="sr-only" aria-live="polite">
        {recording
          ? 'Recording. Click again to stop, or press Escape to discard.'
          : transcribing
            ? 'Transcribing your recording.'
            : 'Voice input ready.'}
      </span>
    </div>
  );
};
