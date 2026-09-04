/**
 * Desktop canvas-view trailing control: an Export dropdown in the same slot
 * as Copy script. Hidden on mobile — Download / Copy stay on the theatre
 * player overlay, which already meets the 44px hit target.
 */

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type {
  ExportProgress,
  SequenceExportState,
} from '@/components/theatre/use-sequence-export';
import { ChevronDown, Download, FileDown, Link, Loader2 } from 'lucide-react';

export function formatExportProgress(progress: ExportProgress | null): string {
  if (!progress) return 'Creating MP4…';
  return 'Rendering on server…';
}

export const SequenceExportActions: React.FC<{
  sequenceExport: SequenceExportState;
}> = ({ sequenceExport }) => {
  const running = sequenceExport.isRunning;
  const pending =
    !running && !sequenceExport.canExport && !sequenceExport.freshExportUrl;
  const label = running
    ? formatExportProgress(sequenceExport.progress)
    : pending
      ? `${sequenceExport.clipsReady} of ${sequenceExport.clipsTotal} clips ready`
      : 'Export';

  return (
    <div className="hidden md:block">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2.5"
            aria-label={label}
            aria-busy={running}
            disabled={pending}
          >
            {running ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileDown className="mr-1.5 h-3.5 w-3.5" />
            )}
            <span>{running ? 'Creating…' : 'Export'}</span>
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={pending || running}
            onClick={sequenceExport.download}
          >
            <Download />
            Download MP4
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={pending || running}
            onClick={sequenceExport.copyLink}
          >
            <Link />
            Copy link
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
