import type React from 'react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { StyleDetailDialog } from '@/components/style/style-detail-dialog';
import { PromoteStyleDialog } from '@/components/style/promote-style-dialog';
import { useSequenceStyle, useStyle, useStyles } from '@/hooks/use-styles';
import { cn } from '@/lib/utils';
import { ChevronDown, Info, Library, Wand2 } from 'lucide-react';

// Tinted chip treatments from the Tailwind palette. A style name always hashes
// to the same entry, so the same style gets the same color everywhere.
const BADGE_COLORS = [
  'bg-red-500/15 text-red-700 dark:text-red-400',
  'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  'bg-lime-500/15 text-lime-700 dark:text-lime-400',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  'bg-teal-500/15 text-teal-700 dark:text-teal-400',
  'bg-cyan-500/15 text-cyan-700 dark:text-cyan-400',
  'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  'bg-violet-500/15 text-violet-700 dark:text-violet-400',
  'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-400',
  'bg-rose-500/15 text-rose-700 dark:text-rose-400',
];

function getStyleBadgeColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return BADGE_COLORS[Math.abs(hash) % BADGE_COLORS.length] ?? '';
}

type StyleBadgeProps = {
  // undefined while the owning sequence is still loading
  styleId?: string;
  /**
   * The sequence the badge sits on. When its style is an automatic one bound
   * to this sequence (#1213), the badge becomes a menu: view the derived
   * recipe, or add it to the team library.
   */
  sequenceId?: string;
  /** `sequence.styleConfig == null`: the automatic recipe isn't derived yet. */
  stylePending?: boolean;
};

/**
 * Shows a sequence's style name as a deterministically-colored badge (#886).
 * Resolves the name from the team+public style catalogue already cached by
 * `useStyles`, so rendering many badges costs a single query; a style outside
 * that list (an automatic one) is fetched by id.
 */
export const StyleBadge: React.FC<StyleBadgeProps> = ({
  styleId,
  sequenceId,
  stylePending = false,
}) => {
  const { data: styles } = useStyles();
  const listed = styleId ? styles?.find((s) => s.id === styleId) : undefined;
  // Off-list style (an automatic one): resolve through the sequence when we
  // have it so an admin's view of another team's sequence still gets a name.
  const needsLookup = !!styleId && !!styles && !listed;
  const { data: bySequence } = useSequenceStyle(
    needsLookup && sequenceId ? sequenceId : ''
  );
  const { data: byId } = useStyle(needsLookup && !sequenceId ? styleId : '');
  const fetched = bySequence ?? byId;
  const [detailOpen, setDetailOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);

  if (!styleId || !styles) {
    return <Skeleton className="w-[80px] h-[20px] rounded-4xl" />;
  }

  const style = listed ?? fetched;
  if (!style) return null;

  const isBoundHere =
    sequenceId !== undefined && style.sequenceId === sequenceId;
  if (!isBoundHere) {
    return (
      <Badge
        className={cn('text-xs', getStyleBadgeColor(style.name))}
        title={`Style: ${style.name}`}
      >
        {style.name}
      </Badge>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="rounded-4xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Match script: ${style.name}. Open style menu`}
          >
            <Badge
              className={cn(
                'flex items-center gap-1 text-xs',
                getStyleBadgeColor(style.name)
              )}
              title={`Match script: ${style.name}`}
            >
              <Wand2 className="size-3" aria-hidden />
              {stylePending ? 'Deriving style…' : style.name}
              <ChevronDown className="size-3" aria-hidden />
            </Badge>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setDetailOpen(true)}>
            <Info />
            View style
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={stylePending}
            onSelect={() => setPromoteOpen(true)}
          >
            <Library />
            Add to library…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <StyleDetailDialog
        style={style}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        readOnly
      />
      <PromoteStyleDialog
        style={style}
        sequenceId={sequenceId}
        open={promoteOpen}
        onOpenChange={setPromoteOpen}
      />
    </>
  );
};
