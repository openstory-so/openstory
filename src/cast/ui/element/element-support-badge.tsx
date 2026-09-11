/**
 * How usable an element is as a model reference, on the element itself (#1559).
 *
 * A still needs no badge — every model takes one. A clip or a voice line is
 * carried by only part of the catalog, which is a property of the file rather
 * than a problem, so it wears an info icon naming the models that take it.
 *
 * With a model in scope (the shot's), the badge answers for THAT model: a
 * warning when it cannot use the file, because there is no fallback — the shot
 * will not render until the model or the file changes. A file longer than every
 * ceiling in the catalog cannot be a reference anywhere: that reads as an
 * error, because the only way out is to trim it.
 */

import {
  listModelNames,
  referenceProblem,
  referenceUsability,
  unusableReferenceLines,
  type ReferenceUsability,
} from '@/motion/reference-support';
import type { ImageToVideoModel } from '@/models/models';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/shadcn/tooltip';
import { cn } from '@/ui/utils';
import { AlertTriangle, CircleAlert, Info } from 'lucide-react';

type ElementSupportBadgeProps = {
  token: string;
  kind: 'image' | 'video' | 'audio';
  durationSeconds: number | null;
  /** The stored file, so a format no model takes is caught on the tile. */
  url?: string | null;
  /** The model the shot renders on, when there is one in scope. */
  motionModel?: ImageToVideoModel;
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
  durationSeconds: number | null,
  url?: string | null
): string {
  return summarise(
    referenceUsability({ kind, durationSeconds, imageUrl: url }),
    kind
  );
}

function summarise(usability: ReferenceUsability, kind: string): string {
  if (usability.level === 'unusable') {
    const { problem } = usability;
    switch (problem.reason) {
      case 'format':
        return `This ${kind} is ${problem.ext.toUpperCase()} — models take ${problem.accepts}. Replace it with an ${problem.accepts} file.`;
      case 'too-short':
        return `This ${kind} is too short to use as a reference — every model needs at least ${problem.minSeconds}s.`;
      case 'too-long':
        return `This ${kind} is too long to use as a reference — no model accepts more than ${problem.maxSeconds}s. Trim it to attach it to a shot.`;
    }
  }
  if (usability.level === 'limited') {
    const parts = [`Works with ${listModelNames(usability.models)}.`];
    if (usability.tooLong.length > 0) {
      parts.push(
        `Too long for ${byLimit(
          usability.tooLong.map((t) => ({
            model: t.model,
            seconds: t.maxSeconds,
          })),
          'max'
        )}.`
      );
    }
    if (usability.tooShort.length > 0) {
      parts.push(
        `Too short for ${byLimit(
          usability.tooShort.map((t) => ({
            model: t.model,
            seconds: t.minSeconds,
          })),
          'min'
        )}.`
      );
    }
    return parts.join(' ');
  }
  return '';
}

/** "Omni Flash (3s max); H3 Max, Seedance 2.0 and Seedance 2.0 Mini (15s max)" */
function byLimit(
  entries: { model: ImageToVideoModel; seconds: number }[],
  bound: 'max' | 'min'
): string {
  const grouped = new Map<number, ImageToVideoModel[]>();
  for (const { model, seconds } of entries) {
    grouped.set(seconds, [...(grouped.get(seconds) ?? []), model]);
  }
  return [...grouped]
    .sort(([a], [b]) => a - b)
    .map(
      ([seconds, models]) => `${listModelNames(models)} (${seconds}s ${bound})`
    )
    .join('; ');
}

export const ElementSupportBadge: React.FC<ElementSupportBadgeProps> = ({
  token,
  kind,
  durationSeconds,
  url,
  motionModel,
  variant = 'overlay',
  className,
}) => {
  const usability = referenceUsability({
    kind,
    durationSeconds,
    imageUrl: url,
  });
  if (usability.level === 'ok') return null;

  const ref = { token, kind, durationSeconds, imageUrl: url };
  const problem = motionModel ? referenceProblem(motionModel, ref) : null;
  const unusable = usability.level === 'unusable';
  const tone = unusable ? 'error' : problem ? 'warning' : 'info';
  const Icon = { error: CircleAlert, warning: AlertTriangle, info: Info }[tone];
  const label =
    motionModel && problem
      ? unusableReferenceLines(motionModel, [ref]).join(' ')
      : summarise(usability, kind);

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
            {
              error: 'text-destructive',
              warning: 'text-warning',
              info: 'text-muted-foreground',
            }[tone],
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
