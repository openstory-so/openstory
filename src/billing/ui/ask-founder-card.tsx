/**
 * "Ask the founder for credits" (#1096, reworked in #1099) — expands into an
 * optional message form before emailing the founder. A PostHog product event
 * fires server-side. Success collapses into a confirmation so it can't be
 * re-sent from the same dialog.
 */

import { Button } from '@/ui/shadcn/button';
import { Textarea } from '@/ui/shadcn/textarea';
import { requestFounderCreditsFn } from '@/billing/billing.fn';
import { cn } from '@/ui/utils';
import { useMutation } from '@tanstack/react-query';
import { ArrowRight, Check, HeartHandshake } from 'lucide-react';
import { useState } from 'react';

export const founderOptionCardClassName = (variant: 'primary' | 'muted') =>
  cn(
    'group relative flex items-center gap-3.5 rounded-xl border p-3.5 transition-all duration-200',
    // The primary card is THE action — it must read as highlighted next to
    // the muted fallbacks, not as a sibling (#1099).
    variant === 'primary' &&
      'border-primary/50 bg-primary/10 hover:border-primary hover:bg-primary/15',
    variant === 'muted' &&
      'border-border/60 bg-transparent hover:border-border hover:bg-accent/50'
  );

export const AskFounderCard: React.FC = () => {
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      requestFounderCreditsFn({
        data: { message: message.trim() || undefined },
      }),
  });

  if (mutation.isSuccess) {
    return (
      <div className={founderOptionCardClassName('muted')}>
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-emerald-600 dark:text-emerald-400">
          <Check className="size-4" />
        </div>
        <div className="flex-1 space-y-0.5">
          <span className="text-sm font-medium">Request sent</span>
          <p className="text-xs text-muted-foreground">
            Tom will reply to your account email soon.
          </p>
        </div>
      </div>
    );
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className={cn(founderOptionCardClassName('muted'), 'w-full text-left')}
      >
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground group-hover:bg-muted/80">
          <HeartHandshake className="size-4" />
        </div>
        <div className="flex-1 space-y-0.5">
          <span className="text-sm font-medium">
            Ask the founder for credits
          </span>
          <p className="text-xs text-muted-foreground">
            Seriously. Tom replies.
          </p>
        </div>
        <ArrowRight className="size-3.5 shrink-0 -translate-x-1 text-muted-foreground opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-60" />
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border/60 p-3.5">
      <div className="flex items-center gap-3.5">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <HeartHandshake className="size-4" />
        </div>
        <div className="flex-1 space-y-0.5">
          <span className="text-sm font-medium">
            Ask the founder for credits
          </span>
          <p className="text-xs text-muted-foreground">
            Seriously. Tom replies.
          </p>
        </div>
      </div>
      <Textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            mutation.mutate();
          }
        }}
        placeholder="Tell Tom what you're making (optional)"
        rows={3}
        maxLength={2000}
      />
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(false)}
          disabled={mutation.isPending}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? 'Sending…' : 'Send request'}
        </Button>
      </div>
      {mutation.isError && (
        <p role="alert" className="text-xs text-destructive">
          {mutation.error instanceof Error
            ? mutation.error.message
            : 'Failed to send request'}
        </p>
      )}
    </div>
  );
};
