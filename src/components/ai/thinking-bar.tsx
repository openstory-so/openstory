import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { cn } from '@/lib/utils';
import { Brain, ChevronRight } from 'lucide-react';
import { useEffect, useState, type FC } from 'react';

/**
 * "Thinking…" indicator shown while the model is in its reasoning pass, before
 * any output streams.
 *
 * Two modes. Without `text` it is a content-free status bar — what the callers
 * that don't stream reasoning (the shot-prompt regens) get. With `text` it
 * becomes a collapsible transcript of the model's actual reasoning.
 *
 * Either mode renders only while `active`: once the answer starts streaming the
 * reasoning is spent, and a lingering summary is just chrome above the thing
 * the user actually asked for.
 *
 * The transcript is **collapsed by default**, deliberately. Measured against
 * OpenRouter, both models we enhance with return a one-or-two-sentence summary
 * of their reasoning, not a live raw stream: ~100 chars for claude-sonnet-5
 * (arriving 0.6s before the answer) and ~200 for grok-4.6, whose summary
 * routinely opens with the first lines of the script it is about to write. So
 * expanding by default buys a flash of text, a spoiler of the answer, and then
 * silence — worse than a clean status bar. Behind one click it is a genuinely
 * interesting look at the plan; in front of the user's face it is noise.
 */
export const ThinkingBar: FC<{
  active: boolean;
  /** Reasoning text streamed so far. Omit for a status-only bar. */
  text?: string;
  className?: string;
}> = ({ active, text, className }) => {
  const [open, setOpen] = useState(false);
  const { ref } = useAutoScroll<HTMLDivElement>({
    enabled: active && open,
    content: text ?? '',
  });

  // A new run (text reset to empty) closes the panel again.
  useEffect(() => {
    if (!text) setOpen(false);
  }, [text]);

  const barClasses = cn(
    'flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground',
    className
  );

  if (!active) return null;

  if (!text) {
    return (
      <div aria-live="polite" className={barClasses}>
        <Brain
          className="size-3.5 shrink-0 animate-pulse motion-reduce:animate-none"
          aria-hidden
        />
        <span>Thinking…</span>
      </div>
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(barClasses, 'flex-col items-stretch gap-2')}
    >
      {/* Not CollapsibleTrigger: that renders a bare <button>, and this needs
          the shared focus ring and a real hit target. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-6 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Brain
          className="size-3.5 shrink-0 animate-pulse motion-reduce:animate-none"
          aria-hidden
        />
        {/* The status line is the live region, not the transcript below: a
            token-by-token stream through aria-live would flood a screen reader
            with scratch work. */}
        <span aria-live="polite">Thinking…</span>
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
            open && 'rotate-90'
          )}
          aria-hidden
        />
      </button>
      <CollapsibleContent>
        <div
          ref={ref}
          aria-busy
          className="max-h-32 overflow-y-auto font-normal whitespace-pre-wrap"
        >
          {text}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
