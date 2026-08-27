/**
 * Copy the whole script — the composed document (#1037).
 *
 * The script document is rendered as one block per scene, so there is no single
 * element to select-all across. This copies `getComposedScriptFn`'s output: the
 * selected scene versions joined in order — exactly the text the blocks show,
 * and exactly what a re-analysis would consume.
 *
 * The copy goes through `copyTextToClipboard`, which falls back to
 * `execCommand` when `navigator.clipboard` is missing or rejects — on mobile
 * Chrome without a clipboard grant the Clipboard API alone silently does
 * nothing. Either outcome now lands on the button itself, so a tap that failed
 * reads as failed instead of as a dead control.
 */

import { Button } from '@/components/ui/button';
import { useComposedScript } from '@/hooks/use-scenes';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/utils/clipboard';
import { AlertCircle, Check, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

type CopyStatus = 'idle' | 'copied' | 'failed';

const STATUS: Record<
  CopyStatus,
  {
    label: string;
    announced: string;
    Icon: typeof CopyIcon;
    className?: string;
  }
> = {
  idle: {
    label: 'Copy script',
    announced: 'Copy the whole script',
    Icon: CopyIcon,
  },
  copied: { label: 'Copied', announced: 'Script copied', Icon: Check },
  failed: {
    label: 'Copy failed',
    announced: 'Copy failed',
    Icon: AlertCircle,
    className: 'text-destructive',
  },
};

export const CopyScriptButton: React.FC<{ sequenceId: string }> = ({
  sequenceId,
}) => {
  const { data: composed } = useComposedScript(sequenceId);
  const [status, setStatus] = useState<CopyStatus>('idle');
  // Bumped on every attempt so a repeat tap restarts the reset timer — keyed on
  // `status` alone, a second tap 1.5s in would still revert 0.5s later.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (status === 'idle') return;
    const timer = setTimeout(() => setStatus('idle'), 2000);
    return () => clearTimeout(timer);
  }, [status, attempt]);

  const script = composed?.script ?? '';

  const handleCopy = async () => {
    const copied = await copyTextToClipboard(script);
    setStatus(copied ? 'copied' : 'failed');
    setAttempt((n) => n + 1);
    if (copied) return;
    // Stable id: three taps in half a second should not stack three toasts.
    toast.error('Could not copy the script', {
      id: 'copy-script-failed',
      description:
        'Your browser blocked clipboard access. Select the script text to copy it manually.',
    });
  };

  const { label, announced, Icon, className } = STATUS[status];

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-11 px-2 md:h-8 md:px-2.5"
      disabled={!script}
      onClick={() => void handleCopy()}
      aria-label={announced}
    >
      <Icon className={cn('h-4 w-4 md:mr-1.5 md:h-3.5 md:w-3.5', className)} />
      <span className="sr-only" aria-live="polite">
        {announced}
      </span>
      <span className="hidden md:inline">{label}</span>
    </Button>
  );
};
