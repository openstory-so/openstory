/**
 * Download menu for the whole cut. `toolbar` is the labelled button in the
 * Canvas/Script toggle's trailing slot (desktop); `overlay` is the icon on the
 * theatre player, at the 44px mobile hit target. Both open the same menu:
 * Download / Copy link once the current cut has a render, otherwise why it
 * has none and "Render MP4 on server".
 */

import { Button } from '@/ui/shadcn/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/shadcn/dropdown-menu';
import type { SequenceExportState } from '@/sequences/ui/theatre/use-sequence-export';
import { cn } from '@/ui/utils';
import {
  ChevronDown,
  CircleStop,
  Download,
  Link,
  Loader2,
  Server,
} from 'lucide-react';
import { useSyncExternalStore } from 'react';

function subscribeToSeconds(onTick: () => void): () => void {
  const id = window.setInterval(onTick, 1000);
  return () => window.clearInterval(id);
}

/** `m:ss` since `startedAt`, ticking once a second; empty on the server. */
function useElapsed(startedAt: number | null): string {
  const now = useSyncExternalStore(
    subscribeToSeconds,
    () => Math.floor(Date.now() / 1000),
    () => 0
  );
  if (startedAt === null || now === 0) return '';
  const seconds = Math.max(0, now - Math.floor(startedAt / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export const SequenceDownloadMenu: React.FC<{
  sequenceExport: SequenceExportState;
  /** Draft clips in the cut (#1756) — the render would carry 480p shots. */
  draftLabel?: string | null;
  variant: 'toolbar' | 'overlay';
}> = ({ sequenceExport, draftLabel = null, variant }) => {
  const {
    isRunning,
    freshExportUrl,
    hasStaleExport,
    canExport,
    clipsReady,
    clipsTotal,
  } = sequenceExport;
  const elapsed = useElapsed(isRunning ? sequenceExport.renderStartedAt : null);
  const status = isRunning
    ? `Rendering on server${elapsed ? ` · ${elapsed}` : ''}`
    : freshExportUrl
      ? null
      : !canExport
        ? `${clipsReady} of ${clipsTotal} clips ready`
        : hasStaleExport
          ? 'Cut changed since last render'
          : 'Not rendered yet';
  const shortLabel = isRunning ? `Rendering… ${elapsed}`.trim() : 'Download';
  const triggerLabel = isRunning
    ? shortLabel
    : status
      ? `Download — ${status}`
      : 'Download';

  const icon = isRunning ? <Loader2 className="animate-spin" /> : <Download />;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === 'toolbar' ? (
          <Button
            type="button"
            variant={freshExportUrl || isRunning ? 'default' : 'outline'}
            size="sm"
            aria-label={triggerLabel}
            aria-busy={isRunning}
            className="hidden md:inline-flex"
          >
            {icon}
            {/* Labelled only when the view bar has room (canvas-view-toggle). */}
            <span className="hidden tabular-nums @[40rem]/viewbar:inline">
              {shortLabel}
            </span>
            <ChevronDown className="size-3" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'h-11 w-11 bg-black/50 text-white hover:bg-black/70 hover:text-white md:h-8 md:w-8',
              '[&_svg]:size-5 md:[&_svg]:size-4'
            )}
            aria-label={triggerLabel}
            aria-busy={isRunning}
          >
            {icon}
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {draftLabel && (
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            {draftLabel} — finals not rendered
          </DropdownMenuLabel>
        )}
        {status && (
          <DropdownMenuLabel
            aria-live="polite"
            className="font-normal text-muted-foreground tabular-nums"
          >
            {status}
          </DropdownMenuLabel>
        )}
        {freshExportUrl ? (
          <DropdownMenuItem onClick={sequenceExport.download}>
            <Download />
            Download MP4
          </DropdownMenuItem>
        ) : isRunning ? (
          <DropdownMenuItem onClick={sequenceExport.abort}>
            <CircleStop />
            Stop waiting
            <span className="ml-auto text-xs text-muted-foreground">
              render continues
            </span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            disabled={!canExport}
            onClick={sequenceExport.render}
          >
            <Server />
            Render MP4 on server
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!freshExportUrl}
          onClick={sequenceExport.copyLink}
        >
          <Link />
          Copy link
          {!freshExportUrl && (
            <span className="ml-auto text-xs text-muted-foreground">
              after render
            </span>
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
