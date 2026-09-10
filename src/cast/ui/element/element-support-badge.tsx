/**
 * How usable an element is as a model reference, on the element itself (#1559).
 *
 * A still needs no badge — every model takes one. A clip or a voice line is
 * carried by only part of the catalog, which is a permanent property of the
 * file rather than a transient problem, so it wears a warning that names the
 * models that will use it. And a file longer than every ceiling in the catalog
 * cannot be a reference at all: that reads as an error, because the only way
 * out is to trim it.
 *
 * The badge answers "will this be used?" where it is uploaded, rather than
 * leaving the user to discover it from a refused render.
 */

import {
  referenceUsability,
  type ReferenceUsability,
} from '@/motion/reference-support';
import { IMAGE_TO_VIDEO_MODELS } from '@/models/models';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/shadcn/tooltip';
import { cn } from '@/ui/utils';
import { AlertTriangle, CircleAlert } from 'lucide-react';

type ElementSupportBadgeProps = {
  kind: 'image' | 'video' | 'audio';
  durationSeconds: number | null;
  /** Tile overlay by default; `inline` sits in a row of detail text. */
  variant?: 'overlay' | 'inline';
  className?: string;
};

/**
 * The same sentence the tooltip shows, as plain text — the detail view states
 * it outright rather than hiding it behind a hover.
 */
export function elementSupportSummary(
  kind: 'image' | 'video' | 'audio',
  durationSeconds: number | null
): string {
  return summarise(referenceUsability({ kind, durationSeconds }), kind);
}

function summarise(usability: ReferenceUsability, kind: string): string {
  if (usability.level === 'unusable') {
    return `This ${kind} is too long to use as a reference — no model accepts more than ${usability.maxSeconds}s. Trim it to attach it to a shot.`;
  }
  if (usability.level === 'limited') {
    const names = usability.models
      .map((model) => IMAGE_TO_VIDEO_MODELS[model].name)
      .join(', ');
    const limit = usability.maxSeconds
      ? ` Up to ${usability.maxSeconds}s.`
      : '';
    return `Only some models use a reference ${kind}: ${names}.${limit} On any other model it is described in the prompt instead of sent.`;
  }
  return '';
}

export const ElementSupportBadge: React.FC<ElementSupportBadgeProps> = ({
  kind,
  durationSeconds,
  variant = 'overlay',
  className,
}) => {
  const usability = referenceUsability({ kind, durationSeconds });
  if (usability.level === 'ok') return null;

  const unusable = usability.level === 'unusable';
  const Icon = unusable ? CircleAlert : AlertTriangle;
  const label = summarise(usability, kind);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <output
          // Not a button: it is a status, not an action. The same sentence is
          // stated outright on the detail view for anyone who cannot hover.
          aria-label={label}
          className={cn(
            'inline-flex items-center justify-center rounded-full',
            variant === 'overlay'
              ? 'absolute top-2 left-2 size-6 bg-background/80 backdrop-blur-sm'
              : 'size-5',
            unusable
              ? 'text-destructive'
              : 'text-amber-600 dark:text-amber-500',
            className
          )}
        >
          <Icon className="size-3.5" />
        </output>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px]">{label}</TooltipContent>
    </Tooltip>
  );
};
