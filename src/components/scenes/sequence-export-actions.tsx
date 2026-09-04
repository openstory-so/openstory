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
import type { SequenceExportState } from '@/components/theatre/use-sequence-export';
import type { ExportProgress } from '@/shared/sequence-player/export';
import { ChevronDown, Download, FileDown, Link, Loader2 } from 'lucide-react';

export function formatExportProgress(progress: ExportProgress | null): string {
  if (!progress) return 'Creating MP4…';
  const phaseLabel: Record<ExportProgress['phase'], string> = {
    prepare: 'Preparing',
    video: 'Stitching video',
    music: 'Downloading music',
    dialogue: 'Decoding dialogue',
    mix: 'Mixing audio',
    encode: 'Encoding audio',
    finalize: 'Finalizing',
    upload: 'Uploading',
    commit: 'Saving',
    server: 'Rendering on server',
  };
  const label = phaseLabel[progress.phase];
  if (progress.total > 0) {
    const pct = Math.min(
      100,
      Math.round((progress.completed / progress.total) * 100)
    );
    return `${label}… ${pct}%`;
  }
  return `${label}…`;
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
